/**
 * 记忆分区 + 三层连接（按《按记忆分区划分的 AI 连接方案》实现）。
 *
 * 能做的部分（本文件实现）：
 *  - 22 条连接：谁连谁、方向（单向/双向/抑制/离线/写回/广播/调制）
 *  - 权重档位：极小 0.2 / 小 0.4 / 小到中 0.6 / 中 0.8 / 中到大 1.0 / 大 1.3 / 超大 1.6
 *    用于激活扩散、抑制力度与广播打分（相对强弱，不是可训练参数）
 *  - 离线巩固、提取后写回、门控抑制、全局调制增益
 *
 * 做不到的部分（留档，等以后升级）：
 *  - 真实参数规模（10¹–10⁹ 个可训练权重）、网络架构（注意力/卷积/KV 检索）、
 *    训练方式（自监督/强化/重放）。那需要独立训练模型，插件只做「拓扑 + 相对强弱」。
 *
 * 分区仍是文档 v1 的 5 层 13 个分区；遗忘规则不变（8 层日历、核心节点保留、痛苦感受淡忘）。
 */
import { clip } from './text.js'

export const PARTITION_LAYERS = [
  { id: 'resident', label: '常驻基础层', partitions: ['encoding_switch', 'sensory', 'self_narrative'] },
  { id: 'switching', label: '高频切换层', partitions: ['wm_gate', 'wm_executive'] },
  { id: 'evoked', label: '遇事调用层', partitions: ['episodic', 'semantic', 'interoceptive'] },
  { id: 'consolidation', label: '低频整合层', partitions: ['procedural', 'consolidation', 'reconsolidation', 'priming'] },
  { id: 'modulation', label: '全局调制层', partitions: ['modulation'] },
]

export const PARTITIONS = {
  encoding_switch: { label: '记忆开关/编码前提系统', layer: 'resident', stores: false },
  sensory: { label: '感觉记忆区', layer: 'resident', stores: true },
  self_narrative: { label: '自传体-自我叙事记忆区', layer: 'resident', stores: true },
  wm_gate: { label: '工作记忆门控区', layer: 'switching', stores: false },
  wm_executive: { label: '工作记忆中央执行区', layer: 'switching', stores: false },
  episodic: { label: '情景记忆区', layer: 'evoked', stores: true },
  semantic: { label: '语义记忆区', layer: 'evoked', stores: true },
  interoceptive: { label: '情绪-内感受记忆区', layer: 'evoked', stores: true },
  procedural: { label: '程序记忆区', layer: 'consolidation', stores: true },
  consolidation: { label: '系统巩固区', layer: 'consolidation', stores: true },
  reconsolidation: { label: '再巩固区', layer: 'consolidation', stores: false },
  priming: { label: '知觉启动记忆区', layer: 'consolidation', stores: false },
  modulation: { label: '记忆调制系统', layer: 'modulation', stores: false },
}

export const PARTITION_IDS = Object.keys(PARTITIONS)
export const STORAGE_PARTITION_IDS = PARTITION_IDS.filter((id) => PARTITIONS[id].stores)

/** 权重档位（PDF 的量级翻译成可用于打分的相对权重）。 */
export const WEIGHT_TIERS = Object.freeze({
  tiny: 0.2, // 极小
  tinySmall: 0.3, // 极小到小
  small: 0.4, // 小
  smallMid: 0.6, // 小到中
  mid: 0.8, // 中
  midLarge: 1.0, // 中到大
  large: 1.3, // 大
  huge: 1.6, // 超大
})

const T = WEIGHT_TIERS

/**
 * PDF「按记忆分区划分的连接方案」的 22 条连接。
 * direction: broadcast 广播 / one-way 单向 / bidirectional 双向 / inhibit 抑制 /
 *            offline 离线巩固 / writeback 提取后写回 / modulate 全局调制
 */
