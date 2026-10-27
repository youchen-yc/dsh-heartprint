/**
 * The decay engine.
 *
 * `applyDecay` is a pure, idempotent fold over the whole store: given "now"
 * and a policy it returns the new record list, the pre-loss copies that must
 * be archived into the encrypted vault, and a change count. Running it twice
 * at the same instant changes nothing.
 *
 * Forgetting is physical. When a record is compressed or forgotten the old
 * text is dropped from the store and the archived copy exists only in the
 * encrypted vault. That is what makes the user-visible document a faithful
 * picture of what the AI still remembers.
 */

import {
  DAY_MS,
  ageDaysOf,
  clip,
  formatDate,
  gistText,
  quarterKey,
  quarterLabel,
  recordAgeDays,
  recordTimestamp,
  summarizeText,
} from './text.js'
import {
  FEELING_STAGES,
  TYPE_LABELS,
  classify,
  feelingRank,
  planFor,
} from './policy.js'

const FEELING_TEMPLATES = {
  warm: {
    faint: '只记得当时心里是暖的，细节已经模糊。',
    faded: '那份暖意已经想不起来了，只记得是一段好的记忆。',
  },
  tender: {
    faint: '只记得当时很温柔，其余的已经淡了。',
    faded: '当时那份柔软已经记不清了，只记得是被善待的。',
  },
  excited: {
    faint: '只记得当时很开心，具体的事已经模糊。',
    faded: '当时的兴奋已经想不起来了，只记得是快乐的。',
  },
  calm: {
    faint: '只记得当时很平静。',
    faded: '当时的平静也淡了，只剩一点模糊的安稳。',
  },
  painful: {
    soft: '当时的难受已经不那么清楚了。',
    faint: '当时的痛苦已经淡忘，只记得这件事曾让我难受。',
    faded: '当时的痛已经完全淡忘，只记得这件事发生过。',
  },
  mixed: {
    faint: '只记得当时又暖又涩，说不清了。',
    faded: '当时那种复杂的心情已经淡了。',
  },
  neutral: {
    faint: '当时的感受已经很淡了。',
    faded: '当时的感受已经想不起来了。',
  },
}

/** Copy a record before its text is lost. */
export function archiveEntry(record, reason, now) {
  return {
    at: now,
    reason,
    record: JSON.parse(JSON.stringify(record)),
  }
}

function fadeFeeling(record, targetStage) {
  const valence = record.valence && FEELING_TEMPLATES[record.valence] ? record.valence : 'neutral'
  if (targetStage === 'soft') {
    const prior = record.feeling || ''
    if (prior) return `${summarizeText(prior, 56)}（感受渐渐变淡）`
    return '感受渐渐变淡。'
  }
  const template = FEELING_TEMPLATES[valence][targetStage]
  return template || '当时的感受已经淡了。'
}

function tombstone(record, plan, now) {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    happenedAt: record.happenedAt ?? record.createdAt ?? now,
    createdAt: record.createdAt ?? now,
    importance: record.importance ?? 0,
    special: record.special === true,
    tags: [],
    people: [],
    content: '',
    feeling: '',
    feelingStage: 'gone',
    detailLevel: 0,
    state: 'forgotten',
    forgottenAt: now,
    lastDecayAt: now,
    updatedAt: now,
    layer: plan.layerId,
  }
}

/**
 * Lower the visible detail of a live record toward the plan's targets.
 * Never upgrades: loss is one-way.
 */
function renderStored(record, plan, now) {
  const currentDetail = Number.isFinite(record.detailLevel) ? record.detailLevel : 2
  const currentStage = record.feelingStage || 'full'
  const targetDetail = Math.min(currentDetail, plan.detail)
  const targetRank = Math.max(feelingRank(currentStage), feelingRank(plan.feeling))

  let content = record.content || ''
  if (targetDetail < currentDetail) {
    content = targetDetail === 1 ? summarizeText(content, 200) : gistText(content, 72)
  }

  let feeling = record.feeling || ''
  if (targetRank > feelingRank(currentStage)) {
    feeling = fadeFeeling(record, FEELING_STAGES[targetRank])
  }

  const feelingStage = FEELING_STAGES[targetRank]
  const state = targetDetail < 2 || feelingStage !== 'full' ? 'compressed' : 'active'
  const changed = targetDetail !== currentDetail
    || targetRank !== feelingRank(currentStage)
    || content !== record.content
    || feeling !== record.feeling

  return {
    changed,
    record: {
      ...record,
      content,
      feeling,
      detailLevel: targetDetail,
      feelingStage,
      state,
      layer: plan.layerId,
      lastDecayAt: now,
      updatedAt: changed ? now : record.updatedAt,
    },
  }
}

