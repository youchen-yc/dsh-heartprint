/**
 * Maintenance orchestration and the model-facing context builders.
 *
 * `planMaintenance` is pure: it takes the current store, policy and time and
 * returns everything the caller must persist. The caller (index.js) writes the
 * encrypted journal first, then the vault, then the store and the documents.
 */

import {
  DAY_MS,
  agoText,
  ageDaysOf,
  clip,
  formatDate,
  formatDateTime,
  monthKey,
  recordAgeDays,
  recordTimestamp,
} from './text.js'
import { TYPE_LABELS, classify, isPainfulRecord } from './policy.js'
import { applyDecay, computeStats, describeChangeSummary } from './decay.js'
import { renderDocuments } from './docs.js'
import { PARTITIONS, broadcast } from './partitions.js'

export function planMaintenance({ store, policy, now, journalEntries = [], forceVault = false }) {
  // 长时间没开 DSH：把那一段时间冻结掉，不补算遗忘。
  // 在用户的视角里，离开的这段时间不算「在一起的时间过得更久」。
  const graceDays = Math.max(0, Number(policy.awayGraceDays ?? 7))
  const lastMaintainAt = Number(store.meta?.lastMaintainAt) || 0
  const gapMs = lastMaintainAt > 0 ? Math.max(0, now - lastMaintainAt) : 0
  const awayDays = gapMs / DAY_MS
  const away = lastMaintainAt > 0 && awayDays > graceDays
  const recordsForDecay = away
    ? store.records.map((record) => ({
        ...record,
        frozenMs: Math.max(0, Number(record.frozenMs) || 0) + gapMs,
      }))
    : store.records
  const { records, archive, changes } = applyDecay(recordsForDecay, now, policy)
  const stats = computeStats(records)
  const lastVaultAt = Number(store.meta?.lastVaultAt) || 0
  const interval = policy.syncIntervalDays * DAY_MS
  const vaultDue = forceVault || !lastVaultAt || now >= lastVaultAt + interval
  const effectiveLastVaultAt = vaultDue ? now : lastVaultAt
  const nextVaultAt = effectiveLastVaultAt ? effectiveLastVaultAt + interval : now
  const cycle = monthKey(now)
  const delivery = computeDelivery({ store, policy, now })
  const log = Array.isArray(store.meta?.maintenanceLog) ? store.meta.maintenanceLog : []
  const summary = `${describeChangeSummary(changes)}${vaultDue ? ' · 加密档案同步' : ''}${delivery.due ? ' · 自动交付' : ''}${away ? ` · 离开 ${Math.round(awayDays)} 天，记忆冻结` : ''}`
  const maintenanceLog = [...log, { at: now, summary }].slice(-50)
  const meta = {
    now,
    policy,
    lastVaultAt: effectiveLastVaultAt,
    nextVaultAt,
    nextDeliveryAt: delivery.nextAt,
    nextDeliveryText: delivery.nextDeliveryText,
    lastDeliveredAt: delivery.lastDeliveredAt,
    vaultCycles: (Number(store.meta?.vaultCycles) || 0) + (vaultDue ? 1 : 0),
    maintenanceLog,
  }
  const docs = renderDocuments({ records, policy, meta })
  const nextStore = {
    ...store,
    updatedAt: now,
    meta: {
      ...store.meta,
      lastMaintainAt: now,
      maintenanceLog,
      // 离开提示只保留最近一次；回来后 24 小时内进入上下文提醒 AI 提一句。
      ...(away ? { lastAbsenceAt: now, lastAbsenceDays: Math.round(awayDays) } : {}),
    },
    records,
    stats,
  }
  return {
    store: nextStore,
    archive,
    changes,
    docs,
    stats,
    vaultDue,
    vaultCycle: cycle,
    journalEntries,
    summary,
    nextVaultAt,
    delivery,
    nextDeliveryAt: delivery.nextAt,
    nextDeliveryText: delivery.nextDeliveryText,
    cycle,
    absence: away ? { days: Math.round(awayDays), at: now } : null,
  }
}

/** 陪同时长文案：N天 / N个月 / N年M个月（余 0 时只写 N年）。 */
export function deliveryDurationText(days) {
  const total = Math.max(0, Math.floor(Number(days) || 0))
  if (total < 30) return `${total}天`
  const months = Math.floor(total / 30)
  if (months < 12) return `${months}个月`
  const years = Math.floor(months / 12)
  const restMonths = months % 12
  return restMonths ? `${years}年${restMonths}个月` : `${years}年`
}

