import { compareId, type Bounds, type Edge, type Module, type Point, type RuntimeProject, type Port, typeTargets, validateProject, weightFor } from './model'

export type Placement = { instanceId: string; moduleId: string; typeId: string; x: number; z: number; rotation: 0 | 1 | 2 | 3; parent?: { instanceId: string; parentPortId: string; ownPortId: string } }
export type PreviewResult = { placements: Placement[]; complete: boolean; seed: number; checks: number; restarts: number; targets: Record<string, number>; warnings: string[] }
type Candidate = { parentIndex: number; parentPort: Port; child: Module; childPort: Port; rotation: 0 | 1 | 2 | 3; x: number; z: number; rank: number }
type Progress = (result: PreviewResult) => void

export class XorShift32 {
  private state: number
  constructor(seed: number) { this.state = (seed >>> 0) || 0x6d2b79f5 }
  nextUint(): number {
    let x = this.state
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    this.state = x >>> 0
    return this.state
  }
  next(): number { return this.nextUint() / 4294967296 }
  index(length: number): number { return Math.floor(this.next() * length) }
}

export function rotate(point: Point, quarterTurns: number): Point {
  switch (quarterTurns & 3) {
    case 1: return { x: point.z, z: -point.x }
    case 2: return { x: -point.x, z: -point.z }
    case 3: return { x: -point.z, z: point.x }
    default: return { x: point.x, z: point.z }
  }
}
export function rotatedBounds(bounds: Bounds, rotation: number, x = 0, z = 0): Bounds {
  const corners = [
    rotate({ x: bounds.minX, z: bounds.minZ }, rotation), rotate({ x: bounds.minX, z: bounds.maxZ }, rotation),
    rotate({ x: bounds.maxX, z: bounds.minZ }, rotation), rotate({ x: bounds.maxX, z: bounds.maxZ }, rotation),
  ]
  return { minX: Math.min(...corners.map(p => p.x)) + x, maxX: Math.max(...corners.map(p => p.x)) + x, minZ: Math.min(...corners.map(p => p.z)) + z, maxZ: Math.max(...corners.map(p => p.z)) + z }
}
export function overlaps(a: Bounds, b: Bounds): boolean {
  return Math.min(a.maxX, b.maxX) > Math.max(a.minX, b.minX) && Math.min(a.maxZ, b.maxZ) > Math.max(a.minZ, b.minZ)
}
const normal = (edge: Edge): Point => edge === 'N' ? { x: 0, z: 1 } : edge === 'E' ? { x: 1, z: 0 } : edge === 'S' ? { x: 0, z: -1 } : { x: -1, z: 0 }
const usedKey = (index: number, portId: string) => `${index}\u0000${portId}`

