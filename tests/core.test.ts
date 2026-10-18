import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { emptyEditor, emptyProject, exampleProject, exportRules, normalizeEditor, occupiedBounds, parseRuntime, typeTargets, validateProject, type Bounds, type RuntimeProject } from '../src/model'
import { generate, overlaps, previewDoors, rotatedBounds, rotate } from '../src/generator'
import { nearestValidPort, portAtBoundary, portsFromDoorMarkers, remapPorts } from '../src/geometry'
import { buildProjectZip, fbxMetersPerUnit, fbxModelNames, openProject, type FbxAnalysis } from '../src/io'
import { applyImports } from '../src/importer'
import { tidyLayout } from '../src/layout'
import { renameType } from '../src/editorActions'
import { nextTypeColor, typeColorSwatches } from '../src/typeColors'

// A 6 x 4 x 6 m room centred on the origin, as door markers would see it (millimetres).
const room: Bounds = { minX: -3000, maxX: 3000, minY: 0, maxY: 4000, minZ: -3000, maxZ: 3000 }
const marker = (name: string, box: Bounds) => ({ name, box })
const analysis = (moduleId: string, markers: FbxAnalysis['markers'], bounds: Bounds = room): FbxAnalysis => ({ moduleId, typeHint: moduleId.split('_')[0], bounds, markers, mainFound: true, doorsAbove: markers.some(m => (m.box.minY + m.box.maxY) / 2 > bounds.maxY) })

