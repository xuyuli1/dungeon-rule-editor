export const SCHEMA_VERSION = 2 as const
export type Edge = 'N' | 'E' | 'S' | 'W'
export type Point = { x: number; z: number }
export type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number }
export type Port = { id: string; edge: Edge; x: number; z: number; allowedTypeIds: string[] | null }
export type SpawnEntry = { id: string; weight: number }
export type SpawnRule = { min: number; max: number; entries: SpawnEntry[] }
export type ModuleType = {
  id: string
  color: string
  percent: number
  requiredMin: number
}
export type Module = { id: string; typeId: string; bounds: Bounds; ports: Port[]; items: SpawnRule; enemies: SpawnRule }
export type Connection = { a: string; b: string; weightAB: number; weightBA: number }
export type RuntimeProject = {
  schemaVersion: typeof SCHEMA_VERSION
  settings: { totalModules: number; startTypeId: string; doorWidth: number }
  types: ModuleType[]
  modules: Module[]
  connections: Connection[]
}
export type ExportedRules = Omit<RuntimeProject, 'types'> & { types: Omit<ModuleType, 'color'>[] }
export type WindowLayout = { kind: 'type' | 'module'; id: string; x: number; y: number; width: number; height: number; z: number }
export type EditorState = { graphPositions: Record<string, { x: number; y: number }>; modelNames: Record<string, string>; windows: WindowLayout[]; seed: number }

export const emptyProject = (): RuntimeProject => ({
  schemaVersion: SCHEMA_VERSION,
  settings: { totalModules: 20, startTypeId: '', doorWidth: 2000 },
  types: [], modules: [], connections: [],
})
export const emptyEditor = (): EditorState => ({ graphPositions: {}, modelNames: {}, windows: [], seed: 1 })
export const meters = (mm: number) => (mm / 1000).toFixed(3)
export const toMm = (m: number) => Math.round(m * 1000)
export const isId = (id: string) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)
export const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export const pairKey = (a: string, b: string) => [a, b].sort().join('\u0000')
export const canonicalConnection = (a: string, b: string, ab = 1, ba = 1): Connection => a <= b
  ? { a, b, weightAB: ab, weightBA: ba }
  : { a: b, b: a, weightAB: ba, weightBA: ab }
export function weightFor(connections: Connection[], from: string, to: string): number {
  const relation = connections.find(c => pairKey(c.a, c.b) === pairKey(from, to))
  if (!relation) return 0
  return relation.a === from ? relation.weightAB : relation.weightBA
}

export function typeTargets(project: RuntimeProject): Record<string, number> {
  const total = project.settings.totalModules
  const rows = project.types.map(t => {
    const exact = total * t.percent / 100
    return { id: t.id, count: Math.floor(exact), fraction: exact - Math.floor(exact) }
  })
  let left = total - rows.reduce((sum, row) => sum + row.count, 0)
  rows.sort((a, b) => b.fraction - a.fraction || compareId(a.id, b.id))
  for (const row of rows) if (left-- > 0) row.count++
  return Object.fromEntries(rows.map(row => [row.id, row.count]))
}