export function generate(project: RuntimeProject, seed: number, onProgress?: Progress, maxChecks = 120000, maxRestarts = 24): PreviewResult {
  const errors = validateProject(project)
  if (errors.length) throw new Error(errors.join('\n'))
  const rng = new XorShift32(seed)
  const targets = typeTargets(project)
  const moduleById = new Map(project.modules.map(m => [m.id, m]))
  const modulesByType = new Map(project.types.map(t => [t.id, project.modules.filter(m => m.typeId === t.id).sort((a, b) => compareId(a.id, b.id))]))
  const typeIds = project.types.map(t => t.id).sort()
  let checks = 0
  let restarts = 0
  let best: Placement[] = []
  let bestScore: number[] = [Infinity, Infinity, Infinity]
  const score = (placements: Placement[]): number[] => {
    const counts: Record<string, number> = {}
    for (const p of placements) counts[p.typeId] = (counts[p.typeId] ?? 0) + 1
    const requiredMissing = project.types.reduce((n, t) => n + Math.max(0, t.requiredMin - (counts[t.id] ?? 0)), 0)
    const totalMissing = Math.max(0, project.settings.totalModules - placements.length)
    const typeDeviation = typeIds.reduce((n, id) => n + Math.abs((targets[id] ?? 0) - (counts[id] ?? 0)), 0)
    return [requiredMissing, totalMissing, typeDeviation]
  }
  const better = (a: number[], b: number[]) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))
  const result = (placements: Placement[], complete: boolean): PreviewResult => {
    const counts: Record<string, number> = {}
    placements.forEach(p => { counts[p.typeId] = (counts[p.typeId] ?? 0) + 1 })
    const warnings = complete ? [] : [
      `已放置 ${placements.length}/${project.settings.totalModules} 个模块`,
      ...project.types.filter(t => (counts[t.id] ?? 0) < t.requiredMin).map(t => `${t.name} 必出至少 ${t.requiredMin}，当前 ${counts[t.id] ?? 0}`),
      ...project.types.filter(t => (counts[t.id] ?? 0) !== targets[t.id]).map(t => `${t.name} 目标 ${targets[t.id]}，当前 ${counts[t.id] ?? 0}`),
    ]
    return { placements: placements.map(p => ({ ...p, parent: p.parent ? { ...p.parent } : undefined })), complete, seed: seed >>> 0, checks, restarts, targets, warnings }
  }
  const updateBest = (placements: Placement[]) => {
    const s = score(placements)
    if (better(s, bestScore)) {
      best = placements.map(p => ({ ...p, parent: p.parent ? { ...p.parent } : undefined }))
      bestScore = s
      if (onProgress) onProgress(result(best, best.length === project.settings.totalModules))
    }
  }
  const weightedRank = (weight: number) => -Math.log(Math.max(rng.next(), 1 / 4294967296)) / weight

  for (restarts = 1; restarts <= maxRestarts && checks < maxChecks; restarts++) {
    const bag = new Map<string, number>()
    for (const id of typeIds) {
      const variants = modulesByType.get(id)!
      for (let n = 0; n < targets[id]; n++) {
        const module = variants[rng.index(variants.length)]
        bag.set(module.id, (bag.get(module.id) ?? 0) + 1)
      }
    }
    const rootOptions = [...bag].filter(([id, count]) => count > 0 && moduleById.get(id)!.typeId === project.settings.startTypeId).sort(([a], [b]) => compareId(a, b))
    const rootTotal = rootOptions.reduce((n, [, count]) => n + count, 0)
    let rootPick = rng.index(rootTotal)
    let rootId = rootOptions[0][0]
    for (const [id, count] of rootOptions) { if (rootPick < count) { rootId = id; break } rootPick -= count }
    bag.set(rootId, bag.get(rootId)! - 1)
    const rootModule = moduleById.get(rootId)!
    const placements: Placement[] = [{ instanceId: 'p0', moduleId: rootId, typeId: rootModule.typeId, x: 0, z: 0, rotation: 0 }]
    const used = new Set<string>()
    updateBest(placements)

    const search = (): boolean => {
      if (placements.length === project.settings.totalModules) return true
      if (checks >= maxChecks) return false
      const candidates: Candidate[] = []
      const bagModules = [...bag].filter(([, count]) => count > 0).map(([id, count]) => ({ module: moduleById.get(id)!, count })).sort((a, b) => compareId(a.module.id, b.module.id))
      for (let pi = 0; pi < placements.length && checks < maxChecks; pi++) {
        const parent = placements[pi]
        const parentModule = moduleById.get(parent.moduleId)!
        for (const parentPort of parentModule.ports) {
          if (used.has(usedKey(pi, parentPort.id))) continue
          const parentPoint = rotate(parentPort, parent.rotation)
          const worldPoint = { x: parent.x + parentPoint.x, z: parent.z + parentPoint.z }
          const parentNormal = rotate(normal(parentPort.edge), parent.rotation)
          for (const { module: child, count } of bagModules) {
            const weight = weightFor(project.connections, parent.typeId, child.typeId)
            if (weight <= 0) continue
            for (const childPort of child.ports) for (const rotation of [0, 1, 2, 3] as const) {
              const childNormal = rotate(normal(childPort.edge), rotation)
              if (childNormal.x !== -parentNormal.x || childNormal.z !== -parentNormal.z) continue
              checks++
              if (checks > maxChecks) break
              const offset = rotate(childPort, rotation)
              const x = worldPoint.x - offset.x, z = worldPoint.z - offset.z
              const bounds = rotatedBounds(child.bounds, rotation, x, z)
              if (placements.some(p => overlaps(bounds, rotatedBounds(moduleById.get(p.moduleId)!.bounds, p.rotation, p.x, p.z)))) continue
              candidates.push({ parentIndex: pi, parentPort, child, childPort, rotation, x, z, rank: weightedRank(weight * count) })
            }
          }
        }
      }
      candidates.sort((a, b) => a.rank - b.rank || a.parentIndex - b.parentIndex || compareId(a.child.id, b.child.id) || compareId(a.childPort.id, b.childPort.id) || a.rotation - b.rotation)
      for (const c of candidates.slice(0, 96)) {
        if (checks >= maxChecks) return false
        if ((bag.get(c.child.id) ?? 0) <= 0 || used.has(usedKey(c.parentIndex, c.parentPort.id))) continue
        const index = placements.length
        const parent = placements[c.parentIndex]
        placements.push({ instanceId: `p${index}`, moduleId: c.child.id, typeId: c.child.typeId, x: c.x, z: c.z, rotation: c.rotation, parent: { instanceId: parent.instanceId, parentPortId: c.parentPort.id, ownPortId: c.childPort.id } })
        bag.set(c.child.id, bag.get(c.child.id)! - 1)
        used.add(usedKey(c.parentIndex, c.parentPort.id))
        used.add(usedKey(index, c.childPort.id))
        updateBest(placements)
        if (search()) return true
        used.delete(usedKey(c.parentIndex, c.parentPort.id))
        used.delete(usedKey(index, c.childPort.id))
        bag.set(c.child.id, bag.get(c.child.id)! + 1)
        placements.pop()
      }
      return false
    }
    if (search()) return result(placements, true)
  }
  restarts = Math.min(restarts - 1, maxRestarts)
  return result(best, false)
}
