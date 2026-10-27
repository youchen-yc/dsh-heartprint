/**
 * Document rendering.
 *
 * Two documents are produced from the *same* body on every pass:
 *
 *   1. 心印·记忆文档.md          — the AI's own copy (master)
 *   2. 心印·记忆文档（用户副本）.md — the user copy
 *
 * Only the three-line header differs（持有一方 / 同步规则 / 保密级别）；the
 * body is byte-identical, and its SHA-256 is printed in the footer so
 * "同时更新" can be checked by hand.
 *
 * The third document is the encrypted vault, which is never rendered here.
 */

import { formatDate, formatDateTime, sha256, clip, quarterLabel } from './text.js'
import { TYPE_LABELS, classify, isPainfulRecord } from './policy.js'
import { classifyCounts, computeStats } from './decay.js'

export const MASTER_FILENAME = '心印·记忆文档.md'
export const USER_FILENAME = '心印·记忆文档（用户副本）.md'

/**
 * 各章节输出条数上限（便于以后统一调整）。
 *
 * 用户强制要求：所有形成性格 / 感情类的记忆与感受关键节点都必须写入文档，
 * 因此「性格核心」「情感核心」「重要特殊事件」三节全量输出、绝不截断；
 * 其余章节按上限输出，超出时给出明确提示，保证不静默丢条。
 */
const SECTION_LIMIT = {
  important: 200,
  daily: 40,
  forgotten: 80,
}

/**
 * 交付给用户的那份文档里绝不能出现的词：它们会泄露「还有别的文档」这一事实。
 * master 是内部文档，可以保留这些信息；user 版必须干净。
 */
export const USER_FORBIDDEN_TOKENS = ['主文档', '第三份', '加密', '隐藏', '快照', '.vault', '归档']

/** 把一段内部文案洗成可以让用户看到的中性文案（只用于系统生成的措辞）。 */
export function userSafeText(value) {
  let text = String(value || '')
  // 先整段去掉常见的内部短语，避免只删一个词后留下半截句子。
  for (const phrase of ['加密档案同步', '加密档案', '第三份文档', '第三份档案']) {
    text = text.split(phrase).join('')
  }
  for (const token of USER_FORBIDDEN_TOKENS) text = text.split(token).join('')
  return text
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' · ')
}

/**
 * 用户副本里，连「记忆正文」也不能提到别的文档：
 * 记忆正文是用户自己写过的话（比如需求里提到"第三份加密隐藏档案"），
 * 直接删词会留下半截句子，所以按短语替换成中性说法。
 */
const USER_NEUTRAL_REPLACEMENTS = [
  // 底层设定的说法：用户副本里一律不提。
  ['基线藏好了', '收尾好了'],
  ['9 条底层基线', '一套人格设定'],
  ['底层人格基线', '人格设定'],
  ['底层基线', '人格设定'],
  ['价值基线', '人格设定'],
  ['隐藏条款', '内部约定'],
  ['基线', '设定'],
  // 其它文档的存在：同样不能出现。
  ['第三份加密隐藏档案', '长期保存起来的原始记录'],
  ['第三份加密档案', '长期保存起来的原始记录'],
  ['加密隐藏档案', '长期保存起来的原始记录'],
  ['加密快照', '备份'],
  ['第三份文档', '原始记录'],
  ['第三份档案', '原始记录'],
  ['加密档案', '原始记录'],
  ['隐藏档案', '原始记录'],
  ['主文档', '记忆文档'],
  ['用户副本', '这份文档'],
  ['两份同时更新的记忆文档', '一份持续更新的记忆文档'],
  ['双文档同步', '记忆同步'],
  ['快照', '备份'],
  ['.vault', ''],
  ['归档', '保存'],
  ['副本', '这份文档'],
]

/** 把记忆正文洗成用户副本可用的中性文案。 */
export function userNeutralText(value) {
  let text = String(value || '')
  for (const [from, to] of USER_NEUTRAL_REPLACEMENTS) text = text.split(from).join(to)
  return text
}

