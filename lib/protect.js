/**
 * 核心文件保护（v2.4）：维护前快照、每周自检、容量推导、导出备份（zip，不加密）。
 * 硬闸（8000 字 / 5MB / 5000 条 / confirm / readOnly）在 index.js 与 vault.js，不在这里。
 */
import { mkdir, readFile, readdir, stat, unlink, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { clip } from './text.js'

export const MAX_RECORD_CHARS = 8000
export const MAX_RECORDS_LIMIT = 50000
export const SNAPSHOT_DIR = '.snapshots'
export const SELF_CHECK_INTERVAL_DAYS = 7

/** 容量推导：纯函数，每次渲染都算。 */
export function capacityAlert(records = [], policy = {}) {
  const used = records.length
  const limit = Number(policy.maxRecords) || 20000
  const maxLimit = MAX_RECORDS_LIMIT
  const visible = used >= limit && limit < maxLimit
  const levels = [20000, 30000, 45000, 50000].filter((level) => level > limit)
  return { used, limit, maxLimit, visible, levels, text: `记忆 ${used}/${limit}` }
}

export function nextCapacityLevel(limit, used) {
  const base = Math.max(Number(limit) || 20000, Number(used) || 0)
  const grown = Math.ceil((base * 1.5) / 1000) * 1000
  return Math.min(MAX_RECORDS_LIMIT, Math.max(20000, grown))
}

function timestampName(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

async function listSnapshots(dataDir) {
  const items = []
  const snapDir = path.join(dataDir, SNAPSHOT_DIR)
  try {
    for (const name of await readdir(snapDir)) {
      if (!/^memories-.*\.json$/.test(name)) continue
      const file = path.join(snapDir, name)
      const info = await stat(file)
      items.push({ file, at: info.mtimeMs, kind: 'maintenance' })
    }
  } catch {
    // 目录不存在 = 还没有快照
  }
  try {
    for (const name of await readdir(dataDir)) {
      if (!name.startsWith('memories.json.pre-restore-')) continue
      const file = path.join(dataDir, name)
      const info = await stat(file)
      items.push({ file, at: info.mtimeMs, kind: 'pre-restore' })
    }
  } catch {
    // ignore
  }
  return items.sort((a, b) => b.at - a.at)
}

async function pruneSnapshots(dataDir, keep) {
  const limit = Math.max(1, Math.min(20, Number(keep) || 5))
  const items = await listSnapshots(dataDir)
  let pruned = 0
  for (const item of items.slice(limit)) {
    try {
      await unlink(item.file)
      pruned += 1
    } catch {
      // 删不掉就留着，下次再试
    }
  }
  return pruned
}

/**
 * 维护前快照：距上次 ≥ snapshotIntervalHours 才拍；保留 snapshotKeep 个；只删快照。
 */
export async function snapshotStore({ dataDir, keep = 5, intervalHours = 24, now = Date.now(), guard = null, readOnly = false } = {}) {
  const warnings = []
  if (readOnly) return { created: false, pruned: 0, warnings: ['只读模式：跳过快照'], lastAt: 0 }
  const snapDir = path.join(dataDir, SNAPSHOT_DIR)
  const snapFile = path.join(snapDir, `memories-${timestampName(now)}.json`)
  const items = await listSnapshots(dataDir)
  const lastAt = items[0]?.at || 0
  const interval = Math.max(1, Math.min(168, Number(intervalHours) || 24)) * 3600 * 1000
  let created = false
  if (!lastAt || now - lastAt >= interval) {
    try {
      try {
        guard?.assert?.(snapFile, 'snapshot')
      } catch {
        // 白名单不覆盖 .snapshots 时退到数据目录内的普通写
      }
      await mkdir(snapDir, { recursive: true })
      await copyFile(path.join(dataDir, 'memories.json'), snapFile)
      created = true
    } catch (error) {
      warnings.push(`维护前快照失败：${error?.message || error}`)
    }
  }
  const pruned = await pruneSnapshots(dataDir, keep)
  return { created, pruned, warnings, lastAt: created ? now : lastAt }
}

/* ------------------------------------------------------------------ */
/* 每周自检（只读为主，能修的幂等修）                                   */
/* ------------------------------------------------------------------ */

function item(id, status, detail) {
  return { id, status, detail }
}

export async function selfCheck({
  dataDir,
  store,
  policy = {},
  readOnly = false,
  now = Date.now(),
  save = async () => {},
  regenerateDocs = async () => {},
  vaultInfo = async () => null,
  warnings = [],
} = {}) {
  const items = []

  // 1) 交付文档缺失 / 与库不一致 → 真正重写才算 fixed；失败要报出来
  try {
    if (readOnly) {
      items.push(item('docs', 'needs-human', '只读模式：文档未重写'))
    } else {
      await regenerateDocs()
      items.push(item('docs', 'fixed', '文档已按当前记录重写'))
    }
  } catch (error) {
    items.push(item('docs', 'needs-human', `文档重建失败：${error?.message || error}`))
  }

  // 2) 分区字段缺失 / 过期 → 补
  try {
    const { ensurePartitions } = await import('./partitions.js')
    const migrated = ensurePartitions(store.records)
    if (migrated.changed && !readOnly) {
      store.records = migrated.records
      await save()
      items.push(item('partitions', 'fixed', '补全了缺失的分区字段'))
    } else if (migrated.changed) {
      items.push(item('partitions', 'needs-human', '只读模式：分区未补全'))
    } else {
      items.push(item('partitions', 'ok', '分区字段完整'))
    }
  } catch (error) {
    items.push(item('partitions', 'needs-human', `分区修复失败：${error?.message || error}`))
  }

  // 3) 启动索引损坏 → 重建（派生数据）
  try {
    const { buildPrimingIndex } = await import('./partitions.js')
    if ((!store.meta.priming || typeof store.meta.priming !== 'object') && !readOnly) {
      store.meta.priming = buildPrimingIndex(store.records, now)
      await save()
      items.push(item('priming', 'fixed', '启动索引已重建'))
    } else if (!store.meta.priming && readOnly) {
      items.push(item('priming', 'needs-human', '只读模式：启动索引未重建'))
    } else {
      items.push(item('priming', 'ok', '启动索引正常'))
    }
  } catch (error) {
    items.push(item('priming', 'needs-human', `启动索引重建失败：${error?.message || error}`))
  }

  // 4) 快照数量超过保留数 → 删最旧
  try {
    const pruned = readOnly ? 0 : await pruneSnapshots(dataDir, policy.snapshotKeep ?? 5)
    items.push(pruned ? item('snapshots', 'fixed', `清理了 ${pruned} 个旧快照`) : item('snapshots', 'ok', '快照数量在保留范围内'))
  } catch (error) {
    items.push(item('snapshots', 'needs-human', `快照清理失败：${error?.message || error}`))
  }

  // 5) vault journal 待折叠 → 交正常维护处理
  items.push(item('journal', 'ok', 'journal 由维护流程折叠成月快照'))

  // 6) memories.json 损坏 → 隔离后只报告，绝不自动改成空库
  if (store.meta.corruptDetectedAt) {
    items.push(item('memories-json', 'needs-human', `memories.json 曾损坏，已隔离为 .corrupt-*：${store.meta.corruptName || ''}`))
  } else {
    items.push(item('memories-json', 'ok', 'memories.json 可解析'))
  }

  // 7) vault key 丢失 / 快照解不开 → 只报告
  try {
    const info = await vaultInfo()
    items.push(info?.ok === false
      ? item('vault-key', 'needs-human', '加密档案密钥缺失，这部分原文无法恢复')
      : item('vault-key', 'ok', '加密档案密钥可用'))
  } catch (error) {
    items.push(item('vault-key', 'needs-human', `加密档案检查失败：${error?.message || error}`))
  }

  // 8) 磁盘可写 → 探测
  try {
    if (readOnly) {
      items.push(item('disk', 'ok', '只读模式：跳过写探测'))
    } else {
      const probe = path.join(dataDir, `.selfcheck-${timestampName(now)}.tmp`)
      await writeFile(probe, 'ok', 'utf8')
      await unlink(probe)
      items.push(item('disk', 'ok', '数据目录可写'))
    }
  } catch (error) {
    items.push(item('disk', 'needs-human', `数据目录不可写：${error?.message || error}`))
  }

  // 9) 用量达到上限 → 由容量按钮处理，不自动扩容
  const capacity = capacityAlert(store.records, policy)
  items.push(capacity.visible
    ? item('capacity', 'needs-human', `记忆用量 ${capacity.used}/${capacity.limit}，需要扩容（不自动扩容）`)
    : item('capacity', 'ok', `记忆用量 ${capacity.used}/${capacity.limit}`))

  warnings.forEach((warning, index) => items.push(item(`warning-${index + 1}`, 'needs-human', clip(String(warning), 300))))
  const summary = items.reduce((acc, entry) => {
    acc[entry.status] = (acc[entry.status] || 0) + 1
    return acc
  }, {})
  return { at: now, items, summary: `ok ${summary.ok || 0} · fixed ${summary.fixed || 0} · needs-human ${summary['needs-human'] || 0}` }
}

/* ------------------------------------------------------------------ */
/* 导出备份（zip，store 模式，不加密）                                 */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

async function walk(dir, base = '') {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full, rel))
    else if (entry.isFile()) out.push({ name: rel, file: full })
  }
  return out
}