describe('v5 map rules', () => {
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
    expect(remapPorts([{ id: 'a', edge: 'N', doorTypeId: 'd', x: 1000, y: 1000, z: 2000, allowedTypeIds: null }], before, after))
      .toEqual([{ id: 'a', edge: 'N', doorTypeId: 'd', x: 2000, y: 3000, z: 4000, allowedTypeIds: null }])
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
    const doorTypeId = 'Door_100x100'
    start.id = 'start_a'; start.typeId = 'start'; start.ports = [{ id: 'exit', edge: 'E', doorTypeId, x: 4000, y: 1500, z: 0, allowedTypeIds: null }]
    stair.id = 'stair_a'; stair.typeId = 'stair'; stair.bounds.maxY = 6000
    stair.ports = [{ id: 'lower', edge: 'W', doorTypeId, x: -4000, y: 1500, z: 0, allowedTypeIds: null }, { id: 'upper', edge: 'E', doorTypeId, x: 4000, y: 4500, z: 0, allowedTypeIds: null }]
    room.id = 'room_a'; room.typeId = 'room'; room.ports = [{ id: 'entry', edge: 'W', doorTypeId, x: -4000, y: 1500, z: 0, allowedTypeIds: null }]
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
  it('requires the door centre on a side face but lets the opening overhang', () => {
    const bounds = { minX: -4000, maxX: 4000, minY: 0, maxY: 3000, minZ: -4000, maxZ: 4000 }
    expect(portAtBoundary(bounds, 0, 100, 4000)?.edge).toBe('N')
    expect(portAtBoundary(bounds, 3900, 2900, 4000)).toEqual({ edge: 'N', x: 3900, y: 2900, z: 4000 })
    expect(portAtBoundary(bounds, 0, 3100, 4000)).toBeNull()
    expect(portAtBoundary(bounds, 4100, 1500, 4000)).toBeNull()
    expect(portAtBoundary(bounds, 0, 1500, 3900)).toBeNull()
    expect(portAtBoundary(bounds, 0, 1500, 3995, 10)).toEqual({ edge: 'N', x: 0, y: 1500, z: 4000 })
    expect(nearestValidPort(bounds, 3900, 3500, 0)).toEqual({ edge: 'E', x: 4000, y: 3000, z: 0 })
    const project = exampleProject()
    project.doorTypes[0] = { ...project.doorTypes[0], width: 10000, height: 5000 }
    project.modules[0].ports[0].x = 4000
    expect(validateProject(project)).toEqual([])
    project.modules[0].ports[0].x = 4100
    expect(validateProject(project).some(error => error.includes('centre off its side face'))).toBe(true)
  })
  it('checks both connector type permissions and directed connections', () => {
    const project = exampleProject()
    project.modules[0].ports.forEach(port => { port.allowedTypeIds = ['special'] })
    expect(generate(project, 42, undefined, 2000, 2).complete).toBe(false)
    project.modules[0].ports.forEach(port => { port.allowedTypeIds = ['basic'] })
    project.modules.filter(m => m.typeId === 'basic').forEach(m => m.ports.forEach(port => { port.allowedTypeIds = null }))
    expect(generate(project, 42).complete).toBe(true)
  })
  it('only joins ports of the same door type', () => {
    const project = exampleProject()
    project.doorTypes.push({ id: 'Door_200x100', width: 2000, height: 1000 })
    project.modules.filter(m => m.typeId !== 'entrance').forEach(m => m.ports.forEach(port => { port.doorTypeId = 'Door_200x100' }))
    expect(validateProject(project)).toEqual([])
    const result = generate(project, 42, undefined, 2000, 2)
    expect(result.complete).toBe(false)
    expect(result.placements).toHaveLength(1)
  })
  it('validates door types: unique sizes and ports that reference one', () => {
    const project = exampleProject()
    project.doorTypes.push({ id: 'Door_101x100', width: 1010, height: 1000 })
    expect(validateProject(project).some(error => error.includes('are the same size'))).toBe(true)
    project.doorTypes.pop()
    project.modules[0].ports[0].doorTypeId = 'missing'
    expect(validateProject(project).some(error => error.includes('needs a valid door type'))).toBe(true)
    expect(validateProject({ ...emptyProject(), types: [{ id: 'a', color: '#ffffff', percent: 0, requiredMin: 0 }], settings: { modulesAfterStart: 1, startTypeId: 'a' } }).some(error => error.includes('door type'))).toBe(false)
  })
  it('turns door meshes into ports on the face their centre lies on', () => {
    const doors = [
      marker('Room_Door01', { minX: 3000, maxX: 3000, minY: 100, maxY: 3100, minZ: -1500, maxZ: 1500 }),
      marker('Room_Door02', { minX: -1000, maxX: 1000, minY: 100, maxY: 2100, minZ: -3010, maxZ: -2990 }),
      marker('Room_Door03', { minX: -3000, maxX: -3000, minY: 100, maxY: 3100, minZ: -1490, maxZ: 1510 }),
      marker('Room_Door04', { minX: -500, maxX: 1500, minY: 100, maxY: 2100, minZ: 3000, maxZ: 3000 }),
    ]
    const result = portsFromDoorMarkers(room, doors, [{ id: 'Big', width: 3000, height: 3000 }])
    expect(result.errors).toEqual([])
    expect(result.ports.map(p => [p.id, p.edge, p.doorTypeId, p.x, p.y, p.z])).toEqual([
      ['Room_Door01', 'E', 'Big', 3000, 1600, 0],
      ['Room_Door02', 'S', 'Door_200x200', 0, 1100, -3000],
      ['Room_Door03', 'W', 'Big', -3000, 1600, 10],
      ['Room_Door04', 'N', 'Door_200x200', 500, 1100, 3000],
    ])
    expect(result.newDoorTypes).toEqual([{ id: 'Door_200x200', width: 2000, height: 2000 }])
  })
  it('reports bad door meshes instead of guessing or renaming', () => {
    const onFace = { minX: -500, maxX: 500, minY: 0, maxY: 1000, minZ: 3000, maxZ: 3000 }
    expect(portsFromDoorMarkers(room, [marker('ns:Door01', onFace)], []).errors[0]).toContain('not a valid port ID')
    expect(portsFromDoorMarkers(room, [marker('Door', onFace), marker('Door', onFace)], []).errors[0]).toContain('Two door meshes')
    expect(portsFromDoorMarkers(room, [marker('Door', { ...onFace, minZ: 0, maxZ: 0 })], []).errors[0]).toContain('not on a side face')
    expect(portsFromDoorMarkers(room, [marker('Door', { ...onFace, minX: 3500, maxX: 4500 })], []).errors[0]).toContain('not on a side face')
    const overhang = portsFromDoorMarkers(room, [marker('Wide_Door', { minX: -4000, maxX: 4000, minY: 0, maxY: 5000, minZ: 3000, maxZ: 3000 })], [])
    expect(overhang.errors).toEqual([])
    expect(overhang.ports[0]).toMatchObject({ edge: 'N', doorTypeId: 'Door_800x500', x: 0, y: 2500, z: 3000 })
    const mixed = portsFromDoorMarkers(room, [marker('Good', onFace), marker('9bad', onFace)], [])
    expect(mixed.ports).toEqual([])
  })
  it('imports FBX analyses: types from file names, door types by size, replace rebuilds ports', () => {
    const door = (name: string) => marker(name, { minX: 3000, maxX: 3000, minY: 0, maxY: 4000, minZ: -2000, maxZ: 2000 })
    const first = applyImports(emptyProject(), [
      { fileName: 'CorridorConnection_Ten_Small.fbx', analysis: analysis('CorridorConnection_Ten_Small', [door('CorridorConnection_Ten_Small_Door01')]), target: { kind: 'new', typeId: 'CorridorConnection' } },
      { fileName: 'StairsRoom.fbx', analysis: analysis('StairsRoom', [door('StairsRoom_Door01')]), target: { kind: 'new', typeId: 'StairsRoom' } },
      { fileName: 'chaguan03(1).fbx', analysis: analysis('chaguan03(1)', []), target: { kind: 'new', typeId: 'chaguan03(1)' } },
    ])
    expect(first.outcomes.map(o => o.ok)).toEqual([true, true, false])
    expect(first.project.types.map(t => t.id)).toEqual(['CorridorConnection', 'StairsRoom'])
    expect(first.project.doorTypes).toEqual([{ id: 'Door_400x400', width: 4000, height: 4000 }])
    expect(first.project.modules.map(m => [m.id, m.typeId, m.ports.map(p => `${p.id}:${p.doorTypeId}`)])).toEqual([
      ['CorridorConnection_Ten_Small', 'CorridorConnection', ['CorridorConnection_Ten_Small_Door01:Door_400x400']],
      ['StairsRoom', 'StairsRoom', ['StairsRoom_Door01:Door_400x400']],
    ])
    const renamed = structuredClone(first.project); renamed.doorTypes[0].id = 'Big'; renamed.modules.forEach(m => m.ports.forEach(p => { p.doorTypeId = 'Big' }))
    const replaced = applyImports(renamed, [{ fileName: 'StairsRoom_B.fbx', analysis: analysis('StairsRoom_B', [door('X_Door'), door('Y_Door')]), target: { kind: 'replace', moduleId: 'StairsRoom' } }])
    expect(replaced.outcomes[0]).toMatchObject({ ok: true, replaced: 'StairsRoom', moduleId: 'StairsRoom_B' })
    expect(replaced.project.doorTypes.map(d => d.id)).toEqual(['Big'])
    expect(replaced.project.modules[1]).toMatchObject({ id: 'StairsRoom_B', typeId: 'StairsRoom' })
    expect(replaced.project.modules[1].ports.map(p => p.id)).toEqual(['X_Door', 'Y_Door'])
    expect(applyImports(first.project, [{ fileName: 'StairsRoom.fbx', analysis: analysis('StairsRoom', []), target: { kind: 'new', typeId: 'StairsRoom' } }]).outcomes[0].message).toContain('already exists')
  })
  it('reads original model names from binary and ASCII FBX', () => {
    const ascii = new TextEncoder().encode('Objects:  {\n Model: 123, "Model::ns:Door 01", "Mesh" {\n }\n Model: 124, "Model::Room", "Mesh" {\n }\n}')
    expect(fbxModelNames(ascii.buffer)).toEqual(['ns:Door 01', 'Room'])
    // Binary FBX 7.4 (32-bit records): header, an Objects node holding one Model record, then the null terminators.
    const name = new TextEncoder().encode('Room_Door01\u0000\u0001Model'), props = new Uint8Array(9 + 5 + name.length)
    const pv = new DataView(props.buffer); props[0] = 0x4c; pv.setBigInt64(1, 7n, true); props[9] = 0x53; pv.setUint32(10, name.length, true); props.set(name, 14)
    const record = (nodeName: string, properties: Uint8Array, children: Uint8Array, start: number, count = 0) => {
      const label = new TextEncoder().encode(nodeName), size = 13 + label.length + properties.length + children.length
      const out = new Uint8Array(size), view = new DataView(out.buffer)
      view.setUint32(0, start + size, true); view.setUint32(4, count, true); view.setUint32(8, properties.length, true); out[12] = label.length
      out.set(label, 13); out.set(properties, 13 + label.length); out.set(children, 13 + label.length + properties.length)
      return out
    }
    const header = new Uint8Array(27); header.set(new TextEncoder().encode('Kaydara FBX Binary  \u0000'), 0); new DataView(header.buffer).setUint32(23, 7400, true)
    const objectsHead = 27 + 13 + 'Objects'.length
    const model = record('Model', props, new Uint8Array(13), objectsHead, 2)
    const objects = record('Objects', new Uint8Array(0), new Uint8Array([...model, ...new Uint8Array(13)]), 27)
    const file = new Uint8Array([...header, ...objects, ...new Uint8Array(13)])
    expect(fbxModelNames(file.buffer)).toEqual(['Room_Door01'])
  })
  it('keeps the space reserved above a module empty and lets its faces extend into it', () => {
    // Rooftop-like slab: 1.5 m tall body, door centre at 2.1 m on the +Z face.
    const slab: Bounds = { minX: -20500, maxX: 20500, minY: 0, maxY: 1500, minZ: -20500, maxZ: 20500 }
    const door = marker('Rooftop_Door', { minX: -2000, maxX: 2000, minY: 100, maxY: 4100, minZ: 20500, maxZ: 20500 })
    expect(portsFromDoorMarkers(slab, [door], []).errors[0]).toContain('not on a side face')
    expect(portsFromDoorMarkers(slab, [door], [], Infinity).ports[0]).toMatchObject({ id: 'Rooftop_Door', edge: 'N', y: 2100, z: 20500 })
    const imported = applyImports(emptyProject(), [{ fileName: 'Rooftop.fbx', analysis: analysis('Rooftop', [door], slab), target: { kind: 'new', typeId: 'Rooftop' }, reservedAbove: null }])
    expect(imported.outcomes[0].ok).toBe(true)
    expect(imported.project.modules[0].reservedAbove).toBeNull()
    expect(analysis('Rooftop', [door], slab).doorsAbove).toBe(true)
    // Validation: a centre above the body is only valid inside the reserved space.
    const project = exampleProject()
    project.modules[0].ports[0].y = 3500
    expect(validateProject(project).some(error => error.includes('centre off its side face'))).toBe(true)
    project.modules[0].reservedAbove = 1000
    expect(validateProject(project)).toEqual([])
    project.modules[0].reservedAbove = -5
    expect(validateProject(project).some(error => error.includes('space reserved above'))).toBe(true)
    // Overlap: a module directly above is blocked by open sky, allowed above a custom reserve.
    const base = { bounds: { minX: 0, maxX: 2000, minY: 0, maxY: 3000, minZ: 0, maxZ: 2000 } }
    const above = { minX: 0, maxX: 2000, minY: 6000, maxY: 9000, minZ: 0, maxZ: 2000 }
    expect(overlaps(occupiedBounds({ ...base, reservedAbove: 0 }), above)).toBe(false)
    expect(overlaps(occupiedBounds({ ...base, reservedAbove: null }), above)).toBe(true)
    expect(overlaps(occupiedBounds({ ...base, reservedAbove: 3000 }), above)).toBe(false)
    expect(overlaps(occupiedBounds({ ...base, reservedAbove: 3500 }), above)).toBe(true)
    // Older v5 data without the field reads as Normal.
    const exported = JSON.parse(JSON.stringify(exportRules(exampleProject())))
    delete exported.modules[0].reservedAbove
    expect(parseRuntime(exported).modules[0].reservedAbove).toBe(0)
  })
  it('never places a module above an open-to-sky start', () => {
    const project = exampleProject()
    project.settings.modulesAfterStart = 6
    const result = generate({ ...project, modules: project.modules.map(m => m.typeId === 'entrance' ? { ...m, reservedAbove: null } : m) }, 7)
    const start = result.placements[0]
    const startBox = project.modules.find(m => m.id === start.moduleId)!.bounds
    for (const p of result.placements.slice(1)) {
      const box = rotatedBounds(project.modules.find(m => m.id === p.moduleId)!.bounds, p.rotation, p.x, p.y, p.z)
      const overHead = box.minY >= startBox.maxY && box.minX < startBox.maxX && box.maxX > startBox.minX && box.minZ < startBox.maxZ && box.maxZ > startBox.minZ
      expect(overHead).toBe(false)
    }
  })
  it('tidies the graph layout without undoing where nodes were moved', () => {
    const node = (id: string, x: number, y: number) => ({ id, x, y, width: 370, height: 220 })
    // b was dragged to the left of a and slightly lower; c sits on a second row; d far right of c.
    const tidy = tidyLayout([node('a', 500, 0), node('b', 20, 40), node('c', 480, 600), node('d', 1900, 640)])
    expect(tidy).toEqual({ b: { x: 20, y: 0 }, a: { x: 480, y: 0 }, c: { x: 480, y: 330 }, d: { x: 940, y: 330 } })
    expect(tidyLayout(Object.entries(tidy).map(([id, p]) => node(id, p.x, p.y)))).toEqual(tidy)
    // Two nodes dropped on the same spot keep their order and are separated.
    expect(tidyLayout([node('x', 0, 0), node('y', 10, 5)])).toEqual({ x: { x: 0, y: 0 }, y: { x: 460, y: 0 } })
  })
  it('exports only v5 map data and rejects older versions', () => {
    const project = exampleProject()
    const exported = exportRules(project)
    expect(exported.schemaVersion).toBe(5)
    expect(exported.doorTypes).toEqual([{ id: 'Door_100x100', width: 1000, height: 1000 }])
    expect(exported.modules[0].ports[0].doorTypeId).toBe('Door_100x100')
    expect(exported.types[0]).not.toHaveProperty('color')
    expect(exported.modules[0]).not.toHaveProperty('items')
    expect(exported.modules[0]).not.toHaveProperty('enemies')
    expect(exported.modules[0].bounds).toHaveProperty('minY')
    expect(exported.modules[0].ports[0]).toHaveProperty('y')
    expect(parseRuntime(JSON.parse(JSON.stringify(exported))).doorTypes[0].height).toBe(1000)
    expect(() => parseRuntime({ ...exported, schemaVersion: 4 })).toThrow('requires v5')
  })
  it('keeps directional weights when renaming a type', () => {
    const project = exampleProject()
    project.connections = [{ from: 'basic', to: 'special', weight: 3 }, { from: 'special', to: 'basic', weight: 1 }]
    const changed = renameType(project, { ...emptyEditor(), panel: { kind: 'type', id: 'basic' } }, 'basic', 'z_basic')
    expect(changed.editor.panel).toEqual({ kind: 'type', id: 'z_basic' })
    expect(changed.project.connections).toEqual([{ from: 'z_basic', to: 'special', weight: 3 }, { from: 'special', to: 'z_basic', weight: 1 }])
  })
  it('stores v5 rules, layout and FBX bytes in a project ZIP', async () => {
    const project = exampleProject(), editor = emptyEditor()
    const file = new Blob([new Uint8Array([1, 2, 3])])
    const zip = await JSZip.loadAsync(await buildProjectZip(project, editor, new Map([['room_a', file]])))
    const saved = JSON.parse(await zip.file('project.json')!.async('text')) as { version: number; runtime: RuntimeProject }
    expect(saved.version).toBe(5)
    expect(saved.runtime.modules[0].bounds.minY).toBe(0)
    expect([...await zip.file('assets/room_a.fbx')!.async('uint8array')]).toEqual([1, 2, 3])
    const reopened = await openProject(new File([await buildProjectZip(project, editor, new Map([['room_a', file]]))], 'project.zip'))
    expect(reopened.project.modules).toHaveLength(project.modules.length)
    expect(reopened.files.get('room_a')?.name).toBe('room_a.fbx')
    expect(reopened.library.size).toBe(0)
    saved.version = 4; zip.file('project.json', JSON.stringify(saved))
    await expect(openProject(new File([await zip.generateAsync({ type: 'blob' })], 'old.zip'))).rejects.toThrow('requires v5')
  })
  it('keeps unassigned library models in the project ZIP', async () => {
    const project = exampleProject(), editor = emptyEditor()
    const library = new Map([['Stairs Room.fbx', new Blob([new Uint8Array([4, 5])])], ['hall.fbx', new Blob([new Uint8Array([6])])]])
    const reopened = await openProject(new File([await buildProjectZip(project, editor, new Map(), library)], 'project.zip'))
    expect([...reopened.library.keys()]).toEqual(['Stairs Room.fbx', 'hall.fbx'])
    expect([...new Uint8Array(await reopened.library.get('Stairs Room.fbx')!.arrayBuffer())]).toEqual([4, 5])
    const zip = await JSZip.loadAsync(await buildProjectZip(project, editor, new Map(), library))
    const saved = JSON.parse(await zip.file('project.json')!.async('text')) as { library?: unknown }
    delete saved.library; zip.file('project.json', JSON.stringify(saved))
    expect((await openProject(new File([await zip.generateAsync({ type: 'blob' })], 'older.zip'))).library.size).toBe(0)
  })
  it('opens editor state saved with floating windows as one inspector panel', () => {
    const old = { graphPositions: {}, modelNames: {}, seed: 7, windows: [{ kind: 'module', id: 'room_a', x: 0, y: 0, width: 1, height: 1, z: 104 }, { kind: 'type', id: 'basic', x: 0, y: 0, width: 1, height: 1, z: 102 }] }
    expect(normalizeEditor(old)).toEqual({ graphPositions: {}, modelNames: {}, seed: 7, panel: { kind: 'module', id: 'room_a' } })
    expect(normalizeEditor({ ...emptyEditor(), panel: { kind: 'type', id: 'basic' } }).panel).toEqual({ kind: 'type', id: 'basic' })
    expect(() => normalizeEditor({ seed: 1 })).toThrow('Incomplete editor data')
  })
})
