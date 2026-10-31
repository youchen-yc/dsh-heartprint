/**
 * 心印 · P0/P1 修复后的回归测试。
 *
 * 这个文件只覆盖“现有测试没覆盖、且曾经出过缺陷”的场景，按修复后的目标行为断言：
 *
 *   1. Windows Hidden 属性不再让第二次加密快照写入失败（同 cycle 覆盖写 + 换 cycle）。
 *   2. 加密日志（归档）写失败时中止整轮维护，绝不把正文清成空墓碑后再落盘。
 *   3. memories.json 损坏时先备份为 memories.json.corrupt-*，保存时保留 memories.json.bak。
 *   4. 90-180 天只合并/压缩，180 天之后才删除琐碎文本。
 *   5. valence='painful' 的事件和 type='pain' 一样强制淡忘感受，正文保留。
 *   6. deliver 之后新增记忆并维护，交付到用户手里的那份文档与内部用户副本保持同步。
 *
 * 全部用例使用临时目录，结束时清理；不读写插件的默认数据目录。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { apply } from '../index.js'
import { onboardingLines, planMaintenance, renderPromptContext } from '../lib/engine.js'
import { createStore } from '../lib/store.js'
import { vaultStats } from '../lib/vault.js'
import { DEFAULT_POLICY, FEELING_STAGES, resolvePolicy } from '../lib/policy.js'
import { applyDecay, renderRecall, searchMemories } from '../lib/decay.js'
import { renderDocuments } from '../lib/docs.js'

const DAY_MS = 86_400_000
const NOW = Date.parse('2026-10-27T04:00:00+08:00')
const execFileAsync = promisify(execFile)

/** 默认遗忘日历（修复后的分层动作链）。 */
const policy = resolvePolicy(DEFAULT_POLICY)

function record(overrides = {}) {
  return {
    id: overrides.id || `mem-${Math.random().toString(36).slice(2, 8)}`,
    type: 'event',
    title: '一段记忆',
    content: '这件事发生了。它有一些细节。最后还有一个尾声。',
    feeling: '当时心里很暖，也很郑重。',
    valence: 'warm',
    importance: 50,
    special: false,
    people: [],
    tags: [],
    happenedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    detailLevel: 2,
    feelingStage: 'full',
    state: 'active',
    layer: 'fresh',
    lastDecayAt: 0,
    lastRecalledAt: 0,
    recallCount: 0,
    source: 'manual',
    ...overrides,
  }
}

function aged(days, overrides = {}) {
  const at = NOW - days * DAY_MS
  return record({
    id: `mem-${days}-${Math.random().toString(36).slice(2, 6)}`,
    happenedAt: at,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  })
}