const finite = (value: number) => Number.isFinite(value)
const integer = (value: number) => Number.isInteger(value)
export function validateProject(project: RuntimeProject): string[] {
  const errors: string[] = []
  if (project.schemaVersion !== SCHEMA_VERSION) errors.push(`Unsupported data version ${project.schemaVersion}`)
  const { totalModules, startTypeId, doorWidth } = project.settings
  if (!integer(totalModules) || totalModules < 1 || totalModules > 500) errors.push('Total modules must be an integer from 1 to 500')
  if (!integer(doorWidth) || doorWidth <= 0) errors.push('Door width must be greater than zero')
  if (!project.types.length) errors.push('Add at least one type')
  const typeIds = new Set<string>()
  for (const type of project.types) {
    if (!isId(type.id)) errors.push(`Invalid type ID ${type.id || '(empty)'}: start with a letter; use letters, numbers, _ or -`)
    if (typeIds.has(type.id)) errors.push(`Duplicate type ID: ${type.id}`)
    typeIds.add(type.id)
    if (!/^#[0-9a-fA-F]{6}$/.test(type.color)) errors.push(`Type ${type.id} has an invalid color`)
    if (!finite(type.percent) || type.percent < 0 || type.percent > 100) errors.push(`Type ${type.id} share must be 0–100%`)
    if (!integer(type.requiredMin) || type.requiredMin < 0) errors.push(`Type ${type.id} has an invalid required minimum`)
  }
  if (Math.abs(project.types.reduce((sum, t) => sum + t.percent, 0) - 100) > 0.000001) errors.push('Type shares must total 100%')
  if (!typeIds.has(startTypeId)) errors.push('Select a valid start type')
  const targets = typeTargets(project)
  for (const type of project.types) if (type.requiredMin > (targets[type.id] ?? 0)) errors.push(`${type.id} required minimum ${type.requiredMin} exceeds its target ${targets[type.id] ?? 0}`)
  if (startTypeId && (targets[startTypeId] ?? 0) < 1) errors.push('Start type needs at least one target slot')
  const moduleIds = new Set<string>()
  const modulesByType = new Map<string, number>()
  for (const module of project.modules) {
    if (!isId(module.id)) errors.push(`Invalid module ID: ${module.id || '(empty)'}`)
    if (moduleIds.has(module.id)) errors.push(`Duplicate module ID: ${module.id}`)
    moduleIds.add(module.id)
    if (!typeIds.has(module.typeId)) errors.push(`Module ${module.id} references a missing type`)
    modulesByType.set(module.typeId, (modulesByType.get(module.typeId) ?? 0) + 1)
    for (const [label, rule] of [['item', module.items], ['enemy', module.enemies]] as const) {
      if (!rule || !integer(rule.min) || !integer(rule.max) || rule.min < 0 || rule.max < rule.min) { errors.push(`${module.id} has an invalid ${label} count range`); continue }
      if (rule.max > 0 && !rule.entries.length) errors.push(`${module.id} needs at least one ${label} ID`)
      const seen = new Set<string>()
      for (const entry of rule.entries) {
        if (!entry.id.trim() || seen.has(entry.id)) errors.push(`${module.id} has an empty or duplicate ${label} ID`)
        seen.add(entry.id)
        if (!finite(entry.weight) || entry.weight <= 0) errors.push(`${module.id} ${label} weight must be greater than zero`)
      }
    }
    const b = module.bounds
    if (![b.minX, b.maxX, b.minZ, b.maxZ].every(integer) || b.minX >= b.maxX || b.minZ >= b.maxZ) errors.push(`Module ${module.id} has invalid bounds`)
    const portIds = new Set<string>()
    for (const port of module.ports) {
      if (!isId(port.id) || portIds.has(port.id)) errors.push(`Module ${module.id} has an empty, invalid or duplicate port ID`)
      portIds.add(port.id)
      if (!['N', 'E', 'S', 'W'].includes(port.edge) || !integer(port.x) || !integer(port.z)) errors.push(`Module ${module.id} has an invalid port ${port.id}`)
      if (port.allowedTypeIds !== null && (!Array.isArray(port.allowedTypeIds) || new Set(port.allowedTypeIds).size !== port.allowedTypeIds.length || port.allowedTypeIds.some(id => !typeIds.has(id)))) errors.push(`Port ${port.id} on module ${module.id} has invalid target types`)
      const half = doorWidth / 2
      const valid = port.edge === 'N' ? port.z === b.maxZ && port.x >= b.minX + half && port.x <= b.maxX - half
        : port.edge === 'S' ? port.z === b.minZ && port.x >= b.minX + half && port.x <= b.maxX - half
          : port.edge === 'E' ? port.x === b.maxX && port.z >= b.minZ + half && port.z <= b.maxZ - half
            : port.x === b.minX && port.z >= b.minZ + half && port.z <= b.maxZ - half
      if (!valid) errors.push(`Port ${port.id} on module ${module.id} is off its edge or outside the bounds`)
    }
  }
  for (const type of project.types) if ((targets[type.id] ?? 0) > 0 && !modulesByType.has(type.id)) errors.push(`Type ${type.id} has target slots but no modules`)
  const relationKeys = new Set<string>()
  for (const c of project.connections) {
    if (!typeIds.has(c.a) || !typeIds.has(c.b)) errors.push('A connection references a missing type')
    if (c.a > c.b || relationKeys.has(pairKey(c.a, c.b))) errors.push('Duplicate or unsorted connection')
    relationKeys.add(pairKey(c.a, c.b))
    if (![c.weightAB, c.weightBA].every(v => finite(v) && v > 0)) errors.push('Connection weights must be greater than zero')
  }
  return errors
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function parseRuntime(value: unknown): RuntimeProject {
  if (object(value) && value.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported data version ${String(value.schemaVersion)}; this editor requires v2`)
  if (!object(value) || !object(value.settings) || !Array.isArray(value.types) || !Array.isArray(value.modules) || !Array.isArray(value.connections)) throw new Error('Invalid JSON structure')
  const project = value as RuntimeProject
  if (typeof project.settings.totalModules !== 'number' || typeof project.settings.startTypeId !== 'string' || typeof project.settings.doorWidth !== 'number') throw new Error('Invalid map settings')
  for (const [index, t] of project.types.entries()) {
    if (!object(t) || typeof t.id !== 'string' || typeof t.percent !== 'number' || typeof t.requiredMin !== 'number') throw new Error('Invalid type data')
    if (typeof t.color !== 'string') t.color = ['#65b9d4', '#c987f0', '#efb565', '#83caa0', '#d58a9b'][index % 5]
  }
  for (const m of project.modules) {
    if (!object(m) || typeof m.id !== 'string' || typeof m.typeId !== 'string' || !object(m.bounds) || ['minX', 'maxX', 'minZ', 'maxZ'].some(k => typeof m.bounds[k as keyof Bounds] !== 'number') || !Array.isArray(m.ports) || m.ports.some((p: Port) => !object(p) || typeof p.id !== 'string' || typeof p.edge !== 'string' || typeof p.x !== 'number' || typeof p.z !== 'number' || !(p.allowedTypeIds === null || Array.isArray(p.allowedTypeIds) && p.allowedTypeIds.every(id => typeof id === 'string')))) throw new Error('Invalid module data')
    for (const rule of [m.items, m.enemies]) if (!object(rule) || typeof rule.min !== 'number' || typeof rule.max !== 'number' || !Array.isArray(rule.entries) || rule.entries.some((e: SpawnEntry) => !object(e) || typeof e.id !== 'string' || typeof e.weight !== 'number')) throw new Error('Invalid module spawn rule')
  }
  for (const c of project.connections) if (!object(c) || typeof c.a !== 'string' || typeof c.b !== 'string' || typeof c.weightAB !== 'number' || typeof c.weightBA !== 'number') throw new Error('Invalid connection data')
  return project
}

export function exportRules(project: RuntimeProject): ExportedRules {
  return {
    schemaVersion: project.schemaVersion,
    settings: { ...project.settings },
    types: project.types.map(({ id, percent, requiredMin }) => ({ id, percent, requiredMin })),
    modules: structuredClone(project.modules),
    connections: structuredClone(project.connections),
  }
}

export function exampleProject(): RuntimeProject {
  const spawn = (): SpawnRule => ({ min: 0, max: 0, entries: [] })
  const type = (id: string, color: string, percent: number, requiredMin: number): ModuleType => ({ id, color, percent, requiredMin })
  const bounds = { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 }
  const ports = (): Port[] => [{ id: 'north', edge: 'N', x: 0, z: 4000, allowedTypeIds: null }, { id: 'east', edge: 'E', x: 4000, z: 0, allowedTypeIds: null }, { id: 'south', edge: 'S', x: 0, z: -4000, allowedTypeIds: null }, { id: 'west', edge: 'W', x: -4000, z: 0, allowedTypeIds: null }]
  const module = (id: string, typeId: string): Module => ({ id, typeId, bounds: { ...bounds }, ports: ports(), items: spawn(), enemies: spawn() })
  const project: RuntimeProject = {
    schemaVersion: SCHEMA_VERSION,
    settings: { totalModules: 10, startTypeId: 'entrance', doorWidth: 2000 },
    types: [type('entrance', '#c987f0', 20, 1), type('basic', '#65b9d4', 60, 0), type('special', '#efb565', 20, 0)],
    modules: [module('entry_a', 'entrance'), module('room_a', 'basic'), module('room_b', 'basic'), module('special_a', 'special')],
    connections: [canonicalConnection('entrance', 'basic', 3, 3), canonicalConnection('basic', 'basic', 2, 2), canonicalConnection('basic', 'special', 1, 1)],
  }
  project.modules.find(m => m.id === 'room_a')!.items = { min: 1, max: 2, entries: [{ id: 'supply', weight: 2 }, { id: 'key', weight: 1 }] }
  project.modules.find(m => m.id === 'special_a')!.enemies = { min: 1, max: 1, entries: [{ id: 'guardian', weight: 1 }] }
  return project
}
