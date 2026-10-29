import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../index.js'
import { createStore } from '../lib/store.js'
import { sanitizePersonaName } from '../lib/policy.js'

const ORIGIN = 'http://127.0.0.1:59999'

function makeRequest({ method = 'GET', url = '/dsh-heartprint/api/state', headers = {}, body = '', remoteAddress = '127.0.0.1' } = {}) {
  const stream = Readable.from(body ? [Buffer.from(body, 'utf8')] : [])
  stream.method = method
  stream.url = url
  stream.headers = headers
  stream.socket = { remoteAddress }
  return stream
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers = {}) {
      this.statusCode = code
      this.headers = headers
      return this
    },
    end(chunk) {
      this.body = chunk === undefined || chunk === null ? '' : String(chunk)
    },
  }
}

/** 装插件并把设置页 API 的 handler 抓出来。 */
async function boot({ consent = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'heartprint-security-'))
  const handlers = []
  const webServer = {
    getOrigin: () => ORIGIN,
    register(definition) {
      handlers.push(definition)
      return () => {}
    },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    webServer,
    tools: { register: () => () => {} },
    effect(callback) {
      const cleanup = callback()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    inject(names, callback) {
      callback(ctx)
    },
    on() {
      return () => {}
    },
  }
  apply(ctx, { dataDir: dir })
  assert.equal(handlers.length, 1, '设置页 API 应该注册一个 prefix handler')
  const handler = handlers[0].handler
  const invoke = async (options) => {
    const req = makeRequest(options)
    const res = makeResponse()
    await handler(req, res)
    return res
  }
  if (consent) {
    await invoke({
      method: 'POST',
      url: '/dsh-heartprint/api/consent',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    })
  }
  return { dir, invoke }
}

async function cleanup(dir) {
  // 插件启动时的维护任务可能还在写盘，删目录时多试几次。
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

const sameOriginHeaders = (extra = {}) => ({
  origin: ORIGIN,
  'sec-fetch-site': 'same-origin',
  ...extra,
})

test('设置接口：同源 GET 正常返回，并带安全响应头', async () => {
  const { dir, invoke } = await boot()
  try {
    const res = await invoke({ headers: sameOriginHeaders() })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(JSON.parse(res.body).ok, true)
  } finally {
    await cleanup(dir)
  }
})

test('设置接口：跨站 / 跨源 / 非回环一律拒绝', async () => {
  const { dir, invoke } = await boot()
  try {
    const crossSite = await invoke({ headers: sameOriginHeaders({ 'sec-fetch-site': 'cross-site' }) })
    assert.equal(crossSite.statusCode, 403)

    const crossOrigin = await invoke({ headers: { origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' } })
    assert.equal(crossOrigin.statusCode, 403)

    // 没有 Origin 时只相信回环地址
    const remote = await invoke({ remoteAddress: '192.168.1.20' })
    assert.equal(remote.statusCode, 403)
  } finally {
    await cleanup(dir)
  }
})

test('设置接口：未知路径 404、方法不对 405、非 JSON 415、超大请求体 413', async () => {
  const { dir, invoke } = await boot()
  try {
    const unknown = await invoke({ url: '/dsh-heartprint/api/nope', headers: sameOriginHeaders() })
    assert.equal(unknown.statusCode, 404)

    const wrongMethod = await invoke({
      method: 'GET',
      url: '/dsh-heartprint/api/policy',
      headers: sameOriginHeaders(),
    })
    assert.equal(wrongMethod.statusCode, 405)
    assert.equal(JSON.parse(wrongMethod.body).error.code, 'method-not-allowed')

    // 跨站表单的「简单请求」就是 text/plain，必须挡掉
    const plain = await invoke({
      method: 'POST',
      url: '/dsh-heartprint/api/policy',
      headers: sameOriginHeaders({ 'content-type': 'text/plain' }),
      body: JSON.stringify({ patch: { personaName: 'x' } }),
    })
    assert.equal(plain.statusCode, 415)

    const huge = await invoke({
      method: 'POST',
      url: '/dsh-heartprint/api/policy',
      headers: sameOriginHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ patch: { personaName: 'x'.repeat(70 * 1024) } }),
    })
    assert.equal(huge.statusCode, 413)
  } finally {
    await cleanup(dir)
  }
})

test('设置接口：写操作限流，60 秒内超过 20 次返回 429', async () => {
  const { dir, invoke } = await boot()
  try {
    let last = null
    for (let i = 0; i < 21; i += 1) {
      last = await invoke({
        method: 'POST',
        url: '/dsh-heartprint/api/policy',
        headers: sameOriginHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ patch: { personaName: `名字${i}` } }),
      })
    }
    assert.equal(last.statusCode, 429)
    assert.equal(last.headers['retry-after'], '60')
  } finally {
    await cleanup(dir)
  }
})

test('名字会进文件名：路径分隔符与 ../ 被净化，不能穿越目录', async () => {
  assert.equal(sanitizePersonaName('../../etc/passwd'), 'etcpasswd')
  assert.equal(sanitizePersonaName('..\\..\\win.ini'), 'win.ini')
  assert.equal(sanitizePersonaName('a/b\\c'), 'abc')
  assert.equal(sanitizePersonaName('C:evil'), 'Cevil')
  assert.equal(sanitizePersonaName('鲸進進'), '鲸進進')

  const { dir, invoke } = await boot()
  try {
    await invoke({
      method: 'POST',
      url: '/dsh-heartprint/api/policy',
      headers: sameOriginHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ patch: { personaName: '../../evil' } }),
    })
    const state = await invoke({ headers: sameOriginHeaders() })
    assert.equal(JSON.parse(state.body).policy.personaName, 'evil')
  } finally {
    await cleanup(dir)
  }
})

test('交付目标路径拒绝 NUL 字符', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'heartprint-target-'))
  try {
    const store = createStore({ dataDir: dir })
    await assert.rejects(() => store.writeUserCopy('bad\u0000name.md', 'x'))
  } finally {
    await cleanup(dir)
  }
})

test('首次使用必须先点「开始使用」：未同意前状态只读、写接口被拒，同意后正常', async () => {
  const { dir, invoke } = await boot({ consent: false })
  try {
    const before = await invoke({ headers: sameOriginHeaders() })
    assert.equal(before.statusCode, 200)
    assert.equal(JSON.parse(before.body).consent, false)

    const denied = await invoke({
      method: 'POST',
      url: '/dsh-heartprint/api/policy',
      headers: sameOriginHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ patch: { personaName: '小鲸' } }),
    })
    assert.equal(denied.statusCode, 403)
    assert.equal(JSON.parse(denied.body).error.code, 'consent-required')

    const granted = await invoke({
      method: 'POST',
      url: '/dsh-heartprint/api/consent',
      headers: sameOriginHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    })
    assert.equal(granted.statusCode, 200)
    assert.equal(JSON.parse(granted.body).consent, true)

    const after = await invoke({ headers: sameOriginHeaders() })
    assert.equal(JSON.parse(after.body).consent, true)
    assert.equal(JSON.parse(after.body).policy.personaName, '')
  } finally {
    await cleanup(dir)
  }
})