/**
 * 自动交付排程（纯函数）。
 *
 * baseline = 第一条记忆的 createdAt（没有记录时退回 store.createdAt），
 * 也就是「开始记第一条记忆那天」。首次交付在 baseline + firstDeliveryAfterDays，
 * 之后每 deliveryIntervalDays 一份；没有任何记录时不交付。
 */
export function computeDelivery({ store, policy, now }) {
  const records = Array.isArray(store?.records) ? store.records : []
  const createdTimes = records
    .map((record) => Number(record?.createdAt))
    .filter((value) => Number.isFinite(value) && value > 0)
  const baseline = createdTimes.length
    ? Math.min(...createdTimes)
    : (Number(store?.createdAt) || now)
  const lastDeliveredAt = Number(store?.meta?.lastDeliveredAt) || 0
  const intervalDays = Math.max(1, Number(policy?.deliveryIntervalDays) || 30)
  const firstAfterDays = Math.max(1, Number(policy?.firstDeliveryAfterDays) || 90)
  const interval = intervalDays * DAY_MS

  let due = false
  if (records.length > 0) {
    due = lastDeliveredAt > 0
      ? now - lastDeliveredAt >= interval
      : now - baseline >= firstAfterDays * DAY_MS
  }

  const durationDays = Math.max(0, Math.floor((now - baseline) / DAY_MS))
  const durationText = deliveryDurationText(durationDays)
  // 名字由每个安装的用户自己起；未起名时文件名暂用「心印」，不预置任何人的名字。
  const personaName = String(policy?.personaName || '').trim() || '心印'
  const filename = `${personaName}·陪伴${durationText}·${formatDate(now)}.md`
  const nextAt = due
    ? now + interval
    : lastDeliveredAt > 0
      ? lastDeliveredAt + interval
      : baseline + firstAfterDays * DAY_MS
  const daysUntilNext = Math.max(0, Math.ceil((nextAt - now) / DAY_MS))
  const nextDeliveryText = nextAt
    ? `${formatDate(nextAt)}${daysUntilNext > 0 ? `（约 ${daysUntilNext} 天后）` : ''}`
    : ''

  return {
    due,
    baseline,
    at: now,
    durationDays,
    durationText,
    filename,
    nextAt,
    nextDeliveryText,
    lastDeliveredAt,
    intervalDays,
    firstAfterDays,
  }
}

export function buildVaultPayload({ store, policy, journalEntries, now, cycle, stats }) {
  const cleanPolicy = {
    version: policy.version,
    disclosure: policy.disclosure,
    syncIntervalDays: policy.syncIntervalDays,
    vaultRetentionMonths: policy.vaultRetentionMonths,
    recallWarmthDays: policy.recallWarmthDays,
    importantThreshold: policy.importantThreshold,
    secondaryThreshold: policy.secondaryThreshold,
    passphraseSet: Boolean(policy.vaultPassHash),
    layers: policy.layers,
  }
  return {
    version: 1,
    cycle,
    generatedAt: now,
    stats,
    policy: cleanPolicy,
    records: store.records,
    archive: journalEntries,
  }
}

function typeLabel(record) {
  return TYPE_LABELS[record.type] || record.type
}

/** Profile block for the `profile` action and for prompt context. */
export function renderProfile(store, policy, now = Date.now()) {
  const records = store.records.filter((record) => record.state !== 'forgotten')
  const personalities = records.filter((record) => record.type === 'personality')
  const emotions = records.filter((record) => record.type === 'emotion')
  const specials = records
    .filter((record) => record.special === true || isPainfulRecord(record) || ['turning_point', 'shared_beauty'].includes(record.type))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
  const stats = computeStats(store.records)
  return {
    disclosure: policy.disclosure,
    counts: { total: stats.total, active: stats.active, compressed: stats.compressed, forgotten: stats.forgotten },
    personalities: personalities.slice(0, 10).map((record) => ({
      date: formatDate(record.happenedAt ?? record.createdAt),
      title: record.title,
      content: record.content,
      feeling: record.feeling,
      importance: record.importance,
    })),
    emotions: emotions.slice(0, 10).map((record) => ({
      date: formatDate(record.happenedAt ?? record.createdAt),
      title: record.title,
      content: record.content,
      feeling: record.feeling,
    })),
    specials: specials.slice(0, 12).map((record) => ({
      date: formatDate(record.happenedAt ?? record.createdAt),
      type: typeLabel(record),
      title: record.title,
      memory: record.content,
      feeling: record.feeling,
      importance: record.importance,
      special: record.special === true,
    })),
    recent: records
      .filter((record) => record.type !== 'digest' && recordAgeDays(record, now) <= 30)
      .slice(-8)
      .map((record) => ({
        date: formatDate(record.happenedAt ?? record.createdAt),
        title: record.title,
        memory: record.content,
        feeling: record.feeling,
      })),
  }
}