function buildDigest(bucket, existing, now) {
  const titles = bucket.items.map((item) => clip(item.title || gistText(item.content, 24), 40)).filter(Boolean)
  const previousTitles = Array.isArray(existing?.mergedTitles) ? existing.mergedTitles : []
  const mergedTitles = [...previousTitles, ...titles]
  const mergedCount = (Number(existing?.mergedCount) || 0) + bucket.items.length
  const at = Math.min(
    ...bucket.items.map((item) => item.happenedAt ?? item.createdAt ?? now),
    existing?.happenedAt ?? Infinity,
  )
  return {
    id: existing?.id || `digest-${bucket.key}`,
    type: 'digest',
    digestKey: bucket.key,
    title: `${quarterLabel(bucket.key)}的日常`,
    content: `那段时间共有 ${mergedCount} 件琐事：${mergedTitles.slice(0, 24).join('、')}${mergedTitles.length > 24 ? '…' : ''}。`,
    feeling: '',
    feelingStage: 'gone',
    detailLevel: 0,
    importance: 20,
    special: false,
    tags: [],
    people: [],
    happenedAt: Number.isFinite(at) ? at : now,
    createdAt: Number.isFinite(at) ? at : now,
    updatedAt: now,
    state: 'compressed',
    layer: 'digest',
    mergedCount,
    mergedTitles: mergedTitles.slice(-200),
    lastDecayAt: now,
  }
}

export function applyDecay(records, now, policy) {
  const archive = []
  const changes = { compressed: 0, forgotten: 0, merged: 0, deleted: 0 }
  const kept = []
  const buckets = new Map()
  const digestRecords = []

  for (const record of records) {
    if (!record || typeof record !== 'object' || !record.id) continue

    if (record.type === 'digest') {
      const ageDays = recordAgeDays(record, now)
      if (record.state !== 'forgotten' && ageDays >= (policy.digestRetentionDays ?? 365)) {
        archive.push(archiveEntry(record, 'digest-delete', now))
        digestRecords.push(tombstone(record, { layerId: 'digest' }, now))
        changes.deleted += 1
      } else {
        digestRecords.push(record)
      }
      continue
    }

    const plan = planFor(record, now, policy, { warmth: true })
    if (plan.frozen) {
      kept.push(record)
      continue
    }

    if (plan.action === 'forget' || plan.action === 'delete') {
      archive.push(archiveEntry(record, plan.action, now))
      kept.push(tombstone(record, plan, now))
      if (plan.action === 'delete') changes.deleted += 1
      else changes.forgotten += 1
      continue
    }

    if (plan.action === 'merge') {
      archive.push(archiveEntry(record, 'merge', now))
      const at = record.happenedAt ?? record.createdAt ?? now
      const key = quarterKey(at)
      if (!buckets.has(key)) buckets.set(key, { key, items: [] })
      buckets.get(key).items.push(record)
      changes.merged += 1
      continue
    }

    const rendered = renderStored(record, plan, now)
    if (rendered.changed) {
      archive.push(archiveEntry(record, 'decay', now))
      changes.compressed += 1
    }
    kept.push(rendered.record)
  }

  const consumedKeys = new Set(buckets.keys())
  const retainedDigests = digestRecords.filter(
    (record) => record.state === 'forgotten' || !consumedKeys.has(record.digestKey),
  )
  const mergedDigests = []
  for (const [key, bucket] of buckets) {
    const existing = digestRecords.find((record) => record.state !== 'forgotten' && record.digestKey === key)
    mergedDigests.push(buildDigest(bucket, existing, now))
  }

  const nextRecords = [...kept, ...retainedDigests, ...mergedDigests]
  nextRecords.sort((a, b) => {
    const atA = a.happenedAt ?? a.createdAt ?? 0
    const atB = b.happenedAt ?? b.createdAt ?? 0
    return atA - atB
  })

  return { records: nextRecords, archive, changes }
}

export function computeStats(records) {
  const stats = {
    total: records.length,
    active: 0,
    compressed: 0,
    forgotten: 0,
    digests: 0,
    core: 0,
    important: 0,
    secondary: 0,
    trivial: 0,
    byType: {},
    oldest: null,
    newest: null,
  }
  for (const record of records) {
    stats[record.state === 'active' ? 'active' : record.state === 'forgotten' ? 'forgotten' : 'compressed'] += 1
    if (record.type === 'digest') stats.digests += 1
    stats.byType[record.type] = (stats.byType[record.type] || 0) + 1
    const at = record.happenedAt ?? record.createdAt ?? 0
    if (at && (stats.oldest === null || at < stats.oldest)) stats.oldest = at
    if (at && (stats.newest === null || at > stats.newest)) stats.newest = at
  }
  return stats
}

