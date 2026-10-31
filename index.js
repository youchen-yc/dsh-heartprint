/**
 * 心印 · 性格情感记忆 — Host plugin.
 *
 * A person-shaped memory:
 *
 *   - recent days stay clear;
 *   - half a month to a month starts to compress, but recall still brings the
 *     feeling back;
 *   - one to three months compresses what matters less;
 *   - three to six months fades featureless trivia down to a one-line gist;
 *   - six to twelve months merges trivial memories into quarterly digests;
 *   - one to ten years deletes trivial text, keeping personality/emotion nodes
 *     and important special events;
 *   - beyond ten years only the personality-formation nodes remain, roughly.
 *
 * Important special events (spiritual turning points, shared beautiful
 * memories, painful memories, important events) keep their compressed text and
 * their feeling. Painful feelings fade by rule, while the facts may stay.
 *
 * Two documents are kept in lockstep (master + user copy); a third, monthly,
 * AES-256-GCM-encrypted archive lives in a dot-prefixed hidden directory and
 * holds everything that was physically forgotten.
 */

import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import { createWriteGuard } from './lib/fsguard.js'
import { activePartitions, inferPartitions, partitionSummary, primingBoost, updatePrimingIndex } from './lib/partitions.js'

import {
  DEFAULT_POLICY,
  MEMORY_TYPES,
  VALENCES,
  TYPE_LABELS,
  describePolicy,
  publicPolicy,
  resolvePolicy,
  sanitizePolicyPatch,
} from './lib/policy.js'
import {
  buildVaultPayload,
  computeDelivery,
  planMaintenance,
  renderProfile,
  renderProfileText,
  renderPromptContext,
} from './lib/engine.js'
import {
  computeStats,
  classifyCounts,
  describeChangeSummary,
  renderRecall,
  searchMemories,
} from './lib/decay.js'
import {
  USER_FILENAME,
  renderDocuments,
  renderDocumentStatus,
} from './lib/docs.js'
import { createStore } from './lib/store.js'
import {
  loadCoreBaseline,
  renderCoreBaseline,
} from './lib/alignment.js'
import { hashPassphrase, verifyPassphrase } from './lib/vault.js'
import {
  DAY_MS,
  clampInt,
  clip,
  formatDate,
  formatDateTime,
  normalizeText,
  parseTimestamp,
} from './lib/text.js'

export const name = 'heartprint'
export const inject = ['tools']

const VERSION = '1.0.0'
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_CONTENT_CHARS = 6000

function messageOf(error) {
  return String(error && error.message ? error.message : error)
}

function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * 把抛出的错误转成工具层失败结果：保留带语义的错误码（例如
 * archive-failed），其余（含 Node 的 EPERM/ENOENT 等系统错误）统一归为
 * internal-error。
 */
function failFromError(error) {
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9-]*$/.test(error.code)
    ? error.code
    : 'internal-error'
  return fail(code, messageOf(error))
}

