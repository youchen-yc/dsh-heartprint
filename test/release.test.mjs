import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const policy = JSON.parse(readFileSync(path.join(root, 'release-policy.json'), 'utf8'))
const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
const warning = policy.legacyWarning

test('发布说明必须带「旧版本不安全」的加粗提示（连续 3 个版本）', () => {
  assert.ok(warning, 'release-policy.json 必须有 legacyWarning')
  assert.equal(warning.sinceVersion, '1.1.0')
  assert.ok(warning.remainingReleases >= 1, '至少还应有 1 个版本需要保留提示')
  assert.match(warning.text, /^\*\*/, '提示必须以 ** 开头（加粗）')
  assert.match(warning.text, /\*\*$/, '提示必须以 ** 结尾（加粗）')
  assert.match(warning.text, /1\.1\.0 之前/)
  assert.ok(readme.includes(warning.text), 'README（即 npm 说明与仓库首页）必须原样包含这条提示')
})

test('README 顶部的提示出现在正文最前面，用户一眼能看到', () => {
  const head = readme.slice(0, 1200)
  assert.ok(head.includes(warning.text), '提示必须在 README 前 1200 字符内')
})

test('prepublishOnly 会跑发布检查，缺提示时发布会被拦下', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.prepublishOnly, 'node scripts/release-check.mjs')
  const output = execFileSync(process.execPath, [path.join(root, 'scripts/release-check.mjs')], { encoding: 'utf8' })
  assert.match(output, /通过/)
})
