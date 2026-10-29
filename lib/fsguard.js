/**
 * 写入收口（应用层最小权限）。
 *
 * 所有落盘操作都必须先过这里：只允许写心印自己的数据目录，以及用户已经
 * 确认过的交付目录。它是「运行时自我保护」——能挡住路径写错、bug 误写，
 * 但挡不住被注入的代码（那不是应用层能解决的边界）。这一点不要对外夸大。
 */
import path from 'node:path'

export class ScopeError extends Error {
  constructor(target, event) {
    super(`写入被拒绝：${event} 指向了允许范围之外的路径（${target}）`)
    this.name = 'ScopeError'
    this.code = 'ESCOPE'
    this.target = target
    this.event = event
  }
}

export function createWriteGuard({ dataDir, getExtraRoots } = {}) {
  const baseRoots = [path.resolve(String(dataDir || '.'))]
  const extraRoots = typeof getExtraRoots === 'function' ? getExtraRoots : () => []
  // 运行期显式确认过的目录（例如用户指定了一次性的交付路径）。
  const runtimeRoots = []

  function roots() {
    const extra = [...runtimeRoots]
    try {
      for (const dir of extraRoots() || []) {
        if (dir) extra.push(path.resolve(String(dir)))
      }
    } catch {
      // 取不到附加目录时按「只有数据目录」处理（默认拒绝）。
    }
    return [...baseRoots, ...extra]
  }

  /** 用户在一次明确动作里选定的目录：只能加、不加宽默认范围。 */
  function addRoot(dir) {
    const resolved = path.resolve(String(dir || ''))
    if (!resolved || !runtimeRoots.includes(resolved)) runtimeRoots.push(resolved)
    return resolved
  }

  function allowed(target) {
    const abs = path.resolve(String(target || ''))
    return roots().some((root) => abs === root || abs.startsWith(`${root}${path.sep}`))
  }

  function assert(target, event = 'write') {
    const abs = path.resolve(String(target || ''))
    if (!allowed(abs)) throw new ScopeError(abs, event)
    return abs
  }

  return {
    kind: 'application-level',
    roots,
    allowed,
    assert,
    addRoot,
  }
}