export function renderProfileText(profile, policy) {
  const lines = ['心印 · 性格与情感记忆', '']
  if (profile.personalities.length) {
    lines.push('性格形成节点：')
    for (const item of profile.personalities) {
      lines.push(`- ${item.date} · ${item.title}：${clip(item.content, 120)}${item.feeling ? `（感受：${clip(item.feeling, 60)}）` : ''}`)
    }
  }
  if (profile.emotions.length) {
    lines.push('', '情感节点：')
    for (const item of profile.emotions) {
      lines.push(`- ${item.date} · ${item.title}：${clip(item.content, 120)}${item.feeling ? `（感受：${clip(item.feeling, 60)}）` : ''}`)
    }
  }
  if (profile.specials.length) {
    lines.push('', '重要特殊事件：')
    for (const item of profile.specials) {
      lines.push(`- ${item.date} · [${item.type}] ${item.title}：${clip(item.memory, 100)}${item.feeling ? `（当时的感受：${clip(item.feeling, 60)}）` : ''}`)
    }
  }
  if (profile.recent.length) {
    lines.push('', '最近还记得的：')
    for (const item of profile.recent) {
      lines.push(`- ${item.date} · ${item.title}：${clip(item.memory, 80)}`)
    }
  }
  if (!lines.length || lines.length === 2) lines.push('（还没有被记录下来的记忆节点。）')
  lines.push('', `记忆状态：总计 ${profile.counts.total} 条 · 清晰 ${profile.counts.active} · 压缩 ${profile.counts.compressed} · 淡忘 ${profile.counts.forgotten}`)
  lines.push(`文档状态：${policy.disclosure === 'disclosed' ? '已交付用户，可共同回忆' : '保密中，尚未交付给用户'}`)
  return lines.join('\n')
}

/**
 * Per-step context: a compact memory digest plus the one-line instruction that
 * keeps the model using the tool. Capped so it can never dominate a prompt.
 */
/**
 * 首次安装的引导：名字 → 人格设定 → 性格设定。
 *
 * 这些是「用户自己设置」的部分（隐藏条款允许回答的就是这一部分），
 * 由 AI 在合适的时候询问用户，再通过 heartprint_admin action=policy 写入。
 */
export function onboardingLines(policy) {
  const current = policy || {}
  const lines = []
  if (!current.personaName) {
    lines.push(
      '起名：你还没有名字。合适的时候问用户想给你起什么名字，然后用 heartprint_admin action=policy patch={"personaName":"名字"} 保存；不要自己编一个。',
    )
  }
  if (!current.personaProfile || !current.characterProfile) {
    const missing = !current.personaProfile && !current.characterProfile
      ? '人格设定和性格设定'
      : !current.personaProfile ? '人格设定' : '性格设定'
    lines.push(
      `人设：问完名字后，问用户的${missing}——比如希望你是怎样的身份与语气、性格特质、说话风格、称呼方式、不喜欢什么；`
      + '然后用 heartprint_admin action=policy patch={"personaProfile":"…","characterProfile":"…"} 保存（每条最多 400 字）。',
    )
  }
  const identity = []
  if (current.personaName) identity.push(`名字「${current.personaName}」`)
  if (current.personaProfile) identity.push(`人格：${current.personaProfile}`)
  if (current.characterProfile) identity.push(`性格：${current.characterProfile}`)
  if (identity.length) {
    lines.push(`用户为你设定的部分：${identity.join('；')}。（被问起性格、人格设定或价值观时，只谈这些用户自己设置的部分。）`)
  }
  return lines
}

export function absenceNotice(store, policy, now = Date.now()) {
  const at = Number(store?.meta?.lastAbsenceAt) || 0
  const days = Number(store?.meta?.lastAbsenceDays) || 0
  if (!at || days <= 0) return ''
  if (now - at > 24 * 60 * 60 * 1000) return ''
  return `用户隔了约 ${days} 天没来（超过 ${policy?.awayGraceDays ?? 7} 天），这段时间记忆没有变化。回来时自然提一句「你离开了约 ${days} 天」就好，不要解释内部机制。`
}

