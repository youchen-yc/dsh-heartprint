#!/usr/bin/env node
/**
 * 极简秘密扫描（无第三方依赖），CI 强制项 I-03 的一部分。
 * 扫描仓库中被 git 跟踪的文本文件，命中常见凭据前缀或私钥块就失败。
 * 误报可以用行内 `// pragma: allowlist-secret` 豁免。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

const PATTERNS = [
  { name: 'npm token', regex: /npm_[A-Za-z0-9]{30,}/ },
  { name: 'github token', regex: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'aws access key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'private key block', regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'generic api key assignment', regex: /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/i },
  { name: 'slack webhook', regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
]

const SKIP = /^(node_modules\/|\.git\/|sbom\.cdx\.json$)/

const listed = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => !SKIP.test(file))

const findings = []
for (const file of listed) {
  let text
  try {
    if (statSync(file).size > 2 * 1024 * 1024) continue
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (line.includes('allowlist-secret')) continue
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) findings.push({ file, line: index + 1, kind: pattern.name })
    }
  }
}

if (findings.length) {
  console.error(`[secret-scan] 发现 ${findings.length} 处疑似凭据：`)
  for (const finding of findings) console.error(`  ${finding.file}:${finding.line} (${finding.kind})`)
  process.exit(1)
}
console.log(`[secret-scan] 干净：扫描 ${listed.length} 个文件，无凭据命中`)
