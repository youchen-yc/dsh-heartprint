#!/usr/bin/env node
/**
 * 生成 CycloneDX 1.5 SBOM（无第三方依赖）。
 *
 * 产物：仓库根目录的 `sbom.cdx.json`，包含：
 *  - 包元数据（名称、版本、许可证、purl）
 *  - 发布清单里每个文件的 SHA-256（哈希锁定发布内容）
 *  - 运行环境要求（node / dsh）与「不联网」声明
 *
 * `--check` 只比对磁盘上的 SBOM 与当前代码是否一致，不写文件；
 * 用于 CI 保证「发布的 SBOM 就是这次代码的 SBOM」。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

function expand(pattern) {
  if (!pattern.includes('*')) return [pattern]
  const dir = path.posix.dirname(pattern)
  const ext = path.posix.extname(pattern)
  return readdirSync(path.join(root, dir))
    .filter((name) => name.endsWith(ext))
    .map((name) => `${dir}/${name}`)
}

const rels = [...new Set((pkg.files || []).flatMap(expand))]
  .filter((rel) => existsSync(path.join(root, rel)))
  .sort()

const files = rels.map((rel) => {
  const content = readFileSync(path.join(root, rel))
  return {
    rel,
    hash: createHash('sha256').update(content).digest('hex'),
    size: content.length,
  }
})

const ref = `pkg:npm/${pkg.name}@${pkg.version}`
// 序列号种子：用 JSON 结构代替字符串拼接（这里只是哈希输入，不是 SQL；
// 但保持「不拼字符串」的统一风格，也避免静态扫描误判）。
const seed = JSON.stringify({ name: pkg.name, version: pkg.version, files: files.map((file) => file.hash) })
const serial = createHash('sha256').update(seed).digest('hex')
const uuid = serial.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5')
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${uuid}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'heartprint', name: 'scripts/sbom.mjs', version: pkg.version }],
    component: {
      type: 'application',
      'bom-ref': ref,
      name: pkg.name,
      version: pkg.version,
      licenses: [{ license: { id: pkg.license || 'MIT' } }],
      purl: ref,
      properties: [
        { name: 'dsh.bundle.patch', value: pkg.dsh?.bundle?.patch || '' },
        { name: 'engines.node', value: pkg.engines?.node || '' },
        { name: 'engines.dsh', value: pkg.engines?.dsh || '' },
        { name: 'network', value: 'none: no outbound connections, no telemetry' },
      ],
    },
  },
  components: files.map((file) => ({
    type: 'file',
    'bom-ref': `file:${file.rel}`,
    name: file.rel,
    version: pkg.version,
    hashes: [{ alg: 'SHA-256', content: file.hash }],
    properties: [{ name: 'size', value: String(file.size) }],
  })),
  dependencies: [{ ref, dependsOn: files.map((file) => `file:${file.rel}`) }],
}

const outPath = path.join(root, 'sbom.cdx.json')
const text = `${JSON.stringify(sbom, null, 2)}\n`

if (process.argv.includes('--check')) {
  if (!existsSync(outPath)) {
    console.error('[sbom] 缺少 sbom.cdx.json，请先运行 npm run sbom')
    process.exit(1)
  }
  const strip = (value) => JSON.stringify({ ...value, metadata: { ...value.metadata, timestamp: undefined } })
  if (strip(JSON.parse(readFileSync(outPath, 'utf8'))) !== strip(sbom)) {
    console.error('[sbom] sbom.cdx.json 与当前代码不一致，请重新生成：npm run sbom')
    process.exit(1)
  }
  console.log(`[sbom] 一致：${files.length} 个文件`)
  process.exit(0)
}

writeFileSync(outPath, text, 'utf8')
console.log(`[sbom] 已生成 ${outPath}（${files.length} 个文件）`)
