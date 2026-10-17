import { exportRules, normalizeEditor, parseRuntime, SCHEMA_VERSION, toMm, type Bounds, type EditorState, type RuntimeProject } from './model'

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
export async function importFbx(file: File): Promise<Bounds> {
  if (!file.name.toLowerCase().endsWith('.fbx')) throw new Error('Only .fbx files are supported')
  const [{ Box3 }, { FBXLoader }] = await Promise.all([import('three'), import('three/addons/loaders/FBXLoader.js')])
  const model = new FBXLoader().parse(await file.arrayBuffer(), '')
  const metersPerUnit = fbxMetersPerUnit(model.userData.unitScaleFactor)
  model.updateWorldMatrix(true, true)
  const box = new Box3().setFromObject(model, true)
  if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.z)) throw new Error('No valid mesh found in the model')
  const bounds = { minX: toMm(box.min.x * metersPerUnit), maxX: toMm(box.max.x * metersPerUnit), minY: toMm(box.min.y * metersPerUnit), maxY: toMm(box.max.y * metersPerUnit), minZ: toMm(box.min.z * metersPerUnit), maxZ: toMm(box.max.z * metersPerUnit) }
  if (bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) throw new Error('Model has no X-Z footprint')
  return bounds
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
// `library` holds FBX files that are not assigned to a module yet; it is optional so older v4 ZIPs still open.
type SavedProject = { format: 'dungeon-editor-project'; version: 4; runtime: RuntimeProject; editor: EditorState; assets: Record<string, string>; library?: LibraryEntry[] }
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
  const saved: SavedProject = { format: 'dungeon-editor-project', version: 4, runtime: project, editor, assets, library: libraryEntries }
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
  if (saved.format !== 'dungeon-editor-project' || saved.version !== 4) throw new Error(`Unsupported project version ${String(saved.version)}; this editor requires v4`)
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
