import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { emptyEditor, exampleProject, exportRules, parseRuntime, typeTargets, validateProject, type RuntimeProject } from '../src/model'
import { generate, overlaps, previewDoors, rotatedBounds, rotate } from '../src/generator'
import { nearestValidPort, portAtBoundary, remapPorts } from '../src/geometry'
import { buildProjectZip, fbxMetersPerUnit, openProject } from '../src/io'
import { renameType } from '../src/editorActions'
import { nextTypeColor, typeColorSwatches } from '../src/typeColors'

describe('v4 map rules', () => {
  it('keeps preset and generated type colors distinct', () => {
    expect(nextTypeColor(['#E85D5D'])).toBe('#f28c5b')
    const used = typeColorSwatches.slice(6)
    const next = nextTypeColor(used)
    expect(nextTypeColor([...used, next])).not.toBe(next)
  })
  it('converts FBX units and remaps XYZ ports on model replacement', () => {
    expect(fbxMetersPerUnit(1)).toBe(.01)
    expect(fbxMetersPerUnit(100)).toBe(1)
    expect(fbxMetersPerUnit(undefined)).toBe(.01)
    const before = { minX: -2000, maxX: 2000, minY: 0, maxY: 4000, minZ: -2000, maxZ: 2000 }
    const after = { minX: -4000, maxX: 4000, minY: 1000, maxY: 9000, minZ: -4000, maxZ: 4000 }
    expect(remapPorts([{ id: 'a', edge: 'N', x: 1000, y: 1000, z: 2000, allowedTypeIds: null }], before, after, 1000, 1000))
      .toEqual([{ id: 'a', edge: 'N', x: 2000, y: 3000, z: 4000, allowedTypeIds: null }])
  })
  it('uses largest remainders and keeps required minima inside targets', () => {
    const project = exampleProject()
    project.settings.modulesAfterStart = 13
    project.types[1].percent = 70; project.types[2].percent = 30
    expect(typeTargets(project)).toEqual({ entrance: 1, basic: 9, special: 4 })
    project.types[1].requiredMin = 10
    expect(validateProject(project).some(error => error.includes('exceeds its target'))).toBe(true)
  })
  it('rotates in XZ, preserves Y, and only rejects positive-volume intersections', () => {
    expect(rotate({ x: 2, z: 3 }, 1)).toEqual({ x: 3, z: -2 })
    const b = { minX: -2, maxX: 4, minY: 10, maxY: 20, minZ: -1, maxZ: 3 }
    expect(rotatedBounds(b, 1, 100, 30, 200)).toEqual({ minX: 99, maxX: 103, minY: 40, maxY: 50, minZ: 196, maxZ: 202 })
    const a = { minX: 0, maxX: 2000, minY: 0, maxY: 3000, minZ: 0, maxZ: 2000 }
    expect(overlaps(a, { ...a, minX: 2000, maxX: 4000 })).toBe(false)
    expect(overlaps(a, { ...a, minY: 3000, maxY: 6000 })).toBe(false)
    expect(overlaps(a, { ...a, minY: 3100, maxY: 6100 })).toBe(false)
    expect(overlaps(a, { ...a, minY: 2000, maxY: 5000 })).toBe(true)
  })
  it('places a higher room through a stair upper connector', () => {
    const project = exampleProject()
    project.settings.modulesAfterStart = 2
    project.types = [
      { id: 'start', color: '#ffffff', percent: 0, requiredMin: 0 },
      { id: 'stair', color: '#ff8800', percent: 50, requiredMin: 1 },
      { id: 'room', color: '#00aaff', percent: 50, requiredMin: 1 },
    ]
    project.settings.startTypeId = 'start'
    const [start, stair, room] = project.modules.slice(0, 3).map(module => structuredClone(module))
    start.id = 'start_a'; start.typeId = 'start'; start.ports = [{ id: 'exit', edge: 'E', x: 4000, y: 1500, z: 0, allowedTypeIds: null }]
    stair.id = 'stair_a'; stair.typeId = 'stair'; stair.bounds.maxY = 6000
    stair.ports = [{ id: 'lower', edge: 'W', x: -4000, y: 1500, z: 0, allowedTypeIds: null }, { id: 'upper', edge: 'E', x: 4000, y: 4500, z: 0, allowedTypeIds: null }]
    room.id = 'room_a'; room.typeId = 'room'; room.ports = [{ id: 'entry', edge: 'W', x: -4000, y: 1500, z: 0, allowedTypeIds: null }]
    project.modules = [start, stair, room]
    project.connections = [{ from: 'start', to: 'stair', weight: 1 }, { from: 'stair', to: 'room', weight: 1 }]
    expect(validateProject(project)).toEqual([])
    const result = generate(project, 42)
    expect(result.complete).toBe(true)
    expect(result.placements.map(p => [p.moduleId, p.y])).toEqual([['start_a', 0], ['stair_a', 0], ['room_a', 3000]])
    expect(result.placements[2].parent?.instanceId).toBe('p1')
  })
  it('keeps generated maps deterministic and non-overlapping', () => {
    const project = exampleProject()
    const a = generate(project, 53), b = generate(project, 53)
    expect(a.complete).toBe(true)
    expect(a.placements).toEqual(b.placements)
    expect(a.placements).toHaveLength(10)
    for (let i = 0; i < a.placements.length; i++) for (let j = i + 1; j < a.placements.length; j++) {
      const p = a.placements[i], q = a.placements[j]
      const pb = rotatedBounds(project.modules.find(m => m.id === p.moduleId)!.bounds, p.rotation, p.x, p.y, p.z)
      const qb = rotatedBounds(project.modules.find(m => m.id === q.moduleId)!.bounds, q.rotation, q.x, q.y, q.z)
      expect(overlaps(pb, qb)).toBe(false)
    }
  })
  it('finishes a 50-module sample within the search budget', () => {
    const project = exampleProject(); project.settings.modulesAfterStart = 49
    const start = performance.now(), result = generate(project, 20261014)
    expect(result.complete).toBe(true)
    expect(result.placements).toHaveLength(50)
    expect(performance.now() - start).toBeLessThan(10000)
  })
  it('shows a single connected rectangle and normal unconnected rectangles', () => {
    const project = exampleProject()
    const result = generate(project, 5)
    const doors = previewDoors(project, result.placements)
    expect(doors.filter(door => door.connected)).toHaveLength(result.placements.length - 1)
    expect(doors.every(door => door.width === 1000 && door.height === 1000)).toBe(true)
    expect(doors.every(door => Number.isInteger(door.y))).toBe(true)
  })
  it('requires the full connector rectangle to fit a vertical side face', () => {
    const bounds = { minX: -4000, maxX: 4000, minY: 0, maxY: 3000, minZ: -4000, maxZ: 4000 }
    expect(portAtBoundary(bounds, 0, 500, 4000, 1000, 1000)?.edge).toBe('N')
    expect(portAtBoundary(bounds, 0, 2500, 4000, 1000, 1000)?.edge).toBe('N')
    expect(portAtBoundary(bounds, 0, 2600, 4000, 1000, 1000)).toBeNull()
    expect(portAtBoundary(bounds, 3800, 1500, 4000, 1000, 1000)).toBeNull()
    expect(portAtBoundary(bounds, 0, 1500, 3900, 1000, 1000)).toBeNull()
    expect(nearestValidPort(bounds, 3900, 2900, 0, 1000, 1000)).toEqual({ edge: 'E', x: 4000, y: 2500, z: 0 })
    expect(portAtBoundary({ ...bounds, maxY: 100 }, 0, 50, 4000, 1000, 1000)).toBeNull()
  })
  it('checks both connector type permissions and directed connections', () => {
    const project = exampleProject()
    project.modules[0].ports.forEach(port => { port.allowedTypeIds = ['special'] })
    expect(generate(project, 42, undefined, 2000, 2).complete).toBe(false)
    project.modules[0].ports.forEach(port => { port.allowedTypeIds = ['basic'] })
    project.modules.filter(m => m.typeId === 'basic').forEach(m => m.ports.forEach(port => { port.allowedTypeIds = null }))
    expect(generate(project, 42).complete).toBe(true)
  })
  it('exports only v4 map data and rejects older versions', () => {
    const project = exampleProject()
    const exported = exportRules(project)
    expect(exported.schemaVersion).toBe(4)
    expect(exported.types[0]).not.toHaveProperty('color')
    expect(exported.modules[0]).not.toHaveProperty('items')
    expect(exported.modules[0]).not.toHaveProperty('enemies')
    expect(exported.modules[0].bounds).toHaveProperty('minY')
    expect(exported.modules[0].ports[0]).toHaveProperty('y')
    expect(parseRuntime(JSON.parse(JSON.stringify(exported))).settings.doorHeight).toBe(1000)
    expect(() => parseRuntime({ ...exported, schemaVersion: 3 })).toThrow('requires v4')
  })
  it('keeps directional weights when renaming a type', () => {
    const project = exampleProject()
    project.connections = [{ from: 'basic', to: 'special', weight: 3 }, { from: 'special', to: 'basic', weight: 1 }]
    const changed = renameType(project, emptyEditor(), 'basic', 'z_basic')
    expect(changed.project.connections).toEqual([{ from: 'z_basic', to: 'special', weight: 3 }, { from: 'special', to: 'z_basic', weight: 1 }])
  })
  it('stores v4 rules, layout and FBX bytes in a project ZIP', async () => {
    const project = exampleProject(), editor = emptyEditor()
    const file = new Blob([new Uint8Array([1, 2, 3])])
    const zip = await JSZip.loadAsync(await buildProjectZip(project, editor, new Map([['room_a', file]])))
    const saved = JSON.parse(await zip.file('project.json')!.async('text')) as { version: number; runtime: RuntimeProject }
    expect(saved.version).toBe(4)
    expect(saved.runtime.modules[0].bounds.minY).toBe(0)
    expect([...await zip.file('assets/room_a.fbx')!.async('uint8array')]).toEqual([1, 2, 3])
    const reopened = await openProject(new File([await buildProjectZip(project, editor, new Map([['room_a', file]]))], 'project.zip'))
    expect(reopened.project.modules).toHaveLength(project.modules.length)
    expect(reopened.files.get('room_a')?.name).toBe('room_a.fbx')
    saved.version = 3; zip.file('project.json', JSON.stringify(saved))
    await expect(openProject(new File([await zip.generateAsync({ type: 'blob' })], 'old.zip'))).rejects.toThrow('requires v4')
  })
})
