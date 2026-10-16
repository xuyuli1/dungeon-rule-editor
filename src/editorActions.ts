import { canonicalConnection, type EditorState, type RuntimeProject } from './model'

export function renameType(project: RuntimeProject, editor: EditorState, oldId: string, nextId: string) {
  const next = structuredClone(project)
  const target = next.types.find(type => type.id === oldId)
  if (!target) return { project, editor }
  target.id = nextId
  if (next.settings.startTypeId === oldId) next.settings.startTypeId = nextId
  next.modules.forEach(module => { if (module.typeId === oldId) module.typeId = nextId; module.ports.forEach(port => { if (port.allowedTypeIds) port.allowedTypeIds = port.allowedTypeIds.map(id => id === oldId ? nextId : id) }) })
  next.connections = next.connections.map(connection => canonicalConnection(
    connection.a === oldId ? nextId : connection.a,
    connection.b === oldId ? nextId : connection.b,
    connection.weightAB,
    connection.weightBA,
  ))
  const positions = { ...editor.graphPositions }
  if (positions[oldId]) { positions[nextId] = positions[oldId]; delete positions[oldId] }
  return { project: next, editor: { ...editor, graphPositions: positions, windows: editor.windows.map(window => window.kind === 'type' && window.id === oldId ? { ...window, id: nextId } : window) } }
}