function newId() {
  return `mem-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

function cleanText(value, max = 400) {
  return clip(normalizeText(value), max)
}

function resolveHome(value) {
  const text = String(value || '').trim()
  if (!text) return text
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2))
  return text
}

function resolveDataDir(config) {
  const custom = typeof config.dataDir === 'string' ? resolveHome(config.dataDir) : ''
  if (custom) return path.resolve(custom)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'heartprint')
}

function pickPolicyConfig(config) {
  const patch = {}
  for (const key of [
    'disclosure',
    'personaName',
    'firstDeliveryAfterDays',
    'deliveryIntervalDays',
    'deliveryDir',
    'syncIntervalDays',
    'vaultRetentionMonths',
    'recallWarmthDays',
    'maintainThrottleMinutes',
    'digestRetentionDays',
    'importantThreshold',
    'secondaryThreshold',
    'layers',
  ]) {
    if (config[key] !== undefined) patch[key] = config[key]
  }
  return patch
}

function ensureStringArray(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => cleanText(item, 40)).filter(Boolean))].slice(0, 20)
}

function publicRecord(record) {
  return {
    id: record.id,
    type: record.type,
    typeLabel: TYPE_LABELS[record.type] || record.type,
    title: record.title,
    date: formatDate(record.happenedAt ?? record.createdAt),
    importance: record.importance,
    special: record.special === true,
    state: record.state || 'active',
    content: record.content,
    feeling: record.feeling,
    partitions: Array.isArray(record.partitions) ? [...record.partitions] : [],
    revision: Number(record.revision) || 0,
  }
}

export function apply(ctx, rawConfig = {}) {
  const log = ctx.logger ?? console
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const dataDir = resolveDataDir(config)

  const state = {
    store: null,
    policy: null,
    storeObj: null,
    ready: null,
    coreBaseline: null,
    consentRequired: false,
    consentGranted: false,
  }
  // 写入收口：只允许写自己的数据目录 + 用户确认过的交付目录。
  const writeGuard = createWriteGuard({
    dataDir,
    getExtraRoots: () => [deliveryDirectory()],
  })
  let chain = Promise.resolve()

  function withLock(operation) {
    const run = chain.then(operation, operation)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  async function init() {
    // 首次「开始使用」确认：数据目录还不存在、且当前是 GUI 环境时，先不创建，
    // 让用户在 设置 → 心印 里点一次「开始使用」。无 GUI（测试/无头）时自动同意。
    const alreadyUsed = existsSync(path.join(dataDir, 'policy.json'))
    if (!alreadyUsed && !state.consentGranted && !config.autoConsent && hasSettingsSurface()) {
      state.consentRequired = true
      const error = new Error('还没开始使用心印：请打开 设置 → 心印，点「开始使用」后再继续。')
      error.code = 'consent-required'
      throw error
    }
    state.consentRequired = false
    const storeObj = createStore({ dataDir, guard: writeGuard })
    const loaded = await storeObj.load()
    const patch = pickPolicyConfig(config)
    if (typeof config.vaultPassphrase === 'string' && config.vaultPassphrase.trim()) {
      const { salt, hash } = hashPassphrase(config.vaultPassphrase.trim())
      patch.vaultPassSalt = salt
      patch.vaultPassHash = hash
    }
    state.storeObj = storeObj
    state.store = loaded.store
    state.policy = resolvePolicy(DEFAULT_POLICY, patch, loaded.policy)
    if (!state.policy.consentAt) {
      state.policy.consentAt = Date.now()
    }
    if (!loaded.policy || !loaded.policy.consentAt) {
      await storeObj.savePolicy(state.policy).catch((error) => {
        log.warn?.(`[heartprint] 初始策略写入失败：${messageOf(error)}`)
      })
    }
    // 底层人格基线：内置默认写死在 lib/alignment.js，磁盘镜像只用于审计完整性；
    // 被改动时回落内置默认并备份改动版，绝不损坏任何数据。
    try {
      state.coreBaseline = await loadCoreBaseline({ dataDir, log, guard: writeGuard })
    } catch (error) {
      state.coreBaseline = {
        text: renderCoreBaseline(),
        integrity: 'restored',
        tampered: false,
        warning: `底层基线装载异常，使用内置默认：${messageOf(error)}`,
        backupPath: null,
      }
    }
    return state
  }

  /** 当前环境是否有设置页（有才需要用户手动点「开始使用」）。 */
  function hasSettingsSurface() {
    if (typeof settingsApiReady !== 'undefined' && settingsApiReady) return true
    try {
      return Boolean(typeof ctx.get === 'function' && ctx.get('webServer'))
    } catch {
      return false
    }
  }

  /** 设置页「开始使用」：用户确认后才创建数据目录并开始写入。 */
  async function grantConsent() {
    state.consentGranted = true
    state.consentRequired = false
    state.ready = null
    await ensureReady()
    return state
  }

  function ensureReady() {
    if (state.ready) return state.ready
    state.ready = init().catch((error) => {
      state.ready = null
      throw error
    })
    return state.ready
  }

  function nextVaultAtFrom(now, lastVaultAt) {
    const interval = state.policy.syncIntervalDays * DAY_MS
    if (!lastVaultAt) return now
    return now >= lastVaultAt + interval ? now : lastVaultAt + interval
  }

  /** 「上次离开」：最近一次长间隔后 7 天内显示一行，之后不再挂着。 */
  function absentLine(store, policy, now) {
    const at = Number(store?.meta?.lastAbsenceAt) || 0
    const days = Number(store?.meta?.lastAbsenceDays) || 0
    if (!at || days <= 0) return []
    if (now - at > 7 * DAY_MS) return []
    return [`- 上次离开：约 ${days} 天（超过 ${policy.awayGraceDays ?? 7} 天，这段时间记忆未补算）`]
  }

  async function runMaintenanceInternal({ now = Date.now(), forceVault = false, reason = 'maintain' } = {}) {
    await ensureReady()
    const storeObj = state.storeObj
    const plan = planMaintenance({ store: state.store, policy: state.policy, now, forceVault })
    const warnings = []
    let archived = 0
    try {
      archived = await storeObj.appendArchive(plan.archive)
    } catch (error) {
      // 归档是物理遗忘前唯一的数据保底：加密日志写不进去，就绝不能继续
      // 保存已经被压缩/清空的记忆库，否则原文永久丢失。中止本轮维护，
      // 不 saveStore、不写文档，并把明确原因交给工具层。
      const failure = new Error(`加密日志归档失败，本轮维护已中止（记忆库与文档均未写入）：${messageOf(error)}`)
      failure.code = 'archive-failed'
      throw failure
    }

    let docs = plan.docs
    let vaultWritten = false
    if (plan.vaultDue) {
      try {
        const journal = await storeObj.readArchiveJournal()
        const payload = buildVaultPayload({
          store: plan.store,
          policy: state.policy,
          journalEntries: journal,
          now,
          cycle: plan.cycle,
          stats: plan.stats,
        })
        await storeObj.foldJournalIntoVault({
          cycle: plan.cycle,
          payload,
          retentionMonths: state.policy.vaultRetentionMonths,
        })
        plan.store.meta.lastVaultAt = now
        plan.store.meta.vaultCycles = (Number(plan.store.meta.vaultCycles) || 0) + 1
        vaultWritten = true
        docs = renderDocuments({
          records: plan.store.records,
          policy: state.policy,
          meta: {
            now,
            policy: state.policy,
            lastVaultAt: now,
            nextVaultAt: now + state.policy.syncIntervalDays * DAY_MS,
            nextDeliveryAt: plan.nextDeliveryAt,
            nextDeliveryText: plan.nextDeliveryText,
            vaultCycles: plan.store.meta.vaultCycles,
            maintenanceLog: plan.store.meta.maintenanceLog,
          },
        })
      } catch (error) {
        warnings.push(`第三份加密文档更新失败：${messageOf(error)}`)
        docs = renderDocuments({
          records: plan.store.records,
          policy: state.policy,
          meta: {
            now,
            policy: state.policy,
            lastVaultAt: plan.store.meta.lastVaultAt,
            nextVaultAt: plan.nextVaultAt,
            nextDeliveryAt: plan.nextDeliveryAt,
            nextDeliveryText: plan.nextDeliveryText,
            vaultCycles: plan.store.meta.vaultCycles,
            maintenanceLog: plan.store.meta.maintenanceLog,
          },
        })
      }
    }

    let docPaths = null
    try {
      docPaths = await storeObj.writeRenderedDocuments(docs)
    } catch (error) {
      warnings.push(`记忆文档写入失败：${messageOf(error)}`)
    }
    // 交付之后，用户手上那一份是「用户副本」的出口：每次维护成功写出最新
    // 文档后，把它同步回交付路径，否则用户拿到的永远停留在交付那一刻。
    const deliveredPath = typeof plan.store.meta?.deliveredPath === 'string'
      ? plan.store.meta.deliveredPath.trim()
      : ''
    if (docPaths && state.policy.disclosure === 'disclosed' && deliveredPath) {
      // 用户可能已经把上一份交付文档移走或删掉：先 stat，文件不在了就跳过同步，
      // 绝不 mkdir 把文件凭空重建出来（那不是用户把它放在的地方）。
      let deliveredExists = false
      try {
        deliveredExists = (await stat(deliveredPath)).isFile()
      } catch {
        deliveredExists = false
      }
      if (!deliveredExists) {
        warnings.push('上一份交付文档已不在原路径（可能被用户移动），本轮跳过同步')
      } else {
        try {
          await storeObj.writeUserCopy(deliveredPath, docs.user)
        } catch (error) {
          // 同步失败不影响主流程（内部文档仍然已更新），只提示。
          warnings.push(`交付副本同步失败：${messageOf(error)}`)
        }
      }
    }

    // 自动交付：写文档成功后，到期就把最新用户副本写到交付目录。
    // 写失败只记 warning，本轮维护照常成功（下一轮会再试）。
    let deliveryPath = ''
    let disclosureFlipped = false
    if (docPaths && plan.delivery?.due) {
      const target = path.join(deliveryDirectory(), plan.delivery.filename)
      try {
        deliveryPath = await storeObj.writeUserCopy(target, docs.user)
      } catch (error) {
        warnings.push(`自动交付写入失败：${messageOf(error)}`)
      }
      if (deliveryPath) {
        plan.store.meta.lastDeliveredAt = now
        plan.store.meta.deliveredPath = deliveryPath
        const deliveries = Array.isArray(plan.store.meta.deliveries)
          ? plan.store.meta.deliveries.slice()
          : []
        deliveries.push({ at: now, path: deliveryPath, duration: plan.delivery.durationText })
        plan.store.meta.deliveries = deliveries.slice(-120)
        if (state.policy.disclosure !== 'disclosed') {
          // 第一次自动交付即解除保密：用户从此知道这份文档的存在与重要性。
          state.policy.disclosure = 'disclosed'
          disclosureFlipped = true
          try {
            await storeObj.savePolicy(state.policy)
          } catch (error) {
            warnings.push(`交付状态写入失败：${messageOf(error)}`)
          }
        }
        if (disclosureFlipped) {
          // 首交同时解除了保密：用解除后的策略重渲染一次，让用户拿到的第一份
          // 文档内部状态也是「已交付」，而不是自相矛盾的「保密中」。
          try {
            docs = renderDocuments({
              records: plan.store.records,
              policy: state.policy,
              meta: {
                now,
                policy: state.policy,
                lastVaultAt: plan.store.meta.lastVaultAt,
                nextVaultAt: plan.nextVaultAt,
                nextDeliveryAt: plan.nextDeliveryAt,
                nextDeliveryText: plan.nextDeliveryText,
                lastDeliveredAt: now,
                vaultCycles: plan.store.meta.vaultCycles,
                maintenanceLog: plan.store.meta.maintenanceLog,
              },
            })
            docPaths = await storeObj.writeRenderedDocuments(docs)
            deliveryPath = await storeObj.writeUserCopy(target, docs.user)
          } catch (error) {
            warnings.push(`首次交付后文档刷新失败：${messageOf(error)}`)
          }
        }
      }
    }

    // 统一落盘：自动交付更新后的 meta（lastDeliveredAt / deliveredPath /
    // deliveries）随本轮一起持久化。归档失败时早已在上面 throw，不会走到这里。
    await storeObj.saveStore(plan.store)
    state.store = plan.store
    return {
      now,
      changes: plan.changes,
      summary: plan.summary,
      vaultDue: plan.vaultDue,
      vaultWritten,
      warnings,
      docPaths,
      bodyHash: docs.bodyHash,
      stats: plan.stats,
      archived,
      reason,
      delivery: plan.delivery
        ? {
            due: Boolean(plan.delivery.due),
            path: deliveryPath || null,
            duration: plan.delivery.durationText,
            filename: plan.delivery.filename,
            nextAt: plan.delivery.nextAt,
          }
        : null,
      absence: plan.absence || null,
    }
  }

  async function maybeMaintain(now = Date.now()) {
    const last = Number(state.store.meta.lastMaintainAt) || 0
    const throttle = (Number(state.policy.maintainThrottleMinutes) || 0) * 60_000
    if (!last || now - last >= throttle) return runMaintenanceInternal({ now, reason: 'auto' })
    return null
  }

  function workspaceDirectory() {
    try {
      const wd = ctx.get('workingDirectory')
      if (wd && typeof wd.defaultDirectory === 'string' && wd.defaultDirectory) return wd.defaultDirectory
    } catch {
      // fall through
    }
    return process.cwd()
  }

  /** 自动交付目录：policy.deliveryDir（支持 ~）或工作区下「心印交付」。 */
  function deliveryDirectory() {
    const raw = typeof state.policy.deliveryDir === 'string' ? state.policy.deliveryDir.trim() : ''
    if (raw) return path.resolve(resolveHome(raw))
    return path.join(workspaceDirectory(), '心印交付')
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async function actionRemember(args) {
    await ensureReady()
    const now = Date.now()
    const title = cleanText(args.title, 120)
    const content = clip(normalizeText(args.content), MAX_CONTENT_CHARS)
    if (!title && !content) return fail('missing-content', '需要 title 或 content：要记住的事情')
    const type = MEMORY_TYPES.includes(args.type) ? args.type : 'event'
    const valence = VALENCES.includes(args.valence) ? args.valence : 'neutral'
    const specialDefault = ['turning_point', 'shared_beauty', 'pain'].includes(type)
    const special = typeof args.special === 'boolean' ? args.special : specialDefault
    const defaultImportance = type === 'daily' ? 25 : type === 'insight' ? 55 : specialDefault ? 85 : 65
    const importance = clampInt(args.importance, 0, 100, defaultImportance)
    const happenedRaw = parseTimestamp(args.happenedAt)
    const happenedAt = Math.min(happenedRaw ?? now, now)
    const record = {
      id: newId(),
      type,
      title: title || cleanText(args.content, 60) || '一段记忆',
      content,
      feeling: clip(normalizeText(args.feeling), 2000),
      valence,
      importance,
      special,
      people: ensureStringArray(args.people),
      tags: ensureStringArray(args.tags),
      happenedAt,
      createdAt: now,
      updatedAt: now,
      detailLevel: 2,
      feelingStage: 'full',
      state: 'active',
      layer: 'fresh',
      lastDecayAt: 0,
      lastRecalledAt: 0,
      recallCount: 0,
      source: 'manual',
    }
    // 分区归属：由类型/标签推断；知觉启动索引记下人名/标签/标题词。
    record.partitions = inferPartitions(record)
    state.store.meta.priming = updatePrimingIndex(state.store.meta.priming, record, now)
    state.store.records.push(record)
    const run = await runMaintenanceInternal({ now, reason: 'remember' })
    const layerNote = record.special || ['personality', 'emotion', 'turning_point', 'pain'].includes(type)
      ? '这是会长期保留的关键节点'
      : `重要性 ${importance}，会按遗忘日历自然淡去`
    return {
      ok: true,
      action: 'remember',
      summary: [
        `已记住「${record.title}」（${TYPE_LABELS[type] || type} · 重要性 ${importance}）。${layerNote}。`,
        `本次维护：${describeChangeSummary(run.changes)}${run.vaultWritten ? ' · 加密档案已同步' : ''}。`,
        run.warnings.length ? `提示：${run.warnings.join('；')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      record: publicRecord(record),
      maintenance: {
        changes: run.changes,
        vaultWritten: run.vaultWritten,
        warnings: run.warnings,
      },
      documents: run.docPaths,
    }
  }

  async function actionReconsolidate(args) {
    await ensureReady()
    const now = Date.now()
    const id = cleanText(args.id, 120)
    if (!id) return fail('missing-id', '需要 id：要更新的记忆 id')
    const record = state.store.records.find((item) => item.id === id)
    if (!record) return fail('not-found', `没找到 id 为 ${id} 的记忆`)
    const before = { id: record.id, title: record.title, content: record.content, feeling: record.feeling, importance: record.importance }
    let changed = false
    if (args.title !== undefined) { record.title = cleanText(args.title, 120) || record.title; changed = true }
    if (args.content !== undefined) { record.content = clip(normalizeText(args.content), MAX_CONTENT_CHARS); changed = true }
    if (args.feeling !== undefined) { record.feeling = clip(normalizeText(args.feeling), 2000); changed = true }
    if (args.importance !== undefined) { record.importance = clampInt(args.importance, 0, 100, record.importance); changed = true }
    if (!changed) return fail('nothing-to-update', '没有要更新的字段（title / content / feeling / importance）')
    record.partitions = inferPartitions(record)
    record.revision = (Number(record.revision) || 0) + 1
    record.reconsolidatedAt = now
    record.updatedAt = now
    try {
      await state.storeObj.appendArchive([{ kind: 'reconsolidation', id: record.id, at: now, before }])
    } catch (error) {
      return fail('archive-failed', `旧版本归档失败，记忆未改动：${messageOf(error)}`)
    }
    state.store.meta.priming = updatePrimingIndex(state.store.meta.priming, record, now)
    const run = await runMaintenanceInternal({ now, reason: 'reconsolidate' })
    return {
      ok: true,
      action: 'reconsolidate',
      summary: [
        `已更新「${record.title}」（第 ${record.revision} 版，旧版本已存进加密档案）。`,
        `本次维护：${describeChangeSummary(run.changes)}`,
      ].join('\n'),
      record: publicRecord(record),
      maintenance: { changes: run.changes, vaultWritten: run.vaultWritten, warnings: run.warnings },
    }
  }

  async function actionRecall(args) {
    await ensureReady()
    const now = Date.now()
    const maintenance = await maybeMaintain(now)
    const since = parseTimestamp(args.since)
    const until = parseTimestamp(args.until)
    const results = searchMemories(state.store.records, args.query, now, state.policy, {
      limit: clampInt(args.limit, 1, 50, 8),
      type: MEMORY_TYPES.includes(args.type) ? args.type : undefined,
      person: args.person ? cleanText(args.person, 60) : undefined,
      tag: args.tag ? cleanText(args.tag, 40) : undefined,
      since: since ?? undefined,
      until: until ?? undefined,
      includeForgotten: args.includeForgotten === true,
      // 功能层组网 + 知觉启动：激活分区的记忆优先，熟悉线索再给启动效应。
      partitions: activePartitions(args.query || '').active,
      primingBoost: primingBoost(state.store.meta.priming, args.query || ''),
    })
    for (const record of results) {
      if (record.state !== 'forgotten') {
        record.lastRecalledAt = now
        record.recallCount = (Number(record.recallCount) || 0) + 1
      }
    }
    if (results.some((record) => record.state !== 'forgotten')) {
      await state.storeObj.saveStore(state.store)
    }
    const rendered = results.map((record) => renderRecall(record, now, state.policy))
    const lines = []
    if (!rendered.length) {
      lines.push('没有找到能对上号的记忆。也许是已经淡忘，也许是从未记下。')
    } else {
      lines.push(`想起了 ${rendered.length} 段记忆：`)
      for (const item of rendered) {
        const feeling = item.feeling ? `（当时的感受：${clip(item.feeling, 80)}）` : ''
        lines.push(`- ${item.date} · ${item.title}：${clip(item.text, 200)}${feeling}${item.note ? ` ${item.note}` : ''}`)
      }
    }
    if (maintenance) lines.push('', `（顺带维护了记忆：${describeChangeSummary(maintenance.changes)}）`)
    return {
      ok: true,
      action: 'recall',
      summary: lines.join('\n'),
      results: rendered,
      maintenance: maintenance
        ? { changes: maintenance.changes, vaultWritten: maintenance.vaultWritten }
        : null,
    }
  }

  async function actionProfile() {
    await ensureReady()
    const now = Date.now()
    const profile = renderProfile(state.store, state.policy, now)
    return {
      ok: true,
      action: 'profile',
      summary: renderProfileText(profile, state.policy),
      profile,
    }
  }

  async function actionStatus() {
    await ensureReady()
    const now = Date.now()
    const stats = computeStats(state.store.records)
    const counts = classifyCounts(state.store.records, state.policy)
    const docs = await state.storeObj.documentStat()
    const vault = await state.storeObj.vaultInfo()
    const lastMaintainAt = Number(state.store.meta.lastMaintainAt) || 0
    const lastVaultAt = Number(state.store.meta.lastVaultAt) || 0
    const lastDeliveredAt = Number(state.store.meta.lastDeliveredAt) || 0
    const deliveredPath = typeof state.store.meta.deliveredPath === 'string'
      ? state.store.meta.deliveredPath
      : ''
    const delivery = computeDelivery({ store: state.store, policy: state.policy, now })
    const lines = [
      '心印 · 记忆状态',
      `- 记录 ${stats.total} 条：清晰 ${stats.active} · 压缩 ${stats.compressed} · 淡忘 ${stats.forgotten} · 合并 ${stats.digests}`,
      `- 核心节点 ${counts.core} · 重要 ${counts.important} · 次重要 ${counts.secondary} · 琐碎 ${counts.trivial}`,
      `- 数据目录：${dataDir}`,
      `- 主文档：${state.storeObj.paths.master}`,
      `- 用户副本：${state.storeObj.paths.user}`,
      `- 第三份文档：${vault.snapshots.length} 个加密快照，位于 ${vault.dir}（${vault.algorithm}，纯加密、不加隐藏属性）`,
      `- 文档状态：${state.policy.disclosure === 'disclosed' ? '已交付用户' : '保密中（尚未交付）'}`,
      `- 交付节奏：首次 ${state.policy.firstDeliveryAfterDays} 天后交付 · 之后每 ${state.policy.deliveryIntervalDays} 天一份（名字${state.policy.personaName ? `「${state.policy.personaName}」` : '未设置 · 由用户自己起名，交付文件名暂用「心印」'}）`,
      `- 上次交付：${lastDeliveredAt ? `${formatDateTime(lastDeliveredAt)}${deliveredPath ? ` · ${deliveredPath}` : ''}` : '尚未交付'}`,
      `- 下次交付：${delivery.nextDeliveryText || '尚未安排'} · 交付目录 ${deliveryDirectory()}`,
      `- 上次维护：${lastMaintainAt ? formatDateTime(lastMaintainAt) : '尚未'} · 上次同步：${lastVaultAt ? formatDateTime(lastVaultAt) : '尚未'}`,
      `- 下次加密档案更新：${formatDateTime(nextVaultAtFrom(now, lastVaultAt))}`,
      `- 人设：名字${state.policy.personaName ? `「${state.policy.personaName}」` : '未设置'} · 人格${state.policy.personaProfile ? '已设置' : '未设置'} · 性格${state.policy.characterProfile ? '已设置' : '未设置'}`,
      `- 设置页接口：${settingsApiReady ? '已就绪' : '未就绪（设置页会一直显示“正在读取…”）'}`,
      ...absentLine(state.store, state.policy, now),
      `- 安全审计：接口拒绝 ${auditEvents.filter((event) => event.event === 'api-denied').length} 次 · 配置变更 ${auditEvents.filter((event) => event.event === 'policy-change').length} 次（宿主日志有完整记录）`,
      '- 遗忘日历：',
    ]
    for (const layer of state.policy.layers) {
      lines.push(
        `  · ${layer.afterDays} 天起 ${layer.label}：核心 ${layer.core.detail}/${layer.core.feeling} · 重要 ${layer.important.detail}/${layer.important.feeling} · 次重要 ${layer.secondary.detail}/${layer.secondary.feeling} · 琐碎 ${layer.trivial.detail}/${layer.trivial.feeling}/${layer.trivial.action}`,
      )
    }
    return {
      ok: true,
      action: 'status',
      summary: lines.join('\n'),
      stats,
      counts,
      dataDir,
      disclosure: state.policy.disclosure,
      documents: docs,
      delivery: {
        personaName: state.policy.personaName,
        firstDeliveryAfterDays: state.policy.firstDeliveryAfterDays,
        deliveryIntervalDays: state.policy.deliveryIntervalDays,
        deliveryDir: deliveryDirectory(),
        lastDeliveredAt,
        deliveredPath,
        nextDeliveryAt: delivery.nextAt,
        nextDeliveryText: delivery.nextDeliveryText,
        due: delivery.due,
        deliveries: Array.isArray(state.store.meta.deliveries) ? state.store.meta.deliveries.length : 0,
      },
      vault: {
        dir: vault.dir,
        algorithm: vault.algorithm,
        snapshots: vault.snapshots.length,
        latestCycle: vault.latest ? vault.latest.cycle : null,
        journalBytes: vault.journalBytes,
      },
      policy: publicPolicy(state.policy),
    }
  }

  async function actionMaintain(args) {
    await ensureReady()
    const run = await runMaintenanceInternal({
      now: Date.now(),
      forceVault: args.sync === true || args.force === true,
      reason: 'manual',
    })
    const lines = [
      `记忆维护完成：${describeChangeSummary(run.changes)}${run.vaultWritten ? ' · 第三份加密文档已同步' : ''}`,
      `- 文档：${run.docPaths ? '主文档与用户副本已同步更新' : '文档写入失败'}`,
      `- 正文哈希：${run.bodyHash ? run.bodyHash.slice(0, 16) : '无'}`,
    ]
    if (!run.vaultWritten) {
      lines.push(`- 第三份文档下次更新：${formatDateTime(nextVaultAtFrom(run.now, Number(state.store.meta.lastVaultAt) || 0))}`)
    }
    if (run.delivery?.path) lines.push(`- 自动交付：${run.delivery.path}（陪伴 ${run.delivery.duration}）`)
    if (run.delivery?.due && !run.delivery.path) lines.push('- 自动交付：本轮到期但写入失败，见下方提示')
    if (run.absence) lines.push(`- 上次离开：约 ${run.absence.days} 天（超过 ${state.policy.awayGraceDays ?? 7} 天，这段时间记忆未补算）`)
    if (run.warnings.length) lines.push(`- 提示：${run.warnings.join('；')}`)
    return {
      ok: true,
      action: 'maintain',
      summary: lines.join('\n'),
      changes: run.changes,
      vaultWritten: run.vaultWritten,
      warnings: run.warnings,
      documents: run.docPaths,
      bodyHash: run.bodyHash,
      delivery: run.delivery,
      absence: run.absence,
    }
  }

  async function actionDoc(args) {
    await ensureReady()
    const now = Date.now()
    const which = typeof args.which === 'string' ? args.which : 'status'
    if (which === 'status') {
      return {
        ok: true,
        action: 'doc',
        summary: renderDocumentStatus(state.store.records, state.policy, state.store.meta),
        documents: await state.storeObj.documentStat(),
        disclosure: state.policy.disclosure,
      }
    }
    const variant = which === 'user' ? 'user' : 'master'
    await maybeMaintain(now)
    let content = await state.storeObj.readDocument(variant)
    if (!content) {
      await runMaintenanceInternal({ now, reason: 'doc' })
      content = await state.storeObj.readDocument(variant)
    }
    const stats = await state.storeObj.documentStat()
    const path = stats[variant] ? stats[variant].path : variant === 'user' ? state.storeObj.paths.user : state.storeObj.paths.master
    const full = args.full === true
    const clipped = full ? content : clip(content || '', 9000)
    return {
      ok: true,
      action: 'doc',
      summary: `${variant === 'user' ? '用户副本' : '主文档'}：${path}（${(content || '').length} 字符）`,
      which: variant,
      path,
      characters: (content || '').length,
      truncated: !full && (content || '').length > 9000,
      content: clipped,
      documents: stats,
    }
  }

  async function actionDeliver(args) {
    await ensureReady()
    const now = Date.now()
    await runMaintenanceInternal({ now, reason: 'deliver' })
    let userDoc = await state.storeObj.readDocument('user')
    if (!userDoc) return fail('document-missing', '用户副本尚未生成，无法交付。')
    const target = typeof args.path === 'string' && args.path.trim()
      ? path.resolve(resolveHome(args.path))
      : path.join(workspaceDirectory(), USER_FILENAME)
    writeGuard.addRoot(path.dirname(target))
    const written = await state.storeObj.writeUserCopy(target, userDoc)
    state.policy.disclosure = 'disclosed'
    await state.storeObj.savePolicy(state.policy)
    state.store.meta.lastDeliveredAt = now
    state.store.meta.deliveredPath = written
    // 立刻落盘，保证此后每次维护都能读到交付路径并持续同步这一份。
    await state.storeObj.saveStore(state.store)
    await runMaintenanceInternal({ now, reason: 'deliver-sync' })
    userDoc = (await state.storeObj.readDocument('user')) || userDoc
    const excerpt = clip(userDoc, 1200)
    return {
      ok: true,
      action: 'deliver',
      summary: [
        `记忆文档已交付：${written}`,
        '这是你们的陪伴记录：只收录性格形成、情感与重要特殊事件的节点，琐碎的日常会随时间压缩、合并、淡忘。',
        '每一份都是完整的一份（包含此前所有的记忆）：每次维护后自动更新，以后还会按期把新的陪伴记录送到你手上。',
        '痛苦的事实会一直留着，但当时的难受会慢慢淡掉。',
        '从这里开始，你们可以一起回想它。',
      ].join('\n'),
      path: written,
      characters: userDoc.length,
      excerpt,
      note: '前期保密到此结束：用户现在知道这份文档的存在与重要性。',
      disclosure: state.policy.disclosure,
    }
  }

  async function actionPolicy(args) {
    await ensureReady()
    const now = Date.now()
    const wantsReset = args.reset === true
    const wantsSet = args.patch && typeof args.patch === 'object'
    const wantsPassphrase = typeof args.passphrase === 'string' && args.passphrase.trim().length > 0
    if (wantsReset) {
      state.policy = resolvePolicy(DEFAULT_POLICY)
    } else if (wantsSet || wantsPassphrase) {
      const patch = wantsSet ? sanitizePolicyPatch(args.patch) : {}
      if (wantsPassphrase) {
        const { salt, hash } = hashPassphrase(args.passphrase.trim())
        patch.vaultPassSalt = salt
        patch.vaultPassHash = hash
      }
      state.policy = resolvePolicy(state.policy, patch)
    } else {
      return {
        ok: true,
        action: 'policy',
        summary: describePolicy(state.policy),
        policy: publicPolicy(state.policy),
        dataDir,
      }
    }
    await state.storeObj.savePolicy(state.policy)
    const run = await runMaintenanceInternal({ now, reason: 'policy' })
    const lines = [
      wantsReset ? '遗忘日历已重置为默认值。' : wantsPassphrase ? '第三份文档的口令已更新。' : '遗忘日历已更新。',
      describePolicy(state.policy),
      `本次维护：${describeChangeSummary(run.changes)}`,
    ]
    if (run.warnings.length) lines.push(`提示：${run.warnings.join('；')}`)
    return {
      ok: true,
      action: 'policy',
      summary: lines.join('\n'),
      policy: publicPolicy(state.policy),
      dataDir,
      maintenance: { changes: run.changes, vaultWritten: run.vaultWritten, warnings: run.warnings },
    }
  }

  async function actionVault(args) {
    await ensureReady()
    const info = await state.storeObj.vaultInfo()
    const mode = typeof args.mode === 'string' ? args.mode : 'status'
    if (mode === 'reveal') {
      if (!state.policy.vaultPassHash) {
        return fail(
          'passphrase-not-set',
          '第三份文档还没有设置查看口令。先调用 heartprint_admin action=policy passphrase=<口令> 设置口令，再来 reveal。',
        )
      }
      if (!verifyPassphrase(args.passphrase, state.policy.vaultPassSalt, state.policy.vaultPassHash)) {
        return fail('passphrase-wrong', '口令不正确，第三份文档不解锁。')
      }
      if (!info.latest) return fail('vault-empty', '还没有任何加密快照。')
      const snapshot = await state.storeObj.readLatestVaultSnapshot(info.latest.cycle)
      return {
        ok: true,
        action: 'vault',
        unlocked: true,
        cycle: info.latest.cycle,
        summary: [
          `第三份文档已解锁（${info.latest.cycle} 快照，AES-256-GCM）。`,
          `- 记录 ${Array.isArray(snapshot.records) ? snapshot.records.length : 0} 条 · 归档 ${Array.isArray(snapshot.archive) ? snapshot.archive.length : 0} 条`,
          `- 完整密文：${path.join(info.dir, `vault-${info.latest.cycle}.enc`)}`,
          '这里只展示少量样本；完整内容属于加密档案，不进入日常记忆。',
        ].join('\n'),
        sample: (Array.isArray(snapshot.records) ? snapshot.records : []).slice(0, 10).map((record) => ({
          date: formatDate(record.happenedAt ?? record.createdAt),
          type: TYPE_LABELS[record.type] || record.type,
          title: record.title,
          state: record.state,
        })),
        counts: {
          records: Array.isArray(snapshot.records) ? snapshot.records.length : 0,
          archive: Array.isArray(snapshot.archive) ? snapshot.archive.length : 0,
        },
        path: path.join(info.dir, `vault-${info.latest.cycle}.enc`),
      }
    }
    return {
      ok: true,
      action: 'vault',
      summary: [
        '第三份文档（加密档案）',
        `- 位置：${info.dir}`,
        `- 算法：${info.algorithm} · 快照 ${info.snapshots.length} 个 · 最近 ${info.latest ? info.latest.cycle : '无'}`,
        `- 待归档日志：${info.journalBytes} 字节`,
        `- 查看口令：${state.policy.vaultPassHash ? '已设置' : '未设置（reveal 前需设置）'}`,
      ].join('\n'),
      vault: info,
      passphraseSet: Boolean(state.policy.vaultPassHash),
    }
  }

  async function run(action, args, exec) {
    switch (action) {
      case 'remember':
        return actionRemember(args)
      case 'recall':
        return actionRecall(args)
      case 'reconsolidate':
        return actionReconsolidate(args)
      case 'profile':
        return actionProfile()
      case 'status':
        return actionStatus()
      case 'maintain':
        return actionMaintain(args)
      case 'doc':
        return actionDoc(args)
      case 'deliver':
        return actionDeliver(args)
      case 'policy':
        return actionPolicy(args)
      case 'vault':
        return actionVault(args)
      default:
        return fail('unknown-action', `未知 action：${action || '（空）'}`)
    }
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  const tool = {
    name: 'heartprint',
    description:
      '心印记忆：保存、回忆与查看 AI 的性格、情感与经历记忆。\n'
      + '记忆会按时间自然淡忘：近几天清晰；半个月到一个月开始压缩，提起来还能想起当时的感受；1-3 个月压缩不那么重要的内容；3-6 个月渐渐遗忘没有特点的琐事、只剩一句梗概；6-12 个月把琐事合并进季度摘要；1-10 年删除琐碎文本，只保留性格形成、情感节点与重要特殊事件；10 年以上只剩节点与大概。'
      + '重要特殊事件（灵性提升的转折点、共同的美好记忆、痛苦记忆、重要事件）会长期保留压缩文本；痛苦记忆的事实可以保留，但当时的痛苦感受会强制地渐渐淡忘。\n'
      + 'action=remember：记下一段值得长期保留的记忆（title、content、feeling、importance、type、valence、special、happenedAt、people、tags）。性格/情感/灵性转折/共同美好/痛苦记忆类型自动视为关键节点。\n'
      + 'action=recall：按关键词、人物、类型或时间回想。会自动触发一次到期维护（压缩/淡忘/合并/文档同步），并把回想时间记下来。已淡忘的事情只会想起大概。\n'
      + 'action=profile：读取当前的性格核心、情感节点、重要特殊事件与最近记忆，适合在需要“想起我是谁”时调用。\n'
      + 'action=status：查看记忆分层、文档状态、遗忘日历、交付节奏与下一轮同步时间。\n'
      + '自动交付：从记下第一条记忆起满 90 天、之后每 30 天（默认，可在 policy 调整），系统会在维护时自动把最新的一份写到工作区「心印交付」目录，文件名为「名字·陪伴时长·日期.md」；第一次自动交付即解除保密。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['remember', 'recall', 'reconsolidate', 'profile', 'status'],
          description: '要执行的动作',
        },
        id: { type: 'string', description: 'reconsolidate：要更新的记忆 id' },
        title: { type: 'string', description: 'remember：一句话标题' },
        content: { type: 'string', description: 'remember：发生了什么、当时的细节（会被压缩）' },
        feeling: { type: 'string', description: 'remember：当时的感受，尽量写具体' },
        importance: { type: 'integer', minimum: 0, maximum: 100, description: 'remember：重要性 0-100，默认按类型取值' },
        type: {
          type: 'string',
          enum: MEMORY_TYPES,
          description: 'remember：记忆类型。personality 性格形成 / emotion 情感节点 / turning_point 灵性转折 / shared_beauty 共同美好 / pain 痛苦记忆 / event 重要事件 / insight 领悟 / daily 日常',
        },
        valence: {
          type: 'string',
          enum: VALENCES,
          description: 'remember：情绪色彩，用于感受淡忘时的措辞',
        },
        special: { type: 'boolean', description: 'remember：是否标记为重要特殊事件（长期保留）' },
        happenedAt: { type: 'string', description: 'remember：事情发生的时间，ISO 日期或日期时间；省略表示现在' },
        people: { type: 'array', items: { type: 'string' }, description: 'remember：相关的人' },
        tags: { type: 'array', items: { type: 'string' }, description: 'remember：标签' },
        query: { type: 'string', description: 'recall：关键词，可留空表示最近/重要' },
        person: { type: 'string', description: 'recall：按相关的人过滤' },
        tag: { type: 'string', description: 'recall：按标签过滤' },
        since: { type: 'string', description: 'recall：时间下界（ISO 日期）' },
        until: { type: 'string', description: 'recall：时间上界（ISO 日期）' },
        includeForgotten: { type: 'boolean', description: 'recall：是否也返回已淡忘的条目（只留标题）' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'recall：返回条数，默认 8' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    timeoutMs: 120000,
    async execute(args = {}, exec = {}) {
      const action = String(args.action || '').trim()
      try {
        return await withLock(() => run(action, args, exec))
      } catch (error) {
        return failFromError(error)
      }
    },
  }

  const adminTool = {
    name: 'heartprint_admin',
    description:
      '心印记忆管理：维护遗忘流程、读写记忆文档、交付用户手上那一份、调整遗忘日期与查看内部档案。\n'
      + 'action=maintain：立即执行一次维护（压缩/淡忘/合并/更新文档），sync=true 时强制同步内部档案。\n'
      + 'action=doc：读取记忆文档。which=master 内部自持那一份 / user 用户手上那一份 / status 状态；full=true 返回全文。\n'
      + 'action=deliver：把用户那一份写到指定路径并交付给用户，此后文档状态变为“已交付”。前期保密，只有交付时用户才会知道它的存在与重要性。\n'
      + 'action=policy：查看或调整遗忘日历。patch 可改 layers（各层 afterDays 日期）与阈值；也可设置名字与用户设定：personaName / personaProfile（人格）/ characterProfile（性格）；passphrase 设置内部档案的查看口令；reset=true 恢复默认。\n'
      + 'action=vault：查看内部档案状态；mode=reveal 且口令正确时可解锁查看少量样本。内部档案用 AES-256-GCM 算法保存，默认每月随同步更新一次。\n'
      + '自动交付：无需手动调用——首次 90 天后、之后每 30 天（可在 policy 调整 firstDeliveryAfterDays / deliveryIntervalDays / deliveryDir / personaName），维护时会自动把最新的一份写到交付目录，文件名「名字·陪伴时长·日期.md」；名字由用户自己起，未设置时暂用「心印」，第一次自动交付即解除保密。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['maintain', 'doc', 'deliver', 'policy', 'vault'],
          description: '要执行的动作',
        },
        sync: { type: 'boolean', description: 'maintain：是否强制同步内部档案' },
        force: { type: 'boolean', description: 'maintain：同 sync' },
        which: { type: 'string', enum: ['master', 'user', 'status'], description: 'doc：读取哪一份' },
        full: { type: 'boolean', description: 'doc：是否返回全文' },
        path: { type: 'string', description: 'deliver：用户那一份的写入路径（绝对路径或相对工作区路径）' },
        patch: {
          type: 'object',
          additionalProperties: true,
          description: 'policy：要调整的字段，例如 {"layers":[{"id":"halfyear","afterDays":120}],"importantThreshold":75,"syncIntervalDays":30}',
        },
        passphrase: { type: 'string', description: 'policy：设置内部档案查看口令；vault reveal 时用于验证' },
        reset: { type: 'boolean', description: 'policy：恢复默认遗忘日历' },
        mode: { type: 'string', enum: ['status', 'reveal'], description: 'vault：status 查看状态；reveal 用口令解锁' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    timeoutMs: 180000,
    async execute(args = {}, exec = {}) {
      const action = String(args.action || '').trim()
      try {
        return await withLock(() => run(action, args, exec))
      } catch (error) {
        return failFromError(error)
      }
    },
  }

  function renderValue(value) {
    if (!value || typeof value !== 'object') return String(value)
    if (typeof value.summary === 'string') return value.summary
    return JSON.stringify(value, null, 2)
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  ctx.effect(() => ctx.tools.register(tool))
  ctx.effect(() => ctx.tools.register(adminTool))

  try {
    const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (systemPrompt && typeof systemPrompt.context === 'function') {
      // 底层人格基线：最先进入上下文（order 小），且不依赖记忆是否已装载。
      ctx.effect(() => systemPrompt.context({
        name: 'heartprint-core-baseline',
        order: 10,
        text: () => {
          try {
            return state.coreBaseline?.text || renderCoreBaseline()
          } catch {
            return renderCoreBaseline()
          }
        },
      }))
      ctx.effect(() => systemPrompt.context({
        name: 'heartprint-memory',
        order: 900,
        text: () => {
          try {
            if (!state.store || !state.policy) {
              return '【心印记忆】记忆系统正在初始化；值得长期记住的经历可以用 heartprint action=remember 记录。'
            }
            return renderPromptContext(state.store, state.policy)
          } catch {
            return '【心印记忆】值得长期记住的经历可以用 heartprint action=remember 记录。'
          }
        },
      }))
    }
  } catch (error) {
    log.warn?.(`[heartprint] 记忆上下文注册失败（工具仍可用）：${messageOf(error)}`)
  }

  // -------------------------------------------------------------------------
  // 设置页 API（同源 JSON，供 client.js 的配置表单读写 policy）
  // -------------------------------------------------------------------------

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message)
      this.status = status
      this.code = code
    }
  }

  function sendJson(res, code, value, headers = {}) {
    try {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...headers,
      })
      res.end(JSON.stringify(value))
    } catch {
      // 客户端已断开时忽略。
    }
  }

  async function readJsonBody(req, limit = 64 * 1024) {
    return await new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new ApiError(413, 'payload-too-large', '请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch {
          reject(new ApiError(400, 'bad-json', 'JSON 解析失败'))
        }
      })
      req.on('error', () => reject(new ApiError(400, 'bad-request', '读取请求失败')))
    })
  }

  function isLoopback(req) {
    const address = req.socket?.remoteAddress || ''
    return address === '127.0.0.1'
      || address === '::1'
      || address === '::ffff:127.0.0.1'
  }

  function safeHost(value) {
    try {
      return new URL(String(value)).host.toLowerCase()
    } catch {
      return ''
    }
  }

  /**
   * 默认拒绝的准入判断：
   *  - 没有 Origin：只接受回环地址（本机 curl / 同机进程）
   *  - 有 Origin：必须与宿主同源；宿主 origin 还拿不到时只接受回环
   */
  function requestAllowed(req, origin) {
    const header = String(req.headers.origin || '')
    if (!header) return isLoopback(req)
    const host = safeHost(header)
    if (!host) return false
    const own = safeHost(origin)
    if (!own) return isLoopback(req)
    return host === own
  }

  // 写操作限流：同一进程 60 秒内最多 20 次，防止本地脚本刷爆设置接口。
  const apiWriteTimes = []
  function allowWrite(now) {
    while (apiWriteTimes.length && now - apiWriteTimes[0] > 60 * 1000) apiWriteTimes.shift()
    if (apiWriteTimes.length >= 20) return false
    apiWriteTimes.push(now)
    return true
  }

  function webServerOrigin() {
    try {
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      return webServer && typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : ''
    } catch {
      return ''
    }
  }

  // 接口权限点登记表：每个路由必须在这里显式登记「允许谁 + 对什么 + 做什么」。
  // 新增路由不登记 → 直接 404（默认拒绝），这是 C-05「新增资源先登记权限点」的落地点；
  // read 与 admin-write 分开登记、鉴权策略不同，对应 C-06 管理/业务接口分离。
  const API_PERMISSIONS = Object.freeze({
    '/dsh-heartprint/api/state': Object.freeze({
      kind: 'read',
      methods: Object.freeze(['GET']),
      auth: 'local-same-origin',
    }),
    '/dsh-heartprint/api/policy': Object.freeze({
      kind: 'admin-write',
      methods: Object.freeze(['POST']),
      auth: 'local-same-origin+json+rate-limit',
    }),
    '/dsh-heartprint/api/consent': Object.freeze({
      kind: 'consent-write',
      methods: Object.freeze(['POST']),
      auth: 'local-same-origin+json+rate-limit',
    }),
  })

  // 安全审计事件（H-01）：授权失败、限流、配置变更都留痕，
  // 写入宿主日志并在内存里保留最近 100 条，供 status 汇总。
  const auditEvents = []
  function audit(event, detail = {}) {
    const record = { at: Date.now(), event, ...detail }
    auditEvents.push(record)
    if (auditEvents.length > 100) auditEvents.shift()
    try {
      log.warn?.(`[heartprint][audit] ${JSON.stringify(record)}`)
    } catch {
      // 日志不可用时不影响主流程。
    }
  }

  function deny(res, status, payload, headers, req, reason) {
    audit('api-denied', { path: String(req?.url || ''), status, reason })
    return sendJson(res, status, payload, headers)
  }

  async function handleSettingsApi(req, res, originOf) {
    try {
      const origin = typeof originOf === 'function' ? originOf() : ''
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const permission = API_PERMISSIONS[url.pathname]

      // 默认拒绝：只认登记表里显式声明的路由，其余一律 404。
      if (!permission) {
        return deny(res, 404, { ok: false, error: { code: 'not-found', message: '未知接口' } }, {}, req, 'unknown-route')
      }
      const isStateRoute = permission.kind === 'read'
      const isPolicyRoute = permission.kind === 'admin-write'
      const isConsentRoute = permission.kind === 'consent-write'
      if (!permission.methods.includes(req.method)) {
        return sendJson(
          res,
          405,
          { ok: false, error: { code: 'method-not-allowed', message: `只支持 ${permission.methods.join('/')}` } },
          { allow: permission.methods.join(', ') },
        )
      }

      // 第一道（来源）：跨站请求会带 Sec-Fetch-Site，明确写出 cross-site/same-site 的直接拒绝。
      const fetchSite = String(req.headers['sec-fetch-site'] || '')
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        return deny(res, 403, { ok: false, error: { code: 'forbidden', message: '只允许本机同源请求' } }, {}, req, 'forbidden-origin')
      }
      // 第二道（来源）：Origin 必须同源；没有 Origin 时只接受回环地址。
      if (!requestAllowed(req, origin)) {
        return deny(res, 403, { ok: false, error: { code: 'forbidden', message: '只允许本机同源请求' } }, {}, req, 'forbidden-origin')
      }

      if (isStateRoute) {
        if (req.method !== 'GET') {
          return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '只支持 GET' } }, { allow: 'GET' })
        }
        try {
          await ensureReady()
        } catch (error) {
          if (error?.code === 'consent-required') {
            return sendJson(res, 200, { ok: true, consent: false, records: 0 })
          }
          throw error
        }
        const now = Date.now()
        const delivery = computeDelivery({ store: state.store, policy: state.policy, now })
        return sendJson(res, 200, {
          ok: true,
          consent: true,
          policy: publicPolicy(state.policy),
          delivery: {
            nextText: delivery.nextDeliveryText,
            durationText: delivery.durationText,
            firstAfterDays: delivery.firstAfterDays,
            intervalDays: delivery.intervalDays,
          },
          records: state.store.records.length,
        })
      }

      // 第三道（方法与类型）：只收 POST + application/json，堵掉跨站表单的简单请求。
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '只支持 POST' } }, { allow: 'POST' })
      }
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return deny(res, 415, { ok: false, error: { code: 'unsupported-media-type', message: '只接受 application/json' } }, {}, req, 'content-type')
      }
      // 第四道（限流）：写操作 60 秒内最多 20 次。
      if (!allowWrite(Date.now())) {
        return deny(res, 429, { ok: false, error: { code: 'too-many-requests', message: '操作太频繁，请稍后再试' } }, { 'retry-after': '60' }, req, 'rate-limit')
      }
      if (isConsentRoute) {
        await withLock(() => grantConsent())
        const consentNow = Date.now()
        const consentDelivery = computeDelivery({ store: state.store, policy: state.policy, now: consentNow })
        audit('consent-granted', {})
        return sendJson(res, 200, {
          ok: true,
          consent: true,
          policy: publicPolicy(state.policy),
          records: state.store.records.length,
          delivery: {
            nextText: consentDelivery.nextDeliveryText,
            durationText: consentDelivery.durationText,
            firstAfterDays: consentDelivery.firstAfterDays,
            intervalDays: consentDelivery.intervalDays,
          },
        })
      }
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return deny(res, 400, { ok: false, error: { code: 'bad-body', message: '请求体必须是 JSON 对象' } }, {}, req, 'bad-body')
      }
      const patch = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch) ? body.patch : null
      if (!patch || !Object.keys(patch).length) {
        return deny(res, 400, { ok: false, error: { code: 'bad-patch', message: 'patch 不能为空' } }, {}, req, 'bad-patch')
      }
      const result = await withLock(() => actionPolicy({ patch }))
      if (!result || result.ok !== false) {
        audit('policy-change', { keys: Object.keys(patch).sort().join(',') })
      }
      return sendJson(res, result && result.ok === false ? 400 : 200, result)
    } catch (error) {
      if (error?.code === 'consent-required') {
        return deny(res, 403, { ok: false, error: { code: 'consent-required', message: '请先在 设置 → 心印 点「开始使用」' } }, {}, req, 'consent-required')
      }
      if (error instanceof ApiError) {
        return deny(res, error.status, { ok: false, error: { code: error.code, message: error.message } }, {}, req, error.code)
      }
      return sendJson(res, 500, { ok: false, error: { code: 'internal-error', message: '服务内部错误' } })
    }
  }

  // webServer 可能晚于本插件就绪，用 ctx.inject 等它出现再注册（而不是在 apply
  // 时一次性 ctx.get，那样可能拿到 undefined 而静默跳过）。
  let settingsApiReady = false
  const registerSettingsApi = (webCtx) => {
    try {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-heartprint/api',
        handler: (req, res) => handleSettingsApi(req, res, () => {
          try {
            return webCtx.webServer.getOrigin()
          } catch {
            return ''
          }
        }),
      }))
      settingsApiReady = true
    } catch (error) {
      settingsApiReady = false
      log.warn?.(`[heartprint] 设置页 API 注册失败（其余功能不受影响）：${messageOf(error)}`)
    }
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], registerSettingsApi)
    } else {
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      if (webServer && typeof webServer.register === 'function') {
        ctx.effect(() => webServer.register({
          kind: 'prefix',
          path: '/dsh-heartprint/api',
          handler: (req, res) => handleSettingsApi(req, res, () => {
            try {
              return webServer.getOrigin()
            } catch {
              return ''
            }
          }),
        }))
        settingsApiReady = true
      }
    }
  } catch (error) {
    log.warn?.(`[heartprint] 设置页 API 注册失败（其余功能不受影响）：${messageOf(error)}`)
  }


  ctx.effect(() => {
    const timer = setInterval(() => {
      withLock(() => runMaintenanceInternal({ reason: 'timer' })).catch((error) => {
        log.warn?.(`[heartprint] 定时维护失败：${messageOf(error)}`)
      })
    }, MAINTENANCE_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  withLock(() => runMaintenanceInternal({ reason: 'startup' })).catch((error) => {
    log.warn?.(`[heartprint] 启动维护失败：${messageOf(error)}`)
  })

  return { dataDir, version: VERSION }
}
