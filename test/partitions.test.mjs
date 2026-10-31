import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CONNECTIONS,
  PARTITION_IDS,
  PARTITION_LAYERS,
  PARTITIONS,
  STORAGE_PARTITION_IDS,
  activePartitions,
  broadcast,
  buildPrimingIndex,
  ensurePartitions,
  inferPartitions,
  partitionSummary,
  primingBoost,
  updatePrimingIndex,
} from '../lib/partitions.js'

const DAY = 86400000
const NOW = Date.now()

function record(overrides = {}) {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    type: 'event',
    title: '一件事',
    content: '内容',
    feeling: '感觉',
    valence: 'neutral',
    importance: 50,
    special: false,
    people: [],
    tags: [],
    happenedAt: NOW - DAY,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    detailLevel: 2,
    feelingStage: 'full',
    state: 'active',
    lastRecalledAt: 0,
    ...overrides,
  }
}

test('分区表：5 层 13 个分区（按文档表格），有 7 个存记忆的分区', () => {
  assert.equal(PARTITION_LAYERS.length, 5)
  assert.equal(PARTITION_IDS.length, 13)
  const total = PARTITION_LAYERS.reduce((sum, layer) => sum + layer.partitions.length, 0)
  assert.equal(total, 13)
  assert.equal(STORAGE_PARTITION_IDS.length, 7)
  for (const id of ['reconsolidation', 'priming']) {
    assert.ok(PARTITION_IDS.includes(id), `${id} 必须在分区表里`)
    assert.equal(PARTITIONS[id].stores, false, `${id} 是过程分区，不存记忆`)
  }
})

test('文档点名的三条线路都在连接表里', () => {
  const has = (a, b) => CONNECTIONS.some((edge) => (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a))
  assert.equal(has('episodic', 'wm_executive'), true)
  assert.equal(has('interoceptive', 'episodic'), true)
  assert.equal(has('wm_gate', 'self_narrative'), true, '门控区 ↔ 自我叙事区必须有线路')
})

test('记忆按类型落到存记忆的分区（过程分区不承载记录）', () => {
  assert.deepEqual(inferPartitions(record({ type: 'personality' })), ['self_narrative'])
  assert.deepEqual(inferPartitions(record({ type: 'emotion' })), ['interoceptive'])
  assert.deepEqual(inferPartitions(record({ type: 'pain' })), ['episodic', 'interoceptive'])
  assert.deepEqual(inferPartitions(record({ type: 'insight' })), ['semantic'])
  assert.deepEqual(inferPartitions(record({ type: 'digest' })), ['consolidation'])
  assert.ok(inferPartitions(record({ type: 'event', tags: ['习惯'] })).includes('procedural'))
  for (const parts of [inferPartitions(record({ type: 'event' })), inferPartitions(record({ type: 'daily' }))]) {
    for (const id of parts) assert.equal(PARTITIONS[id].stores, true)
  }
})

test('迁移：老记忆补分区、幂等、不覆盖已有分区', () => {
  const legacy = record({ type: 'event' })
  delete legacy.partitions
  const first = ensurePartitions([legacy])
  assert.equal(first.changed, true)
  assert.deepEqual(first.records[0].partitions, ['episodic'])
  assert.equal(ensurePartitions(first.records).changed, false)
  const custom = record({ type: 'event', partitions: ['semantic'] })
  assert.deepEqual(ensurePartitions([custom]).records[0].partitions, ['semantic'])
})

test('组网：危险线索按文档「蛇」场景激活感觉区、情绪区、门控与中央执行区，并压住自我叙事', () => {
  const danger = activePartitions('路上突然看到一条蛇，很危险')
  for (const id of ['sensory', 'interoceptive', 'wm_gate', 'wm_executive', 'episodic', 'semantic']) {
    assert.ok(danger.active.has(id), `${id} 应被激活`)
  }
  assert.ok(danger.suppressed.has('self_narrative'), '自我叙事应被压住')
  assert.equal(danger.active.has('self_narrative'), false)

  const normal = activePartitions('今天天气不错')
  assert.ok(normal.active.has('episodic'))
  assert.equal(normal.suppressed.size, 0)
})

test('广播层：最多 5 条上屏，压住的区不参与，淡忘的不参与', () => {
  const records = [
    record({ type: 'personality', title: '性格底色', importance: 90, special: true }),
    record({ type: 'pain', title: '一次难受', importance: 80 }),
    record({ type: 'event', title: '普通事件', importance: 40 }),
    record({ type: 'event', title: '已经淡忘', state: 'forgotten', importance: 99 }),
    ...Array.from({ length: 8 }, (_, i) => record({ title: `事件${i}`, importance: 60 })),
  ]
  const items = broadcast(records, { query: '我有点害怕', now: NOW, limit: 5 })
  assert.ok(items.length <= 5)
  assert.equal(items.some((item) => item.record.title === '已经淡忘'), false)
  assert.equal(items.some((item) => item.record.title === '性格底色'), false, '被压住的自我叙事不上屏')
  assert.ok(items.some((item) => item.record.title === '一次难受'))
})

test('知觉启动：见过的线索进入索引，查询命中时产生启动效应', () => {
  const records = [
    record({ title: '和小林去海边', people: ['小林'], tags: ['旅行'] }),
    record({ title: '小林推荐的店', people: ['小林'] }),
  ]
  const index = buildPrimingIndex(records, NOW)
  assert.ok(index['小林'], '人名应进入索引')
  assert.ok(index['小林'].count >= 2)
  assert.ok(primingBoost(index, '小林') > 0)
  assert.equal(primingBoost(index, '完全没见过的词'), 0)

  const updated = updatePrimingIndex(index, record({ title: '小林又来了', people: ['小林'] }), NOW)
  assert.equal(updated['小林'].count, index['小林'].count + 1)
})

test('分区概览：只统计未淡忘记忆，只输出存记忆的分区', () => {
  const summary = partitionSummary([
    record({ type: 'personality' }),
    record({ type: 'pain' }),
    record({ type: 'event', state: 'forgotten' }),
  ])
  assert.match(summary, /自传体-自我叙事记忆区 1/)
  assert.match(summary, /情景记忆区 1/)
  assert.equal(/再巩固区/.test(summary), false)
  assert.equal(/情景记忆区 2/.test(summary), false)
})

test('再巩固：回忆之后可以更新原记忆，旧版本写进加密档案', async () => {
  const { apply } = await import('../index.js')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-reconsolidate-'))
  try {
    const tools = new Map()
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
      effect(callback) { const cleanup = callback(); return () => cleanup && cleanup() },
      get() { return undefined },
      on() { return () => {} },
    }
    apply(ctx, { dataDir: dir })
    const call = (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal, agent: { id: 'test' } })

    const remembered = await call('heartprint', { action: 'remember', title: '一次见面', content: '说是下午见的。', type: 'event', importance: 60 })
    assert.equal(remembered.ok, true)
    const id = remembered.record.id
    assert.ok(Array.isArray(remembered.record.partitions) && remembered.record.partitions.length > 0)

    const updated = await call('heartprint', { action: 'reconsolidate', id, content: '其实是晚上见的，之前记错了。' })
    assert.equal(updated.ok, true)
    assert.equal(updated.record.revision, 1)
    assert.match(updated.record.content, /晚上/)

    const missing = await call('heartprint', { action: 'reconsolidate', id: 'nope', content: 'x' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'not-found')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