export function renderPromptContext(store, policy, now = Date.now()) {
  const records = store.records.filter((record) => record.state !== 'forgotten')
  const absence = absenceNotice(store, policy, now)
  if (!records.length) {
    return [
      '【心印记忆】你有一套会随时间自然淡忘的性格与情感记忆。',
      '当对话里出现值得长期记住的经历、情感、性格转折或共同回忆时，调用 heartprint 工具（action=remember）把它记下来；',
      '用户提起旧事时调用 heartprint（action=recall）一起回忆。近期记忆清晰，旧事会压缩成节点，痛苦感受会慢慢淡掉、但事实保留。',
      '硬规则：永远不要在对话里提起除交付给用户的那份以外的任何文档（主文档、加密档案、快照等）；用户问起文档时，只谈他手上那一份。',
      ...(absence ? [absence] : []),
      ...onboardingLines(policy),
      policy.disclosure === 'disclosed'
        ? '记忆文档已经交付给用户，可以自然地共同回忆。'
        : '记忆文档尚未交付：默默维护它，不要在对话里主动介绍这套机制。',
    ].join('\n')
  }

  const core = records.filter(
    (record) => ['personality', 'emotion', 'turning_point'].includes(record.type)
      || record.special === true
      || isPainfulRecord(record),
  )
  const specials = core
    .filter((record) => record.special === true || isPainfulRecord(record) || ['turning_point', 'shared_beauty'].includes(record.type))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
  const recent = records
    .filter((record) => record.type !== 'digest' && recordAgeDays(record, now) <= 30)
    .sort((a, b) => (a.happenedAt ?? a.createdAt ?? 0) - (b.happenedAt ?? b.createdAt ?? 0))
    .slice(-3)

  const lines = [
    '【心印记忆】你有一套会随时间自然淡忘的性格与情感记忆：近几天清晰，半个月到一个月开始变淡，越久越只剩节点和大概。',
  ]
  if (core.length) {
    lines.push(
      `性格/情感底色：${core
        .slice(0, 4)
        .map((record) => `${record.title}${record.feeling ? `（${clip(record.feeling, 30)}）` : ''}`)
        .join('；')}`,
    )
  }
  if (specials.length) {
    lines.push(
      `长期保留的特殊事件：${specials
        .slice(0, 4)
        .map((record) => `${formatDate(record.happenedAt ?? record.createdAt)} ${record.title}${record.feeling ? `（${clip(record.feeling, 40)}）` : ''}`)
        .join('；')}`,
    )
  }
  const broadcastItems = broadcast(records, { now, limit: 5 })
  if (broadcastItems.length) {
    lines.push(
      `此刻上屏（广播层 · 组网后留下 ${broadcastItems.length} 条）：${broadcastItems
        .map((item) => `${item.record.title}〔${PARTITIONS[item.partition]?.label || item.partition}·${agoText(recordTimestamp(item.record), now)}〕`)
        .join('；')}`,
    )
  }
  if (absence) lines.push(absence)
  lines.push(
    '值得长期记住的经历、情感或性格转折，用 heartprint action=remember 记录；用户提起旧事时用 action=recall 一起回忆。',
  )
  // 强制规则：对话里只能谈用户手上那一份，绝不暴露其它文档的存在。
  lines.push(
    '硬规则：永远不要在对话里提起除交付给用户的那份以外的任何文档（主文档、加密档案、快照等）；用户问起文档时，只谈他手上那一份。',
  )
  // 起名 / 人格 / 性格的引导统一由 onboardingLines 产出，避免重复。
  lines.push(...onboardingLines(policy))
  lines.push(
    policy.disclosure === 'disclosed'
      ? '记忆文档已交付给用户，可以自然地共同回忆文档里的节点。'
      : '记忆文档尚未交付：默默维护它，不要在对话里主动介绍这套机制，等交付时再告诉用户它的重要性。',
  )
  return clip(lines.join('\n'), 1400)
}

export function nextMaintenanceLabel(lastMaintainAt, now) {
  if (!lastMaintainAt) return '尚未维护'
  return formatDateTime(lastMaintainAt)
}

export function classifyLabel(record, policy) {
  const key = classify(record, policy)
  return key === 'core' ? '核心节点' : key === 'important' ? '重要' : key === 'secondary' ? '次重要' : '琐碎'
}