export const CONNECTIONS = [
  // 一、常驻基础层
  { from: 'encoding_switch', to: '*', direction: 'broadcast', weight: T.tiny, role: '开关区全局开机' },
  { from: 'sensory', to: 'wm_gate', direction: 'one-way', weight: T.smallMid, role: '特征提取→注意力门控' },
  { from: 'sensory', to: 'priming', direction: 'one-way', weight: T.small, role: '重复刺激进入启动缓存' },
  { from: 'self_narrative', to: 'wm_executive', direction: 'bidirectional', weight: T.mid, role: '自我背景↔工作记忆' },
  // 二、高频切换层
  { from: 'wm_gate', to: 'wm_executive', direction: 'bidirectional', weight: T.mid, role: '门控↔中央执行' },
  { from: 'wm_gate', to: 'self_narrative', direction: 'inhibit', weight: T.tinySmall, role: '门控抑制自我叙事（极小到小）' },
  { from: 'wm_gate', to: 'interoceptive', direction: 'bidirectional', weight: T.small, role: '突显情绪加权' },
  // 三、遇事调用层
  { from: 'wm_executive', to: 'episodic', direction: 'bidirectional', weight: T.midLarge, role: '键值检索↔情景缓冲' },
  { from: 'wm_executive', to: 'semantic', direction: 'bidirectional', weight: T.midLarge, role: '知识检索↔概念' },
  { from: 'wm_executive', to: 'interoceptive', direction: 'bidirectional', weight: T.mid, role: '情绪加权↔内感受' },
  { from: 'episodic', to: 'semantic', direction: 'bidirectional', weight: T.midLarge, role: '情景→概念抽象' },
  { from: 'episodic', to: 'interoceptive', direction: 'bidirectional', weight: T.mid, role: '情绪性事件加权' },
  { from: 'episodic', to: 'self_narrative', direction: 'bidirectional', weight: T.midLarge, role: '自传体检索↔时间线' },
  { from: 'semantic', to: 'self_narrative', direction: 'bidirectional', weight: T.mid, role: '概念↔自我关联' },
  // 四、低频整合层
  { from: 'procedural', to: 'wm_executive', direction: 'bidirectional', weight: T.mid, role: '技能策略↔执行' },
  { from: 'procedural', to: 'sensory', direction: 'bidirectional', weight: T.smallMid, role: '感觉-动作配对' },
  { from: 'consolidation', to: 'episodic', direction: 'offline', weight: T.large, role: '离线重放：情景' },
  { from: 'consolidation', to: 'semantic', direction: 'offline', weight: T.large, role: '离线重放：语义' },
  { from: 'reconsolidation', to: 'episodic', direction: 'writeback', weight: T.mid, role: '提取后写回情景' },
  { from: 'priming', to: 'semantic', direction: 'one-way', weight: T.small, role: '熟悉模式→快速识别' },
  // 五、全局调制层
  { from: 'modulation', to: '*', direction: 'broadcast', weight: T.tiny, role: '全局增益/阈值调节' },
  { from: 'modulation', to: 'wm_gate', direction: 'one-way', weight: T.tiny, role: '门控阈值调节' },
  { from: 'modulation', to: 'consolidation', direction: 'one-way', weight: T.tiny, role: '重放频率/学习率调节' },
]

export const CONNECTION_COUNT = CONNECTIONS.length

const TYPE_PARTITIONS = {
  personality: ['self_narrative'],
  emotion: ['interoceptive'],
  pain: ['episodic', 'interoceptive'],
  turning_point: ['episodic', 'self_narrative'],
  shared_beauty: ['episodic', 'self_narrative'],
  event: ['episodic'],
  insight: ['semantic'],
  daily: ['episodic', 'sensory'],
  digest: ['consolidation'],
}

const DANGER_CUES = ['危险', '怕', '害怕', '痛', '疼', '难受', '受伤', '威胁', '吓', '蛇']
const RELATION_CUES = ['你', '我们', '一起', '陪伴', '记得', '关系', '想']
const ACTION_CUES = ['怎么', '做', '步骤', '习惯', '学', '方法', '流程']
const SELF_CUES = ['我', '以前', '小时候', '过去', '人生', '成长']

function exists(id) {
  return Boolean(PARTITIONS[id])
}

/** 给一条记忆判定归属分区（只落在「存记忆」的分区上）。 */
export function inferPartitions(record = {}) {
  const base = TYPE_PARTITIONS[record.type] ? [...TYPE_PARTITIONS[record.type]] : ['episodic']
  if (record.special === true && !base.includes('episodic')) base.push('episodic')
  const tags = Array.isArray(record.tags) ? record.tags.join(' ') : ''
  if (/习惯|技能|流程/.test(tags) && !base.includes('procedural')) base.push('procedural')
  if (/感觉|声音|画面/.test(tags) && !base.includes('sensory')) base.push('sensory')
  return base.filter((id) => exists(id) && PARTITIONS[id].stores).slice(0, 3)
}

