/**
 * 记忆分区 + 三层连接（按设计文档 v1 实现，共 13 个分区）。
 *
 * 文档里 5 个层级、13 个分区名称（正文写「十一个」是文档自身的笔误，以表格为准）：
 *   常驻基础层 3 · 高频切换层 2 · 遇事调用层 3 · 低频整合层 4 · 全局调制层 1
 *
 * 三层结构：
 *  1. 底层连接（CONNECTIONS）：分区之间的静态线路，决定「谁和谁能说话」。
 *  2. 功能层组网（activePartitions）：按线索临时组队，两跳扩展；危险线索会激活
 *     感觉记忆区并压住自我叙事（对应文档「蛇」场景）。
 *  3. 广播层（broadcast）：组网结果收敛成最多 5 条「此刻上屏」，而不是把最近
 *     记忆一股脑塞进提示词。
 *
 * 其中「再巩固」「知觉启动」两个分区是**过程分区**（不是存记忆的桶）：
 *  - 再巩固：记忆被提取后可以更新（reconsolidate），旧版本进加密档案；
 *  - 知觉启动：见过的线索（人名/标签/称呼）进入熟悉度索引，让后续回忆更快命中。
 *
 * 本模块只影响「归属、选择、排序」，不影响遗忘规则：
 * 8 层遗忘日历、核心节点保留、痛苦感受淡忘仍由 policy/decay 负责。
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

/**
 * 底层连接。kind：read 读取 / activate 激活 / suppress 抑制 / tune 调制。
 * 文档 2.1 点名的三条线路都已包含：
 *   episodic ↔ wm_executive、interoceptive ↔ episodic、wm_gate ↔ self_narrative。
 */
export const CONNECTIONS = [
  { from: 'episodic', to: 'semantic', kind: 'read' },
  { from: 'episodic', to: 'interoceptive', kind: 'read' },
  { from: 'episodic', to: 'self_narrative', kind: 'read' },
  { from: 'episodic', to: 'wm_executive', kind: 'activate' },
  { from: 'semantic', to: 'episodic', kind: 'read' },
  { from: 'semantic', to: 'procedural', kind: 'activate' },
  { from: 'interoceptive', to: 'wm_gate', kind: 'activate' },
  { from: 'interoceptive', to: 'episodic', kind: 'read' },
  { from: 'wm_gate', to: 'wm_executive', kind: 'activate' },
  { from: 'wm_gate', to: 'self_narrative', kind: 'suppress' },
  { from: 'wm_executive', to: 'self_narrative', kind: 'suppress' },
  { from: 'wm_executive', to: 'episodic', kind: 'read' },
  { from: 'self_narrative', to: 'episodic', kind: 'read' },
  { from: 'procedural', to: 'wm_executive', kind: 'activate' },
  { from: 'consolidation', to: 'episodic', kind: 'read' },
  { from: 'consolidation', to: 'semantic', kind: 'read' },
  { from: 'reconsolidation', to: 'episodic', kind: 'read' },
  { from: 'reconsolidation', to: 'self_narrative', kind: 'read' },
  { from: 'priming', to: 'semantic', kind: 'read' },
  { from: 'priming', to: 'episodic', kind: 'read' },
  { from: 'modulation', to: '*', kind: 'tune' },
]

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

/** 给一条记忆判定归属分区（可多个；第一个是主分区）。只落在「存记忆」的分区上。 */
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

/**
 * 功能层：按线索临时组网，两跳扩展。
 * 返回 {active, seeds, suppressed}；active 含两跳可达的分区，suppressed 被压住。
 */
