/**
 * Small deterministic text helpers shared by the decay engine, the documents
 * and the tool renderers.
 *
 * Everything here is pure and locale-neutral: the same input always produces
 * the same output. That matters because the memory store must be reproducible
 * from its own data (no hidden randomness in "forgetting").
 */

import { createHash } from 'node:crypto'

export const DAY_MS = 86_400_000

/** Collapse whitespace without destroying paragraph structure entirely. */
export function normalizeText(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Clip to at most `max` characters, appending an ellipsis when cut. */
export function clip(value, max) {
  const text = normalizeText(value)
  const limit = Math.max(1, Number(max) || 1)
  if (text.length <= limit) return text
  if (limit <= 2) return text.slice(0, limit)
  return `${text.slice(0, limit - 1)}…`
}

/**
 * Split on sentence-ish boundaries for Chinese and Western punctuation.
 * Newlines are also boundaries so a bullet list compresses sensibly.
 */
export function splitSentences(value) {
  const text = normalizeText(value)
  if (!text) return []
  const parts = []
  let current = ''
  for (const char of text) {
    current += char
    if ('。！？!?；;…'.includes(char)) {
      parts.push(current.trim())
      current = ''
    } else if (char === '\n') {
      if (current.trim()) parts.push(current.trim())
      current = ''
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts.filter(Boolean)
}

/** Keep the first sentence (or the whole text when it is one sentence). */
export function firstSentence(value, max = 80) {
  const sentences = splitSentences(value)
  if (!sentences.length) return clip(value, max)
  return clip(sentences[0], max)
}

/**
 * Lossy but deterministic summary.
 *
 * Detail level 1: keep leading sentences while they fit, then a trailing hint.
 * Detail level 0: a one-line gist built from the first sentence.
 */
export function summarizeText(value, max = 180) {
  const text = normalizeText(value)
  if (text.length <= max) return text
  const sentences = splitSentences(text)
  if (sentences.length <= 1) return clip(text, max)
  let out = ''
  for (const sentence of sentences) {
    if (out && (out + sentence).length > max) break
    out += sentence
    if (out.length >= max) break
  }
  if (!out) out = text.slice(0, max)
  if (out.length < text.length) return `${clip(out, max - 1)}…`
  return out
}

export function gistText(value, max = 64) {
  const text = normalizeText(value)
  if (!text) return ''
  return clip(firstSentence(text, max), max)
}

/** Local calendar date `YYYY-MM-DD` (the host timezone, not UTC). */
export function formatDate(timestamp) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '未知日期'
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Local date and time, minute precision. */
export function formatDateTime(timestamp) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '未知时间'
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${formatDate(timestamp)} ${hh}:${mm}`
}

export function monthKey(timestamp) {
  const date = new Date(timestamp)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

export function quarterKey(timestamp) {
  const date = new Date(timestamp)
  const q = Math.floor(date.getMonth() / 3) + 1
  return `${date.getFullYear()}-Q${q}`
}

export function quarterLabel(key) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(key || ''))
  if (!match) return String(key || '某段时间')
  return `${match[1]} 年 Q${match[2]}`
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

export function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.round(number)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  if (number < min) return min
  if (number > max) return max
  return number
}

/** Parse an ISO-ish date/time; returns milliseconds or null. */
export function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value).trim()
  if (!text) return null
  const direct = Date.parse(text)
  if (Number.isFinite(direct)) return direct
  // `YYYY-MM-DD` is parsed as UTC by Date.parse; treat a bare date as local noon.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match) {
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0)
    return Number.isNaN(date.getTime()) ? null : date.getTime()
  }
  return null
}

export function ageDaysOf(timestamp, now) {
  const at = Number(timestamp)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, (now - at) / DAY_MS)
}

/** Coarse "how long ago" label used in the prompt digest and status text. */
export function agoText(timestamp, now = Date.now()) {
  const days = ageDaysOf(timestamp, now)
  if (days < 1) return '今天'
  if (days < 2) return '昨天'
  if (days < 15) return `${Math.floor(days)} 天前`
  if (days < 60) return `${Math.floor(days / 30)} 个月前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}