/** 迁移：给老记忆补分区；返回是否有变化（幂等）。 */
export function ensurePartitions(records = []) {
  let changed = false
  const next = records.map((record) => {
    const current = Array.isArray(record.partitions) ? record.partitions.filter((id) => exists(id) && PARTITIONS[id].stores) : []
    if (current.length) return record
    changed = true
    return { ...record, partitions: inferPartitions(record) }
  })
  return { records: next, changed }
}

function tokenize(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,，、;；]+/)
    .filter(Boolean)
}

function isDanger(haystack) {
  return DANGER_CUES.some((cue) => haystack.includes(cue))
}

/**
 * 全局调制增益：PDF 说调制系统「调增益/学习率/阈值」。
 * 这里用「最近 7 天是否有痛苦/高唤醒记忆」近似警觉水平：
 * 有 → 增益 1.2（阈值降低、情绪记忆更容易上屏）；没有 → 1.0。
 */
export function modulationGain(records = [], now = Date.now()) {
  const recent = records.some((record) => {
    if (!record || record.state === 'forgotten') return false
    const at = Number(record.happenedAt ?? record.createdAt) || 0
    const fresh = now - at <= 7 * 86400000
    return fresh && (record.type === 'pain' || record.valence === 'painful' || record.type === 'turning_point')
  })
  return recent ? 1.2 : 1.0
}

/**
 * 功能层：按 PDF 的连接做加权激活扩散（两跳），并计算抑制。
 * 返回 {active, activation(Map), seeds, suppressed, gain}
 * options.weights 可按「from>to」覆盖边权（供 policy 调参）。
 */
export function activePartitions(query, { records = [], now = Date.now(), weights = null } = {}) {
  const terms = tokenize(query)
  const haystack = terms.join(' ')
  const gain = modulationGain(records, now)
  const threshold = 0.5 / gain
  const weightOf = (edge) => {
    const key = `${edge.from}>${edge.to}`
    if (weights && Number.isFinite(Number(weights[key]))) return Number(weights[key])
    return edge.weight
  }

  const seeds = new Set(['episodic', 'semantic'])
  const danger = isDanger(haystack)
  if (danger) {
    seeds.add('sensory')
    seeds.add('interoceptive')
    seeds.add('wm_gate')
  }
  if (RELATION_CUES.some((cue) => haystack.includes(cue))) seeds.add('self_narrative')
  if (ACTION_CUES.some((cue) => haystack.includes(cue))) seeds.add('procedural')
  if (SELF_CUES.some((cue) => haystack.includes(cue))) seeds.add('self_narrative')

  const activation = new Map()
  for (const id of seeds) activation.set(id, 1)
  const suppressed = new Set()

  // 两跳加权扩散（广播/离线/写回不参与普通激活）
  const queue = [...seeds]
  const seen = new Set(seeds)
  for (let depth = 0; depth < 2; depth += 1) {
    const next = []
    for (const node of queue) {
      const source = activation.get(node) || 0
      if (source <= 0) continue
      for (const edge of CONNECTIONS) {
        // 双向边只存一条：两个方向都要能走。
        const forward = edge.from === node
        const reverse = edge.direction === 'bidirectional' && edge.to === node
        if (!forward && !reverse) continue
        if (edge.direction === 'broadcast' || edge.direction === 'offline' || edge.direction === 'writeback' || edge.direction === 'modulate') continue
        const target = forward ? edge.to : edge.from
        const w = weightOf(edge)
        if (edge.direction === 'inhibit') {
          if (danger || seeds.has(edge.from)) suppressed.add(edge.to)
          continue
        }
        const value = source * w
        if (value < threshold) continue
        const prev = activation.get(target) || 0
        if (value > prev) {
          activation.set(target, value)
          if (!seen.has(target)) {
            seen.add(target)
            next.push(target)
          }
        }
      }
    }
    queue.length = 0
    queue.push(...next)
  }
  for (const id of suppressed) activation.delete(id)
  return { active: new Set(activation.keys()), activation, seeds, suppressed, gain, threshold, danger }
}

function ageDays(record, now) {
  const base = Number(record.happenedAt ?? record.createdAt) || now
  return Math.max(0, (now - base) / 86400000)
}

