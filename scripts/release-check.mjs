#!/usr/bin/env node
/**
 * 发布前检查（npm prepublishOnly 调用）。
 *
 * 规则（release-policy.json）：
 *   legacyWarning.remainingReleases > 0 时，README 里必须原样包含那条加粗的旧版本安全提示。
 * 这样「连续 3 次新版本都带提示」不依赖人的记忆：提示被删掉就发布不出去。
 *
 * `--decrement` 用于发布成功后把 remainingReleases 减 1。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const policyPath = path.join(root, 'release-policy.json')
const readmePath = path.join(root, 'README.md')

const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
const warning = policy.legacyWarning || {}

if (process.argv.includes('--decrement')) {
  const remaining = Math.max(0, Number(warning.remainingReleases) || 0)
  warning.remainingReleases = Math.max(0, remaining - 1)
  policy.legacyWarning = warning
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8')
  console.log(`[release-check] 已把剩余提示次数减为 ${warning.remainingReleases}`)
  process.exit(0)
}

const remaining = Number(warning.remainingReleases) || 0
if (remaining <= 0) {
  console.log('[release-check] 旧版本提示次数已用完，不再强制检查')
  process.exit(0)
}

const readme = readFileSync(readmePath, 'utf8')
if (!readme.includes(warning.text)) {
  console.error('[release-check] 发布被拦截：README 缺少旧版本安全提示。')
  console.error(`  还需要在接下来 ${remaining} 个新版本的说明里保留这条加粗提示：`)
  console.error(`  ${warning.text}`)
  process.exit(1)
}
console.log(`[release-check] 通过：旧版本安全提示在位，还需保留 ${remaining} 个新版本`)
