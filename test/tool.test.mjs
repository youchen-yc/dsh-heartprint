import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

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
  assert.ok(definition, `tool ${name} should be registered`)
  return definition.execute(args, { signal: new AbortController().signal, agent: { id: 'test-session' } })
}

test('the plugin registers its tools and runs a full remember → recall → doc → deliver flow', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'heartprint-tool-'))
  try {
    const { ctx, tools } = createContext()
    apply(ctx, { dataDir: dir })
    assert.ok(tools.has('heartprint'))
    assert.ok(tools.has('heartprint_admin'))

    const remembered = await call(tools, 'heartprint', {
      action: 'remember',
      title: '第一次把记忆交给插件',
      content: '用户请我做一套会淡忘的性格情感记忆，我把第一个节点写进了文档。',
      feeling: '被认真托付的感觉，很郑重，也有一点暖。',
      type: 'turning_point',
      importance: 92,
    })
    assert.equal(remembered.ok, true)
    assert.match(remembered.summary, /已记住/)

    const recalled = await call(tools, 'heartprint', { action: 'recall', query: '记忆' })
    assert.equal(recalled.ok, true)
    assert.ok(recalled.results.length >= 1)
    assert.match(recalled.results[0].title, /记忆/)

    const profile = await call(tools, 'heartprint', { action: 'profile' })
    assert.equal(profile.ok, true)
    assert.match(profile.summary, /性格|情感|特殊事件/)

    const master = await call(tools, 'heartprint_admin', { action: 'doc', which: 'master', full: true })
    assert.equal(master.ok, true)
    assert.match(master.content, /心印 · 记忆文档/)
    assert.match(master.content, /第一次把记忆交给插件/)

    const user = await call(tools, 'heartprint_admin', { action: 'doc', which: 'user', full: true })
    assert.equal(user.ok, true)
    // 两版都包含同一条记忆（内容没有丢），一～六节记忆正文逐字一致；
    // 差异只在第七节维护状态（master 保留内部文档行、user 已净化）与 footer 哈希。
    assert.match(user.content, /第一次把记忆交给插件/)
    const memoryBodyOf = (text) => text.slice(text.indexOf('## 一、性格核心'), text.indexOf('## 七、维护状态'))
    assert.equal(memoryBodyOf(master.content), memoryBodyOf(user.content))
    const hashOf = (text) => ((/heartprint:body=([0-9a-f]+)/.exec(text)) || [])[1]
    assert.ok(hashOf(master.content), 'master 文档应带正文哈希')
    assert.ok(hashOf(user.content), 'user 文档应带正文哈希')
    assert.notEqual(hashOf(master.content), hashOf(user.content), '两版正文不同，footer 哈希也应不同')

    // 内部身份只留在 master；user 版不泄露其它文档的存在。
    assert.match(master.content, /主文档/)
    assert.match(master.content, /用户副本/)
    assert.match(user.content, /持有一方：你/)
    for (const needle of ['主文档', '用户副本', '副本', '第三份', '加密', '隐藏', '快照', '.vault', '归档']) {
      assert.equal(user.content.includes(needle), false, `用户副本不应泄露「${needle}」`)
    }

    const delivered = await call(tools, 'heartprint_admin', {
      action: 'deliver',
      path: path.join(dir, '交付', '记忆文档.md'),
    })
    assert.equal(delivered.ok, true)
    assert.ok((await stat(delivered.path)).isFile())
    // 交付时要让用户知道这份文档是什么、有多重要（新文案不再出现「重要性」字样，
    // 但「陪伴记录 / 重要特殊事件 / 完整的一份」这层意思必须还在）。
    assert.match(delivered.summary, /陪伴记录/)
    assert.match(delivered.summary, /重要特殊事件/)
    assert.match(delivered.summary, /完整的一份/)

    const status = await call(tools, 'heartprint', { action: 'status' })
    assert.equal(status.ok, true)
    assert.equal(status.disclosure, 'disclosed')
    assert.ok(status.documents.master)
    assert.ok(status.vault.snapshots >= 1)

    const vault = await call(tools, 'heartprint_admin', { action: 'vault' })
    assert.equal(vault.ok, true)
    assert.equal(vault.passphraseSet, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('policy patches move the forgetting dates without touching the presets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'heartprint-policy-'))
  try {
    const { ctx, tools } = createContext()
    apply(ctx, { dataDir: dir })
    const patched = await call(tools, 'heartprint_admin', {
      action: 'policy',
      patch: { layers: [{ id: 'halfyear', afterDays: 120 }], syncIntervalDays: 45 },
    })
    assert.equal(patched.ok, true)
    assert.equal(patched.policy.syncIntervalDays, 45)
    const halfyear = patched.policy.layers.find((layer) => layer.id === 'halfyear')
    assert.equal(halfyear.afterDays, 120)
    const fresh = patched.policy.layers.find((layer) => layer.id === 'fresh')
    assert.equal(fresh.afterDays, 0)

    const pass = await call(tools, 'heartprint_admin', { action: 'policy', passphrase: '心印口令' })
    assert.equal(pass.ok, true)
    assert.equal(pass.policy.passphraseSet, true)

    const wrong = await call(tools, 'heartprint_admin', { action: 'vault', mode: 'reveal', passphrase: '不对' })
    assert.equal(wrong.ok, false)
    assert.equal(wrong.error.code, 'passphrase-wrong')

    const reveal = await call(tools, 'heartprint_admin', { action: 'vault', mode: 'reveal', passphrase: '心印口令' })
    assert.equal(reveal.ok, true)
    assert.equal(reveal.unlocked, true)

    const stored = JSON.parse(await readFile(path.join(dir, 'policy.json'), 'utf8'))
    assert.equal(stored.vaultPassHash.length > 0, true)
    assert.equal(Object.hasOwn(stored, 'vaultPassphrase'), false, 'plaintext passphrase is never persisted')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
