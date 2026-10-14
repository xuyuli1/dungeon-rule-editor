import { describe, expect, it } from 'vitest'
import { canonicalConnection, exampleProject, exportRules, parseRuntime, typeTargets, validateProject } from '../src/model'
import { generate, overlaps, rotatedBounds, rotate } from '../src/generator'
import JSZip from 'jszip'
import { buildProjectZip, fbxMetersPerUnit, openProject } from '../src/io'
import { gridStep, remapPorts, unitsPerPixel } from '../src/geometry'

describe('rules and geometry', () => {
  it('converts FBX file units to metres and preserves relative port positions', () => {
    expect(fbxMetersPerUnit(1)).toBe(0.01)
    expect(fbxMetersPerUnit(100)).toBe(1)
    expect(fbxMetersPerUnit(undefined)).toBe(0.01)
    expect(() => fbxMetersPerUnit(0)).toThrow('FBX 文件单位无效')
    const before = { minX: -2050000, maxX: 2050000, minZ: -2050000, maxZ: 2050000 }
    const after = { minX: -20500, maxX: 20500, minZ: -20500, maxZ: 20500 }
    expect(remapPorts([{ id: 'door', edge: 'N', x: 1025000, z: 2050000 }], before, after, 2000))
      .toEqual([{ id: 'door', edge: 'N', x: 10250, z: 20500 }])
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
    expect(validateProject(p).some(e => e.includes('超过比例目标'))).toBe(true)
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
    expect(result.warnings.some(w => w.includes('特殊'))).toBe(true)
  })
  it('separates editor display fields from the runtime JSON and imports it again', () => {
    const p = exampleProject()
    const exported = exportRules(p)
    expect(exported.types[0]).not.toHaveProperty('color')
    expect(exported.types[0]).not.toHaveProperty('name')
    const imported = parseRuntime(JSON.parse(JSON.stringify(exported)))
    expect(validateProject(imported)).toEqual([])
    expect(imported.types[0].name).toBe('entrance')
  })
  it('stores rules, editor layout, and FBX bytes in the project ZIP', async () => {
    const p = exampleProject()
    const editor = { graphPositions: { basic: { x: 20, y: 40 } }, modelNames: { room_a: 'room_a.fbx' } }
    const fbx = new Blob([new Uint8Array([1, 2, 3, 4])])
    const zip = await JSZip.loadAsync(await buildProjectZip(p, editor, new Map([['room_a', fbx]])))
    const saved = JSON.parse(await zip.file('project.json')!.async('text'))
    expect(saved.runtime.modules).toHaveLength(p.modules.length)
    expect(saved.editor.graphPositions.basic).toEqual({ x: 20, y: 40 })
    expect([...await zip.file('assets/room_a.fbx')!.async('uint8array')]).toEqual([1, 2, 3, 4])
    const reopened = await openProject(new File([await buildProjectZip(p, editor, new Map([['room_a', fbx]]))], 'project.zip'))
    expect(reopened.project.modules).toHaveLength(p.modules.length)
    expect(reopened.files.get('room_a')?.name).toBe('room_a.fbx')
  })
})