export function classifyCounts(records, policy) {
  const counts = { core: 0, important: 0, secondary: 0, trivial: 0 }
  for (const record of records) {
    if (record.state === 'forgotten') continue
    counts[record.type === 'digest' ? 'trivial' : classify(record, policy)] += 1
  }
  return counts
}

function matches(record, terms) {
  if (!terms.length) return true
  const haystack = [
    record.title,
    record.content,
    record.feeling,
    ...(Array.isArray(record.tags) ? record.tags : []),
    ...(Array.isArray(record.people) ? record.people : []),
    TYPE_LABELS[record.type] || '',
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return terms.some((term) => haystack.includes(term))
}

/**
 * Recall search. The user (or the model) can ask with a keyword, a person, a
 * type or a time window. Forgotten tombstones are searchable by title only and
 * report that the details are gone — which is exactly how "提起来还是会想起"
 * should behave for something that has faded.
 */
export function searchMemories(records, query, now, policy, options = {}) {
  const rawQuery = String(query || '').trim()
  const terms = rawQuery
    .toLowerCase()
    .split(/[\s,，、;；]+/)
    .filter((term) => term.length > 0)
  const limit = Math.max(1, Math.min(Number(options.limit) || 8, 50))
  const includeForgotten = options.includeForgotten === true

  const scored = []
  for (const record of records) {
    if (record.state === 'forgotten' && !includeForgotten) {
      // A tombstone may still be recognised by its title, never by lost text.
      if (!terms.length) continue
      const title = String(record.title || '').toLowerCase()
      if (!terms.some((term) => title.includes(term))) continue
    }
    if (options.type && record.type !== options.type) continue
    if (options.person) {
      const people = (record.people || []).join(' ').toLowerCase()
      if (!people.includes(String(options.person).toLowerCase())) continue
    }
    if (options.tag) {
      const tags = (record.tags || []).join(' ').toLowerCase()
      if (!tags.includes(String(options.tag).toLowerCase())) continue
    }
    const at = record.happenedAt ?? record.createdAt ?? 0
    if (options.since && at < options.since) continue
    if (options.until && at > options.until) continue
    if (terms.length && !matches(record, terms)) continue

    let score = (Number(record.importance) || 0) / 20
    if (record.special) score += 4
    if (record.type === 'pain' || record.type === 'turning_point') score += 2
    const age = recordAgeDays(record, now)
    score += Math.max(0, 3 - age / 120)
    if (terms.length) {
      const title = String(record.title || '').toLowerCase()
      const body = `${record.content || ''}\n${record.feeling || ''}`.toLowerCase()
      for (const term of terms) {
        if (title.includes(term)) score += 6
        if (body.includes(term)) score += 2
        if ((record.tags || []).join(' ').toLowerCase().includes(term)) score += 5
        if ((record.people || []).join(' ').toLowerCase().includes(term)) score += 5
      }
    }
    if (record.state === 'forgotten') score -= 6
    scored.push({ record, score })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((item) => item.record)
}

/**
 * What the model sees when it recalls one memory. Detail cannot exceed what
 * was physically kept; a warm recall adds an afterglow line instead of fake
 * detail.
 */
export function renderRecall(record, now, policy) {
  const date = formatDate(record.happenedAt ?? record.createdAt ?? now)
  const typeLabel = TYPE_LABELS[record.type] || record.type
  if (record.state === 'forgotten') {
    return {
      id: record.id,
      date,
      type: record.type,
      typeLabel,
      title: record.title,
      state: 'forgotten',
      importance: record.importance,
      special: record.special === true,
      text: '文字与感受都已经淡忘，只记得大概有这么一件事。',
      feeling: '',
      note: '这段记忆已经淡忘，细节无法还原。',
    }
  }
  const plan = planFor(record, now, policy, { warmth: true })
  const feeling = record.feeling || ''
  const afterglow = plan.warmed && record.lastRecalledAt
    ? '（这次提起，又让它在心里清晰了一点。）'
    : ''
  return {
    id: record.id,
    date,
    type: record.type,
    typeLabel,
    title: record.title,
    state: record.state || 'active',
    importance: record.importance,
    special: record.special === true,
    layer: plan.layerLabel,
    text: record.content || record.title,
    feeling,
    note: afterglow || undefined,
  }
}

/** Compact summary used by the `remember` / `maintain` tool results. */
export function describeChangeSummary(changes) {
  const parts = []
  if (changes.compressed) parts.push(`压缩 ${changes.compressed}`)
  if (changes.forgotten) parts.push(`淡忘 ${changes.forgotten}`)
  if (changes.merged) parts.push(`合并 ${changes.merged}`)
  if (changes.deleted) parts.push(`删除 ${changes.deleted}`)
  return parts.length ? parts.join(' · ') : '无变化'
}