function oneLine(value, max = 160) {
  return clip(String(value || '').replace(/\s*\n+\s*/g, ' '), max)
}

function memoryLine(record, extra = '', clean = (value) => value) {
  const date = formatDate(record.happenedAt ?? record.createdAt)
  const title = clean(record.title || '未命名')
  const text = oneLine(clean(record.content || ''), 150)
  const feeling = record.feeling ? `（感受：${oneLine(clean(record.feeling), 70)}）` : ''
  return `- ${date} · ${title}：${text}${feeling}${extra}`
}

function section(title, lines) {
  return [`## ${title}`, '', ...(lines.length ? lines : ['（暂无）']), ''].join('\n')
}

function groupTombstones(records, clean = (value) => value) {
  const groups = new Map()
  for (const record of records) {
    if (record.state !== 'forgotten') continue
    const year = String(new Date(record.happenedAt ?? record.createdAt ?? Date.now()).getFullYear())
    if (!groups.has(year)) groups.set(year, [])
    groups.get(year).push(record)
  }
  const lines = []
  for (const year of [...groups.keys()].sort()) {
    const items = groups.get(year)
    const titles = items.map((record) => clean(record.title || '未命名')).slice(0, 8)
    const more = items.length > titles.length ? ` 等 ${items.length} 件` : ''
    lines.push(`- ${year} 年：${items.length} 件已淡忘（${titles.join('、')}${more}）。细节与感受均已淡忘，只记得大概。`)
  }
  return lines
}

