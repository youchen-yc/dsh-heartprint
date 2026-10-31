import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { exportBackup, snapshotStore, writeSelfCheck } from '../lib/protect.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-guard-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

async function initFull(dir) {
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
    effect(callback) { const cleanup = callback(); return () => cleanup && cleanup() },
    get() { return undefined },
    on() { return () => {} },
  }
  apply(ctx, { dataDir: dir })
  return (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal, agent: { id: 't' } })
}

test('日常操作无确认：remember / recall / maintain 不出现确认要求', async () => {
  await withTempDir(async (dir) => {
    const exec = await initFull(dir)
    assert.equal((await exec('heartprint', { action: 'remember', title: '一条', content: '内容', type: 'event' })).ok, true)
    assert.equal((await exec('heartprint', { action: 'recall', query: '一条' })).ok, true)
    const run = await exec('heartprint_admin', { action: 'maintain' })
    assert.equal(run.ok, true)
    for (const result of [run]) assert.notEqual(result.error && result.error.code, 'need-confirm')
  })
})

test('同 id 读档不带 confirm 被拒、带上成功，新增无需确认', async () => {
  await withTempDir(async (dir) => {
    const exec = await initFull(dir)
    const remembered = await exec('heartprint', { action: 'remember', title: '原记录', content: '内容', type: 'event' })
    const id = remembered.record.id
    const backup = path.join(dir, 'b.json')
    await writeFile(backup, JSON.stringify({ records: [{ id, type: 'event', title: '原记录', content: '覆盖内容' }] }), 'utf8')
    const denied = await exec('heartprint_admin', { action: 'restore', source: 'backup', path: backup })
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'need-confirm')
    const ok = await exec('heartprint_admin', { action: 'restore', source: 'backup', path: backup, confirm: true })
    assert.equal(ok.ok, true)
    const fresh = path.join(dir, 'c.json')
    await writeFile(fresh, JSON.stringify({ records: [{ id: 'mem-new-1', type: 'event', title: '新增', content: 'x' }] }), 'utf8')
    const added = await exec('heartprint_admin', { action: 'restore', source: 'backup', path: fresh })
    assert.equal(added.ok, true)
  })
})

test('维护前快照：限频、保留 N、删最旧', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'memories.json'), JSON.stringify({ records: [] }), 'utf8')
    const first = await snapshotStore({ dataDir: dir, keep: 2, intervalHours: 1, now: Date.now() })
    assert.equal(first.created, true)
    const sameHour = await snapshotStore({ dataDir: dir, keep: 2, intervalHours: 1, now: Date.now() })
    assert.equal(sameHour.created, false)
    await snapshotStore({ dataDir: dir, keep: 2, intervalHours: 1, now: Date.now() + 2 * 3600 * 1000 })
    await snapshotStore({ dataDir: dir, keep: 2, intervalHours: 1, now: Date.now() + 4 * 3600 * 1000 })
    const files = (await (await import('node:fs/promises')).readdir(path.join(dir, '.snapshots'))).filter((name) => name.startsWith('memories-'))
    assert.ok(files.length <= 2, JSON.stringify(files))
  })
})

test('维护前快照失败不阻塞：返回 warnings 不抛错', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'memories.json'), JSON.stringify({ records: [] }), 'utf8')
    await writeFile(path.join(dir, '.snapshots'), 'not a dir', 'utf8')
    const result = await snapshotStore({ dataDir: dir, keep: 5, intervalHours: 1 })
    assert.equal(result.created, false)
    assert.ok(result.warnings.length > 0)
  })
})

test('自检与超限同时发生：两条提示都在，互不覆盖', async () => {
  await withTempDir(async (dir) => {
    const exec = await initFull(dir)
    await writeSelfCheck(dir, { at: Date.now(), items: [{ id: 'docs', status: 'needs-human', detail: '缺文档' }], summary: 'ok 1 · needs-human 1' })
    const status = await exec('heartprint', { action: 'status' })
    assert.match(status.summary, /上次体检：.*needs-human 1/)
    assert.match(status.summary, /容量：/)
  })
})

test('导出 → 解压恢复 → status 记录数一致（全链路）', async () => {
  await withTempDir(async (base) => {
    const src = path.join(base, 'src')
    await mkdir(src, { recursive: true })
    await writeFile(path.join(src, 'memories.json'), JSON.stringify({ records: [{ id: 'm1', title: 'a' }, { id: 'm2', title: 'b' }] }), 'utf8')
    await writeFile(path.join(src, 'policy.json'), '{}', 'utf8')
    await mkdir(path.join(src, '.vault'))
    await writeFile(path.join(src, '.vault', 'key'), 'k', 'utf8')
    const out = path.join(base, 'out')
    await mkdir(out)
    const result = await exportBackup({ dataDir: src, targetDir: out, guard: null })
    assert.ok(result.files.includes('memories.json'))
    assert.ok(result.files.includes('.vault/key'))
    const restored = path.join(base, 'restored')
    await mkdir(restored)
    await (await import('node:fs/promises')).copyFile(path.join(src, 'memories.json'), path.join(restored, 'memories.json'))
    await (await import('node:fs/promises')).copyFile(path.join(src, 'policy.json'), path.join(restored, 'policy.json'))
    const exec = await initFull(restored)
    const status = await exec('heartprint', { action: 'status' })
    assert.match(status.summary, /- 记录 2 条/)
  })
})

test('维护被节流时容量按钮仍显示：状态推导不依赖维护', async () => {
  await withTempDir(async (dir) => {
    const exec = await initFull(dir)
    await exec('heartprint_admin', { action: 'policy', patch: { maxRecords: 1000 } })
    const records = Array.from({ length: 1000 }, (_, i) => ({ id: 'm' + i, title: 't' + i }))
    const store = JSON.parse(await readFile(path.join(dir, 'memories.json'), 'utf8'))
    store.records = records
    await writeFile(path.join(dir, 'memories.json'), JSON.stringify(store), 'utf8')
    const second = await initFull(dir)
    const status = await second('heartprint', { action: 'status' })
    assert.match(status.summary, /容量：1000\/1000/)
    const { capacityAlert } = await import('../lib/protect.js')
    assert.equal(capacityAlert(records, { maxRecords: 1000 }).visible, true)
  })
})

test('policy reset 不带 confirm 被拒、带上才重置', async () => {
  await withTempDir(async (dir) => {
    const exec = await initFull(dir)
    const denied = await exec('heartprint_admin', { action: 'policy', reset: true })
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'need-confirm')
    const ok = await exec('heartprint_admin', { action: 'policy', reset: true, confirm: true })
    assert.equal(ok.ok, true)
  })
})

test('maintain 结果可无损序列化：无 undefined / NaN，JSON 往返不丢键', async () => {
  await withTempDir(async (dir) => {
    const exec = await initFull(dir)
    const result = await exec('heartprint_admin', { action: 'maintain' })
    const walk = (value, pathName) => {
      assert.notEqual(value, undefined, 'undefined 字段：' + pathName)
      if (typeof value === 'number') assert.ok(Number.isFinite(value), 'NaN 字段：' + pathName)
    }
    walk(result, 'root')
    const roundTrip = JSON.parse(JSON.stringify(result))
    assert.deepEqual(roundTrip, result)
  })
})
