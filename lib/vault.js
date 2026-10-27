/**
 * The encrypted third document.
 *
 * Everything that is physically removed from the visible memory store is
 * copied here first: an append-only encrypted journal, folded into a monthly
 * encrypted snapshot. The payload is AES-256-GCM with a local key file.
 *
 * It is protected by encryption alone — not by a Windows Hidden attribute.
 * Hiding added no real protection (the key lives beside the archive) while a
 * Hidden flag on the target file makes Node's writeFile() fail with EPERM on
 * Windows, which silently froze the monthly snapshot after its first write.
 *
 * Honest security model:
 *   - It is encrypted at rest, so reading the file does not reveal memories.
 *   - The key lives next to the vault, so this protects against casual reading
 *     and accidental exposure — not a determined local attacker with the same
 *     Windows account. A passphrase can be set (policy vaultPassphrase) to gate
 *     `vault action=reveal`, but the plugin itself must still be able to update
 *     the archive monthly without asking.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile, appendFile, unlink, stat } from 'node:fs/promises'
import path from 'node:path'

const ALGORITHM = 'aes-256-gcm'
const PREFIX = 'v1'

export function generateKeyHex() {
  return randomBytes(32).toString('hex')
}

export async function ensureKey(keyPath) {
  try {
    const existing = (await readFile(keyPath, 'utf8')).trim()
    if (/^[0-9a-f]{64}$/i.test(existing)) return existing.toLowerCase()
  } catch {
    // create below
  }
  const key = generateKeyHex()
  await writeFileBestEffort(keyPath, `${key}\n`, { encoding: 'utf8', mode: 0o600 })
  return key
}

function keyBuffer(keyHex) {
  const buffer = Buffer.from(String(keyHex), 'hex')
  if (buffer.length !== 32) throw new Error('心印档案密钥长度不正确（需要 32 字节）')
  return buffer
}

export function encryptText(keyHex, plaintext) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, keyBuffer(keyHex), iv)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.')
}

export function decryptText(keyHex, payload) {
  const parts = String(payload).trim().split('.')
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('心印档案格式不正确')
  const iv = Buffer.from(parts[1], 'base64')
  const tag = Buffer.from(parts[2], 'base64')
  const ciphertext = Buffer.from(parts[3], 'base64')
  const decipher = createDecipheriv(ALGORITHM, keyBuffer(keyHex), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * Clear a stale Hidden attribute before writing a file. This is a repair step,
 * never a hide step: nothing in the vault is ever marked hidden, because the
 * encryption is the protection. The call exists only so that a vault touched by
 * an older version (or by an external tool) can always be written to on
 * Windows, where writeFile() returns EPERM for a hidden target.
 */
function clearHiddenAttributeBestEffort(target) {
  if (process.platform !== 'win32') return
  try {
    execFileSync('attrib', ['-h', target], { windowsHide: true, stdio: 'ignore' })
  } catch {
    // Missing file, no attribute, or attrib unavailable: nothing to repair.
  }
}

async function writeFileBestEffort(file, data, options = { encoding: 'utf8' }) {
  clearHiddenAttributeBestEffort(file)
  await writeFile(file, data, options)
}

export async function readJournal(journalPath, keyHex) {
  // Without the key the ciphertext cannot be recovered, so report an empty
  // journal instead of throwing: callers treat the vault as best-effort and a
  // missing key must not take the whole maintenance run down.
  if (!keyHex) return []
  let text = ''
  try {
    text = await readFile(journalPath, 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      // appendJournal writes one encryptText() payload per line, so each line
      // has to be decrypted before it can be parsed as JSON.
      entries.push(JSON.parse(decryptText(keyHex, trimmed)))
    } catch {
      // A torn line from an interrupted write, a line encrypted with another
      // key, or a line that is not part of this vault format is skipped, never
      // fatal.
    }
  }
  return entries
}

export async function appendJournal(journalPath, keyHex, entries) {
  if (!Array.isArray(entries) || !entries.length) return
  const lines = entries.map((entry) => encryptText(keyHex, JSON.stringify(entry))).join('\n')
  clearHiddenAttributeBestEffort(journalPath)
  await appendFile(journalPath, `${lines}\n`, 'utf8')
}

export async function truncateJournal(journalPath) {
  try {
    await writeFileBestEffort(journalPath, '')
  } catch {
    // A missing journal is already empty.
  }
}

export function hashPassphrase(passphrase, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(String(passphrase), salt, 32).toString('hex')
  return { salt, hash: derived }
}

export function verifyPassphrase(passphrase, salt, expectedHash) {
  try {
    const derived = scryptSync(String(passphrase), String(salt), 32)
    const expected = Buffer.from(String(expectedHash), 'hex')
    if (derived.length !== expected.length) return false
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

export async function writeVaultSnapshot({ vaultDir, keyHex, cycle, payload, retentionMonths }) {
  await mkdir(vaultDir, { recursive: true })
  const encrypted = encryptText(keyHex, JSON.stringify(payload))
  const file = path.join(vaultDir, `vault-${cycle}.enc`)
  // Both the .enc write and the index write have to survive a vault whose
  // files were hidden by an older version: un-hide first, then write.
  await writeFileBestEffort(file, `${encrypted}\n`)

  const index = await readVaultIndex(vaultDir)
  const snapshots = index.snapshots.filter((item) => item.cycle !== cycle)
  snapshots.push({ cycle, at: Date.now(), bytes: Buffer.byteLength(encrypted, 'utf8') })
  snapshots.sort((a, b) => String(a.cycle).localeCompare(String(b.cycle)))
  const keep = Math.max(1, Number(retentionMonths) || 24)
  const removed = snapshots.slice(0, Math.max(0, snapshots.length - keep))
  const kept = snapshots.slice(Math.max(0, snapshots.length - keep))
  for (const item of removed) {
    try {
      await unlink(path.join(vaultDir, `vault-${item.cycle}.enc`))
    } catch {
      // already gone
    }
  }
  const nextIndex = {
    version: 1,
    algorithm: ALGORITHM,
    updatedAt: Date.now(),
    snapshots: kept,
  }
  await writeFileBestEffort(path.join(vaultDir, 'vault-index.json'), `${JSON.stringify(nextIndex, null, 2)}\n`)
  return { file, index: nextIndex, removed }
}

export async function readVaultIndex(vaultDir) {
  try {
    const raw = await readFile(path.join(vaultDir, 'vault-index.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      version: 1,
      algorithm: ALGORITHM,
      updatedAt: Number(parsed.updatedAt) || 0,
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
    }
  } catch {
    return { version: 1, algorithm: ALGORITHM, updatedAt: 0, snapshots: [] }
  }
}

export async function readVaultSnapshot(vaultDir, keyHex, cycle) {
  const file = path.join(vaultDir, `vault-${cycle}.enc`)
  const encrypted = await readFile(file, 'utf8')
  return JSON.parse(decryptText(keyHex, encrypted))
}

export async function vaultStats(vaultDir) {
  const index = await readVaultIndex(vaultDir)
  let journalBytes = 0
  try {
    journalBytes = (await stat(path.join(vaultDir, 'journal.enc'))).size
  } catch {
    journalBytes = 0
  }
  const files = await readdir(vaultDir).catch(() => [])
  return {
    dir: vaultDir,
    algorithm: ALGORITHM,
    snapshots: index.snapshots,
    latest: index.snapshots.length ? index.snapshots[index.snapshots.length - 1] : null,
    updatedAt: index.updatedAt,
    journalBytes,
    fileCount: files.length,
  }
}
