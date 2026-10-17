import { portsFromDoorMarkers } from './geometry'
import type { FbxAnalysis } from './io'
import { isId, type RuntimeProject } from './model'
import { nextTypeColor } from './typeColors'

export type ImportTarget = { kind: 'new'; typeId: string } | { kind: 'replace'; moduleId: string }
export type ImportRequest = { fileName: string; analysis: FbxAnalysis; target: ImportTarget }
export type ImportOutcome = { fileName: string; moduleId: string; ok: boolean; replaced?: string; message: string }

// Applies FBX imports to a copy of the project. Module IDs are the file names, ports come from door meshes (named exactly
// as the meshes), door types are matched by size or created, and a missing target type is created. Names are never
// altered: an invalid name fails that file. Replacing rebuilds the module's ports entirely from the new file.
export function applyImports(project: RuntimeProject, requests: ImportRequest[]): { project: RuntimeProject; outcomes: ImportOutcome[] } {
  const next = structuredClone(project), outcomes: ImportOutcome[] = []
  for (const { fileName, analysis, target } of requests) {
    const id = analysis.moduleId
    const fail = (message: string) => outcomes.push({ fileName, moduleId: id, ok: false, message: `${fileName}: ${message}` })
    if (!isId(id)) { fail(`"${id}" is not a valid module ID; rename the file (start with a letter; use letters, numbers, _ or -)`); continue }
    const oldId = target.kind === 'replace' ? target.moduleId : ''
    if (next.modules.some(m => m.id === id && m.id !== oldId)) { fail(`module ${id} already exists`); continue }
    if (target.kind === 'new' && !isId(target.typeId)) { fail(`"${target.typeId}" is not a valid type ID`); continue }
    const replacing = target.kind === 'replace' ? next.modules.find(m => m.id === oldId) : undefined
    if (target.kind === 'replace' && !replacing) { fail('the module no longer exists'); continue }
    const doors = portsFromDoorMarkers(analysis.bounds, analysis.markers, next.doorTypes)
    if (doors.errors.length) { fail(doors.errors.join('; ')); continue }
    next.doorTypes.push(...doors.newDoorTypes)
    const notes = [`${doors.ports.length} port${doors.ports.length === 1 ? '' : 's'}`]
    if (doors.newDoorTypes.length) notes.push(`new door type ${doors.newDoorTypes.map(door => door.id).join(', ')}`)
    if (!analysis.mainFound) notes.push(`no mesh named ${id}, so the box uses all non-door meshes`)
    if (target.kind === 'new') {
      if (!next.types.some(t => t.id === target.typeId)) {
        next.types.push({ id: target.typeId, color: nextTypeColor(next.types.map(t => t.color)), percent: 0, requiredMin: 0 })
        notes.push(`new type ${target.typeId}`)
      }
      next.modules.push({ id, typeId: target.typeId, bounds: analysis.bounds, ports: doors.ports })
      outcomes.push({ fileName, moduleId: id, ok: true, message: `${fileName} → ${id} (${target.typeId}) · ${notes.join(' · ')}` })
    } else {
      Object.assign(replacing!, { id, bounds: analysis.bounds, ports: doors.ports })
      outcomes.push({ fileName, moduleId: id, ok: true, replaced: oldId, message: `${fileName} replaced ${oldId} · ports rebuilt · ${notes.join(' · ')}` })
    }
  }
  return { project: next, outcomes }
}