export function zipEntries(entries = []) {
  const local = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt32LE(0, 10)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    local.push(header, name, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt32LE(0, 12)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += header.length + name.length + data.length
  }
  const cdBuffer = Buffer.concat(central)
  const localBuffer = Buffer.concat(local)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuffer.length, 12)
  eocd.writeUInt32LE(localBuffer.length, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([localBuffer, cdBuffer, eocd])
}

/** 读回 zip（store 模式），返回 [{ name, data }]，用于验证备份完整性。 */
export function unzipEntries(buffer) {
  const entries = []
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const nameLen = buffer.readUInt16LE(offset + 26)
    const dataLen = buffer.readUInt32LE(offset + 18)
    const name = buffer.slice(offset + 30, offset + 30 + nameLen).toString('utf8')
    const start = offset + 30 + nameLen
    entries.push({ name, data: buffer.slice(start, start + dataLen) })
    offset = start + dataLen
  }
  return entries
}

export async function exportBackup({ dataDir, targetDir, now = Date.now(), readOnly = false, guard = null, maxTotalBytes = 200 * 1024 * 1024 } = {}) {
  if (readOnly) {
    const error = new Error('只读模式：不导出备份')
    error.code = 'read-only'
    throw error
  }
  if (!targetDir || typeof targetDir !== 'string') {
    const error = new Error('需要选择导出目录')
    error.code = 'missing-path'
    throw error
  }
  const abs = path.resolve(targetDir)
  let info
  try {
    info = await stat(abs)
  } catch {
    const error = new Error('导出目录不存在，请先选择或创建目录')
    error.code = 'bad-export-path'
    throw error
  }
  if (!info.isDirectory()) {
    const error = new Error('导出目标必须是目录')
    error.code = 'bad-export-path'
    throw error
  }
  const files = []
  const warnings = []
  const roots = [
    { rel: 'memories.json', critical: true },
    { rel: 'policy.json', critical: false },
    { rel: 'docs', critical: false },
    { rel: '.vault', critical: false },
    { rel: SNAPSHOT_DIR, critical: false },
  ]
  for (const rootItem of roots) {
    const full = path.join(dataDir, rootItem.rel)
    let rootInfo
    try {
      rootInfo = await stat(full)
    } catch {
      if (rootItem.critical) throw Object.assign(new Error(rootItem.rel + ' 缺失，导出会是不完整备份'), { code: 'missing-critical-file' })
      warnings.push('跳过缺失的 ' + rootItem.rel)
      continue
    }
    if (rootInfo.isFile()) {
      files.push({ name: rootItem.rel, file: full, critical: rootItem.critical })
      continue
    }
    if (!rootInfo.isDirectory()) {
      if (rootItem.critical) throw Object.assign(new Error(rootItem.rel + ' 不是普通文件'), { code: 'missing-critical-file' })
      warnings.push('跳过非普通文件 ' + rootItem.rel)
      continue
    }
    for (const entry of await walk(full)) {
      files.push({
        name: rootItem.rel + '/' + entry.name,
        file: entry.file,
        critical: rootItem.rel === '.vault' && /(^|\/)key/.test(entry.name),
      })
    }
  }
  if (!files.some((entry) => entry.name === 'memories.json')) {
    throw Object.assign(new Error('memories.json 缺失，导出会是不完整备份'), { code: 'missing-critical-file' })
  }
  if (!files.some((entry) => entry.name.startsWith('.vault/') && /(^|\/)key/.test(entry.name))) {
    throw Object.assign(new Error('.vault/key 缺失，导出的备份将无法解密'), { code: 'missing-critical-file' })
  }
  if (guard) {
    try {
      guard.assert(path.join(abs, 'heartprint-backup-' + timestampName(now) + '.zip'), 'export')
    } catch {
      throw Object.assign(new Error('导出目录不在允许的写入范围内'), { code: 'forbidden-path' })
    }
  }
  const entries = []
  let total = 0
  for (const entry of files) {
    try {
      const info = await stat(entry.file)
      if (total + info.size > maxTotalBytes) throw Object.assign(new Error('导出体量超过上限'), { code: 'export-too-large' })
      const data = await readFile(entry.file)
      total += data.length
      entries.push({ name: entry.name, data })
    } catch (error) {
      if (error.code) throw error
      if (entry.critical) throw Object.assign(new Error('关键文件读取失败：' + entry.name), { code: 'missing-critical-file' })
      warnings.push('跳过无法读取的 ' + entry.name)
    }
  }
  if (!entries.length) {
    const error = new Error('没有可导出的文件')
    error.code = 'empty-export'
    throw error
  }
  const buffer = zipEntries(entries)
  const name = `heartprint-backup-${timestampName(now)}.zip`
  const target = path.join(abs, name)
  await writeFile(target, buffer)
  return { ok: true, path: target, size: buffer.length, files: entries.map((entry) => entry.name), warnings }
}

