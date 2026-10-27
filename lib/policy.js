/**
 * Policy: the adjustable "forgetting calendar" and the per-class rules that
 * decide how much of a memory survives at each age.
 *
 * The user-facing knobs are the `afterDays` boundaries between layers. Each
 * layer carries one rule block per memory class:
 *
 *   core       — personality / emotion / turning-point / special events
 *   important  — importance >= importantThreshold
 *   secondary  — importance >= secondaryThreshold
 *   trivial    — everything else
 *
 * rule.detail : 2 full, 1 summary, 0 gist
 * rule.feeling: full | soft | faint | faded | gone
 * rule.action : keep | forget | merge | delete (only honoured for non-core)
 *
 * All defaults follow the user's specification; every number is editable.
 */

import { DAY_MS, ageDaysOf, clampInt, clampNumber } from './text.js'

export const MEMORY_TYPES = [
  'personality',
  'emotion',
  'turning_point',
  'shared_beauty',
  'pain',
  'event',
  'insight',
  'daily',
]

export const TYPE_LABELS = {
  personality: '性格形成',
  emotion: '情感节点',
  turning_point: '灵性转折',
  shared_beauty: '共同美好',
  pain: '痛苦记忆',
  event: '重要事件',
  insight: '领悟',
  daily: '日常',
  digest: '合并记忆',
}

export const VALENCES = ['warm', 'tender', 'excited', 'calm', 'painful', 'mixed', 'neutral']

export const FEELING_STAGES = ['full', 'soft', 'faint', 'faded', 'gone']
export const DETAIL_LEVELS = [0, 1, 2]
export const ACTIONS = ['keep', 'forget', 'merge', 'delete']

const CLASS_KEYS = ['core', 'important', 'secondary', 'trivial']

function rule(detail, feeling, action = 'keep') {
  return { detail, feeling, action }
}

/**
 * Default calendar. The labels are for humans; ids are stable keys.
 *
 *   0d–7d   近几天：一切都还清晰。
 *   7–15d   清晰期尾声：次要内容开始变软。
 *   15–30d  半个月到一个月：开始淡忘，提起来还能想起感受。
 *   30–90d  一个月到三个月：压缩不那么重要的记忆。
 *   90–180d 三个月到六个月：没有特点的琐事渐渐遗忘，只剩一句梗概（不再清空记录）。
 *   180–365d 六个月到一年：琐碎合并成季度摘要。
 *   365–3650d 一年到十年：删除琐碎文本，性格/情感节点保留。
 *   3650d+  十年以上：只剩性格形成节点与重要特殊事件的梗概。
 */
export const DEFAULT_LAYERS = [
  {
    id: 'fresh',
    label: '近几天',
    afterDays: 0,
    core: rule(2, 'full'),
    important: rule(2, 'full'),
    secondary: rule(2, 'full'),
    trivial: rule(2, 'full'),
  },
  {
    id: 'recent',
    label: '清晰期尾声',
    afterDays: 7,
    core: rule(2, 'full'),
    important: rule(2, 'full'),
    secondary: rule(1, 'soft'),
    trivial: rule(1, 'soft'),
  },
  {
    id: 'fade',
    label: '半个月到一个月',
    afterDays: 15,
    core: rule(2, 'full'),
    important: rule(1, 'soft'),
    secondary: rule(1, 'soft'),
    trivial: rule(1, 'faint'),
  },
  {
    id: 'quarter',
    label: '一个月到三个月',
    afterDays: 30,
    core: rule(2, 'full'),
    important: rule(1, 'soft'),
    secondary: rule(1, 'faint'),
    trivial: rule(0, 'faint'),
  },
  {
    id: 'halfyear',
    label: '三个月到六个月',
    afterDays: 90,
    core: rule(1, 'full'),
    important: rule(1, 'faint'),
    secondary: rule(0, 'faint'),
    // 3-6 个月：渐渐遗忘，只剩一句梗概（keep + detail 0，不物理清空）。
    trivial: rule(0, 'gone', 'keep'),
  },
  {
    id: 'year',
    label: '六个月到一年',
    afterDays: 180,
    core: rule(1, 'full'),
    important: rule(1, 'faint'),
    secondary: rule(0, 'faint'),
    // 6-12 个月：琐碎合并成季度摘要。
    trivial: rule(0, 'gone', 'merge'),
  },
  {
    id: 'longterm',
    label: '一年到十年',
    afterDays: 365,
    core: rule(1, 'full'),
    important: rule(1, 'faint'),
    secondary: rule(1, 'faint'),
    // 1 年以上：删除琐碎文本。
    trivial: rule(0, 'gone', 'delete'),
  },
  {
    id: 'deep',
    label: '十年以上',
    afterDays: 3650,
    core: rule(1, 'full'),
    important: rule(0, 'faint'),
    secondary: rule(0, 'faint'),
    trivial: rule(0, 'gone', 'delete'),
  },
]

