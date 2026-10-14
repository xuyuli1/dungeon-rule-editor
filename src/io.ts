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
  download(new Blob([JSON.stringify(exportRules(project), null, 2)], { type: 'application/json' }), 'dungeon-rules.v1.json')
}
export async function readJson(file: File): Promise<RuntimeProject> {
  return parseRuntime(JSON.parse(await file.text()))
}
export async function importFbx(file: File): Promise<Bounds> {
  if (!file.name.toLowerCase().endsWith('.fbx')) throw new Error('第一版只支持 .fbx 文件')
  const [{ Box3 }, { FBXLoader }] = await Promise.all([import('three'), import('three/addons/loaders/FBXLoader.js')])
  const model = new FBXLoader().parse(await file.arrayBuffer(), '')
  model.updateWorldMatrix(true, true)
  const box = new Box3().setFromObject(model, true)
  if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.z)) throw new Error('未找到有效的模型网格')
  const bounds = { minX: toMm(box.min.x), maxX: toMm(box.max.x), minZ: toMm(box.min.z), maxZ: toMm(box.max.z) }
  if (bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) throw new Error('模型在 X-Z 平面上的占地为零')
  return bounds
}
type SavedProject = { format: 'dungeon-editor-project'; version: 1; runtime: RuntimeProject; editor: EditorState; assets: Record<string, string> }
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
  const saved: SavedProject = { format: 'dungeon-editor-project', version: 1, runtime: project, editor, assets }
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
  if (!manifest) throw new Error('压缩包中缺少 project.json')
  const raw: unknown = JSON.parse(await manifest.async('text'))
  if (!raw || typeof raw !== 'object') throw new Error('项目格式不正确')
  const saved = raw as SavedProject
  if (saved.format !== 'dungeon-editor-project' || saved.version !== 1) throw new Error('不支持的项目版本')
  const project = parseRuntime(saved.runtime)
  if (project.schemaVersion !== SCHEMA_VERSION) throw new Error('运行时 JSON 版本不匹配')
  const editor = saved.editor && typeof saved.editor === 'object' ? saved.editor : emptyEditor()
  if (!editor.graphPositions || !editor.modelNames) throw new Error('编辑器数据不完整')
  const files = new Map<string, File>()
  for (const [id, path] of Object.entries(saved.assets ?? {})) {
    if (!project.modules.some(m => m.id === id) || !/^assets\/[A-Za-z][A-Za-z0-9_-]*\.fbx$/.test(path)) throw new Error('项目资源路径无效')
    const entry = zip.file(path)
    if (!entry) throw new Error(`缺少模型文件 ${path}`)
    files.set(id, new File([await entry.async('blob')], editor.modelNames[id] || `${id}.fbx`, { type: 'application/octet-stream' }))
  }
  return { project, editor, files }
}