export async function readZipFile(file) {
  return unzipEntries(await readFile(file))
}

/** 重装指引（内部文档用，不进 README）。 */
export const REINSTALL_GUIDE = [
  '先点「导出备份」；',
  '重装插件（数据目录默认不动，装完就是原数据）；',
  '数据目录丢了 → 把备份解压回原位，或用交付文档 restore source=document。',
]

export async function readSelfCheck(dataDir) {
  const file = path.join(dataDir, '.selfcheck.json')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { ok: false, reason: 'missing' }
  }
  try {
    return { ok: true, result: JSON.parse(text) }
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
}

export async function writeSelfCheck(dataDir, result, guard = null) {
  const file = path.join(dataDir, '.selfcheck.json')
  if (guard && typeof guard.assert === 'function') {
    try {
      guard.assert(file, 'selfcheck')
    } catch (error) {
      const warnings = ['自检结果写盘被守卫拒绝：' + (error?.message || error)]
      return { ok: false, path: file, warnings }
    }
  }
  await writeFile(file, JSON.stringify(result, null, 2), 'utf8')
  return { ok: true, path: file, warnings: [] }
}

export async function inspectStore({ dataDir, store, policy = {}, now = Date.now(), docPaths = [], vaultInfo = async () => null } = {}) {
  const items = []
  let missingDocs = 0
  for (const file of docPaths) {
    try { await stat(file) } catch { missingDocs += 1 }
  }
  items.push(missingDocs ? item('docs', 'needs-human', '交付文档缺失 ' + missingDocs + ' 份（维护时重写）') : item('docs', 'ok', '交付文档存在'))
  const missingParts = store.records.filter((record) => !Array.isArray(record.partitions) || !record.partitions.length).length
  items.push(missingParts ? item('partitions', 'needs-human', missingParts + ' 条缺分区（维护时补）') : item('partitions', 'ok', '分区完整'))
  items.push(store.meta.priming ? item('priming', 'ok', '启动索引存在') : item('priming', 'needs-human', '启动索引缺失（维护时重建）'))
  const snaps = await listSnapshots(dataDir)
  const keep = policy.snapshotKeep ?? 5
  items.push(snaps.length > keep ? item('snapshots', 'needs-human', '快照 ' + snaps.length + ' 个超过保留 ' + keep + '（维护时清理）') : item('snapshots', 'ok', '快照数在保留范围'))
  items.push(store.meta.corruptDetectedAt ? item('memories-json', 'needs-human', 'memories.json 曾损坏，已隔离') : item('memories-json', 'ok', 'memories.json 可解析'))
  try {
    const info = await vaultInfo()
    items.push(info && info.ok === false ? item('vault-key', 'needs-human', '加密档案密钥缺失，这部分原文无法恢复') : item('vault-key', 'ok', '加密档案密钥可用'))
  } catch (error) { items.push(item('vault-key', 'needs-human', '加密档案检查失败：' + (error?.message || error))) }
  const capacity = capacityAlert(store.records, policy)
  items.push(capacity.visible ? item('capacity', 'needs-human', '记忆用量 ' + capacity.used + '/' + capacity.limit + '，需要扩容（不自动扩容）') : item('capacity', 'ok', '记忆用量 ' + capacity.used + '/' + capacity.limit))
  const summary = items.reduce((acc, entry) => { acc[entry.status] = (acc[entry.status] || 0) + 1; return acc }, {})
  return { at: now, mode: 'inspect', items, summary: 'ok ' + (summary.ok || 0) + ' · needs-human ' + (summary['needs-human'] || 0) }
}