/**
 * 交付文件名里的名字默认留空：每个新安装由用户自己给自己的 AI 起名，
 * 不预置任何人的名字。名字只在交付文件命名与状态展示里用到。
 */
export const DEFAULT_PERSONA_NAME = ''
/** 人格/性格设定文本的长度上限。 */
export const PROFILE_MAX_CHARS = 400

export const DEFAULT_POLICY = {
  version: 1,
  disclosure: 'confidential',
  personaName: DEFAULT_PERSONA_NAME,
  // 用户自己设定的人格与性格（首次安装时由 AI 询问后写入）。
  personaProfile: '',
  characterProfile: '',
  firstDeliveryAfterDays: 90,
  deliveryIntervalDays: 30,
  deliveryDir: '',
  syncIntervalDays: 30,
  vaultRetentionMonths: 24,
  recallWarmthDays: 7,
  maintainThrottleMinutes: 60,
  digestRetentionDays: 365,
  importantThreshold: 70,
  secondaryThreshold: 40,
  vaultPassHash: '',
  vaultPassSalt: '',
  layers: DEFAULT_LAYERS,
}

const DISCLOSURES = ['confidential', 'disclosed']

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeRule(base, patch) {
  const source = isPlainObject(patch) ? patch : {}
  const next = { ...base }
  if (DETAIL_LEVELS.includes(Number(source.detail))) next.detail = Number(source.detail)
  if (FEELING_STAGES.includes(source.feeling)) next.feeling = source.feeling
  if (ACTIONS.includes(source.action)) next.action = source.action
  return next
}

function mergeLayer(base, patch) {
  const source = isPlainObject(patch) ? patch : {}
  const next = {
    id: base.id,
    label: typeof source.label === 'string' && source.label.trim() ? source.label.trim() : base.label,
    afterDays: base.afterDays,
  }
  if (Number.isFinite(Number(source.afterDays))) {
    next.afterDays = clampInt(source.afterDays, 0, 365_000, base.afterDays)
  }
  for (const key of CLASS_KEYS) next[key] = mergeRule(base[key], source[key])
  return next
}

/**
 * Layered policy resolution. Later inputs win. `layers` merge by id so a patch
 * may change only the date boundaries and leave the rest at its preset.
 */
export function resolvePolicy(...inputs) {
  let policy = {
    ...clone(DEFAULT_POLICY),
    layers: DEFAULT_LAYERS.map((layer) => mergeLayer(layer, {})),
  }

  for (const input of inputs) {
    if (!isPlainObject(input)) continue
    if (DISCLOSURES.includes(input.disclosure)) policy.disclosure = input.disclosure
    if (typeof input.personaName === 'string') {
      // 空字符串表示「用户还没起名」，保持为空，由用户之后自己设置。
      policy.personaName = input.personaName.trim().slice(0, 40)
    }
    if (typeof input.personaProfile === 'string') {
      policy.personaProfile = input.personaProfile.trim().slice(0, PROFILE_MAX_CHARS)
    }
    if (typeof input.characterProfile === 'string') {
      policy.characterProfile = input.characterProfile.trim().slice(0, PROFILE_MAX_CHARS)
    }
    policy.firstDeliveryAfterDays = clampInt(
      input.firstDeliveryAfterDays,
      1,
      36500,
      policy.firstDeliveryAfterDays,
    )
    policy.deliveryIntervalDays = clampInt(
      input.deliveryIntervalDays,
      1,
      3650,
      policy.deliveryIntervalDays,
    )
    if (typeof input.deliveryDir === 'string') policy.deliveryDir = input.deliveryDir.trim()
    policy.syncIntervalDays = clampInt(input.syncIntervalDays, 1, 3650, policy.syncIntervalDays)
    policy.vaultRetentionMonths = clampInt(input.vaultRetentionMonths, 1, 240, policy.vaultRetentionMonths)
    policy.recallWarmthDays = clampInt(input.recallWarmthDays, 0, 365, policy.recallWarmthDays)
    policy.maintainThrottleMinutes = clampInt(
      input.maintainThrottleMinutes,
      0,
      1440,
      policy.maintainThrottleMinutes,
    )
    policy.digestRetentionDays = clampInt(
      input.digestRetentionDays,
      30,
      3650,
      policy.digestRetentionDays,
    )
    policy.importantThreshold = clampInt(input.importantThreshold, 1, 100, policy.importantThreshold)
    policy.secondaryThreshold = clampInt(input.secondaryThreshold, 0, 100, policy.secondaryThreshold)
    if (typeof input.vaultPassHash === 'string') policy.vaultPassHash = input.vaultPassHash
    if (typeof input.vaultPassSalt === 'string') policy.vaultPassSalt = input.vaultPassSalt

    if (Array.isArray(input.layers)) {
      const byId = new Map(policy.layers.map((layer) => [layer.id, layer]))
      for (const patch of input.layers) {
        if (!isPlainObject(patch) || typeof patch.id !== 'string') continue
        const base = byId.get(patch.id)
        if (!base) continue
        byId.set(patch.id, mergeLayer(base, patch))
      }
      policy.layers = policy.layers.map((layer) => byId.get(layer.id) || layer)
    }
  }

  if (policy.secondaryThreshold >= policy.importantThreshold) {
    policy.secondaryThreshold = Math.max(0, policy.importantThreshold - 1)
  }

  policy.layers = policy.layers
    .slice()
    .sort((a, b) => a.afterDays - b.afterDays)
    .map((layer, index, all) => {
      if (index === 0) return { ...layer, afterDays: 0 }
      const previous = all[index - 1]
      return layer.afterDays <= previous.afterDays
        ? { ...layer, afterDays: previous.afterDays + 1 }
        : layer
    })

  return policy
}

