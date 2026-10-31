/**
 * Filesystem ownership.
 *
 * One store object owns every path under the data directory:
 *
 *   memories.json        visible memory store
 *   policy.json          user-tuned forgetting calendar
 *   docs/                the two synchronized documents
 *   .vault/               encrypted journal, monthly snapshots, key
 *
 * Writes are atomic (same-directory tmp file + rename) so a crash can never
 * leave half a JSON document behind.
 */

import { copyFile, mkdir, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  MASTER_FILENAME,
  USER_FILENAME,
  renderDocuments,
} from './docs.js'
import { buildPrimingIndex, ensurePartitions } from './partitions.js'
import {
  appendJournal,
  ensureKey,
  readJournal,
  readVaultIndex,
  readVaultSnapshot as readVaultSnapshotFile,
  truncateJournal,
  vaultStats,
  writeVaultSnapshot,
} from './vault.js'

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  await writeFile(tmp, text, 'utf8')
  try {
    await rename(tmp, file)
  } catch {
    await writeFile(file, text, 'utf8')
    await unlink(tmp).catch(() => {})
  }
}

function emptyStore(now) {
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    meta: {
      lastMaintainAt: 0,
      lastVaultAt: 0,
      lastDeliveredAt: 0,
      deliveredPath: '',
      maintenanceLog: [],
      vaultCycles: 0,
    },
    records: [],
  }
}

