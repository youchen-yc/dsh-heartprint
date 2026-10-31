import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

function makeCtx() {
  const tools = new Map()
  const contexts = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
    effect(callback) { const cleanup = callback(); return () => cleanup && cleanup() },
    get(name) { return name === 'systemPrompt' ? { context(entry) { contexts.push(entry); return () => {} } } : undefined },
    on() { return () => {} },
  }
  return { ctx, tools, contexts }
}

const call = (tools, name, args) => tools.get(name).execute(args, { signal: new AbortController().signal, agent: { id: 'restore-test' } })

test('交付文档按记忆分区分组（master 与用户副本都有分区视图）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-partition-doc-'))
  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, { dataDir: dir })
    await call(tools, 'heartprint', { action: 'remember', title: '一次经历', content: '路上的事。', type: 'event' })
    await call(tools, 'heartprint', { action: 'remember', title: '一条领悟', content: '做事先列清单。', type: 'insight' })
    for (const which of ['master', 'user']) {
      const doc = await call(tools, 'heartprint_admin', { action: 'doc', which, full: true })
      assert.match(doc.content, /## 分区视图（按记忆分区）/, `${which} 应有分区视图`)
      assert.match(doc.content, /### 情景记忆区（\d+ 条）/)
      assert.match(doc.content, /### 语义记忆区（\d+ 条）/)
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('读档（备份文件）：恢复丢失记忆、重算分区、内容与分区正确、库不损坏', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-restore-backup-'))
  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, { dataDir: dir })
    await call(tools, 'heartprint', { action: 'remember', title: '性格底色', content: '善良、认真。', type: 'personality', importance: 90 })
    await call(tools, 'heartprint', { action: 'remember', title: '一次害怕', content: '当时很怕。', feeling: '害怕', type: 'pain', importance: 80 })
    await call(tools, 'heartprint', { action: 'remember', title: '一条经验', content: '做事先列清单。', type: 'insight', importance: 60 })

    // 把当前记忆库复制成备份文件（模拟用户自己留的档）
    const backupPath = path.join(dir, 'backup.json')
    await copyFile(path.join(dir, 'memories.json'), backupPath)

    // 模拟丢失：删掉其中一条，再重新加载插件
    const store = JSON.parse(await readFile(path.join(dir, 'memories.json'), 'utf8'))
    const lost = store.records.find((record) => record.title === '一条经验')
    store.records = store.records.filter((record) => record.id !== lost.id)
    await writeFile(path.join(dir, 'memories.json'), JSON.stringify(store), 'utf8')

    const second = makeCtx()
    apply(second.ctx, { dataDir: dir })
    const restore = await call(second.tools, 'heartprint_admin', { action: 'restore', source: 'backup', path: backupPath, confirm: true })
    assert.equal(restore.ok, true)
    assert.equal(restore.afterCount, 3)
    assert.ok(restore.added >= 1)
    assert.ok(restore.summary.includes('读档完成'))

    const restored = JSON.parse(await readFile(path.join(dir, 'memories.json'), 'utf8'))
    const record = restored.records.find((item) => item.id === lost.id)
    assert.ok(record, '丢失的记忆应被读档恢复')
    assert.match(record.content, /列清单/)
    assert.deepEqual(record.partitions, ['semantic'], '读档后分区应重新计算正确')

    const status = await call(second.tools, 'heartprint', { action: 'status' })
    assert.equal(status.ok, true)
    assert.match(status.summary, /记录 3 条/)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('读档（加密档案）：按 id 恢复再巩固之前的原文', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-restore-archive-'))
  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, { dataDir: dir })
    const remembered = await call(tools, 'heartprint', { action: 'remember', title: '一次见面', content: '原文：说下午见。', type: 'event' })
    const id = remembered.record.id
    await call(tools, 'heartprint', { action: 'reconsolidate', id, content: '改写：其实晚上见。' })

    const restore = await call(tools, 'heartprint_admin', { action: 'restore', source: 'archive', id, confirm: true })
    assert.equal(restore.ok, true)

    const recall = await call(tools, 'heartprint', { action: 'recall', query: '见面' })
    assert.equal(recall.ok, true)
    const doc = await call(tools, 'heartprint_admin', { action: 'doc', which: 'master', full: true })
    assert.match(doc.content, /原文：说下午见/, '读档应把加密档案里的原文恢复回来')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('读档防护：路径越界被拒、非法 JSON 被拒、不存在 id 被拒', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-restore-guard-'))
  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, { dataDir: dir })
    const outside = await call(tools, 'heartprint_admin', { action: 'restore', source: 'backup', path: 'C:/Windows/win.ini' })
    assert.equal(outside.ok, false)
    assert.equal(outside.error.code, 'forbidden-path')

    const badFile = path.join(dir, 'bad.json')
    await writeFile(badFile, 'not json', 'utf8')
    const bad = await call(tools, 'heartprint_admin', { action: 'restore', source: 'backup', path: badFile })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'bad-backup')

    const missing = await call(tools, 'heartprint_admin', { action: 'restore', source: 'archive', id: 'nope' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'not-found')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('读档（交付文档）：能从交付文档完整读回全部记忆，分区正确', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-restore-doc-'))
  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, { dataDir: dir })
    await call(tools, 'heartprint', { action: 'remember', title: '性格底色', content: '善良、认真。', type: 'personality', importance: 90 })
    await call(tools, 'heartprint', { action: 'remember', title: '一次害怕', content: '当时很怕。', feeling: '害怕', type: 'pain', importance: 80 })
    await call(tools, 'heartprint', { action: 'remember', title: '一条经验', content: '做事先列清单。', type: 'insight', importance: 60 })

    const docPath = path.join(dir, 'docs', '心印·记忆文档.md')
    const doc = await readFile(docPath, 'utf8')
    assert.match(doc, /<!-- heartprint:records:begin -->/, '交付文档应带读档附录')
    assert.match(doc, /性格底色/)
    // 先留一份文档副本：清空记忆库后启动维护会把文档重写为空，真实用户手上那份才是读档来源
    const keptDoc = path.join(dir, '交付文档副本.md')
    await writeFile(keptDoc, doc, 'utf8')

    // 模拟丢失：清空记忆库后重新加载
    const store = JSON.parse(await readFile(path.join(dir, 'memories.json'), 'utf8'))
    store.records = []
    await writeFile(path.join(dir, 'memories.json'), JSON.stringify(store), 'utf8')

    const second = makeCtx()
    apply(second.ctx, { dataDir: dir })
    const restore = await call(second.tools, 'heartprint_admin', { action: 'restore', source: 'document', path: keptDoc, confirm: true })
    assert.equal(restore.ok, true)
    assert.equal(restore.afterCount, 3)
    assert.equal(restore.added, 3)

    const restored = JSON.parse(await readFile(path.join(dir, 'memories.json'), 'utf8'))
    const titles = restored.records.map((record) => record.title)
    for (const title of ['性格底色', '一次害怕', '一条经验']) assert.ok(titles.includes(title), `缺少 ${title}`)
    const byTitle = new Map(restored.records.map((record) => [record.title, record]))
    assert.deepEqual(byTitle.get('性格底色').partitions, ['self_narrative'])
    assert.deepEqual(byTitle.get('一次害怕').partitions, ['episodic', 'interoceptive'])
    assert.deepEqual(byTitle.get('一条经验').partitions, ['semantic'])

    const status = await call(second.tools, 'heartprint', { action: 'status' })
    assert.equal(status.ok, true)
    assert.match(status.summary, /记录 3 条/)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('读档防护（弱）：交付文档无附录被拒、空记录备份被拒', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hp-restore-guard2-'))
  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, { dataDir: dir })
    const plain = path.join(dir, 'plain.md')
    await writeFile(plain, '# 没有读档附录的文档\n', 'utf8')
    const noAppendix = await call(tools, 'heartprint_admin', { action: 'restore', source: 'document', path: plain })
    assert.equal(noAppendix.ok, false)
    assert.equal(noAppendix.error.code, 'bad-document')

    const empty = path.join(dir, 'empty.json')
    await writeFile(empty, JSON.stringify({ records: [] }), 'utf8')
    const nothing = await call(tools, 'heartprint_admin', { action: 'restore', source: 'backup', path: empty })
    assert.equal(nothing.ok, false)
    assert.equal(nothing.error.code, 'empty-restore')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