/** Copy without the passphrase verifier (safe to hand to a model / a page). */
export function publicPolicy(policy) {
  const copy = clone(policy)
  delete copy.vaultPassHash
  delete copy.vaultPassSalt
  return {
    ...copy,
    passphraseSet: Boolean(policy.vaultPassHash),
    layerDates: policy.layers.map((layer) => ({ id: layer.id, label: layer.label, afterDays: layer.afterDays })),
  }
}

export function layerIndexAt(ageDays, policy) {
  let index = 0
  for (let i = 0; i < policy.layers.length; i += 1) {
    if (ageDays >= policy.layers[i].afterDays) index = i
    else break
  }
  return index
}

/**
 * 痛苦记忆的判定：type=pain，或任何 valence=painful 的记录。
 * 事实（正文）按核心节点保留，当时的痛苦感受强制走 painFeeling 淡忘轨道。
 */
export function isPainfulRecord(record) {
  return record.type === 'pain' || record.valence === 'painful'
}

/**
 * The class decides what may be destroyed. Pain is treated as core text
 * ("痛苦记忆可以保留") but its feeling is forced through its own fade track.
 */
export function classify(record, policy) {
  if (isPainfulRecord(record)) return 'core'
  if (record.special === true) return 'core'
  if (record.type === 'personality' || record.type === 'emotion' || record.type === 'turning_point') {
    return 'core'
  }
  const importance = Number(record.importance) || 0
  if (importance >= policy.importantThreshold) return 'important'
  if (importance >= policy.secondaryThreshold) return 'secondary'
  return 'trivial'
}

/** Ranking of feeling stages: higher index = more faded. */
export function feelingRank(stage) {
  const index = FEELING_STAGES.indexOf(stage)
  return index < 0 ? 0 : index
}

function painFeeling(ageDays) {
  if (ageDays < 7) return 'full'
  if (ageDays < 30) return 'soft'
  if (ageDays < 365) return 'faint'
  return 'faded'
}

function warmUp(stage, steps = 1) {
  const index = Math.max(0, feelingRank(stage) - steps)
  return FEELING_STAGES[index]
}

/**
 * Compute the decay target for one record.
 *
 * `warmth` (default true) uses `lastRecalledAt` to pause decay for
 * `recallWarmthDays`: a memory that was just recalled is not compressed
 * further while it is warm. It never *restores* text that was already lost,
 * because the loss was physical.
 */
