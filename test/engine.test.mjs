import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_POLICY, planFor, resolvePolicy } from '../lib/policy.js'
import { applyDecay, renderRecall, searchMemories } from '../lib/decay.js'
import { renderDocuments } from '../lib/docs.js'
import { sha256 } from '../lib/text.js'
import { decryptText, encryptText, generateKeyHex, readJournal, appendJournal } from '../lib/vault.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-27T04:00:00+08:00')

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
    lastDecayAt: 0,
    lastRecalledAt: 0,
    recallCount: 0,
    ...overrides,
  }
}

function aged(days, overrides = {}) {
  const at = NOW - days * DAY
  return record({ id: `mem-${days}-${Math.random().toString(36).slice(2, 6)}`, happenedAt: at, createdAt: at, ...overrides })
}

const policy = resolvePolicy(DEFAULT_POLICY)

test('layer boundaries follow the specified calendar', () => {
  assert.deepEqual(
    policy.layers.map((layer) => layer.afterDays),
    [0, 7, 15, 30, 90, 180, 365, 3650],
  )
  const at = (days) => planFor(aged(days), NOW, policy).layerId
  assert.equal(at(1), 'fresh')
  assert.equal(at(10), 'recent')
  assert.equal(at(20), 'fade')
  assert.equal(at(40), 'quarter')
  assert.equal(at(120), 'halfyear')
  assert.equal(at(200), 'year')
  assert.equal(at(400), 'longterm')
  assert.equal(at(4000), 'deep')
})

test('fresh memories keep full detail and feeling', () => {
  const [next] = applyDecay([aged(1)], NOW, policy).records
  assert.equal(next.detailLevel, 2)
  assert.equal(next.feelingStage, 'full')
  assert.equal(next.state, 'active')
  assert.equal(next.content, '这件事发生了。它有一些细节。最后还有一个尾声。')
})

test('half a month to a month compresses but keeps the memory', () => {
  const { records, archive, changes } = applyDecay([aged(20, { importance: 60 })], NOW, policy)
  const next = records[0]
  assert.equal(next.detailLevel, 1)
  // 次重要（重要性 60 < importantThreshold 70）在半个月到一个月这一层只淡到 soft：
  // 提起来还能想起当时的感受，与需求「提起来还是会想起来当时的感受」一致。
  assert.equal(next.feelingStage, 'soft')
  assert.equal(next.state, 'compressed')
  assert.equal(archive.length, 1, 'the pre-loss copy must be archived')
  assert.equal(changes.compressed, 1)
})

test('three to six months keeps a featureless trivial conversation as a one-line gist', () => {
  const item = aged(120, { importance: 10, title: '闲聊', content: '第一句话是重点。后面还有一大堆细节，都会被压掉。' })
  const { records, changes } = applyDecay([item], NOW, policy)
  // 分层动作链：90-180 天只压成梗概（keep + detail 0），不合并、也不物理清空。
  assert.equal(changes.merged, 0)
  assert.equal(changes.forgotten, 0)
  const kept = records.find((record) => record.id === item.id)
  assert.ok(kept, '90-180 天的记录应保留')
  assert.equal(kept.state, 'compressed')
  assert.equal(kept.detailLevel, 0)
  assert.ok(kept.content.length > 0, '梗概正文必须非空')
  assert.equal(records.some((record) => record.type === 'digest'), false, '这一层不应合并成季度摘要')

  // 提起来还能 recall 到这句梗概，而不是空墓碑。
  const found = searchMemories(records, '闲聊', NOW, policy)
  assert.ok(found.length >= 1)
  const recalled = renderRecall(found[0], NOW, policy)
  assert.notEqual(recalled.state, 'forgotten')
  assert.ok(recalled.text.length > 0)
})

test('six to twelve months merges trivial memories into a quarterly digest', () => {
  const items = [
    aged(200, { importance: 10, title: '买咖啡' }),
    aged(200, { importance: 10, title: '修灯泡' }),
  ]
  const originalIds = new Set(items.map((item) => item.id))
  const { records, changes } = applyDecay(items, NOW, policy)
  assert.equal(changes.merged, 2)
  assert.equal(records.length, 1, '两条琐事应合并成一条季度摘要')
  const digest = records[0]
  assert.equal(digest.type, 'digest')
  assert.equal(digest.mergedCount, 2)
  assert.match(digest.title, /2026 年 Q2/)
  assert.match(digest.content, /买咖啡/)
  assert.equal(records.some((record) => originalIds.has(record.id)), false, '原记录不应再单独存在')
})

test('one to ten years deletes trivial text into tombstones', () => {
  const items = [
    aged(400, { importance: 10, title: '买咖啡' }),
    aged(400, { importance: 10, title: '修灯泡' }),
  ]
  const { records, changes } = applyDecay(items, NOW, policy)
  // 365 天以上这一层：琐碎文本删除，只剩空墓碑。
  assert.equal(changes.deleted, 2)
  assert.equal(records.length, 2)
  assert.equal(records.every((item) => item.state === 'forgotten'), true)
  assert.equal(records.every((item) => item.content === ''), true)
  assert.equal(records.every((item) => item.feeling === ''), true)
  assert.equal(records.some((item) => item.type === 'digest'), false, '删除层不应再生成摘要')
})