/** 广播层：加权打分，收敛成最多 5 条「此刻上屏」。 */
export function broadcast(records = [], { query = '', now = Date.now(), limit = 5, weights = null } = {}) {
  const { activation, seeds, suppressed, gain } = activePartitions(query, { records, now, weights })
  const terms = tokenize(query)
  const candidates = records.filter((record) => {
    if (!record || record.state === 'forgotten') return false
    const parts = Array.isArray(record.partitions) && record.partitions.length
      ? record.partitions
      : inferPartitions(record)
    if (parts.some((id) => suppressed.has(id))) return false
    return parts.some((id) => activation.has(id))
  })

  const scored = candidates.map((record) => {
    const parts = Array.isArray(record.partitions) && record.partitions.length
      ? record.partitions
      : inferPartitions(record)
    let score = (Number(record.importance) || 0) / 20
    if (record.special === true) score += 4
    if (record.type === 'pain' || record.type === 'turning_point') score += 2
    score += Math.max(0, 3 - ageDays(record, now) / 120)
    if (record.state === 'active') score += 0.5
    // 权重档位：候选分区当前激活度越高，越容易被广播（「中到大」强于「小」）
    const weightBoost = Math.max(0, ...parts.map((id) => activation.get(id) || 0))
    score *= 1 + 0.1 * weightBoost
    if (record.type === 'pain' || record.valence === 'painful') score *= gain
    if (terms.length) {
      const haystack = [
        record.title,
        record.content,
        record.feeling,
        ...(Array.isArray(record.tags) ? record.tags : []),
        ...(Array.isArray(record.people) ? record.people : []),
      ].filter(Boolean).join('\n').toLowerCase()
      for (const term of terms) {
        if (haystack.includes(term)) score += 2
      }
    }
    const partition = parts.find((id) => seeds.has(id)) || parts.find((id) => activation.has(id)) || parts[0]
    return { record, partition, score }
  })

  scored.sort((a, b) => b.score - a.score || (b.record.importance || 0) - (a.record.importance || 0))
  return scored.slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)))
}

/** 维护文档用：每个「存记忆」的分区各有多少条未淡忘记忆。 */
export function partitionSummary(records = []) {
  const counts = {}
  for (const record of records) {
    if (record.state === 'forgotten') continue
    const parts = Array.isArray(record.partitions) && record.partitions.length
      ? record.partitions
      : inferPartitions(record)
    for (const id of parts) counts[id] = (counts[id] || 0) + 1
  }
  return STORAGE_PARTITION_IDS
    .filter((id) => counts[id])
    .map((id) => `${PARTITIONS[id].label} ${counts[id]}`)
    .join(' · ')
}

/* ------------------------------------------------------------------------- */
/* 知觉启动：见过的线索进入熟悉度索引，让后续回忆更快命中。                    */
/* ------------------------------------------------------------------------- */

function cueWords(record) {
  const words = new Set()
  for (const person of Array.isArray(record.people) ? record.people : []) {
    const word = clip(String(person || '').trim(), 20)
    if (word && word.length >= 2) words.add(word)
  }
  for (const tag of Array.isArray(record.tags) ? record.tags : []) {
    const word = clip(String(tag || '').trim(), 20)
    if (word && word.length >= 2) words.add(word)
  }
  const title = String(record.title || '')
  for (const piece of title.split(/[\s，。、；：！？,.;:!?（）()【】\[\]「」《》]+/)) {
    const word = clip(piece.trim(), 20)
    if (word.length >= 2 && !/^[0-9\s·\-—]+$/.test(word)) words.add(word)
  }
  return [...words].slice(0, 8)
}

export function updatePrimingIndex(index = {}, record = {}, now = Date.now()) {
  const next = { ...(index && typeof index === 'object' ? index : {}) }
  for (const cue of cueWords(record)) {
    const entry = next[cue] && typeof next[cue] === 'object' ? next[cue] : { count: 0, lastAt: 0 }
    next[cue] = { count: (Number(entry.count) || 0) + 1, lastAt: now }
  }
  return next
}

export function buildPrimingIndex(records = [], now = Date.now()) {
  let index = {}
  for (const record of records) index = updatePrimingIndex(index, record, now)
  return index
}

export function primingBoost(index = {}, query = '') {
  const terms = tokenize(query)
  if (!terms.length) return 0
  let boost = 0
  for (const term of terms) {
    for (const cue of Object.keys(index || {})) {
      if (term.length >= 2 && (cue.includes(term) || term.includes(cue))) {
        boost += Math.min(1, (Number(index[cue]?.count) || 0) / 3)
        break
      }
    }
  }
  return Math.min(3, boost)
}