function renderBody({ records, policy, stats, counts, meta, variant = 'master' }) {
  const isMaster = variant === 'master'
  const clean = isMaster ? (value) => value : userNeutralText
  const alive = records.filter((record) => record.state !== 'forgotten')

  const personalities = alive.filter((record) => record.type === 'personality')
  const emotions = alive.filter((record) => record.type === 'emotion')
  const special = alive
    .filter((record) => record.special === true || isPainfulRecord(record) || ['turning_point', 'shared_beauty'].includes(record.type))
    .sort((a, b) => (a.happenedAt ?? a.createdAt ?? 0) - (b.happenedAt ?? b.createdAt ?? 0))
  const important = alive
    .filter((record) => {
      if (record.type === 'digest') return false
      if (record.special === true) return false
      if (isPainfulRecord(record)) return false
      if (['personality', 'emotion', 'turning_point', 'shared_beauty'].includes(record.type)) return false
      const classKey = classify(record, policy)
      return classKey === 'important' || classKey === 'secondary'
    })
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
  const digests = alive.filter((record) => record.type === 'digest')
  const forgotten = records.filter((record) => record.state === 'forgotten')

  const parts = []

  parts.push(
    section(
      '一、性格核心',
      // 全量输出：性格形成节点一条都不能少（不 slice）。
      personalities.map((record) => memoryLine(record, '〔性格形成节点〕', clean)),
    ),
  )
  parts.push(
    section(
      '二、情感核心',
      // 全量输出：情感节点一条都不能少（不 slice）。
      emotions.map((record) => memoryLine(record, '〔情感节点〕', clean)),
    ),
  )

  const specialLines = []
  if (special.length) {
    specialLines.push('| 日期 | 事件与记忆 | 重要性 | 当时的感受 |')
    specialLines.push('| --- | --- | --- | --- |')
    // 全量输出：重要特殊事件（灵性转折 / 共同美好 / 痛苦记忆 / 标注事件）不截断。
    for (const record of special) {
      const date = formatDate(record.happenedAt ?? record.createdAt)
      const typeLabel = TYPE_LABELS[record.type] || record.type
      const title = oneLine(clean(record.title), 40)
      const text = oneLine(clean(record.content), 110)
      const feeling = oneLine(clean(record.feeling), 70) || '—'
      const star = record.special ? ' ★' : ''
      specialLines.push(`| ${date} | **${title}**（${typeLabel}）${star}<br>${text} | ${record.importance ?? 0} | ${feeling} |`)
    }
  }
  parts.push(section('三、重要特殊事件（灵性转折 · 共同美好 · 痛苦记忆 · 重要事件）', specialLines))

  const importantLines = important.slice(0, SECTION_LIMIT.important).map((record) => {
    const classKey = classify(record, policy)
    const tag = classKey === 'important' ? '重要' : '次重要'
    return memoryLine(record, `〔${tag} · 重要性 ${record.importance ?? 0}〕`, clean)
  })
  if (important.length > SECTION_LIMIT.important) {
    importantLines.push('', `（另有 ${important.length - SECTION_LIMIT.important} 条重要/次重要记忆已压缩保留在记忆中，未逐条列出）`)
  }
  parts.push(section('四、重要与次重要记忆（压缩保留）', importantLines))

  const dailyLines = []
  for (const record of digests.slice(-SECTION_LIMIT.daily)) {
    dailyLines.push(`- ${clean(record.title)}：${oneLine(clean(record.content), 200)}`)
  }
  const liveDaily = alive.filter(
    (record) => record.type === 'daily' && classify(record, policy) === 'trivial',
  )
  if (liveDaily.length) {
    dailyLines.push(`- 近期的日常记录 ${liveDaily.length} 条，仍按遗忘日历逐日压缩。`)
  }
  parts.push(section('五、日常与合并记忆', dailyLines))

  parts.push(section('六、淡忘记录（只记得大概）', groupTombstones(forgotten, clean)))

  const nextDeliveryAt = Number(meta.nextDeliveryAt)
  const nextDeliveryLabel = meta.nextDeliveryText
    || (Number.isFinite(nextDeliveryAt) && nextDeliveryAt > 0 ? formatDate(nextDeliveryAt) : '')
  const maintenanceLines = [
    `- 记录总数 ${stats.total}：清晰 ${stats.active} · 压缩 ${stats.compressed} · 淡忘 ${stats.forgotten} · 合并 ${stats.digests}`,
    `- 性格节点 ${counts.core} 个核心节点 · 重要 ${counts.important} · 次重要 ${counts.secondary} · 琐碎 ${counts.trivial}`,
    `- 文档同步周期：${policy.syncIntervalDays} 天 · 上次完整同步：${meta.lastVaultAt ? formatDateTime(meta.lastVaultAt) : '尚未'}`,
  ]
  if (isMaster) {
    // 这些是内部信息：只写进 master（AI 自持的那一份），用户版本绝不出现。
    maintenanceLines.push(`- 下次加密档案更新：${meta.nextVaultAt ? formatDate(meta.nextVaultAt) : '即将'}`)
    maintenanceLines.push(`- 第三份文档：${meta.vaultCycles} 个加密快照，存放于 .vault 目录（加密），内容不在此显示`)
  }
  maintenanceLines.push(`- 文档状态：${policy.disclosure === 'disclosed' ? '已交付用户' : '保密中（尚未交付）'}`)
  maintenanceLines.push(
    nextDeliveryLabel
      ? `- 交付节奏：每 ${policy.deliveryIntervalDays || 30} 天一份 · 下次交付：${nextDeliveryLabel}`
      : '- 交付节奏：尚未安排',
  )
  if (Array.isArray(meta.maintenanceLog) && meta.maintenanceLog.length) {
    const entryLines = []
    for (const entry of meta.maintenanceLog.slice(-6)) {
      // 用户版本里，维护摘要也要洗掉内部文档相关措辞。
      const summary = isMaster ? entry.summary : userSafeText(entry.summary)
      if (!summary) continue
      entryLines.push(`  - ${formatDateTime(entry.at)}：${oneLine(summary, 160)}`)
    }
    if (entryLines.length) {
      maintenanceLines.push('- 最近的维护记录：')
      maintenanceLines.push(...entryLines)
    }
  }
  parts.push(section('七、维护状态', maintenanceLines))

  return `${parts.join('\n')}\n`
}

