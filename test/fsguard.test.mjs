import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { ScopeError, createWriteGuard } from '../lib/fsguard.js'

const DATA = path.resolve('C:/tmp/heartprint-data')
const DELIVERY = path.resolve('C:/tmp/delivery')

test('写入收口：只放行数据目录与已确认的交付目录', () => {
  const guard = createWriteGuard({ dataDir: DATA, getExtraRoots: () => [DELIVERY] })
  assert.equal(guard.allowed(path.join(DATA, 'memories.json')), true)
  assert.equal(guard.allowed(path.join(DATA, 'docs', 'x.md')), true)
  assert.equal(guard.allowed(path.join(DELIVERY, '心印.md')), true)
  assert.equal(guard.allowed(path.join(DATA, '..', 'outside.txt')), false)
  assert.equal(guard.allowed('C:/Windows/System32/config'), false)
  assert.equal(guard.allowed(path.join(DELIVERY, '..', 'outside', 'x.md')), false)
})

test('写入收口：越界写入抛 ESCOPE，不写盘', () => {
  const guard = createWriteGuard({ dataDir: DATA })
  assert.throws(() => guard.assert('C:/Windows/evil.txt', 'test-write'), (error) => {
    assert.ok(error instanceof ScopeError)
    assert.equal(error.code, 'ESCOPE')
    return true
  })
})

test('写入收口：交付目录是动态读取的（改配置后立即生效）', () => {
  let extra = []
  const guard = createWriteGuard({ dataDir: DATA, getExtraRoots: () => extra })
  assert.equal(guard.allowed(path.join(DELIVERY, 'a.md')), false)
  extra = [DELIVERY]
  assert.equal(guard.allowed(path.join(DELIVERY, 'a.md')), true)
})

test('写入收口：附加目录取值抛错时按默认拒绝处理', () => {
  const guard = createWriteGuard({ dataDir: DATA, getExtraRoots: () => { throw new Error('boom') } })
  assert.equal(guard.allowed(path.join(DATA, 'ok.json')), true)
  assert.equal(guard.allowed(path.join(DELIVERY, 'x.md')), false)
})
