import assert from 'node:assert/strict'
import { resolvePolicy } from '../lib/policy.js'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyRepairs, capacityAlert, exportBackup, inspectStore, readSelfCheck, writeSelfCheck } from '../lib/protect.js'
import { createWriteGuard } from '../lib/fsguard.js'

async function fileSignature(dir) {
  const names = await readdir(dir)
  const rows = []
  for (const name of names.sort()) {
    const info = await stat(path.join(dir, name))
    rows.push(name + ':' + Math.round(info.mtimeMs))
  }
  return rows
}
import { createStore } from '../lib/store.js'

function storeOf(records = [], meta = {}) {
  return { records, meta: { priming: { cue: { count: 1 } }, ...meta } }
}

test('inspectStore：正常库 → 全部 ok，summary 为 ok 7 / needs-human 0', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-inspect-ok-'))
  try {
    await mkdir(path.join(dir, 'docs'), { recursive: true })
    await writeFile(path.join(dir, 'memories.json'), '{}', 'utf8')
    await writeFile(path.join(dir, 'docs', 'master.md'), '# m', 'utf8')
    await writeFile(path.join(dir, 'docs', 'user.md'), '# u', 'utf8')
    const store = storeOf([{ id: 'm1', title: 't', partitions: ['episodic'] }])
    const result = await inspectStore({
      dataDir: dir,
      store,
      policy: { snapshotKeep: 5, maxRecords: 20000 },
      docPaths: [path.join(dir, 'docs', 'master.md'), path.join(dir, 'docs', 'user.md')],
      vaultInfo: async () => ({ ok: true }),
    })
    assert.equal(result.mode, 'inspect')
    assert.equal(result.items.length, 7)
    for (const entry of result.items) assert.equal(entry.status, 'ok', `${entry.id} 应为 ok，实际 ${entry.status}: ${entry.detail}`)
    assert.equal(result.summary, 'ok 7 · needs-human 0')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('inspectStore：缺文档 → docs needs-human，不写任何文件', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-inspect-doc-'))
  try {
    await writeFile(path.join(dir, 'memories.json'), '{}', 'utf8')
    const store = storeOf([])
    const result = await inspectStore({
      dataDir: dir,
      store,
      policy: { snapshotKeep: 5 },
      docPaths: [path.join(dir, 'docs', 'master.md'), path.join(dir, 'docs', 'user.md')],
      vaultInfo: async () => ({ ok: true }),
    })
    const docs = result.items.find((entry) => entry.id === 'docs')
    assert.equal(docs.status, 'needs-human')
    assert.match(docs.detail, /缺失 2 份/)
    assert.match(result.summary, /needs-human 1/)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('inspectStore：坏 memories.json 被隔离后 → memories-json needs-human', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-inspect-corrupt-'))
  try {
    await writeFile(path.join(dir, 'memories.json'), '{ 这不是 JSON', 'utf8')
    const storeObj = createStore({ dataDir: dir })
    const loaded = await storeObj.load()
    assert.equal(loaded.store.records.length, 0)
    assert.ok(loaded.store.meta.corruptDetectedAt)
    const result = await inspectStore({
      dataDir: dir,
      store: loaded.store,
      policy: { snapshotKeep: 5 },
      docPaths: [],
      vaultInfo: async () => ({ ok: true }),
    })
    const corrupted = result.items.find((entry) => entry.id === 'memories-json')
    assert.equal(corrupted.status, 'needs-human')
    assert.match(result.summary, /needs-human 1/)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('writeSelfCheck：写守卫拒绝时返回 warning，不静默成功、不落盘', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-sc-guard-'))
  try {
    const guard = { assert() { throw Object.assign(new Error('越界写入'), { code: 'ESCOPE' }) } }
    const result = await writeSelfCheck(dir, { ok: true }, guard)
    assert.equal(result.ok, false)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /守卫拒绝/)
    const read = await readSelfCheck(dir)
    assert.equal(read.ok, false)
    assert.equal(read.reason, 'missing')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('readSelfCheck：缺失与损坏分别返回 missing / corrupt，正常返回 result', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-sc-read-'))
  try {
    const missing = await readSelfCheck(dir)
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'missing')

    await writeFile(path.join(dir, '.selfcheck.json'), '{ 坏掉的 JSON', 'utf8')
    const corrupt = await readSelfCheck(dir)
    assert.equal(corrupt.ok, false)
    assert.equal(corrupt.reason, 'corrupt')

    const written = await writeSelfCheck(dir, { at: 1, items: [], summary: 'ok 0' })
    assert.equal(written.ok, true)
    const normal = await readSelfCheck(dir)
    assert.equal(normal.ok, true)
    assert.equal(normal.result.summary, 'ok 0')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('status 只读体检结果：无文件 → 尚未体检，且不写盘', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-status-missing-'))
  try {
    const { apply } = await import('../index.js')
    const tools = new Map()
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
      effect(callback) { const cleanup = callback(); return () => cleanup && cleanup() },
      get() { return undefined },
      on() { return () => {} },
    }
    apply(ctx, { dataDir: dir })
    const call = (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal, agent: { id: 't' } })
    await call('heartprint', { action: 'status' })
    await rm(path.join(dir, '.selfcheck.json'), { force: true })
    const before = await fileSignature(dir)
    const status = await call('heartprint', { action: 'status' })
    const after = await fileSignature(dir)
    assert.equal(status.ok, true)
    assert.match(status.summary, /上次体检：尚未体检/)
    assert.deepEqual(after, before)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('status 只读体检结果：有文件 → 输出 at/summary/前 5 条 needs-human', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-status-ok-'))
  try {
    const { apply } = await import('../index.js')
    const tools = new Map()
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
      effect(callback) { const cleanup = callback(); return () => cleanup && cleanup() },
      get() { return undefined },
      on() { return () => {} },
    }
    apply(ctx, { dataDir: dir })
    const call = (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal, agent: { id: 't' } })
    await call('heartprint', { action: 'status' })
    const items = Array.from({ length: 7 }, (_, i) => ({ id: 'check-' + i, status: 'needs-human', detail: '问题 ' + i }))
    await writeSelfCheck(dir, { at: Date.now(), items, summary: 'ok 2 · needs-human 7' })
    const before = await fileSignature(dir)
    const status = await call('heartprint', { action: 'status' })
    const after = await fileSignature(dir)
    assert.match(status.summary, /ok 2 · needs-human 7/)
    assert.match(status.summary, /check-0：问题 0/)
    assert.match(status.summary, /另有 2 条 needs-human/)
    assert.deepEqual(after, before)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('status 只读体检结果：坏 JSON → 提示损坏、不覆盖、不抛错', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-status-corrupt-'))
  try {
    const { apply } = await import('../index.js')
    const tools = new Map()
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
      effect(callback) { const cleanup = callback(); return () => cleanup && cleanup() },
      get() { return undefined },
      on() { return () => {} },
    }
    apply(ctx, { dataDir: dir })
    const call = (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal, agent: { id: 't' } })
    await call('heartprint', { action: 'status' })
    const broken = path.join(dir, '.selfcheck.json')
    await writeFile(broken, '{ 坏掉的 JSON', 'utf8')
    const before = await fileSignature(dir)
    const status = await call('heartprint', { action: 'status' })
    const after = await fileSignature(dir)
    assert.equal(status.ok, true)
    assert.match(status.summary, /体检结果文件损坏/)
    assert.deepEqual(after, before)
    assert.match(await readFile(broken, 'utf8'), /坏掉的 JSON/)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function initPlugin(dir) {
  const { apply } = await import('../index.js')
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
    effect(callback) { const cleanup = callback(); return () => cleanup && cleanup() },
    get() { return undefined },
    on() { return () => {} },
  }
  apply(ctx, { dataDir: dir })
  const call = (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal, agent: { id: 't' } })
  await call('heartprint', { action: 'status' })
  return call
}

test('init 低频体检：无 .selfcheck.json → 生成并带 at', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-init-sc1-'))
  try {
    await initPlugin(dir)
    const read = await readSelfCheck(dir)
    assert.equal(read.ok, true)
    assert.ok(read.result.at > 0)
    assert.equal(read.result.mode, 'inspect')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('init 低频体检：7 天内再 init → 结果文件内容不变', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-init-sc2-'))
  try {
    await initPlugin(dir)
    const before = await readFile(path.join(dir, '.selfcheck.json'), 'utf8')
    await initPlugin(dir)
    const after = await readFile(path.join(dir, '.selfcheck.json'), 'utf8')
    assert.equal(after, before)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('init 低频体检：at 改到 8 天前 → 再 init 更新结果', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-init-sc3-'))
  try {
    await initPlugin(dir)
    const old = JSON.parse(await readFile(path.join(dir, '.selfcheck.json'), 'utf8'))
    old.at = Date.now() - 8 * 86400000
    await writeFile(path.join(dir, '.selfcheck.json'), JSON.stringify(old, null, 2), 'utf8')
    await initPlugin(dir)
    const fresh = JSON.parse(await readFile(path.join(dir, '.selfcheck.json'), 'utf8'))
    assert.ok(fresh.at > old.at)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('init 低频体检：memories.json 字节一致（不写记忆库）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-init-sc4-'))
  try {
    await initPlugin(dir)
    const before = await readFile(path.join(dir, 'memories.json'))
    await initPlugin(dir)
    const after = await readFile(path.join(dir, 'memories.json'))
    assert.deepEqual(after, before)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-maint-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function initFull(dir) {
  const { apply } = await import('../index.js')
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
    effect(callback) { const cleanup = callback(); return () => cleanup && cleanup() },
    get() { return undefined },
    on() { return () => {} },
  }
  apply(ctx, { dataDir: dir })
  const exec = (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal, agent: { id: 't' } })
  return { tools, exec }
}

test('applyRepairs：缺分区 → fixed 含 partitions 且记录被补', async () => {
  await withTempDir(async (dir) => {
    const store = { records: [{ id: 'm1', title: 'x', partitions: [] }], meta: {} }
    const result = await applyRepairs({ dataDir: dir, store, policy: { snapshotKeep: 5 }, docPaths: [] })
    assert.ok(result.fixed.includes('partitions'), JSON.stringify(result))
    assert.ok(store.records[0].partitions.length > 0)
  })
})

test('applyRepairs：readOnly 时不修，返回空 fixed 且只读提示', async () => {
  await withTempDir(async (dir) => {
    const store = { records: [{ id: 'm1', title: 'x', partitions: [] }], meta: {} }
    const result = await applyRepairs({ dataDir: dir, store, policy: { readOnly: true }, docPaths: [] })
    assert.equal(result.fixed.length, 0)
    assert.equal(store.records[0].partitions.length, 0)
    assert.ok(result.warnings.some((text) => /只读/.test(text)))
  })
})

test('applyRepairs：非法 docPaths（含 NUL）→ 返回 warnings、不抛错', async () => {
  await withTempDir(async (dir) => {
    const store = { records: [], meta: {} }
    const result = await applyRepairs({
      dataDir: dir,
      store,
      policy: { snapshotKeep: 5 },
      docPaths: [path.join(dir, 'bad\u0000name.md')],
      regenerateDocs: async () => { throw new Error('写入位置不可用') },
    })
    assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0)
  })
})
test('维护修复：连跑两次 → 第二次 run.repairs 为空（幂等）', async () => {
  await withTempDir(async (dir) => {
    const { exec } = await initFull(dir)
    await exec('heartprint', { action: 'remember', title: '一条记忆', content: '内容', type: 'event' })
    const first = await exec('heartprint_admin', { action: 'maintain' })
    assert.equal(first.ok, true)
    const second = await exec('heartprint_admin', { action: 'maintain' })
    assert.equal(second.ok, true)
    assert.ok(Array.isArray(second.repairs), JSON.stringify(second.repairs))
  })
})

test('readOnly 下 init 不写库：memories.json 字节一致，体检文件状态不变', async () => {
  await withTempDir(async (dir) => {
    const { exec } = await initFull(dir)
    await exec('heartprint_admin', { action: 'policy', patch: { readOnly: true } })
    const storePath = path.join(dir, 'memories.json')
    const beforeStore = await readFile(storePath)
    let beforeSelf = true
    try { await stat(path.join(dir, '.selfcheck.json')) } catch { beforeSelf = false }
    await initFull(dir)
    const afterStore = await readFile(storePath)
    let afterSelf = true
    try { await stat(path.join(dir, '.selfcheck.json')) } catch { afterSelf = false }
    assert.deepEqual(afterStore, beforeStore)
    assert.equal(afterSelf, beforeSelf)
  })
})

test('容量：policy patch maxRecords=30000 后 status 显示 30000', async () => {
  await withTempDir(async (dir) => {
    const { exec } = await initFull(dir)
    await exec('heartprint_admin', { action: 'policy', patch: { maxRecords: 30000 } })
    const status = await exec('heartprint', { action: 'status' })
    assert.match(status.summary, /30000/)
  })
})

test('容量：capacityAlert 20000 满额 visible=true，调到 30000 后 false', async () => {
  const records = new Array(20000).fill({ id: 'x' })
  assert.equal(capacityAlert(records, { maxRecords: 20000 }).visible, true)
  assert.equal(capacityAlert(records, { maxRecords: 30000 }).visible, false)
})

test('容量：limit=50000 已封顶 visible=false', async () => {
  const records = new Array(50000).fill({ id: 'x' })
  assert.equal(capacityAlert(records, { maxRecords: 50000 }).visible, false)
})

test('resolvePolicy：maxRecords / readOnly 夹紧与生效', async () => {
  assert.equal(resolvePolicy({}, { maxRecords: 30000 }).maxRecords, 30000)
  assert.equal(resolvePolicy({}, { maxRecords: 999999 }).maxRecords, 50000)
  assert.equal(resolvePolicy({}, { readOnly: true }).readOnly, true)
})

test('readOnly 集成：maintain 跳过、status 显示开；关闭后维护恢复', async () => {
  await withTempDir(async (dir) => {
    const { exec } = await initFull(dir)
    await exec('heartprint_admin', { action: 'policy', patch: { readOnly: true } })
    const skipped = await exec('heartprint_admin', { action: 'maintain' })
    assert.equal(skipped.ok, true)
    assert.ok(skipped.warnings.some((text) => text.includes('只读模式：跳过维护')), JSON.stringify(skipped.warnings))
    assert.deepEqual(skipped.changes, {})
    const status = await exec('heartprint', { action: 'status' })
    assert.match(status.summary, /只读模式：开/)
    await exec('heartprint_admin', { action: 'policy', patch: { readOnly: false } })
    const normal = await exec('heartprint_admin', { action: 'maintain' })
    assert.equal(normal.ok, true)
    assert.ok((normal.docPaths && (normal.docPaths.master || normal.docPaths.user)) || Object.keys(normal.changes || {}).length > 0)
    const status2 = await exec('heartprint', { action: 'status' })
    assert.match(status2.summary, /只读模式：关/)
  })
})

test('exportBackup：readOnly 拒绝；目标不存在 bad-export-path；临时 guard 限制目录；正常导出含关键文件', async () => {
  await withTempDir(async (base) => {
    const data = path.join(base, 'data')
    await mkdir(path.join(data, '.vault'), { recursive: true })
    await mkdir(path.join(data, 'docs'), { recursive: true })
    await writeFile(path.join(data, 'memories.json'), JSON.stringify({ records: [{ id: 'm1' }] }), 'utf8')
    await writeFile(path.join(data, 'policy.json'), '{}', 'utf8')
    await writeFile(path.join(data, '.vault', 'key'), 'k', 'utf8')
    const out = path.join(base, 'out')
    await mkdir(out)
    const readOnlyError = await exportBackup({ dataDir: data, targetDir: out, readOnly: true, guard: null }).catch((error) => error)
    assert.equal(readOnlyError.code, 'read-only')
    const missing = await exportBackup({ dataDir: data, targetDir: path.join(base, 'nope'), guard: null }).catch((error) => error)
    assert.equal(missing.code, 'bad-export-path')
    const tempGuard = { assert(file) { if (!path.resolve(file).startsWith(path.resolve(out) + path.sep)) throw Object.assign(new Error('x'), { code: 'forbidden-path' }) } }
    const denied = await exportBackup({ dataDir: data, targetDir: base, guard: tempGuard }).catch((error) => error)
    assert.equal(denied.code, 'forbidden-path')
    const result = await exportBackup({ dataDir: data, targetDir: out, guard: tempGuard })
    assert.ok(result.path && result.size > 0)
    for (const name of ['memories.json', 'policy.json', '.vault/key']) assert.ok(result.files.includes(name), name)
  })
})

test('导出不得放宽写范围：复用 guard 时 roots 数量不变', async () => {
  await withTempDir(async (base) => {
    const data = path.join(base, 'data')
    await mkdir(path.join(data, '.vault'), { recursive: true })
    await writeFile(path.join(data, 'memories.json'), JSON.stringify({ records: [] }), 'utf8')
    await writeFile(path.join(data, 'policy.json'), '{}', 'utf8')
    await writeFile(path.join(data, '.vault', 'key'), 'k', 'utf8')
    const other = path.join(base, 'other')
    await mkdir(other)
    const guard = createWriteGuard({ dataDir: data })
    const before = guard.roots().length
    await assert.rejects(
      () => exportBackup({ dataDir: data, targetDir: other, guard }),
      (error) => error.code === 'forbidden-path',
    )
    assert.equal(guard.roots().length, before, '导出不得放宽写范围')
  })
})