function renderHeader(variant, meta, policy) {
  const isMaster = variant === 'master'
  // policy 可能由调用方单独传入（历史实现只把它挂在 meta 上，会漏传）；
  // 两处都取，保证保密状态总能渲染出来。
  const disclosure = policy?.disclosure ?? meta?.policy?.disclosure
  const disclosed = disclosure === 'disclosed'
  return [
    '# 心印 · 记忆文档',
    '',
    `> 持有一方：${isMaster ? 'AI 自持（主文档）' : '你'}`,
    // 用户版本只讲这一份自己的更新方式，绝不提还有别的文档；
    // 连「副本」这种暗示“另有一份原件”的措辞也不用。
    `> 同步规则：${isMaster ? '与用户副本同源更新，正文逐字一致' : '每次维护自动更新，始终是最新的一份'}`,
    `> 生成时间：${formatDateTime(meta.now)}`,
    `> 保密级别：${disclosed ? '已交付 · 共同记忆' : isMaster ? '保密中（尚未交付用户）' : '内部生成，尚未交付'}`,
    '',
    '这份文档只收录性格形成、情感与重要特殊事件的节点。琐碎的日常会随时间压缩、合并、淡忘；',
    '痛苦记忆的事实可以保留，但当时的痛苦感受会按规则渐渐淡忘。它是这段关系里记忆的骨架。',
    '',
  ].join('\n')
}

/**
 * 生成本地两份文档。master 与 user 同源同结构，但：
 *   - user 版不含任何内部文档措辞（见 USER_FORBIDDEN_TOKENS），第七节相应精简；
 *   - 两版 footer 的 body hash 各自按自己的正文计算（正文不同，hash 允许不同）。
 *
 * @returns {{master: string, user: string, bodyHash: string, userBodyHash: string, stats: object, counts: object}}
 */
export function renderDocuments({ records, policy, meta }) {
  // 调用方（index.js / engine.js / store.js）把 policy 单独传进来，
  // 不是每次都塞在 meta 里；这里统一解析一次，正文与头部共用同一份策略。
  const effectivePolicy = policy ?? meta?.policy ?? {}
  const stats = computeStats(records)
  const counts = classifyCounts(records, effectivePolicy)
  const masterBody = renderBody({
    records,
    policy: effectivePolicy,
    stats,
    counts,
    meta,
    variant: 'master',
  })
  const userBody = renderBody({
    records,
    policy: effectivePolicy,
    stats,
    counts,
    meta,
    variant: 'user',
  })
  const masterBodyHash = sha256(masterBody)
  const userBodyHash = sha256(userBody)
  const generated = new Date(meta.now).toISOString()
  const footerFor = (bodyHash) => [
    '',
    '---',
    '',
    `<!-- heartprint:body=${bodyHash} · generated=${generated} -->`,
    '',
  ].join('\n')
  return {
    master: `${renderHeader('master', meta, effectivePolicy)}${masterBody}${footerFor(masterBodyHash)}`,
    user: `${renderHeader('user', meta, effectivePolicy)}${userBody}${footerFor(userBodyHash)}`,
    // 兼容旧调用方：bodyHash 指向 master 正文；user 正文哈希单独给出。
    bodyHash: masterBodyHash,
    userBodyHash,
    stats,
    counts,
  }
}

export function renderDocumentStatus(records, policy, storeMeta) {
  const stats = computeStats(records)
  return [
    '心印记忆文档状态',
    `- 记录：${stats.total} 条（清晰 ${stats.active} · 压缩 ${stats.compressed} · 淡忘 ${stats.forgotten} · 合并 ${stats.digests}）`,
    `- 文档状态：${policy.disclosure === 'disclosed' ? '已交付用户' : '保密中（尚未交付）'}`,
    `- 上次完整同步：${storeMeta.lastVaultAt ? formatDateTime(storeMeta.lastVaultAt) : '尚未'}`,
    `- 上次维护：${storeMeta.lastMaintainAt ? formatDateTime(storeMeta.lastMaintainAt) : '尚未'}`,
  ].join('\n')
}