export function activePartitions(query) {
  const terms = tokenize(query)
  const haystack = terms.join(' ')
  const seeds = new Set(['episodic', 'semantic'])
  const suppressed = new Set()

  const danger = DANGER_CUES.some((cue) => haystack.includes(cue))
  if (danger) {
    // 文档「蛇」场景：感觉记忆区先喊 → 门控区 → 情绪区 → 情景/语义 → 中央执行区
    seeds.add('sensory')
    seeds.add('interoceptive')
    seeds.add('wm_gate')
    suppressed.add('self_narrative')
  }
  if (RELATION_CUES.some((cue) => haystack.includes(cue))) seeds.add('self_narrative')
  if (ACTION_CUES.some((cue) => haystack.includes(cue))) seeds.add('procedural')
  if (SELF_CUES.some((cue) => haystack.includes(cue))) seeds.add('self_narrative')

  const active = new Set(seeds)
  const queue = [...seeds]
  const seen = new Set(seeds)
  for (let depth = 0; depth < 2; depth += 1) {
    const next = []
    for (const node of queue) {
      for (const edge of CONNECTIONS) {
        if (edge.kind === 'tune' || edge.from !== node) continue
        if (edge.kind === 'suppress') {
          // 抑制只在「源头被线索直接激活」或「危险场景下门控/中央执行出手」时生效；
          // 普通对话里自我叙事不会被无端压住。
          const sourceActive = seeds.has(edge.from) || (danger && (edge.from === 'wm_gate' || edge.from === 'wm_executive'))
          if (sourceActive) suppressed.add(edge.to)
          continue
        }
        active.add(edge.to)
        if (!seen.has(edge.to)) {
          seen.add(edge.to)
          next.push(edge.to)
        }
      }
    }
    queue.length = 0
    queue.push(...next)
  }
  for (const id of suppressed) active.delete(id)
  return { active, seeds, suppressed }
}

function ageDays(record, now) {
  const base = Number(record.happenedAt ?? record.createdAt) || now
  return Math.max(0, (now - base) / 86400000)
}

/** 广播层：组网后打分，收敛成「此刻上屏」的少量记忆。 */
export function broadcast(records = [], { query = '', now = Date.now(), limit = 5 } = {}) {
  const { active, seeds, suppressed } = activePartitions(query)
  const terms = tokenize(query)
  const candidates = records.filter((record) => {
    if (!record || record.state === 'forgotten') return false
    const parts = Array.isArray(record.partitions) && record.partitions.length
      ? record.partitions
      : inferPartitions(record)
    if (parts.some((id) => suppressed.has(id))) return false
    return parts.some((id) => active.has(id))
  })

  const scored = candidates.map((record) => {
    const parts = Array.isArray(record.partitions) && record.partitions.length
      ? record.partitions
      : inferPartitions(record)
    let score = (Number(record.importance) || 0) / 20
    if (record.special === true) score += 4
    if (record.type === 'pain' || record.type === 'turning_point') score += 2
    score += Math.max(0, 3 - ageDays(record, now) / 120)
    if (parts.some((id) => seeds.has(id))) score += 2
    if (record.state === 'active') score += 0.5

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
    const partition = parts.find((id) => active.has(id)) || parts[0]
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
    // 纯数字/纯符号不做启动线索，避免「17」「87」这类噪声。
    if (word.length >= 2 && !/^[0-9\s·\-—]+$/.test(word)) words.add(word)
  }
  return [...words].slice(0, 8)
}

/** 把一条记忆的线索计入熟悉度索引（原地返回新对象）。 */
export function updatePrimingIndex(index = {}, record = {}, now = Date.now()) {
  const next = { ...(index && typeof index === 'object' ? index : {}) }
  for (const cue of cueWords(record)) {
    const entry = next[cue] && typeof next[cue] === 'object' ? next[cue] : { count: 0, lastAt: 0 }
    next[cue] = { count: (Number(entry.count) || 0) + 1, lastAt: now }
  }
  return next
}

/** 用记忆库重建熟悉度索引（迁移老数据时用）。 */
export function buildPrimingIndex(records = [], now = Date.now()) {
  let index = {}
  for (const record of records) index = updatePrimingIndex(index, record, now)
  return index
}

/** 查询里命中了多少「熟悉线索」，给回忆加一点启动效应（上限 +3）。 */
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