export function planFor(record, now, policy, options = {}) {
  const warmthEnabled = options.warmth !== false
  const happenedAt = record.happenedAt ?? record.createdAt ?? now
  const ageDays = ageDaysOf(happenedAt, now)
  const index = layerIndexAt(ageDays, policy)
  const layer = policy.layers[index]
  const cls = classify(record, policy)
  const base = layer[cls]

  const frozen = record.state === 'forgotten' || record.state === 'merged'
  if (frozen) {
    return {
      layerId: layer.id,
      layerLabel: layer.label,
      layerIndex: index,
      class: cls,
      action: 'keep',
      detail: 0,
      feeling: 'gone',
      ageDays,
      warmed: false,
      frozen: true,
    }
  }

  let action = cls === 'core' ? 'keep' : base.action || 'keep'
  if (record.type === 'digest') action = 'keep'
  let detail = base.detail
  let feelingStage = base.feeling

  if (isPainfulRecord(record)) {
    const painStage = painFeeling(ageDays)
    if (feelingRank(painStage) > feelingRank(feelingStage)) feelingStage = painStage
  }

  const warmed = Boolean(
    warmthEnabled
    && Number(record.lastRecalledAt) > 0
    && now - Number(record.lastRecalledAt) <= policy.recallWarmthDays * DAY_MS,
  )
  if (warmed) {
    // Pause physical decay, but do not upgrade content that no longer exists.
    if (Number.isFinite(record.detailLevel)) detail = Math.max(detail, record.detailLevel)
    if (record.feelingStage) {
      const storedRank = feelingRank(record.feelingStage)
      if (feelingRank(feelingStage) > storedRank) feelingStage = warmUp(feelingStage, 1)
    }
  }

  return {
    layerId: layer.id,
    layerLabel: layer.label,
    layerIndex: index,
    class: cls,
    action,
    detail: DETAIL_LEVELS.includes(Number(detail)) ? Number(detail) : 2,
    feeling: feelingStage,
    ageDays,
    warmed,
    frozen: false,
  }
}

/** Human-readable policy digest for tool output. */
export function describePolicy(policy) {
  const lines = [
    `遗忘日历（可调）：${policy.layers.map((layer) => `${layer.afterDays}天→${layer.label}`).join(' · ')}`,
    `重要阈值 ${policy.importantThreshold} · 次重要阈值 ${policy.secondaryThreshold} · 回想保温 ${policy.recallWarmthDays} 天`,
    `文档同步周期 ${policy.syncIntervalDays} 天 · 加密档案保留 ${policy.vaultRetentionMonths} 个月`,
    `自动交付${policy.personaName ? `「${policy.personaName}」` : '（名字未设置，交付文件名暂用「心印」）'}：首次 ${policy.firstDeliveryAfterDays} 天后 · 之后每 ${policy.deliveryIntervalDays} 天一份 · 目录 ${policy.deliveryDir || '工作区/心印交付'}`,
    `文档状态：${policy.disclosure === 'disclosed' ? '已交付用户' : '保密（尚未交付）'}`,
  ]
  return lines.join('\n')
}

/** Validate the shape of a user-supplied policy patch (returns cleaned patch). */
export function sanitizePolicyPatch(input) {
  if (!isPlainObject(input)) return {}
  const patch = {}
  for (const key of [
    'syncIntervalDays',
    'vaultRetentionMonths',
    'recallWarmthDays',
    'maintainThrottleMinutes',
    'importantThreshold',
    'secondaryThreshold',
    'firstDeliveryAfterDays',
    'deliveryIntervalDays',
  ]) {
    if (input[key] !== undefined) patch[key] = input[key]
  }
  if (DISCLOSURES.includes(input.disclosure)) patch.disclosure = input.disclosure
  if (typeof input.personaName === 'string') patch.personaName = input.personaName
  if (typeof input.personaProfile === 'string') patch.personaProfile = input.personaProfile
  if (typeof input.characterProfile === 'string') patch.characterProfile = input.characterProfile
  if (typeof input.deliveryDir === 'string') patch.deliveryDir = input.deliveryDir
  if (Array.isArray(input.layers)) {
    patch.layers = input.layers
      .filter((layer) => isPlainObject(layer) && typeof layer.id === 'string' && DEFAULT_LAYERS.some((d) => d.id === layer.id))
      .map((layer) => {
        const clean = { id: layer.id }
        if (layer.afterDays !== undefined) clean.afterDays = clampNumber(layer.afterDays, 0, 365_000, 0)
        for (const key of CLASS_KEYS) {
          if (isPlainObject(layer[key])) {
            const rulePatch = {}
            if (layer[key].detail !== undefined) rulePatch.detail = layer[key].detail
            if (layer[key].feeling !== undefined) rulePatch.feeling = layer[key].feeling
            if (layer[key].action !== undefined) rulePatch.action = layer[key].action
            clean[key] = rulePatch
          }
        }
        return clean
      })
  }
  return patch
}