export function createStore({ dataDir, now = Date.now(), guard = null }) {
  const docsDir = path.join(dataDir, 'docs')
  const vaultDir = path.join(dataDir, '.vault')
  const paths = {
    dataDir,
    docsDir,
    vaultDir,
    store: path.join(dataDir, 'memories.json'),
    policy: path.join(dataDir, 'policy.json'),
    journal: path.join(vaultDir, 'journal.enc'),
    key: path.join(vaultDir, 'key'),
    vaultIndex: path.join(vaultDir, 'vault-index.json'),
    master: path.join(docsDir, MASTER_FILENAME),
    user: path.join(docsDir, USER_FILENAME),
  }

  function scopedWrite(file, text, event = 'store-write') {
    if (guard) guard.assert(file, event)
    return writeAtomic(file, text)
  }

  async function ensureLayout() {
    if (guard) {
      guard.assert(dataDir, 'mkdir')
      guard.assert(docsDir, 'mkdir')
      guard.assert(vaultDir, 'mkdir')
    }
    await mkdir(dataDir, { recursive: true })
    await mkdir(docsDir, { recursive: true })
    // The vault is encrypted, not hidden: a Windows Hidden attribute on the
    // target file makes writeFile() fail with EPERM and used to freeze the
    // monthly snapshot after its first write.
    await mkdir(vaultDir, { recursive: true })
  }

  /**
   * 记忆库解析失败时，先把损坏的文件改名保留下来，再以空库继续。
   * 绝不能静默地把损坏内容直接覆盖掉——那样用户所有记忆就真的没了。
   */
  async function quarantineCorruptStore() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = `${paths.store}.corrupt-${stamp}`
    try {
      await rename(paths.store, target)
      return target
    } catch {
      return ''
    }
  }

  async function load() {
    await ensureLayout()
    let store = null
    let policy = null
    let raw = null
    try {
      raw = await readFile(paths.store, 'utf8')
    } catch {
      // 文件不存在（首次运行）或读不了：按空库处理，没有什么可隔离的。
      raw = null
    }
    if (typeof raw === 'string') {
      let parsed = null
      let parseFailed = false
      try {
        parsed = JSON.parse(raw)
      } catch {
        parseFailed = true
      }
      if (!parseFailed && parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
        store = {
          ...emptyStore(now),
          ...parsed,
          meta: { ...emptyStore(now).meta, ...(parsed.meta || {}) },
          records: parsed.records.filter((record) => record && typeof record === 'object' && record.id),
        }
      } else {
        // JSON 损坏或结构不对：保留原件为 memories.json.corrupt-<时间戳>。
        await quarantineCorruptStore()
      }
    }
    if (!store) store = emptyStore(now)
    const migrated = ensurePartitions(store.records)
    if (migrated.changed) {
      store.records = migrated.records
      await saveStore(store)
    }
    if (!store.meta.priming || typeof store.meta.priming !== 'object') {
      store.meta.priming = buildPrimingIndex(store.records)
      await saveStore(store)
    }
    try {
      const parsed = JSON.parse(await readFile(paths.policy, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) policy = parsed
    } catch {
      policy = null
    }
    return { store, policy }
  }

  async function saveStore(store) {
    // 覆盖前把上一版复制成 memories.json.bak（尽力而为；首次保存时没有上一版）。
    // 配合 load() 的损坏隔离，任何一次异常写入都还能找回上一版记忆库。
    try {
      await copyFile(paths.store, `${paths.store}.bak`)
    } catch {
      // 没有上一版或复制失败都不影响本次保存。
    }
    await scopedWrite(paths.store, `${JSON.stringify(store, null, 2)}\n`)
  }

  async function savePolicy(policy) {
    await scopedWrite(paths.policy, `${JSON.stringify(policy, null, 2)}\n`)
  }

  async function getKey() {
    if (guard) guard.assert(vaultDir, 'mkdir')
    await mkdir(vaultDir, { recursive: true })
    return ensureKey(paths.key, guard)
  }

  async function readArchiveJournal() {
    // The journal stores per-line encryptText() payloads, so the key has to be
    // loaded and handed to readJournal or every line fails to decrypt.
    const key = await getKey()
    return readJournal(paths.journal, key)
  }

  async function appendArchive(entries) {
    if (!Array.isArray(entries) || !entries.length) return 0
    const key = await getKey()
    await appendJournal(paths.journal, key, entries, guard)
    return entries.length
  }

  async function foldJournalIntoVault({ cycle, payload, retentionMonths }) {
    const key = await getKey()
    const result = await writeVaultSnapshot({
      vaultDir,
      keyHex: key,
      cycle,
      payload,
      retentionMonths,
      guard,
    })
    await truncateJournal(paths.journal, guard)
    return result
  }

  async function writeDocuments(records, policy, meta) {
    const rendered = renderDocuments({ records, policy, meta })
    await writeRenderedDocuments(rendered)
    return { ...rendered, masterPath: paths.master, userPath: paths.user }
  }

  async function writeRenderedDocuments(rendered) {
    if (guard) guard.assert(docsDir, 'mkdir')
    await mkdir(docsDir, { recursive: true })
    await scopedWrite(paths.master, rendered.master)
    await scopedWrite(paths.user, rendered.user)
    return { masterPath: paths.master, userPath: paths.user, bodyHash: rendered.bodyHash }
  }

  async function readDocument(variant) {
    const file = variant === 'user' ? paths.user : paths.master
    try {
      return await readFile(file, 'utf8')
    } catch {
      return null
    }
  }

  /**
   * 交付目标路径来自配置或工具参数，属于外部输入：
   * 解析成绝对路径，拒绝 NUL 和「解析后落回目录本身」的写法，
   * 避免 `..` 造成的意外覆盖。
   */
  function safeTargetPath(targetPath) {
    const raw = String(targetPath ?? '')
    if (!raw || raw.includes('\u0000')) throw new Error('交付路径非法')
    const resolved = path.resolve(raw)
    if (!resolved || path.basename(resolved) === '') throw new Error('交付路径非法')
    return resolved
  }

  async function writeUserCopy(targetPath, content) {
    const resolved = safeTargetPath(targetPath)
    await mkdir(path.dirname(resolved), { recursive: true })
    await scopedWrite(resolved, content, 'delivery-write')
    return resolved
  }

  async function documentStat() {
    const result = {}
    for (const [key, file] of Object.entries({ master: paths.master, user: paths.user })) {
      try {
        const info = await stat(file)
        result[key] = { path: file, bytes: info.size, mtime: info.mtimeMs }
      } catch {
        result[key] = null
      }
    }
    return result
  }

  async function readLatestVaultSnapshot(cycle) {
    const key = await getKey()
    return readVaultSnapshotFile(vaultDir, key, cycle)
  }

  return {
    paths,
    ensureLayout,
    load,
    saveStore,
    savePolicy,
    getKey,
    readArchiveJournal,
    appendArchive,
    foldJournalIntoVault,
    readLatestVaultSnapshot,
    writeDocuments,
    writeRenderedDocuments,
    readDocument,
    writeUserCopy,
    documentStat,
    vaultInfo: () => vaultStats(vaultDir),
    readVaultIndex: () => readVaultIndex(vaultDir),
  }
}