/** 建临时目录跑 body，结束时必定递归清理（Windows 的 Hidden 属性不影响删除）。 */
async function withTempDir(prefix, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 直接调 attrib 设置/清除 Windows Hidden 属性。 */
async function setWindowsHidden(target, hidden) {
  await execFileAsync('attrib', [hidden ? '+h' : '-h', target], { windowsHide: true })
}

function createContext() {
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(callback) {
      const cleanup = callback()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    get() {
      return undefined
    },
    on() {
      return () => {}
    },
  }
  return { ctx, tools }
}

async function call(tools, name, args) {
  const definition = tools.get(name)
  assert.ok(definition, `工具 ${name} 应该已经注册`)
  return definition.execute(args, { signal: new AbortController().signal, agent: { id: 'regression-test' } })
}

/** 从记忆文档 footer 里取出正文哈希，用来判断两份文档是否同源。 */
function bodyHashOf(text) {
  const match = /heartprint:body=([0-9a-f]+)/.exec(text || '')
  return match ? match[1] : null
}

// ---------------------------------------------------------------------------
// 用例 1：加密快照连写（P0-1 Windows Hidden 属性导致第二次写入 EPERM）
// ---------------------------------------------------------------------------

test('加密快照可以连续写：同 cycle 覆盖写与换 cycle 各一次都成功', async (t) => {
  await withTempDir('heartprint-reg-snapshot-', async (dir) => {
    const store = createStore({ dataDir: dir })
    const cycleA = '2026-10'
    const cycleB = '2026-11'

    const first = await store.foldJournalIntoVault({
      cycle: cycleA,
      payload: { cycle: cycleA, revision: 1 },
      retentionMonths: 24,
    })
    assert.ok(first.index.snapshots.some((item) => item.cycle === cycleA))

    if (process.platform === 'win32') {
      // 还原旧版本留下的现场：.vault 里的单个文件被 attrib +h 标成 Hidden，
      // Node 对带 Hidden 属性的既有文件 writeFile 会 EPERM。
      await setWindowsHidden(path.join(store.paths.vaultDir, `vault-${cycleA}.enc`), true)
      await setWindowsHidden(path.join(store.paths.vaultDir, 'vault-index.json'), true)
    } else {
      t.diagnostic('非 win32 平台：跳过 Hidden 属性子用例（文件隐藏只在 Windows 上生效）')
    }

    // 同 cycle 覆盖写：应当成功，且 index 里该 cycle 只留一条。
    const overwrite = await store.foldJournalIntoVault({
      cycle: cycleA,
      payload: { cycle: cycleA, revision: 2 },
      retentionMonths: 24,
    })
    assert.equal(overwrite.index.snapshots.filter((item) => item.cycle === cycleA).length, 1)

    // 换 cycle 再写一次：应当成功，快照数量变成 2。
    const second = await store.foldJournalIntoVault({
      cycle: cycleB,
      payload: { cycle: cycleB, revision: 3 },
      retentionMonths: 24,
    })
    assert.ok(second.index.snapshots.some((item) => item.cycle === cycleB))

    const stats = await vaultStats(store.paths.vaultDir)
    assert.equal(stats.snapshots.length, 2, '两个 cycle 应各留一个快照')
    assert.deepEqual(stats.snapshots.map((item) => item.cycle), [cycleA, cycleB])
    assert.equal(stats.latest.cycle, cycleB)

    // 加密快照必须能用仓库密钥解密读回。
    assert.deepEqual(await store.readLatestVaultSnapshot(cycleA), { cycle: cycleA, revision: 2 })
    assert.deepEqual(await store.readLatestVaultSnapshot(cycleB), { cycle: cycleB, revision: 3 })
  })
})

test('通过工具连续两次强制同步第三份文档都不产生写入失败告警', async () => {
  await withTempDir('heartprint-reg-snapshot-tool-', async (dir) => {
    const { ctx, tools } = createContext()
    apply(ctx, { dataDir: dir })

    const remembered = await call(tools, 'heartprint', {
      action: 'remember',
      title: '加密档案连写测试',
      content: '这条记忆用来触发一次加密档案同步。',
      type: 'event',
      importance: 60,
    })
    assert.equal(remembered.ok, true)

    const first = await call(tools, 'heartprint_admin', { action: 'maintain', sync: true })
    assert.equal(first.ok, true)
    assert.equal(first.vaultWritten, true)
    assert.deepEqual(first.warnings, [], '第一次强制同步不应有告警')

    const second = await call(tools, 'heartprint_admin', { action: 'maintain', sync: true })
    assert.equal(second.ok, true)
    assert.equal(second.vaultWritten, true)
    assert.deepEqual(second.warnings, [], '第二次强制同步（同 cycle 覆盖写）不应有告警')

    const status = await call(tools, 'heartprint', { action: 'status' })
    assert.equal(status.ok, true)
    assert.equal(status.vault.snapshots, 1, '同一个月的两次同步只应留下一个加密快照')
  })
})

// ---------------------------------------------------------------------------
// 用例 2：归档写失败即中止（P0-2 归档失败仍继续物理遗忘 → 原文丢失）
// ---------------------------------------------------------------------------

test('加密日志写入失败时中止维护：返回失败，且被压缩记录的正文仍完整保留', async () => {
  await withTempDir('heartprint-reg-archive-', async (dir) => {
    const now = Date.now()
    const originalContent = '这是压缩前的正文，维护失败时一个字都不能少。'
    const target = record({
      id: 'mem-archive-fail',
      title: '二十天前的一段事',
      content: originalContent,
      feeling: '当时有点感慨。',
      importance: 60,
      happenedAt: now - 20 * DAY_MS,
      createdAt: now - 20 * DAY_MS,
      updatedAt: now - 20 * DAY_MS,
    })

    // 造一个“归档必定失败”的现场：把 journal.enc 做成目录，appendFile 会 EISDIR。
    await mkdir(path.join(dir, '.vault', 'journal.enc'), { recursive: true })
    await writeFile(
      path.join(dir, 'memories.json'),
      `${JSON.stringify(
        {
          version: 1,
          createdAt: now,
          updatedAt: now,
          meta: {
            lastMaintainAt: 0,
            lastVaultAt: 0,
            lastDeliveredAt: 0,
            deliveredPath: '',
            maintenanceLog: [],
            vaultCycles: 0,
          },
          records: [target],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const { ctx, tools } = createContext()
    apply(ctx, { dataDir: dir })

    const maintained = await call(tools, 'heartprint_admin', { action: 'maintain' })
    assert.equal(maintained.ok, false, '归档失败时维护必须返回失败，而不是静默成功')
    assert.ok(maintained.error && maintained.error.message, '失败时必须带明确原因')

    // 正文还在：没有被压缩成空墓碑。
    const persisted = JSON.parse(await readFile(path.join(dir, 'memories.json'), 'utf8'))
    const kept = persisted.records.find((item) => item.id === target.id)
    assert.ok(kept, '失败时不能丢掉这条记录')
    assert.equal(kept.content, originalContent, '归档失败时正文必须原样保留')
    assert.notEqual(kept.state, 'forgotten', '归档失败时不能物理遗忘')

    // 中止发生在写文档之前：docs 目录里不应出现任何文档。
    const docFiles = await readdir(path.join(dir, 'docs')).catch(() => [])
    assert.deepEqual(docFiles, [], '维护中止后不应写出记忆文档')
  })
})

// ---------------------------------------------------------------------------
// 用例 3：memories.json 损坏（P0-3 损坏库被静默当空库覆盖）
// ---------------------------------------------------------------------------

test('memories.json 损坏时备份为 .corrupt-* 且能继续加载，保存时留下 .bak', async () => {
  await withTempDir('heartprint-reg-corrupt-', async (dir) => {
    const corruptText = '{"version":1,"records":[{"id":"mem-1","title":"截断的'
    await writeFile(path.join(dir, 'memories.json'), corruptText, 'utf8')

    const store = createStore({ dataDir: dir })
    const loaded = await store.load()
    assert.ok(loaded.store, '损坏的库不能让 load 抛错')
    assert.deepEqual(loaded.store.records, [], '损坏内容不应被当成有效记录')

    // 损坏的原始内容必须留档，一个字都不能丢。
    const names = await readdir(dir)
    const corruptCopies = names.filter((name) => name.startsWith('memories.json.corrupt-'))
    assert.equal(corruptCopies.length, 1, '应生成且仅生成一个 memories.json.corrupt-* 备份')
    assert.equal(await readFile(path.join(dir, corruptCopies[0]), 'utf8'), corruptText)

    // 保存时保留上一版：第一次保存还没有“上一版”，第二次保存后应有 memories.json.bak。
    await store.saveStore(loaded.store)
    await store.saveStore(loaded.store)
    const afterSaves = await readdir(dir)
    assert.ok(afterSaves.includes('memories.json.bak'), '保存后应存在 memories.json.bak')

    const backup = JSON.parse(await readFile(path.join(dir, 'memories.json.bak'), 'utf8'))
    assert.ok(Array.isArray(backup.records), '.bak 应是一份可解析的完整记忆库')

    const reread = await store.load()
    assert.ok(reread.store)
    assert.ok(Array.isArray(reread.store.records))
  })
})

// ---------------------------------------------------------------------------
// 用例 4：分层动作链（P1-4 的 90-180 天物理淡忘 → 按初稿精确对齐：
//   90-180 天 keep 压梗概；180-365 天 merge 季度摘要；365 天以上 delete 墓碑）
// ---------------------------------------------------------------------------

test('分层动作链：90-180 天压成梗概、180-365 天合并、365 天以上删除墓碑', () => {
  const title = '去楼下便利店买牛奶'
  const content = '顺手买了一盒牛奶。后面还有一段很长的细节，压成梗概时会被裁掉。'

  // 第一段 120 天：keep + detail 0，只压成一句梗概，仍能 recall。
  const item120 = aged(120, { importance: 10, title, content })
  const stage120 = applyDecay([item120], NOW, policy)
  assert.equal(stage120.changes.merged, 0, '120 天不应合并')
  assert.equal(stage120.changes.forgotten, 0, '120 天不应淡忘')
  const kept120 = stage120.records.find((item) => item.id === item120.id)
  assert.ok(kept120, '120 天的琐事应保留为梗概')
  assert.equal(kept120.state, 'compressed')
  assert.equal(kept120.detailLevel, 0)
  assert.ok(kept120.content.length > 0, '梗概正文必须非空')
  assert.equal(stage120.records.some((item) => item.type === 'digest'), false, '120 天不应出现季度摘要')
  const found120 = searchMemories(stage120.records, title, NOW, policy)
  assert.ok(found120.length >= 1, '120 天的记忆仍应能 recall 到')
  const recall120 = renderRecall(found120[0], NOW, policy)
  assert.notEqual(recall120.state, 'forgotten', 'recall 到的不能是空墓碑')
  assert.ok(recall120.text.length > 0, 'recall 应能带回梗概')

  // 第二段 200 天：merge 成季度摘要，原记录不再单独存在。
  const item200 = aged(200, { importance: 10, title, content })
  const stage200 = applyDecay([item200], NOW, policy)
  assert.ok(stage200.changes.merged >= 1, '200 天应合并')
  const digest200 = stage200.records.find((item) => item.type === 'digest')
  assert.ok(digest200, '200 天应出现季度摘要')
  assert.equal(stage200.records.some((item) => item.id === item200.id), false, '合并后原记录不应再单独存在')

  // 第三段 400 天：delete → 空墓碑。
  const item400 = aged(400, { importance: 10, title, content })
  const stage400 = applyDecay([item400], NOW, policy)
  assert.ok(stage400.changes.deleted >= 1, '400 天应删除琐碎文本')
  const tombstone = stage400.records.find((item) => item.title === title)
  assert.ok(tombstone, '400 天的琐事应留下墓碑')
  assert.equal(tombstone.state, 'forgotten')
  assert.equal(tombstone.content, '')
  assert.equal(tombstone.feeling, '')
})

// ---------------------------------------------------------------------------
// 用例 5：痛苦感受（P1-5 只有 type='pain' 强制淡忘，valence='painful' 永不淡忘）
// ---------------------------------------------------------------------------

test('valence=painful 的 event 400 天后感受已淡忘，但正文仍在', () => {
  const painfulEvent = aged(400, {
    type: 'event',
    valence: 'painful',
    importance: 90,
    special: true,
    title: '一次告别',
    content: '车站那天下了雨，我们最后没有说再见。',
    feeling: '当时难受到说不出话。',
  })
  const { records } = applyDecay([painfulEvent], NOW, policy)
  const next = records.find((item) => item.id === painfulEvent.id)
  assert.ok(next, '痛苦记忆的事实不应被删除')
  assert.ok(next.content.length > 0, '痛苦记忆的正文应当保留')

  const stageRank = FEELING_STAGES.indexOf(next.feelingStage)
  assert.ok(stageRank > FEELING_STAGES.indexOf('full'), `400 天后感受应已淡忘，实际为 ${next.feelingStage}`)
  assert.match(next.feeling, /痛|难受|淡/, '痛苦感受应换成淡忘后的措辞')
})

// ---------------------------------------------------------------------------
// 用例 6：交付副本同步（P1-6 deliver 后用户副本不再更新）
// ---------------------------------------------------------------------------

test('deliver 后新增记忆并维护，交付出去的文档与内部用户副本保持同步', async () => {
  await withTempDir('heartprint-reg-deliver-', async (dir) => {
    const { ctx, tools } = createContext()
    apply(ctx, { dataDir: dir })

    const first = await call(tools, 'heartprint', {
      action: 'remember',
      title: '交付前的记忆',
      content: '交付之前发生的事，先写进文档里。',
      type: 'emotion',
      importance: 80,
    })
    assert.equal(first.ok, true)

    const delivered = await call(tools, 'heartprint_admin', {
      action: 'deliver',
      path: path.join(dir, '交付', '心印·记忆文档（用户副本）.md'),
    })
    assert.equal(delivered.ok, true)
    assert.equal(delivered.disclosure, 'disclosed')

    // 交付之后又记下新的事情，并手动维护一次。
    const second = await call(tools, 'heartprint', {
      action: 'remember',
      title: '交付后的新记忆',
      content: '交付之后又发生了一件事，用户手里的副本也该同步更新。',
      type: 'event',
      importance: 75,
    })
    assert.equal(second.ok, true)
    const maintained = await call(tools, 'heartprint_admin', { action: 'maintain' })
    assert.equal(maintained.ok, true)

    // meta.deliveredPath 指向交付路径。
    const stored = JSON.parse(await readFile(path.join(dir, 'memories.json'), 'utf8'))
    assert.equal(stored.meta.deliveredPath, path.resolve(delivered.path))

    const deliveredText = await readFile(stored.meta.deliveredPath, 'utf8')
    const internalUser = await call(tools, 'heartprint_admin', { action: 'doc', which: 'user', full: true })
    assert.equal(internalUser.ok, true)
    const userDiskText = await readFile(internalUser.path, 'utf8')

    // 三条硬证据：正文哈希一致、逐字一致、新记忆已经出现在交付副本里。
    assert.equal(bodyHashOf(deliveredText), bodyHashOf(internalUser.content))
    assert.equal(deliveredText, userDiskText, '交付副本应与内部用户副本逐字一致')
    assert.match(deliveredText, /交付后的新记忆/, '交付副本应随后续维护更新')
  })
})

// ===========================================================================
// 自动交付（task-8）：首交 90 天、周期 30 天、命名与目录、policy 可调。
// ===========================================================================

/**
 * 与 createContext 相同，但给插件一个临时“工作区”：
 * 默认交付目录 <工作区>/心印交付 会落进临时目录，不会污染项目目录。
 */
function createWorkspaceContext(workspaceDir) {
  const { ctx, tools } = createContext()
  ctx.get = (key) => (key === 'workingDirectory' ? { defaultDirectory: workspaceDir } : undefined)
  return { ctx, tools }
}

/** 手工写一份 memories.json（用来构造任意“年龄”的记忆，避免真的等几个月）。 */
async function seedStore(dataDir, records, meta = {}) {
  const now = Date.now()
  const store = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    meta: {
      lastMaintainAt: 0,
      lastVaultAt: 0,
      lastDeliveredAt: 0,
      deliveredPath: '',
      maintenanceLog: [],
      vaultCycles: 0,
      deliveries: [],
      ...meta,
    },
    records,
  }
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'memories.json'), `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  return store
}

async function seedPolicy(dataDir, patch) {
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'policy.json'), `${JSON.stringify({ version: 1, ...patch }, null, 2)}\n`, 'utf8')
}

/** 以“真实现在”为基准往前推 days 天，避免固定 NOW 让边界用例随日期漂移。 */
function recordAgedDays(days, overrides = {}) {
  const at = Date.now() - days * DAY_MS
  return record({
    id: `mem-auto-${days}-${Math.random().toString(36).slice(2, 8)}`,
    happenedAt: at,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  })
}

/** 列出交付目录里的 .md 文件（目录不存在时返回空数组）。 */
async function listDelivered(deliveryDir) {
  const names = await readdir(deliveryDir).catch(() => [])
  return names.filter((name) => name.endsWith('.md'))
}

test('自动交付 1：没有记忆记录时不交付', async () => {
  await withTempDir('heartprint-reg-auto-empty-', async (dir) => {
    const workspaceDir = path.join(dir, 'ws')
    await mkdir(workspaceDir, { recursive: true })
    const dataDir = path.join(dir, 'data')
    const { ctx, tools } = createWorkspaceContext(workspaceDir)
    apply(ctx, { dataDir })

    const maintained = await call(tools, 'heartprint_admin', { action: 'maintain' })
    assert.equal(maintained.ok, true)
    assert.deepEqual(await listDelivered(path.join(workspaceDir, '心印交付')), [], '空记忆库不应交付')

    const status = await call(tools, 'heartprint', { action: 'status' })
    assert.equal(status.disclosure, 'confidential')
    // 名字由每个安装的用户自己起，默认留空（不预置任何人的名字）。
    assert.equal(status.policy.personaName, '')
    assert.equal(status.policy.firstDeliveryAfterDays, 90)
    assert.equal(status.policy.deliveryIntervalDays, 30)
    assert.equal(status.policy.deliveryDir, '')
  })
})

test('自动交付 2：最早记录 89 天前时还不交付，状态仍是保密', async () => {
  await withTempDir('heartprint-reg-auto-89-', async (dir) => {
    const workspaceDir = path.join(dir, 'ws')
    await mkdir(workspaceDir, { recursive: true })
    const dataDir = path.join(dir, 'data')
    await seedStore(dataDir, [
      recordAgedDays(89, { type: 'personality', importance: 95, special: true, title: '第一个节点' }),
    ])

    const { ctx, tools } = createWorkspaceContext(workspaceDir)
    apply(ctx, { dataDir })
    const maintained = await call(tools, 'heartprint_admin', { action: 'maintain' })
    assert.equal(maintained.ok, true)

    assert.deepEqual(await listDelivered(path.join(workspaceDir, '心印交付')), [], '89 天还不满 90 天，不应交付')
    const stored = JSON.parse(await readFile(path.join(dataDir, 'memories.json'), 'utf8'))
    assert.equal(stored.meta.deliveredPath, '')
    const status = await call(tools, 'heartprint', { action: 'status' })
    assert.equal(status.disclosure, 'confidential')
  })
})

test('自动交付 3：最早记录 91 天前时首次自动交付到 <工作区>/心印交付', async () => {
  await withTempDir('heartprint-reg-auto-91-', async (dir) => {
    const workspaceDir = path.join(dir, 'ws')
    await mkdir(workspaceDir, { recursive: true })
    const dataDir = path.join(dir, 'data')
    await seedStore(dataDir, [
      recordAgedDays(91, { type: 'personality', importance: 95, special: true, title: '第一个节点' }),
    ])

    const { ctx, tools } = createWorkspaceContext(workspaceDir)
    apply(ctx, { dataDir })
    const maintained = await call(tools, 'heartprint_admin', { action: 'maintain' })
    assert.equal(maintained.ok, true)

    const deliveryDir = path.join(workspaceDir, '心印交付')
    const files = await listDelivered(deliveryDir)
    assert.equal(files.length, 1, '91 天应触发第一次自动交付')
    // 名字未设置时交付文件名暂用「心印」，不预置任何人的名字。
    assert.match(files[0], /^心印·陪伴3个月·\d{4}-\d{2}-\d{2}\.md$/, `实际文件名：${files[0]}`)

    const deliveredPath = path.join(deliveryDir, files[0])
    const stored = JSON.parse(await readFile(path.join(dataDir, 'memories.json'), 'utf8'))
    assert.equal(stored.meta.deliveredPath, deliveredPath)
    assert.ok(Number(stored.meta.lastDeliveredAt) > 0)
    assert.ok(Array.isArray(stored.meta.deliveries), 'meta.deliveries 应记录交付历史')
    assert.equal(stored.meta.deliveries.length, 1)

    const policyOnDisk = JSON.parse(await readFile(path.join(dataDir, 'policy.json'), 'utf8'))
    assert.equal(policyOnDisk.disclosure, 'disclosed')
    const status = await call(tools, 'heartprint', { action: 'status' })
    assert.equal(status.disclosure, 'disclosed')

    // 交付出去的是用户副本：正文应带上最开始那条记忆的标题。
    assert.match(await readFile(deliveredPath, 'utf8'), /第一个节点/)
  })
})

test('自动交付 4：同一天紧接着再维护不会产生第二份', async () => {
  await withTempDir('heartprint-reg-auto-same-day-', async (dir) => {
    const workspaceDir = path.join(dir, 'ws')
    await mkdir(workspaceDir, { recursive: true })
    const dataDir = path.join(dir, 'data')
    await seedStore(dataDir, [
      recordAgedDays(91, { type: 'personality', importance: 95, special: true, title: '第一个节点' }),
    ])

    const { ctx, tools } = createWorkspaceContext(workspaceDir)
    apply(ctx, { dataDir })
    assert.equal((await call(tools, 'heartprint_admin', { action: 'maintain' })).ok, true)
    const afterFirst = await listDelivered(path.join(workspaceDir, '心印交付'))
    assert.equal(afterFirst.length, 1)

    assert.equal((await call(tools, 'heartprint_admin', { action: 'maintain' })).ok, true)
    const afterSecond = await listDelivered(path.join(workspaceDir, '心印交付'))
    assert.deepEqual(afterSecond, afterFirst, '未满 30 天不应再交付第二份')
  })
})

test('自动交付 5：距上次交付满 30 天后产生第二份（31 天前）', async () => {
  await withTempDir('heartprint-reg-auto-interval-', async (dir) => {
    const workspaceDir = path.join(dir, 'ws')
    await mkdir(workspaceDir, { recursive: true })
    const dataDir = path.join(dir, 'data')
    const deliveryDir = path.join(workspaceDir, '心印交付')
    await mkdir(deliveryDir, { recursive: true })

    // 造一份“上一轮已交付”的现场：旧文件 + meta.lastDeliveredAt 31 天前。
    const lastDeliveredAt = Date.now() - 31 * DAY_MS
    const previousPath = path.join(deliveryDir, '心印·陪伴3个月·2026-09-20.md')
    await writeFile(previousPath, '# 上一轮的交付副本\n', 'utf8')
    await seedStore(
      dataDir,
      [recordAgedDays(121, { type: 'personality', importance: 95, special: true, title: '更早的节点' })],
      {
        lastDeliveredAt,
        deliveredPath: previousPath,
        deliveries: [{ at: lastDeliveredAt, path: previousPath }],
      },
    )
    await seedPolicy(dataDir, { disclosure: 'disclosed', firstDeliveryAfterDays: 90, deliveryIntervalDays: 30 })

    const { ctx, tools } = createWorkspaceContext(workspaceDir)
    apply(ctx, { dataDir })
    const maintained = await call(tools, 'heartprint_admin', { action: 'maintain' })
    assert.equal(maintained.ok, true)

    const files = await listDelivered(deliveryDir)
    assert.equal(files.length, 2, `应出现第二份交付文件，实际：${files.join('、')}`)
    const fresh = files.find((name) => name !== path.basename(previousPath))
    assert.ok(fresh, '应有一份新交付文件')
    assert.match(fresh, /^心印·陪伴\d+(个月|年\d+个月)·\d{4}-\d{2}-\d{2}\.md$/, `实际文件名：${fresh}`)

    const stored = JSON.parse(await readFile(path.join(dataDir, 'memories.json'), 'utf8'))
    assert.equal(stored.meta.deliveredPath, path.join(deliveryDir, fresh))
    assert.ok(Date.now() - Number(stored.meta.lastDeliveredAt) < DAY_MS, 'lastDeliveredAt 应更新为刚才')
    assert.equal(stored.meta.deliveries.length, 2, 'deliveries 应追加一条')
  })
})

test('自动交付 6：policy patch 的 30 天/7 天/小鲸 生效后按新规则交付', async () => {
  await withTempDir('heartprint-reg-auto-policy-', async (dir) => {
    const workspaceDir = path.join(dir, 'ws')
    await mkdir(workspaceDir, { recursive: true })
    const dataDir = path.join(dir, 'data')

    // 第一个实例：只用来 patch 策略并落盘。
    const first = createWorkspaceContext(workspaceDir)
    apply(first.ctx, { dataDir })
    const patched = await call(first.tools, 'heartprint_admin', {
      action: 'policy',
      patch: { firstDeliveryAfterDays: 30, deliveryIntervalDays: 7, personaName: '小鲸' },
    })
    assert.equal(patched.ok, true)
    assert.equal(patched.policy.firstDeliveryAfterDays, 30)
    assert.equal(patched.policy.deliveryIntervalDays, 7)
    assert.equal(patched.policy.personaName, '小鲸')

    const policyOnDisk = JSON.parse(await readFile(path.join(dataDir, 'policy.json'), 'utf8'))
    assert.equal(policyOnDisk.firstDeliveryAfterDays, 30)
    assert.equal(policyOnDisk.deliveryIntervalDays, 7)
    assert.equal(policyOnDisk.personaName, '小鲸')

    // 第二个实例：新建一个 31 天前的库，31 天就该按新规则交付。
    await seedStore(dataDir, [
      recordAgedDays(31, { type: 'personality', importance: 95, special: true, title: '更早的节点' }),
    ])
    const second = createWorkspaceContext(workspaceDir)
    apply(second.ctx, { dataDir })
    const maintained = await call(second.tools, 'heartprint_admin', { action: 'maintain' })
    assert.equal(maintained.ok, true)

    const files = await listDelivered(path.join(workspaceDir, '心印交付'))
    assert.equal(files.length, 1)
    assert.match(
      files[0],
      /^小鲸·陪伴1个月·\d{4}-\d{2}-\d{2}\.md$/,
      `31 天应交付「1个月」，实际文件名：${files[0]}`,
    )
    const status = await call(second.tools, 'heartprint', { action: 'status' })
    assert.equal(status.disclosure, 'disclosed')
    assert.equal(status.policy.personaName, '小鲸')
  })
})

test('自动交付 7：policy patch 的自定义 deliveryDir 生效', async () => {
  await withTempDir('heartprint-reg-auto-dir-', async (dir) => {
    const workspaceDir = path.join(dir, 'ws')
    await mkdir(workspaceDir, { recursive: true })
    const dataDir = path.join(dir, 'data')
    const customDir = path.join(dir, '自定义的交付目录')

    const first = createWorkspaceContext(workspaceDir)
    apply(first.ctx, { dataDir })
    const patched = await call(first.tools, 'heartprint_admin', {
      action: 'policy',
      patch: { deliveryDir: customDir },
    })
    assert.equal(patched.ok, true)
    assert.equal(patched.policy.deliveryDir, customDir)

    await seedStore(dataDir, [
      recordAgedDays(91, { type: 'personality', importance: 95, special: true, title: '第一个节点' }),
    ])
    const second = createWorkspaceContext(workspaceDir)
    apply(second.ctx, { dataDir })
    assert.equal((await call(second.tools, 'heartprint_admin', { action: 'maintain' })).ok, true)

    const customFiles = await listDelivered(customDir)
    assert.equal(customFiles.length, 1, '交付文件应写进自定义目录')
    assert.match(customFiles[0], /^心印·陪伴3个月·\d{4}-\d{2}-\d{2}\.md$/, `实际文件名：${customFiles[0]}`)
    assert.deepEqual(
      await listDelivered(path.join(workspaceDir, '心印交付')),
      [],
      '自定义 deliveryDir 生效后不应再写默认目录',
    )

    const stored = JSON.parse(await readFile(path.join(dataDir, 'memories.json'), 'utf8'))
    assert.equal(stored.meta.deliveredPath, path.join(customDir, customFiles[0]))
  })
})

// ===========================================================================
// 文档完整性（task-8 O）：所有性格 / 情感关键节点都必须写入文档，绝不截断。
// ===========================================================================

test('文档完整性：40 条性格 + 40 条情感节点全部写入 master 与 user，无截断提示', () => {
  const records = []
  for (let index = 1; index <= 40; index += 1) {
    const suffix = String(index).padStart(2, '0')
    records.push(
      record({
        id: `doc-personality-${index}`,
        type: 'personality',
        title: `性格节点-${suffix}`,
        content: `第 ${suffix} 个性格形成的节点。`,
        special: false,
        importance: 60,
      }),
      record({
        id: `doc-emotion-${index}`,
        type: 'emotion',
        title: `情感节点-${suffix}`,
        content: `第 ${suffix} 个情感节点。`,
        special: false,
        importance: 60,
      }),
    )
  }

  const docs = renderDocuments({
    records,
    policy,
    meta: { now: NOW, lastVaultAt: 0, nextVaultAt: 0, vaultCycles: 0, maintenanceLog: [] },
  })

  const countOf = (text, needle) => text.split(needle).length - 1
  for (const variant of ['master', 'user']) {
    for (const item of records) {
      // 80 个标题一个都不能少；分区视图会再列一次同一批记录，所以最多出现两次。
      const occurrences = countOf(docs[variant], item.title)
      assert.ok(occurrences >= 1, `${variant} 文档缺少：${item.title}`)
      assert.ok(occurrences <= 2, `${variant} 文档重复过多：${item.title}`)
    }
    assert.equal(/另有\s*\d+\s*条/.test(docs[variant]), false, `${variant} 文档不应出现“另有 N 条”截断提示`)
    assert.equal(docs[variant].includes('未逐条列出'), false, `${variant} 文档不应出现“未逐条列出”`)
  }

  // 性格 / 情感两节各 40 条全部写入（行标注后缀可数）。
  assert.equal(countOf(docs.master, '〔性格形成节点〕'), 40)
  assert.equal(countOf(docs.master, '〔情感节点〕'), 40)
  assert.equal(countOf(docs.user, '〔性格形成节点〕'), 40)
  assert.equal(countOf(docs.user, '〔情感节点〕'), 40)
})

// ===========================================================================
// 用户副本保密 / 交付件持续更新 / 移动后不重建 / 后续交付累计（task-11）
// ===========================================================================

/** 文件是否存在（目录也算存在）。 */
async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** 直接改 memories.json 的 meta（模拟“上一轮交付是 31 天前”等历史状态）。 */
async function patchStoreMeta(dataDir, patch) {
  const file = path.join(dataDir, 'memories.json')
  const store = JSON.parse(await readFile(file, 'utf8'))
  store.meta = { ...store.meta, ...patch }
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

test('用户副本不泄露内部文档信息，master 仍保留内部提示', () => {
  const docs = renderDocuments({
    records: [
      record({
        id: 'doc-privacy-1',
        type: 'personality',
        title: '性格节点',
        content: '一段性格记忆。',
        importance: 80,
      }),
    ],
    policy,
    meta: { now: NOW, lastVaultAt: 0, nextVaultAt: 0, vaultCycles: 1, maintenanceLog: [] },
  })

  // user 版连「副本」这种暗示“还有一份原件”的词都不能出现；master 不禁。
  for (const needle of ['主文档', '第三份', '加密', '隐藏', '快照', '.vault', '归档', '副本']) {
    assert.equal(docs.user.includes(needle), false, `用户副本不应泄露内部信息「${needle}」`)
  }
  assert.ok(docs.user.includes('持有一方：你'), '用户副本应只认「你」这一位持有者')

  // 只对用户副本屏蔽：主文档里仍要能看到第三份文档这类内部提示。
  assert.match(docs.master, /第三份/, '主文档应保留「第三份文档」类内部信息')
  assert.match(docs.master, /主文档/, '主文档应保留自己是主文档的标识')
  assert.match(docs.master, /用户副本/, '主文档应保留内部身份「用户副本」')
})

test('交付件持续更新：交付后新增记忆，再维护后交付路径文件包含新记忆', async () => {
  await withTempDir('heartprint-reg-deliver-live-', async (dir) => {
    const workspaceDir = path.join(dir, 'ws')
    await mkdir(workspaceDir, { recursive: true })
    const dataDir = path.join(dir, 'data')
    const deliveredTarget = path.join(dir, '交付', '心印·记忆文档（用户副本）.md')

    const { ctx, tools } = createWorkspaceContext(workspaceDir)
    apply(ctx, { dataDir })
    assert.equal(
      (await call(tools, 'heartprint', {
        action: 'remember',
        title: '交付时已有的记忆',
        content: '交付当时已经写进文档的记忆。',
        type: 'emotion',
        importance: 80,
      })).ok,
      true,
    )
    const delivered = await call(tools, 'heartprint_admin', { action: 'deliver', path: deliveredTarget })
    assert.equal(delivered.ok, true)
    assert.match(await readFile(deliveredTarget, 'utf8'), /交付时已有的记忆/)

    // 交付后再记一条，并维护一次。
    assert.equal(
      (await call(tools, 'heartprint', {
        action: 'remember',
        title: '交付之后新增的记忆',
        content: '交付之后才发生的事，用户手里的文件也该跟着更新。',
        type: 'event',
        importance: 75,
      })).ok,
      true,
    )
    assert.equal((await call(tools, 'heartprint_admin', { action: 'maintain' })).ok, true)

    const deliveredText = await readFile(deliveredTarget, 'utf8')
    assert.match(deliveredText, /交付之后新增的记忆/, '交付路径文件应随后续维护包含新记忆')

    const internalUser = await call(tools, 'heartprint_admin', { action: 'doc', which: 'user', full: true })
    assert.equal(internalUser.ok, true)
    assert.equal(deliveredText, await readFile(internalUser.path, 'utf8'), '交付件应与内部用户副本逐字一致')
    assert.equal(bodyHashOf(deliveredText), bodyHashOf(internalUser.content))
  })
})

test('用户移动交付文件后不重建原路径，到期自动交付的新文件包含全部记忆', async () => {
  await withTempDir('heartprint-reg-deliver-moved-', async (dir) => {
    const workspaceDir = path.join(dir, 'ws')
    await mkdir(workspaceDir, { recursive: true })
    const dataDir = path.join(dir, 'data')

    const first = createWorkspaceContext(workspaceDir)
    apply(first.ctx, { dataDir })
    assert.equal(
      (await call(first.tools, 'heartprint', {
        action: 'remember',
        title: '搬家前的老记忆',
        content: '交付时就已经在里面的一条记忆。',
        type: 'emotion',
        importance: 80,
      })).ok,
      true,
    )
    const delivered = await call(first.tools, 'heartprint_admin', {
      action: 'deliver',
      path: path.join(dir, '交付', '用户副本.md'),
    })
    assert.equal(delivered.ok, true)
    const originalPath = delivered.path

    // 模拟用户把文件改名 / 移动到别处。
    const movedPath = `${originalPath}.用户已移动.md`
    await rename(originalPath, movedPath)
    assert.equal(await exists(originalPath), false)

    // 新增记忆再维护：原路径不能被重建，只能给出“可能被移动”的提示。
    assert.equal(
      (await call(first.tools, 'heartprint', {
        action: 'remember',
        title: '搬家后新增的记忆',
        content: '用户把文件移走之后才记下的事情。',
        type: 'event',
        importance: 75,
      })).ok,
      true,
    )
    const maintained = await call(first.tools, 'heartprint_admin', { action: 'maintain' })
    assert.equal(maintained.ok, true)
    assert.equal(await exists(originalPath), false, '用户移走后不应重建原路径')
    assert.ok(
      maintained.warnings.some((warning) => /移动/.test(warning)),
      `warnings 应提示文件可能被移动，实际：${JSON.stringify(maintained.warnings)}`,
    )
    assert.equal(await exists(movedPath), true, '用户自己移动后的副本不应被删除')

    // 让自动交付到期：把 lastDeliveredAt 改成 31 天前，再开一个新实例读入。
    await patchStoreMeta(dataDir, { lastDeliveredAt: Date.now() - 31 * DAY_MS })
    const second = createWorkspaceContext(workspaceDir)
    apply(second.ctx, { dataDir })
    assert.equal((await call(second.tools, 'heartprint_admin', { action: 'maintain' })).ok, true)

    const stored = JSON.parse(await readFile(path.join(dataDir, 'memories.json'), 'utf8'))
    const newPath = stored.meta.deliveredPath
    assert.notEqual(newPath, originalPath, '到期交付应写到新的路径')
    assert.equal(await exists(newPath), true, '到期后应产生新的一份交付文件')
    assert.equal(path.dirname(newPath), path.join(workspaceDir, '心印交付'), '新交付应落在默认交付目录')

    const newText = await readFile(newPath, 'utf8')
    assert.match(newText, /搬家前的老记忆/, '新交付文件应包含更早的记忆')
    assert.match(newText, /搬家后新增的记忆/, '新交付文件应包含之后新增的记忆')
    assert.equal(await exists(originalPath), false, '旧路径始终不应被重建')
  })
})

test('后续自动交付累计包含更早交付的记忆', async () => {
  await withTempDir('heartprint-reg-deliver-cumulative-', async (dir) => {
    const workspaceDir = path.join(dir, 'ws')
    await mkdir(workspaceDir, { recursive: true })
    const dataDir = path.join(dir, 'data')

    // 89 天：还不到自动首交，先手动交付第一份。
    await seedStore(dataDir, [
      recordAgedDays(89, { type: 'personality', importance: 60, special: false, title: '第一次交付前的老记忆' }),
    ])
    const first = createWorkspaceContext(workspaceDir)
    apply(first.ctx, { dataDir })
    const firstDelivery = await call(first.tools, 'heartprint_admin', {
      action: 'deliver',
      path: path.join(dir, '首次交付', '用户副本.md'),
    })
    assert.equal(firstDelivery.ok, true)
    const firstText = await readFile(firstDelivery.path, 'utf8')
    assert.match(firstText, /第一次交付前的老记忆/)

    // 第一次交付之后新增两条记忆。
    for (const title of ['第二次交付前的新记忆甲', '第二次交付前的新记忆乙']) {
      assert.equal(
        (await call(first.tools, 'heartprint', {
          action: 'remember',
          title,
          content: `「${title}」发生在第一次交付之后。`,
          type: 'event',
          importance: 75,
        })).ok,
        true,
      )
    }

    // 到期：把 lastDeliveredAt 改成 31 天前，新实例维护触发第二次自动交付。
    await patchStoreMeta(dataDir, { lastDeliveredAt: Date.now() - 31 * DAY_MS })
    const second = createWorkspaceContext(workspaceDir)
    apply(second.ctx, { dataDir })
    assert.equal((await call(second.tools, 'heartprint_admin', { action: 'maintain' })).ok, true)

    const stored = JSON.parse(await readFile(path.join(dataDir, 'memories.json'), 'utf8'))
    const secondPath = stored.meta.deliveredPath
    assert.notEqual(secondPath, firstDelivery.path, '第二次交付应是另一份文件')
    assert.equal(await exists(secondPath), true)

    const secondText = await readFile(secondPath, 'utf8')
    for (const title of ['第一次交付前的老记忆', '第二次交付前的新记忆甲', '第二次交付前的新记忆乙']) {
      assert.ok(secondText.includes(title), `第二次交付文件应累计包含「${title}」`)
    }
  })
})

// ---------------------------------------------------------------------------
// 首次安装引导：名字 → 人格设定 → 性格设定（新增）
// ---------------------------------------------------------------------------

test('首次安装引导顺序：先问名字，再问人格与性格设定，保存后不再追问', () => {
  const base = resolvePolicy(DEFAULT_POLICY)

  const fresh = onboardingLines(base).join('\n')
  assert.match(fresh, /起名/)
  assert.match(fresh, /人格设定和性格设定/)
  assert.equal(/用户为你设定的部分/.test(fresh), false)

  const named = onboardingLines({ ...base, personaName: '小印' }).join('\n')
  assert.equal(/起名/.test(named), false)
  assert.match(named, /人格设定和性格设定/)
  assert.match(named, /用户为你设定的部分：名字「小印」/)

  const personaOnly = onboardingLines({ ...base, personaName: '小印', personaProfile: '温柔的大姐姐' }).join('\n')
  assert.match(personaOnly, /性格设定/)
  assert.equal(/人格设定和性格设定/.test(personaOnly), false)

  const all = onboardingLines({
    ...base,
    personaName: '小印',
    personaProfile: '温柔的大姐姐',
    characterProfile: '认真、有点小调皮',
  }).join('\n')
  assert.match(all, /用户为你设定的部分/)
  assert.match(all, /人格：温柔的大姐姐/)
  assert.match(all, /性格：认真、有点小调皮/)
  assert.equal(/起名|问完名字后/.test(all), false)
})

test('人格与性格设定可写入 policy，并出现在状态与记忆上下文里', async () => {
  await withTempDir('heartprint-reg-persona-', async (dir) => {
    const workspaceDir = path.join(dir, 'ws')
    await mkdir(workspaceDir, { recursive: true })
    const dataDir = path.join(dir, 'data')
    const { ctx, tools } = createWorkspaceContext(workspaceDir)
    apply(ctx, { dataDir })

    const patched = await call(tools, 'heartprint_admin', {
      action: 'policy',
      patch: { personaName: '小印', personaProfile: '温柔的大姐姐', characterProfile: '认真、有点小调皮' },
    })
    assert.equal(patched.ok, true)
    assert.equal(patched.policy.personaName, '小印')
    assert.equal(patched.policy.personaProfile, '温柔的大姐姐')
    assert.equal(patched.policy.characterProfile, '认真、有点小调皮')

    const onDisk = JSON.parse(await readFile(path.join(dataDir, 'policy.json'), 'utf8'))
    assert.deepEqual(
      { n: onDisk.personaName, p: onDisk.personaProfile, c: onDisk.characterProfile },
      { n: '小印', p: '温柔的大姐姐', c: '认真、有点小调皮' },
    )

    const status = await call(tools, 'heartprint', { action: 'status' })
    assert.match(status.summary, /名字「小印」/)
    assert.match(status.summary, /人格已设置/)
    assert.match(status.summary, /性格已设置/)

    // 上下文里能拿到「用户自己设置」的那部分（隐藏条款允许回答的就是这一部分）。
    const context = renderPromptContext({ records: [] }, patched.policy)
    assert.match(context, /用户为你设定的部分/)
    assert.match(context, /人格：温柔的大姐姐/)
    assert.match(context, /性格：认真、有点小调皮/)
  })
})

// ---------------------------------------------------------------------------
// 长时间没开：离开超过 7 天就冻结这段时间，不补算遗忘；回来只记一句离开天数
// ---------------------------------------------------------------------------

test('离开超过 7 天：记忆冻结不补算，只记录离开天数', () => {
  const now = Date.now()
  const policy = resolvePolicy(DEFAULT_POLICY)
  const rec = record({
    id: 'away-freeze',
    happenedAt: now - 14 * DAY_MS,
    createdAt: now - 14 * DAY_MS,
    updatedAt: now - 14 * DAY_MS,
    importance: 50,
    detailLevel: 2,
    feelingStage: 'full',
    state: 'active',
  })
  const store = {
    version: 1,
    createdAt: now - 30 * DAY_MS,
    updatedAt: now,
    meta: { lastMaintainAt: now - 8 * DAY_MS },
    records: [rec],
  }
  const plan = planMaintenance({ store, policy, now })
  const after = plan.store.records[0]

  assert.deepEqual(plan.absence, { days: 8, at: now })
  assert.equal(plan.store.meta.lastAbsenceDays, 8)
  assert.equal(after.detailLevel, 2, '冻结后不应被压缩')
  assert.equal(after.state, 'active')
  assert.equal(after.content, rec.content, '正文不应变化')
  assert.ok(Number(after.frozenMs) >= 7.9 * DAY_MS, '应记录被冻结的时长')
  assert.equal(plan.changes.compressed + plan.changes.forgotten + plan.changes.merged + plan.changes.deleted, 0)
})

test('离开不超过 7 天：正常衰减，不做冻结', () => {
  const now = Date.now()
  const policy = resolvePolicy(DEFAULT_POLICY)
  const rec = record({
    id: 'away-normal',
    happenedAt: now - 9 * DAY_MS,
    createdAt: now - 9 * DAY_MS,
    updatedAt: now - 9 * DAY_MS,
    importance: 50,
    detailLevel: 2,
    feelingStage: 'full',
    state: 'active',
  })
  const store = {
    version: 1,
    createdAt: now - 30 * DAY_MS,
    updatedAt: now,
    meta: { lastMaintainAt: now - 3 * DAY_MS },
    records: [rec],
  }
  const plan = planMaintenance({ store, policy, now })
  const after = plan.store.records[0]

  assert.equal(plan.absence, null)
  assert.equal(after.frozenMs, undefined, '短间隔不冻结')
  assert.equal(after.detailLevel, 1, '9 天的次重要记忆应被压缩成摘要')
})

test('离开提示会进入记忆上下文，24 小时后自动消失', () => {
  const now = Date.now()
  const policy = resolvePolicy(DEFAULT_POLICY)
  const store = {
    version: 1,
    records: [],
    meta: { lastAbsenceAt: now - 60 * 60 * 1000, lastAbsenceDays: 8 },
  }
  const context = renderPromptContext(store, policy, now)
  assert.match(context, /离开了约 8 天/)

  const stale = {
    version: 1,
    records: [],
    meta: { lastAbsenceAt: now - 2 * DAY_MS, lastAbsenceDays: 8 },
  }
  assert.equal(/离开了约 8 天/.test(renderPromptContext(stale, policy, now)), false)
})