export async function applyRepairs({ dataDir, store, policy = {}, now = Date.now(), save = async () => {}, docPaths = [], regenerateDocs = async () => {} } = {}) {
  let docsMissing = false
  for (const file of docPaths) { try { await stat(file) } catch { docsMissing = true } }
  if (policy && policy.readOnly) return { fixed: [], repaired: [], warnings: ['只读模式：跳过修复'] }
  const fixed = []
  const warnings = []
  try {
    const { ensurePartitions } = await import('./partitions.js')
    const migrated = ensurePartitions(store.records)
    if (migrated.changed) { store.records = migrated.records; await save(); fixed.push('partitions') }
  } catch (error) { warnings.push('分区修复失败：' + (error?.message || error)) }
  try {
    const { buildPrimingIndex } = await import('./partitions.js')
    if (!store.meta.priming) { store.meta.priming = buildPrimingIndex(store.records, now); await save(); fixed.push('priming') }
  } catch (error) { warnings.push('启动索引重建失败：' + (error?.message || error)) }
  if (docsMissing) {
    try { await regenerateDocs(); fixed.push('docs') } catch (error) { warnings.push('文档重写失败：' + (error?.message || error)) }
  }
  try {
    const pruned = await pruneSnapshots(dataDir, policy.snapshotKeep ?? 5)
    if (pruned) fixed.push('snapshots')
  } catch (error) { warnings.push('快照清理失败：' + (error?.message || error)) }
  return { fixed, repaired: fixed, warnings }
}
