export const SCHEMA_VERSION = 1 as const
export type Edge = 'N' | 'E' | 'S' | 'W'
export type Point = { x: number; z: number }
export type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number }
export type Port = { id: string; edge: Edge; x: number; z: number }
export type SpawnEntry = { id: string; weight: number }
export type SpawnRule = { min: number; max: number; entries: SpawnEntry[] }
export type ModuleType = {
  id: string
  name: string
  color: string
  percent: number
  requiredMin: number
  items: SpawnRule
  enemies: SpawnRule
}
export type Module = { id: string; typeId: string; bounds: Bounds; ports: Port[] }
export type Connection = { a: string; b: string; weightAB: number; weightBA: number }
export type RuntimeProject = {
  schemaVersion: typeof SCHEMA_VERSION
  settings: { totalModules: number; startTypeId: string; doorWidth: number }
  types: ModuleType[]
  modules: Module[]
  connections: Connection[]
}
export type ExportedRules = Omit<RuntimeProject, 'types'> & { types: Omit<ModuleType, 'name' | 'color'>[] }
export type EditorState = { graphPositions: Record<string, { x: number; y: number }>; modelNames: Record<string, string> }

export const emptyProject = (): RuntimeProject => ({
  schemaVersion: SCHEMA_VERSION,
  settings: { totalModules: 20, startTypeId: '', doorWidth: 2000 },
  types: [], modules: [], connections: [],
})
export const emptyEditor = (): EditorState => ({ graphPositions: {}, modelNames: {} })
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
  if (project.schemaVersion !== SCHEMA_VERSION) errors.push(`不支持的数据版本 ${project.schemaVersion}`)
  const { totalModules, startTypeId, doorWidth } = project.settings
  if (!integer(totalModules) || totalModules < 1 || totalModules > 500) errors.push('模块总数须为 1–500 的整数')
  if (!integer(doorWidth) || doorWidth <= 0) errors.push('门洞宽度须大于 0')
  if (!project.types.length) errors.push('至少需要一个类型')
  const typeIds = new Set<string>()
  for (const type of project.types) {
    if (!isId(type.id)) errors.push(`类型 ID ${type.id || '（空）'} 无效：须以英文字母开头，仅使用字母、数字、_、-`)
    if (typeIds.has(type.id)) errors.push(`类型 ID 重复：${type.id}`)
    typeIds.add(type.id)
    if (!type.name.trim()) errors.push(`类型 ${type.id} 缺少名称`)
    if (!/^#[0-9a-fA-F]{6}$/.test(type.color)) errors.push(`类型 ${type.id} 的颜色无效`)
    if (!finite(type.percent) || type.percent < 0 || type.percent > 100) errors.push(`类型 ${type.id} 的比例须为 0–100%`)
    if (!integer(type.requiredMin) || type.requiredMin < 0) errors.push(`类型 ${type.id} 的必出数量无效`)
    for (const [label, rule] of [['物品', type.items], ['敌人', type.enemies]] as const) {
      if (!integer(rule.min) || !integer(rule.max) || rule.min < 0 || rule.max < rule.min) errors.push(`${type.name} 的${label}数量范围无效`)
      if (rule.max > 0 && !rule.entries.length) errors.push(`${type.name} 需要至少一个${label} ID`)
      const seen = new Set<string>()
      for (const entry of rule.entries) {
        if (!entry.id.trim() || seen.has(entry.id)) errors.push(`${type.name} 的${label} ID 为空或重复`)
        seen.add(entry.id)
        if (!finite(entry.weight) || entry.weight <= 0) errors.push(`${type.name} 的${label}权重须大于 0`)
      }
    }
  }
  if (Math.abs(project.types.reduce((sum, t) => sum + t.percent, 0) - 100) > 0.000001) errors.push('类型比例合计必须为 100%')
  if (!typeIds.has(startTypeId)) errors.push('请选择有效的起始类型')
  const targets = typeTargets(project)
  for (const type of project.types) if (type.requiredMin > (targets[type.id] ?? 0)) errors.push(`${type.name} 必出 ${type.requiredMin} 个，超过比例目标 ${targets[type.id] ?? 0} 个`)
  if (startTypeId && (targets[startTypeId] ?? 0) < 1) errors.push('起始类型的目标数量至少为 1')
  const moduleIds = new Set<string>()
  const modulesByType = new Map<string, number>()
  for (const module of project.modules) {
    if (!isId(module.id)) errors.push(`模块 ID ${module.id || '（空）'} 无效`)
    if (moduleIds.has(module.id)) errors.push(`模块 ID 重复：${module.id}`)
    moduleIds.add(module.id)
    if (!typeIds.has(module.typeId)) errors.push(`模块 ${module.id} 引用了不存在的类型`)
    modulesByType.set(module.typeId, (modulesByType.get(module.typeId) ?? 0) + 1)
    const b = module.bounds
    if (![b.minX, b.maxX, b.minZ, b.maxZ].every(integer) || b.minX >= b.maxX || b.minZ >= b.maxZ) errors.push(`模块 ${module.id} 的占地边界无效`)
    const portIds = new Set<string>()
    for (const port of module.ports) {
      if (!isId(port.id) || portIds.has(port.id)) errors.push(`模块 ${module.id} 的接口 ID 为空、无效或重复`)
      portIds.add(port.id)
      if (!['N', 'E', 'S', 'W'].includes(port.edge) || !integer(port.x) || !integer(port.z)) errors.push(`模块 ${module.id} 的接口 ${port.id} 无效`)
      const half = doorWidth / 2
      const valid = port.edge === 'N' ? port.z === b.maxZ && port.x >= b.minX + half && port.x <= b.maxX - half
        : port.edge === 'S' ? port.z === b.minZ && port.x >= b.minX + half && port.x <= b.maxX - half
          : port.edge === 'E' ? port.x === b.maxX && port.z >= b.minZ + half && port.z <= b.maxZ - half
            : port.x === b.minX && port.z >= b.minZ + half && port.z <= b.maxZ - half
      if (!valid) errors.push(`模块 ${module.id} 的接口 ${port.id} 超出边缘或未贴边`)
    }
  }
  for (const type of project.types) if ((targets[type.id] ?? 0) > 0 && !modulesByType.has(type.id)) errors.push(`类型 ${type.name} 有生成名额但没有模块`)
  const relationKeys = new Set<string>()
  for (const c of project.connections) {
    if (!typeIds.has(c.a) || !typeIds.has(c.b)) errors.push('连接关系引用了不存在的类型')
    if (c.a > c.b || relationKeys.has(pairKey(c.a, c.b))) errors.push('连接关系重复或未按 ID 排序')
    relationKeys.add(pairKey(c.a, c.b))
    if (![c.weightAB, c.weightBA].every(v => finite(v) && v > 0)) errors.push('连接权重须大于 0')
  }
  return errors
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function parseRuntime(value: unknown): RuntimeProject {
  if (!object(value) || value.schemaVersion !== SCHEMA_VERSION || !object(value.settings) || !Array.isArray(value.types) || !Array.isArray(value.modules) || !Array.isArray(value.connections)) throw new Error('JSON 结构或版本不正确')
  const project = value as RuntimeProject
  if (typeof project.settings.totalModules !== 'number' || typeof project.settings.startTypeId !== 'string' || typeof project.settings.doorWidth !== 'number') throw new Error('地图设置格式不正确')
  for (const [index, t] of project.types.entries()) {
    if (!object(t) || typeof t.id !== 'string' || typeof t.percent !== 'number' || typeof t.requiredMin !== 'number') throw new Error('类型格式不正确')
    if (typeof t.name !== 'string') t.name = t.id
    if (typeof t.color !== 'string') t.color = ['#65b9d4', '#c987f0', '#efb565', '#83caa0', '#d58a9b'][index % 5]
    for (const rule of [t.items, t.enemies]) if (!object(rule) || typeof rule.min !== 'number' || typeof rule.max !== 'number' || !Array.isArray(rule.entries) || rule.entries.some((e: SpawnEntry) => !object(e) || typeof e.id !== 'string' || typeof e.weight !== 'number')) throw new Error('内部生成规则格式不正确')
  }
  for (const m of project.modules) if (!object(m) || typeof m.id !== 'string' || typeof m.typeId !== 'string' || !object(m.bounds) || ['minX', 'maxX', 'minZ', 'maxZ'].some(k => typeof m.bounds[k as keyof Bounds] !== 'number') || !Array.isArray(m.ports) || m.ports.some((p: Port) => !object(p) || typeof p.id !== 'string' || typeof p.edge !== 'string' || typeof p.x !== 'number' || typeof p.z !== 'number')) throw new Error('模块格式不正确')
  for (const c of project.connections) if (!object(c) || typeof c.a !== 'string' || typeof c.b !== 'string' || typeof c.weightAB !== 'number' || typeof c.weightBA !== 'number') throw new Error('连接格式不正确')
  return project
}

export function exportRules(project: RuntimeProject): ExportedRules {
  return {
    schemaVersion: project.schemaVersion,
    settings: { ...project.settings },
    types: project.types.map(({ id, percent, requiredMin, items, enemies }) => ({ id, percent, requiredMin, items: structuredClone(items), enemies: structuredClone(enemies) })),
    modules: structuredClone(project.modules),
    connections: structuredClone(project.connections),
  }
}

export function exampleProject(): RuntimeProject {
  const spawn = (): SpawnRule => ({ min: 0, max: 0, entries: [] })
  const type = (id: string, name: string, color: string, percent: number, requiredMin: number): ModuleType => ({ id, name, color, percent, requiredMin, items: spawn(), enemies: spawn() })
  const bounds = { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 }
  const ports = (): Port[] => [{ id: 'north', edge: 'N', x: 0, z: 4000 }, { id: 'east', edge: 'E', x: 4000, z: 0 }, { id: 'south', edge: 'S', x: 0, z: -4000 }, { id: 'west', edge: 'W', x: -4000, z: 0 }]
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { totalModules: 10, startTypeId: 'entrance', doorWidth: 2000 },
    types: [type('entrance', '入口', '#c987f0', 20, 1), type('basic', '基础', '#65b9d4', 60, 0), type('special', '特殊', '#efb565', 20, 0)],
    modules: [{ id: 'entry_a', typeId: 'entrance', bounds: { ...bounds }, ports: ports() }, { id: 'room_a', typeId: 'basic', bounds: { ...bounds }, ports: ports() }, { id: 'room_b', typeId: 'basic', bounds: { ...bounds }, ports: ports() }, { id: 'special_a', typeId: 'special', bounds: { ...bounds }, ports: ports() }],
    connections: [canonicalConnection('entrance', 'basic', 3, 3), canonicalConnection('basic', 'basic', 2, 2), canonicalConnection('basic', 'special', 1, 1)],
  }
}
