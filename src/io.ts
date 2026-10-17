import { exportRules, normalizeEditor, parseRuntime, SCHEMA_VERSION, toMm, type Bounds, type EditorState, type RuntimeProject } from './model'
import type { DoorMarker } from './geometry'

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30000)
}
export function downloadJson(project: RuntimeProject): void {
  download(new Blob([JSON.stringify(exportRules(project), null, 2)], { type: 'application/json' }), 'dungeon-rules.v4.json')
}
export async function readJson(file: File): Promise<RuntimeProject> {
  return parseRuntime(JSON.parse(await file.text()))
}
export function fbxMetersPerUnit(unitScaleFactor: unknown): number {
  if (unitScaleFactor === undefined) return 0.01 // FBX defaults to centimetres.
  if (typeof unitScaleFactor !== 'number' || !Number.isFinite(unitScaleFactor) || unitScaleFactor <= 0) throw new Error('Invalid FBX unit scale')
  return unitScaleFactor / 100 // FBX UnitScaleFactor is centimetres per file unit.
}
// Original FBX model names. three's FBXLoader sanitises names (spaces to "_", drops ":./[]"), which would hide invalid IDs.
export function fbxModelNames(buffer: ArrayBuffer): string[] {
  const bytes = new Uint8Array(buffer), text = new TextDecoder('latin1')
  if (text.decode(bytes.subarray(0, 18)) !== 'Kaydara FBX Binary') {
    return [...new TextDecoder().decode(bytes).matchAll(/Model:\s*-?\d+\s*,\s*"Model::([^"]*)"/g)].map(match => match[1])
  }
  const view = new DataView(buffer), wide = view.getUint32(23, true) >= 7500, names: string[] = []
  const read = (at: number) => wide ? Number(view.getBigUint64(at, true)) : view.getUint32(at, true)
  const walk = (offset: number, limit: number, inObjects: boolean) => {
    while (offset < limit) {
      const end = read(offset), headSize = wide ? 24 : 12
      if (end === 0) return
      const propertyBytes = read(offset + (wide ? 16 : 8)), nameLength = bytes[offset + headSize]
      const name = text.decode(bytes.subarray(offset + headSize + 1, offset + headSize + 1 + nameLength))
      const properties = offset + headSize + 1 + nameLength
      // An Objects/Model record starts with an id ('L', 8 bytes) followed by its 'S' name, stored as "Name\0\x01Model".
      if (inObjects && name === 'Model' && bytes[properties] === 0x4c && bytes[properties + 9] === 0x53) {
        const length = view.getUint32(properties + 10, true)
        names.push(new TextDecoder().decode(bytes.subarray(properties + 14, properties + 14 + length)).split('\u0000\u0001')[0])
      }
      if (name === 'Objects') walk(properties + propertyBytes, end, true)
      offset = end
    }
  }
  walk(27, bytes.length, false)
  return names
}
// `doorsAbove` is true when a door mesh's centre is above the body's top, which suggests an open-top module.
export type FbxAnalysis = { moduleId: string; typeHint: string; bounds: Bounds; markers: DoorMarker[]; mainFound: boolean; doorsAbove: boolean }
// Reads an FBX for auto-setup. The mesh named like the file is the module; meshes with "door" in their name mark ports
// and never enlarge the occupancy box. All names are the originals from the file. Distances are model millimetres.
export async function analyzeFbx(file: File): Promise<FbxAnalysis> {
  if (!isFbxName(file.name)) throw new Error('Only .fbx files are supported')
  const [{ Box3, Mesh, PropertyBinding }, { FBXLoader }] = await Promise.all([import('three'), import('three/addons/loaders/FBXLoader.js')])
  const buffer = await file.arrayBuffer()
  const model = new FBXLoader().parse(buffer, '')
  const metersPerUnit = fbxMetersPerUnit(model.userData.unitScaleFactor)
  const original = fbxModelNames(buffer)
  const rawName = (name: string) => original.find(raw => raw === name) ?? original.find(raw => PropertyBinding.sanitizeNodeName(raw) === name) ?? name
  model.updateWorldMatrix(true, true)
  const toBounds = (box: InstanceType<typeof Box3>): Bounds => ({ minX: toMm(box.min.x * metersPerUnit), maxX: toMm(box.max.x * metersPerUnit), minY: toMm(box.min.y * metersPerUnit), maxY: toMm(box.max.y * metersPerUnit), minZ: toMm(box.min.z * metersPerUnit), maxZ: toMm(box.max.z * metersPerUnit) })
  const moduleId = fbxStem(file.name), meshes: { name: string; box: InstanceType<typeof Box3> }[] = []
  model.traverse(object => { if (object instanceof Mesh) { const box = new Box3().setFromObject(object, true); if (!box.isEmpty()) meshes.push({ name: rawName(object.name), box }) } })
  const isDoor = (name: string) => name !== moduleId && /door/i.test(name)
  const main = meshes.filter(mesh => mesh.name === moduleId)
  const body = main.length ? main : meshes.filter(mesh => !isDoor(mesh.name))
  if (!body.length) throw new Error('No model mesh found (only door meshes)')
  const box = body.reduce((all, mesh) => all.union(mesh.box), new Box3())
  const bounds = toBounds(box)
  if (bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) throw new Error('Model has no X-Z footprint')
  const markers = meshes.filter(mesh => isDoor(mesh.name)).map(mesh => ({ name: mesh.name, box: toBounds(mesh.box) }))
  return { moduleId, typeHint: moduleId.split('_')[0], bounds, mainFound: main.length > 0, markers, doorsAbove: markers.some(marker => (marker.box.minY + marker.box.maxY) / 2 > bounds.maxY) }
}
export async function importFbx(file: File): Promise<Bounds> {
  return (await analyzeFbx(file)).bounds
}
export const isFbxName = (name: string) => name.toLowerCase().endsWith('.fbx')
export const fbxStem = (name: string) => name.replace(/\.fbx$/i, '')
// Collects every .fbx file from a drop, walking dropped folders (Chromium, Firefox and Safari expose them as entries).
export async function collectFbxFiles(data: DataTransfer): Promise<File[]> {
  const entries = Array.from(data.items).map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry)
  if (!entries.length) return Array.from(data.files).filter(file => isFbxName(file.name))
  const files: File[] = []
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) { if (isFbxName(entry.name)) files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))); return }
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (!batch.length) break
      for (const child of batch) await walk(child)
    }
  }
  for (const entry of entries) await walk(entry)
  return files
}
type LibraryEntry = { fileName: string; path: string }
// `library` holds FBX files that are not assigned to a module yet; it is optional, so a ZIP without unassigned models omits it.
type SavedProject = { format: 'dungeon-editor-project'; version: typeof SCHEMA_VERSION; runtime: RuntimeProject; editor: EditorState; assets: Record<string, string>; library?: LibraryEntry[] }
export async function buildProjectZip(project: RuntimeProject, editor: EditorState, files: Map<string, Blob>, library: Map<string, Blob> = new Map()): Promise<Blob> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const assets: Record<string, string> = {}
  for (const [id, file] of files) {
    if (!project.modules.some(m => m.id === id)) continue
    const path = `assets/${id}.fbx`
    assets[id] = path
    zip.file(path, file)
  }
  const libraryEntries = [...library].map(([fileName, file], i) => { const path = `library/${i + 1}.fbx`; zip.file(path, file); return { fileName, path } })
  const saved: SavedProject = { format: 'dungeon-editor-project', version: SCHEMA_VERSION, runtime: project, editor, assets, library: libraryEntries }
  zip.file('project.json', JSON.stringify(saved, null, 2))
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}
export async function saveProject(project: RuntimeProject, editor: EditorState, files: Map<string, File>, library: Map<string, File>): Promise<void> {
  download(await buildProjectZip(project, editor, files, library), 'dungeon-editor-project.zip')
}
export async function openProject(file: File): Promise<{ project: RuntimeProject; editor: EditorState; files: Map<string, File>; library: Map<string, File> }> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(file)
  const manifest = zip.file('project.json')
  if (!manifest) throw new Error('project.json is missing from the ZIP')
  const raw: unknown = JSON.parse(await manifest.async('text'))
  if (!raw || typeof raw !== 'object') throw new Error('Invalid project format')
  const saved = raw as SavedProject
  if (saved.format !== 'dungeon-editor-project' || saved.version !== SCHEMA_VERSION) throw new Error(`Unsupported project version ${String(saved.version)}; this editor requires v${SCHEMA_VERSION}`)
  const project = parseRuntime(saved.runtime)
  if (project.schemaVersion !== SCHEMA_VERSION) throw new Error('Runtime JSON version mismatch')
  const editor = normalizeEditor(saved.editor)
  const files = new Map<string, File>()
  for (const [id, path] of Object.entries(saved.assets ?? {})) {
    if (!project.modules.some(m => m.id === id) || !/^assets\/[A-Za-z][A-Za-z0-9_-]*\.fbx$/.test(path)) throw new Error('Invalid project asset path')
    const entry = zip.file(path)
    if (!entry) throw new Error(`Missing model file ${path}`)
    files.set(id, new File([await entry.async('blob')], editor.modelNames[id] || `${id}.fbx`, { type: 'application/octet-stream' }))
  }
  const library = new Map<string, File>()
  for (const item of Array.isArray(saved.library) ? saved.library : []) {
    if (!item || typeof item.fileName !== 'string' || !isFbxName(item.fileName) || typeof item.path !== 'string' || !/^library\/\d+\.fbx$/.test(item.path)) throw new Error('Invalid library entry')
    const entry = zip.file(item.path)
    if (!entry) throw new Error(`Missing model file ${item.path}`)
    library.set(item.fileName, new File([await entry.async('blob')], item.fileName, { type: 'application/octet-stream' }))
  }
  return { project, editor, files, library }
}
