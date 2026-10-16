import { describe, expect, it } from 'vitest'
import { canonicalConnection, emptyEditor, exampleProject, exportRules, parseRuntime, typeTargets, validateProject } from '../src/model'
import { generate, overlaps, rotatedBounds, rotate } from '../src/generator'
import JSZip from 'jszip'
import { buildProjectZip, fbxMetersPerUnit, openProject } from '../src/io'
import { gridStep, nearestValidPort, portAtBoundary, remapPorts, unitsPerPixel } from '../src/geometry'
import { renameType } from '../src/editorActions'
import { saveDraft } from '../src/autosave'

describe('rules and geometry', () => {
  it('converts FBX file units to metres and preserves relative port positions', () => {
    expect(fbxMetersPerUnit(1)).toBe(0.01)
    expect(fbxMetersPerUnit(100)).toBe(1)
    expect(fbxMetersPerUnit(undefined)).toBe(0.01)
    expect(() => fbxMetersPerUnit(0)).toThrow('Invalid FBX unit scale')
    const before = { minX: -2050000, maxX: 2050000, minZ: -2050000, maxZ: 2050000 }
    const after = { minX: -20500, maxX: 20500, minZ: -20500, maxZ: 20500 }
    expect(remapPorts([{ id: 'door', edge: 'N', x: 1025000, z: 2050000, allowedTypeIds: null }], before, after, 2000))
      .toEqual([{ id: 'door', edge: 'N', x: 10250, z: 20500, allowedTypeIds: null }])
  })
  it('keeps port handles at a fixed screen size across model scales', () => {
    const normal = unitsPerPixel(56000, 56000, 800, 380)
    const large = unitsPerPixel(5600000, 5600000, 800, 380)
    expect(normal).toBeCloseTo(56000 / 380)
    expect(large).toBe(normal * 100)
    expect(gridStep(41000)).toBe(5000)
    expect(gridStep(4100000)).toBe(500000)
  })
  it('uses largest remainders and includes required counts in targets', () => {
    const p = exampleProject()
    p.settings.totalModules = 13
    p.types[0].percent = 60
    p.types[1].percent = 10
    p.types[2].percent = 30
    expect(typeTargets(p)).toEqual({ entrance: 8, basic: 1, special: 4 })
    p.types[0].requiredMin = 9
    expect(validateProject(p).some(e => e.includes('exceeds its target'))).toBe(true)
  })
  it('rotates coordinates and accepts touching but not overlapping rectangles', () => {
    expect(rotate({ x: 2, z: 3 }, 1)).toEqual({ x: 3, z: -2 })
    const b = { minX: -2, maxX: 4, minZ: -1, maxZ: 3 }
    expect(rotatedBounds(b, 1)).toEqual({ minX: -1, maxX: 3, minZ: -4, maxZ: 2 })
    expect(overlaps({ minX: 0, maxX: 2, minZ: 0, maxZ: 2 }, { minX: 2, maxX: 4, minZ: 0, maxZ: 2 })).toBe(false)
    expect(overlaps({ minX: 0, maxX: 2, minZ: 0, maxZ: 2 }, { minX: 1, maxX: 3, minZ: 0, maxZ: 2 })).toBe(true)
  })
  it('generates a deterministic, non-overlapping complete map with quotas', () => {
    const p = exampleProject()
    const a = generate(p, 42)
    const b = generate(p, 42)
    expect(a.complete).toBe(true)
    expect(a.placements).toEqual(b.placements)
    expect(a.placements).toHaveLength(10)
    for (const type of p.types) expect(a.placements.filter(v => v.typeId === type.id)).toHaveLength(typeTargets(p)[type.id])
    for (let i = 0; i < a.placements.length; i++) for (let j = i + 1; j < a.placements.length; j++) {
      const x = a.placements[i], y = a.placements[j]
      const xb = rotatedBounds(p.modules.find(m => m.id === x.moduleId)!.bounds, x.rotation, x.x, x.z)
      const yb = rotatedBounds(p.modules.find(m => m.id === y.moduleId)!.bounds, y.rotation, y.x, y.z)
      expect(overlaps(xb, yb)).toBe(false)
    }
  })
  it('handles a 50-module preview sample within the search budget', () => {
    const p = exampleProject()
    p.settings.totalModules = 50
    const start = performance.now()
    const result = generate(p, 20261014)
    expect(result.complete).toBe(true)
    expect(result.placements).toHaveLength(50)
    expect(performance.now() - start).toBeLessThan(10000)
  })
  it('returns a partial result when the connection graph cannot reach a type', () => {
    const p = exampleProject()
    p.connections = [canonicalConnection('entrance', 'basic')]
    const result = generate(p, 12, undefined, 3000, 3)
    expect(result.complete).toBe(false)
    expect(result.warnings.some(w => w.includes('special'))).toBe(true)
  })
  it('separates editor display fields from the runtime JSON and imports it again', () => {
    const p = exampleProject()
    const exported = exportRules(p)
    expect(exported.types[0]).not.toHaveProperty('color')
    expect(exported.types[0]).not.toHaveProperty('name')
    const imported = parseRuntime(JSON.parse(JSON.stringify(exported)))
    expect(validateProject(imported)).toEqual([])
    expect(imported.types[0].id).toBe('entrance')
  })
  it('renames type references without reversing directional weights', () => {
    const project = exampleProject()
    const editor = { graphPositions: { entrance: { x: 30, y: 40 } }, modelNames: {}, windows: [{ kind: 'type' as const, id: 'entrance', x: 10, y: 20, width: 400, height: 500, z: 101 }], seed: 1 }
    project.connections = [canonicalConnection('entrance', 'basic', 3, 1)]
    project.modules[1].ports[0].allowedTypeIds = ['entrance']
    const renamed = renameType(project, editor, 'entrance', 'z_entry')
    expect(renamed.project.settings.startTypeId).toBe('z_entry')
    expect(renamed.project.modules[0].typeId).toBe('z_entry')
    expect(renamed.editor.graphPositions.z_entry).toEqual({ x: 30, y: 40 })
    expect(renamed.project.connections[0]).toEqual(canonicalConnection('z_entry', 'basic', 3, 1))
    expect(renamed.project.modules[1].ports[0].allowedTypeIds).toEqual(['z_entry'])
    expect(renamed.editor.windows[0].id).toBe('z_entry')
  })
  it('stores rules, editor layout, and FBX bytes in the project ZIP', async () => {
    const p = exampleProject()
    const editor = { graphPositions: { basic: { x: 20, y: 40 } }, modelNames: { room_a: 'room_a.fbx' }, windows: [{ kind: 'module' as const, id: 'room_a', x: 100, y: 120, width: 560, height: 620, z: 110 }], seed: 93 }
    const fbx = new Blob([new Uint8Array([1, 2, 3, 4])])
    const zip = await JSZip.loadAsync(await buildProjectZip(p, editor, new Map([['room_a', fbx]])))
    const saved = JSON.parse(await zip.file('project.json')!.async('text'))
    expect(saved.runtime.modules).toHaveLength(p.modules.length)
    expect(saved.editor.graphPositions.basic).toEqual({ x: 20, y: 40 })
    expect(saved.editor.windows[0].id).toBe('room_a')
    expect(saved.editor.seed).toBe(93)
    expect([...await zip.file('assets/room_a.fbx')!.async('uint8array')]).toEqual([1, 2, 3, 4])
    const reopened = await openProject(new File([await buildProjectZip(p, editor, new Map([['room_a', fbx]]))], 'project.zip'))
    expect(reopened.project.modules).toHaveLength(p.modules.length)
    expect(reopened.files.get('room_a')?.name).toBe('room_a.fbx')
    expect(reopened.editor.windows[0]).toEqual(editor.windows[0])
  })
  it('exports v2 module spawns and port permissions and rejects v1', () => {
    const project = exampleProject()
    project.modules[1].items = { min: 1, max: 2, entries: [{ id: 'loot', weight: 3 }] }
    project.modules[1].ports[0].allowedTypeIds = ['basic', 'special']
    const data = exportRules(project)
    expect(data.schemaVersion).toBe(2)
    expect(data.types[1]).not.toHaveProperty('items')
    expect(data.modules[1].items.min).toBe(1)
    expect(data.modules[1].ports[0].allowedTypeIds).toEqual(['basic', 'special'])
    expect(parseRuntime(data).modules[1].items.entries[0].id).toBe('loot')
    expect(() => parseRuntime({ ...data, schemaVersion: 1 })).toThrow('requires v2')
  })
  it('requires both ports to permit the opposite type', () => {
    const project = exampleProject()
    project.modules[0].ports.forEach(p => { p.allowedTypeIds = ['special'] })
    expect(generate(project, 42, undefined, 2000, 2).complete).toBe(false)
    project.modules[0].ports.forEach(p => { p.allowedTypeIds = ['basic'] })
    project.modules.filter(m => m.typeId === 'basic').forEach(m => m.ports.forEach(p => { p.allowedTypeIds = ['special'] }))
    expect(generate(project, 42, undefined, 2000, 2).complete).toBe(false)
    project.modules.filter(m => m.typeId === 'basic').forEach(m => m.ports.forEach(p => { p.allowedTypeIds = null }))
    expect(generate(project, 42).complete).toBe(true)
  })
  it('samples module content reproducibly without changing layout', () => {
    const project = exampleProject()
    const base = generate(project, 53)
    project.modules[1].items = { min: 2, max: 2, entries: [{ id: 'key', weight: 1 }, { id: 'coin', weight: 2 }] }
    project.modules[1].enemies = { min: 1, max: 1, entries: [{ id: 'slime', weight: 1 }] }
    const next = generate(project, 53)
    expect(next.placements).toEqual(base.placements)
    expect(next.markers).toEqual(generate(project, 53).markers)
    expect(next.markers.some(marker => marker.kind === 'item')).toBe(true)
    expect(next.markers.some(marker => marker.kind === 'enemy')).toBe(true)
  })
  it('validates numeric positions and finds the nearest side across corners', () => {
    const bounds = { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 }
    expect(portAtBoundary(bounds, 0, 4000, 2000)?.edge).toBe('N')
    expect(portAtBoundary(bounds, 3999, 4000, 2000)).toBeNull()
    expect(portAtBoundary(bounds, 0, 3900, 2000)).toBeNull()
    expect(nearestValidPort(bounds, 3900, 0, 2000)?.edge).toBe('E')
    expect(nearestValidPort(bounds, 0, 3900, 2000)?.edge).toBe('N')
  })
  it('reports autosave failure when browser storage is unavailable', async () => {
    await expect(saveDraft({ project: exampleProject(), editor: emptyEditor(), files: new Map() })).rejects.toThrow()
  })
})
