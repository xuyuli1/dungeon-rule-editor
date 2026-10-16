import { emptyEditor, exportRules, parseRuntime, SCHEMA_VERSION, toMm, type Bounds, type EditorState, type RuntimeProject } from './model'

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
  download(new Blob([JSON.stringify(exportRules(project), null, 2)], { type: 'application/json' }), 'dungeon-rules.v3.json')
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
  const bounds = { minX: toMm(box.min.x * metersPerUnit), maxX: toMm(box.max.x * metersPerUnit), minZ: toMm(box.min.z * metersPerUnit), maxZ: toMm(box.max.z * metersPerUnit) }
  if (bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) throw new Error('Model has no X-Z footprint')
  return bounds
}
type SavedProject = { format: 'dungeon-editor-project'; version: 3; runtime: RuntimeProject; editor: EditorState; assets: Record<string, string> }
export async function buildProjectZip(project: RuntimeProject, editor: EditorState, files: Map<string, Blob>): Promise<Blob> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const assets: Record<string, string> = {}
  for (const [id, file] of files) {
    if (!project.modules.some(m => m.id === id)) continue
    const path = `assets/${id}.fbx`
    assets[id] = path
    zip.file(path, file)
  }
  const saved: SavedProject = { format: 'dungeon-editor-project', version: 3, runtime: project, editor, assets }
  zip.file('project.json', JSON.stringify(saved, null, 2))
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}
export async function saveProject(project: RuntimeProject, editor: EditorState, files: Map<string, File>): Promise<void> {
  download(await buildProjectZip(project, editor, files), 'dungeon-editor-project.zip')
}
export async function openProject(file: File): Promise<{ project: RuntimeProject; editor: EditorState; files: Map<string, File> }> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(file)
  const manifest = zip.file('project.json')
  if (!manifest) throw new Error('project.json is missing from the ZIP')
  const raw: unknown = JSON.parse(await manifest.async('text'))
  if (!raw || typeof raw !== 'object') throw new Error('Invalid project format')
  const saved = raw as SavedProject
  if (saved.format !== 'dungeon-editor-project' || saved.version !== 3) throw new Error(`Unsupported project version ${String(saved.version)}; this editor requires v3`)
  const project = parseRuntime(saved.runtime)
  if (project.schemaVersion !== SCHEMA_VERSION) throw new Error('Runtime JSON version mismatch')
  const editor = saved.editor && typeof saved.editor === 'object' ? saved.editor : emptyEditor()
  if (!editor.graphPositions || !editor.modelNames || !Array.isArray(editor.windows) || !Number.isInteger(editor.seed)) throw new Error('Incomplete editor data')
  const files = new Map<string, File>()
  for (const [id, path] of Object.entries(saved.assets ?? {})) {
    if (!project.modules.some(m => m.id === id) || !/^assets\/[A-Za-z][A-Za-z0-9_-]*\.fbx$/.test(path)) throw new Error('Invalid project asset path')
    const entry = zip.file(path)
    if (!entry) throw new Error(`Missing model file ${path}`)
    files.set(id, new File([await entry.async('blob')], editor.modelNames[id] || `${id}.fbx`, { type: 'application/octet-stream' }))
  }
  return { project, editor, files }
}
