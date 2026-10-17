export const SCHEMA_VERSION = 5 as const
export type Edge = 'N' | 'E' | 'S' | 'W'
export type Point = { x: number; z: number }
export type Bounds = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
// `doorTypeId` names the port's opening; ports join only when their door types are the same.
export type Port = { id: string; edge: Edge; doorTypeId: string; x: number; y: number; z: number; allowedTypeIds: string[] | null }
// A door opening size in millimetres. Sizes are unique per project (more than DOOR_MATCH_TOLERANCE apart).
export type DoorType = { id: string; width: number; height: number }
export type ModuleType = {
  id: string
  color: string
  percent: number
  requiredMin: number
}
// `reservedAbove` keeps space empty above the box: 0 = none, a number = that many millimetres, null = open to the sky.
// Side faces extend up through it (door centres may sit there), and the generator treats it as occupied.
export type Module = { id: string; typeId: string; bounds: Bounds; reservedAbove: number | null; ports: Port[] }
export type Connection = { from: string; to: string; weight: number }
export type RuntimeProject = {
  schemaVersion: typeof SCHEMA_VERSION
  settings: { modulesAfterStart: number; startTypeId: string }
  doorTypes: DoorType[]
  types: ModuleType[]
  modules: Module[]
  connections: Connection[]
}
export type ExportedRules = Omit<RuntimeProject, 'types'> & { types: Omit<ModuleType, 'color'>[] }
export type PanelRef = { kind: 'type' | 'module' | 'create-type'; id: string }
export type EditorState = { graphPositions: Record<string, { x: number; y: number }>; modelNames: Record<string, string>; panel: PanelRef | null; seed: number }

export const emptyProject = (): RuntimeProject => ({
  schemaVersion: SCHEMA_VERSION,
  settings: { modulesAfterStart: 20, startTypeId: '' },
  doorTypes: [], types: [], modules: [], connections: [],
})
export const emptyEditor = (): EditorState => ({ graphPositions: {}, modelNames: {}, panel: null, seed: 1 })
const panelKinds: PanelRef['kind'][] = ['type', 'module', 'create-type']
const asPanel = (value: unknown): PanelRef | null => object(value) && panelKinds.includes(value.kind as PanelRef['kind']) && typeof value.id === 'string' ? { kind: value.kind as PanelRef['kind'], id: value.id } : null
// Accepts saved editor state, including drafts and ZIPs from before the inspector panel, which stored floating `windows`.
export function normalizeEditor(value: unknown): EditorState {
  if (!object(value) || !object(value.graphPositions) || !object(value.modelNames) || !Number.isInteger(value.seed)) throw new Error('Incomplete editor data')
  const windows = Array.isArray(value.windows) ? [...value.windows].sort((a, b) => (object(a) && typeof a.z === 'number' ? a.z : 0) - (object(b) && typeof b.z === 'number' ? b.z : 0)) : []
  const panel = 'panel' in value ? asPanel(value.panel) : asPanel(windows.at(-1))
  return { graphPositions: value.graphPositions as EditorState['graphPositions'], modelNames: value.modelNames as EditorState['modelNames'], panel, seed: value.seed as number }
}
// Door sizes within this many millimetres count as the same door type when importing.
export const DOOR_MATCH_TOLERANCE = 20
export const faceTop = (module: Pick<Module, 'bounds' | 'reservedAbove'>) => module.reservedAbove === null ? Infinity : module.bounds.maxY + module.reservedAbove
export const occupiedBounds = (module: Pick<Module, 'bounds' | 'reservedAbove'>): Bounds => ({ ...module.bounds, maxY: faceTop(module) })
export const doorTypeFor = (project: Pick<RuntimeProject, 'doorTypes'>, port: Pick<Port, 'doorTypeId'>) => project.doorTypes.find(door => door.id === port.doorTypeId)
export const sameDoorSize = (a: Pick<DoorType, 'width' | 'height'>, b: Pick<DoorType, 'width' | 'height'>) => Math.abs(a.width - b.width) <= DOOR_MATCH_TOLERANCE && Math.abs(a.height - b.height) <= DOOR_MATCH_TOLERANCE
// Default door type name from its size in whole centimetres, e.g. Door_400x400.
export const doorTypeName = (width: number, height: number) => `Door_${Math.round(width / 10)}x${Math.round(height / 10)}`
export const meters = (mm: number) => (mm / 1000).toFixed(3)
export const toMm = (m: number) => Math.round(m * 1000)
export const isId = (id: string) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)
export const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export const relationKey = (from: string, to: string) => `${from}\u0000${to}`
export function weightFor(connections: Connection[], from: string, to: string): number {
  return connections.find(c => c.from === from && c.to === to)?.weight ?? 0
}

export function typeTargets(project: RuntimeProject): Record<string, number> {
  const total = project.settings.modulesAfterStart
  const rows = project.types.filter(t => t.id !== project.settings.startTypeId).map(t => {
    const exact = total * t.percent / 100
    return { id: t.id, count: Math.floor(exact), fraction: exact - Math.floor(exact) }
  })
  let left = total - rows.reduce((sum, row) => sum + row.count, 0)
  rows.sort((a, b) => b.fraction - a.fraction || compareId(a.id, b.id))
  for (const row of rows) if (left-- > 0) row.count++
  return { ...Object.fromEntries(rows.map(row => [row.id, row.count])), [project.settings.startTypeId]: 1 }
}