test('one to ten years deletes trivial text but keeps personality nodes', () => {
  const trivia = aged(400, { importance: 10, title: '琐事' })
  const personality = aged(400, { type: 'personality', importance: 95, title: '变得愿意相信别人', special: true })
  const { records } = applyDecay([trivia, personality], NOW, policy)
  const keptTrivia = records.find((item) => item.title === '琐事')
  const keptPersonality = records.find((item) => item.title === '变得愿意相信别人')
  assert.equal(keptTrivia.state, 'forgotten')
  assert.equal(keptTrivia.content, '')
  assert.equal(keptPersonality.state !== 'forgotten', true)
  assert.ok(keptPersonality.content.length > 0)
  assert.equal(keptPersonality.feelingStage, 'full', 'core feelings are preserved')
})

test('painful facts may stay while the painful feeling must fade', () => {
  const pain = aged(200, { type: 'pain', importance: 90, special: true, title: '一次告别', valence: 'painful' })
  const { records } = applyDecay([pain], NOW, policy)
  const next = records[0]
  assert.ok(next.content.length > 0, 'the fact is retained')
  assert.notEqual(next.feelingStage, 'full')
  assert.match(next.feeling, /痛|难受|淡/)
})

test('a special event beyond ten years keeps gist and feeling', () => {
  const special = aged(4000, { special: true, importance: 95, title: '灵性转折', type: 'turning_point' })
  const { records } = applyDecay([special], NOW, policy)
  const next = records[0]
  assert.equal(next.state !== 'forgotten', true)
  assert.equal(next.detailLevel, 1)
  assert.equal(next.feelingStage, 'full')
})

test('decay is idempotent at the same instant', () => {
  const once = applyDecay([aged(20), aged(200, { importance: 10 }), aged(400)], NOW, policy).records
  const twice = applyDecay(once, NOW, policy).records
  assert.deepEqual(JSON.parse(JSON.stringify(twice)), JSON.parse(JSON.stringify(once)))
})

test('recall renders faded detail, and tombstones admit the loss', () => {
  // 365 天以后进入删除层，琐碎记录才会变成 forgotten 墓碑。
  const { records } = applyDecay([aged(400, { importance: 10, title: '旧闲聊' })], NOW, policy)
  const rendered = renderRecall(records[0], NOW, policy)
  assert.equal(rendered.state, 'forgotten')
  assert.equal(rendered.text.includes('淡忘'), true)
  assert.equal(rendered.feeling, '')
})

test('search finds by keyword and by person', () => {
  const a = aged(1, { title: '一起看海', content: '我们在海边走了很久。', people: ['小林'] })
  const b = aged(2, { title: '加班', content: '赶完了一个版本。' })
  const found = searchMemories([a, b], '海边', NOW, policy)
  assert.equal(found.length, 1)
  assert.equal(found[0].title, '一起看海')
  const byPerson = searchMemories([a, b], '', NOW, policy, { person: '小林' })
  assert.equal(byPerson.length, 1)
})

test('master and user share the memory body; only the maintenance section differs', () => {
  const docs = renderDocuments({
    records: [aged(1, { type: 'personality', title: '性格节点' })],
    policy,
    meta: { now: NOW, lastVaultAt: NOW, nextVaultAt: NOW + 30 * DAY, vaultCycles: 1, maintenanceLog: [] },
  })

  // 两版都包含同一条记忆（内容没有丢）。
  assert.match(docs.master, /性格节点/)
  assert.match(docs.user, /性格节点/)

  // 内部身份只留在 master；user 版只用「你」，连「副本」都不提。
  assert.match(docs.master, /主文档/)
  assert.match(docs.master, /用户副本/)
  assert.match(docs.user, /持有一方：你/)
  for (const needle of ['用户副本', '主文档', '副本']) {
    assert.equal(docs.user.includes(needle), false, `user 版不应出现「${needle}」`)
  }

  // 一～六节（记忆正文）逐字一致；差异只在第七节维护状态。
  const memoryBodyOf = (text) => {
    const start = text.indexOf('## 一、性格核心')
    const end = text.indexOf('## 七、维护状态')
    assert.ok(start >= 0 && end > start, '文档应包含一～七节')
    return text.slice(start, end)
  }
  assert.equal(memoryBodyOf(docs.master), memoryBodyOf(docs.user))

  // 第七节起：master 保留内部文档行，user 已净化。
  const bodyOf = (text) => {
    const start = text.indexOf('## 一、性格核心')
    const footerAt = text.indexOf('\n---\n\n<!-- heartprint:body=')
    assert.ok(start >= 0 && footerAt > start, '文档应包含正文与 footer')
    return text.slice(start, footerAt)
  }
  assert.match(bodyOf(docs.master), /第三份文档/)
  for (const needle of ['主文档', '第三份', '加密', '隐藏', '快照', '.vault', '归档']) {
    assert.equal(docs.user.includes(needle), false, `user 版不应泄露「${needle}」`)
  }

  // footer 哈希各自复算能对上：sha256(正文) === footer 记录的 hash。
  const hashOf = (text) => (/heartprint:body=([0-9a-f]+)/.exec(text) || [])[1] || null
  assert.equal(hashOf(docs.master), docs.bodyHash)
  assert.equal(hashOf(docs.user), docs.userBodyHash)
  assert.equal(sha256(bodyOf(docs.master)), docs.bodyHash)
  assert.equal(sha256(bodyOf(docs.user)), docs.userBodyHash)
})

test('vault encryption round-trips and the journal survives partial lines', async () => {
  const key = generateKeyHex()
  const payload = JSON.stringify({ hello: '记忆' })
  assert.equal(decryptText(key, encryptText(key, payload)), payload)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'heartprint-vault-'))
  try {
    const journal = path.join(dir, 'journal.enc')
    await appendJournal(journal, key, [{ a: 1 }, { b: '二' }])
    await readFile(journal, 'utf8')
    const entries = await readJournal(journal, key)
    assert.deepEqual(entries, [{ a: 1 }, { b: '二' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