const finite = (value: number) => Number.isFinite(value)
const integer = (value: number) => Number.isInteger(value)
export function validateProject(project: RuntimeProject): string[] {
  const errors: string[] = []
  if (project.schemaVersion !== SCHEMA_VERSION) errors.push(`Unsupported data version ${project.schemaVersion}`)
  const { modulesAfterStart, startTypeId } = project.settings
  if (!integer(modulesAfterStart) || modulesAfterStart < 1 || modulesAfterStart > 500) errors.push('Modules after start must be an integer from 1 to 500')
  const doorIds = new Set<string>()
  project.doorTypes.forEach((door, i) => {
    if (!isId(door.id)) errors.push(`Invalid door type ID ${door.id || '(empty)'}: start with a letter; use letters, numbers, _ or -`)
    if (doorIds.has(door.id)) errors.push(`Duplicate door type ID: ${door.id}`)
    doorIds.add(door.id)
    if (!integer(door.width) || door.width <= 0 || !integer(door.height) || door.height <= 0) errors.push(`Door type ${door.id} needs a width and height greater than zero`)
    const twin = project.doorTypes.slice(0, i).find(other => sameDoorSize(other, door))
    if (twin) errors.push(`Door types ${twin.id} and ${door.id} are the same size (within ${DOOR_MATCH_TOLERANCE / 10} cm); each size must be one door type`)
  })
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
  if (Math.abs(project.types.filter(t => t.id !== startTypeId).reduce((sum, t) => sum + t.percent, 0) - 100) > 0.000001) errors.push('Non-start type shares must total 100%')
  if (!typeIds.has(startTypeId)) errors.push('Select a valid start type')
  const startType = project.types.find(t => t.id === startTypeId)
  if (startType && (startType.requiredMin !== 0 || startType.percent !== 0)) errors.push('Start type share and required minimum must be zero')
  const targets = typeTargets(project)
  for (const type of project.types.filter(t => t.id !== startTypeId)) if (type.requiredMin > (targets[type.id] ?? 0)) errors.push(`${type.id} required minimum ${type.requiredMin} exceeds its target ${targets[type.id] ?? 0}`)
  const moduleIds = new Set<string>()
  const modulesByType = new Map<string, number>()
  for (const module of project.modules) {
    if (!isId(module.id)) errors.push(`Invalid module ID: ${module.id || '(empty)'}`)
    if (moduleIds.has(module.id)) errors.push(`Duplicate module ID: ${module.id}`)
    moduleIds.add(module.id)
    if (!typeIds.has(module.typeId)) errors.push(`Module ${module.id} references a missing type`)
    modulesByType.set(module.typeId, (modulesByType.get(module.typeId) ?? 0) + 1)
    const b = module.bounds
    if (![b.minX, b.maxX, b.minY, b.maxY, b.minZ, b.maxZ].every(integer) || b.minX >= b.maxX || b.minY >= b.maxY || b.minZ >= b.maxZ) errors.push(`Module ${module.id} has invalid bounds`)
    if (module.reservedAbove !== null && (!integer(module.reservedAbove) || module.reservedAbove < 0)) errors.push(`Module ${module.id} has an invalid space reserved above`)
    const top = faceTop(module)
    const portIds = new Set<string>()
    for (const port of module.ports) {
      if (!isId(port.id) || portIds.has(port.id)) errors.push(`Module ${module.id} has an empty, invalid or duplicate port ID`)
      portIds.add(port.id)
      if (!['N', 'E', 'S', 'W'].includes(port.edge) || !integer(port.x) || !integer(port.y) || !integer(port.z)) errors.push(`Module ${module.id} has an invalid port ${port.id}`)
      if (port.allowedTypeIds !== null && (!Array.isArray(port.allowedTypeIds) || new Set(port.allowedTypeIds).size !== port.allowedTypeIds.length || port.allowedTypeIds.some(id => !typeIds.has(id)))) errors.push(`Port ${port.id} on module ${module.id} has invalid target types`)
      const door = doorTypeFor(project, port)
      if (!door) { errors.push(`Port ${port.id} on module ${module.id} needs a valid door type`); continue }
      // The centre must be on its side face; the door rectangle may overhang the face's edges, top or bottom.
      const valid = port.edge === 'N' ? port.z === b.maxZ && port.x >= b.minX && port.x <= b.maxX
        : port.edge === 'S' ? port.z === b.minZ && port.x >= b.minX && port.x <= b.maxX
          : port.edge === 'E' ? port.x === b.maxX && port.z >= b.minZ && port.z <= b.maxZ
            : port.x === b.minX && port.z >= b.minZ && port.z <= b.maxZ
      if (!valid || port.y < b.minY || port.y > top) errors.push(`Port ${port.id} on module ${module.id} has its centre off its side face`)
    }
  }
  for (const type of project.types) if ((targets[type.id] ?? 0) > 0 && !modulesByType.has(type.id)) errors.push(`Type ${type.id} has target slots but no modules`)
  const relationKeys = new Set<string>()
  for (const c of project.connections) {
    if (!typeIds.has(c.from) || !typeIds.has(c.to)) errors.push('A connection references a missing type')
    if (c.to === startTypeId) errors.push('Connections cannot point to the start type')
    if (relationKeys.has(relationKey(c.from, c.to))) errors.push('Duplicate directed connection')
    relationKeys.add(relationKey(c.from, c.to))
    if (!finite(c.weight) || c.weight <= 0) errors.push('Connection weight must be greater than zero')
  }
  return errors
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function parseRuntime(value: unknown): RuntimeProject {
  if (object(value) && value.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported data version ${String(value.schemaVersion)}; this editor requires v${SCHEMA_VERSION}`)
  if (!object(value) || !object(value.settings) || !Array.isArray(value.doorTypes) || !Array.isArray(value.types) || !Array.isArray(value.modules) || !Array.isArray(value.connections)) throw new Error('Invalid JSON structure')
  const project = value as RuntimeProject
  if (typeof project.settings.modulesAfterStart !== 'number' || typeof project.settings.startTypeId !== 'string') throw new Error('Invalid map settings')
  for (const door of project.doorTypes) if (!object(door) || typeof door.id !== 'string' || typeof door.width !== 'number' || typeof door.height !== 'number') throw new Error('Invalid door type data')
  for (const [index, t] of project.types.entries()) {
    if (!object(t) || typeof t.id !== 'string' || typeof t.percent !== 'number' || typeof t.requiredMin !== 'number') throw new Error('Invalid type data')
    if (typeof t.color !== 'string') t.color = ['#65b9d4', '#c987f0', '#efb565', '#83caa0', '#d58a9b'][index % 5]
  }
  for (const m of project.modules) {
    if (!object(m) || typeof m.id !== 'string' || typeof m.typeId !== 'string' || !object(m.bounds) || ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'].some(k => typeof m.bounds[k as keyof Bounds] !== 'number') || !Array.isArray(m.ports) || m.ports.some((p: Port) => !object(p) || typeof p.id !== 'string' || typeof p.edge !== 'string' || typeof p.doorTypeId !== 'string' || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number' || !(p.allowedTypeIds === null || Array.isArray(p.allowedTypeIds) && p.allowedTypeIds.every(id => typeof id === 'string')))) throw new Error('Invalid module data')
  }
  for (const m of project.modules) {
    if (m.reservedAbove === undefined) m.reservedAbove = 0
    else if (m.reservedAbove !== null && typeof m.reservedAbove !== 'number') throw new Error('Invalid module data')
  }
  for (const c of project.connections) if (!object(c) || typeof c.from !== 'string' || typeof c.to !== 'string' || typeof c.weight !== 'number') throw new Error('Invalid connection data')
  return project
}

export function exportRules(project: RuntimeProject): ExportedRules {
  return {
    schemaVersion: project.schemaVersion,
    settings: { ...project.settings },
    doorTypes: structuredClone(project.doorTypes),
    types: project.types.map(({ id, percent, requiredMin }) => ({ id, percent, requiredMin })),
    modules: structuredClone(project.modules),
    connections: structuredClone(project.connections),
  }
}

export function exampleProject(): RuntimeProject {
  const type = (id: string, color: string, percent: number, requiredMin: number): ModuleType => ({ id, color, percent, requiredMin })
  const bounds = { minX: -4000, maxX: 4000, minY: 0, maxY: 3000, minZ: -4000, maxZ: 4000 }
  const door = 'Door_100x100'
  const ports = (): Port[] => [{ id: 'north', edge: 'N', doorTypeId: door, x: 0, y: 1500, z: 4000, allowedTypeIds: null }, { id: 'east', edge: 'E', doorTypeId: door, x: 4000, y: 1500, z: 0, allowedTypeIds: null }, { id: 'south', edge: 'S', doorTypeId: door, x: 0, y: 1500, z: -4000, allowedTypeIds: null }, { id: 'west', edge: 'W', doorTypeId: door, x: -4000, y: 1500, z: 0, allowedTypeIds: null }]
  const module = (id: string, typeId: string): Module => ({ id, typeId, bounds: { ...bounds }, reservedAbove: 0, ports: ports() })
  const project: RuntimeProject = {
    schemaVersion: SCHEMA_VERSION,
    settings: { modulesAfterStart: 9, startTypeId: 'entrance' },
    doorTypes: [{ id: door, width: 1000, height: 1000 }],
    types: [type('entrance', '#c987f0', 0, 0), type('basic', '#65b9d4', 75, 0), type('special', '#efb565', 25, 0)],
    modules: [module('entry_a', 'entrance'), module('room_a', 'basic'), module('room_b', 'basic'), module('special_a', 'special')],
    connections: [{ from: 'entrance', to: 'basic', weight: 3 }, { from: 'basic', to: 'basic', weight: 2 }, { from: 'basic', to: 'special', weight: 1 }],
  }
  return project
}
