import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, Controls, type Edge as FlowEdge, type Node as FlowNode, type ReactFlowInstance } from '@xyflow/react'
import { RelationEdge } from './RelationEdge'
import { renameType } from './editorActions'
import { collectFbxFiles, downloadJson, fbxStem, importFbx, isFbxName, openProject, readJson, saveProject } from './io'
import { emptyEditor, emptyProject, exampleProject, isId, meters, relationKey, toMm, type Bounds, type Edge, type EditorState, type Module, type ModuleType, type PanelRef, type Port, type RuntimeProject, validateProject, typeTargets } from './model'
import { type PreviewResult } from './generator'
import { portAtBoundary, remapPorts } from './geometry'
import { InspectorPanel, ModuleSlot } from './WorkspaceWidgets'
import { ThreeCanvas } from './ThreeCanvas'
import { clearDraft, loadDraft, saveDraft } from './autosave'
import { nextTypeColor, typeColorSwatches } from './typeColors'

type GraphMenu = { kind: 'pane' | 'node' | 'edge'; id?: string; x: number; y: number; flowX?: number; flowY?: number } | null
type FbxMode = { kind: 'new'; typeId: string } | { kind: 'replace'; moduleId: string }
const edgeNames: Record<Edge, string> = { N: 'North (+Z)', E: 'East (+X)', S: 'South (-Z)', W: 'West (-X)' }
const relationEdgeTypes = { relation: RelationEdge }
const num = (value: string, fallback = 0) => value === '' ? fallback : Number(value)
const uniqueId = (existing: string[], prefix: string) => { let i = 1; while (existing.includes(`${prefix}_${i}`)) i++; return `${prefix}_${i}` }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const LIBRARY_DRAG = 'application/x-dungeon-library-model'
type LibraryInfo = Bounds | { error: string }
type PanelPhase = 'idle' | 'out' | 'in'
const footprint = (b: Bounds) => `${meters(b.maxX - b.minX)} × ${meters(b.maxY - b.minY)} × ${meters(b.maxZ - b.minZ)} m`

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{children}</label> }
function NumberField({ label, value, onChange, step = 1, min, max, suffix, validate, defaultValue }: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; suffix?: string; validate?: (n: number) => string | undefined; defaultValue?: number }) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState('')
  const editing = useRef(false)
  const cancelCommit = useRef(false)
  useEffect(() => { if (!editing.current) { setDraft(String(value)); setError('') } }, [value])
  const commit = () => {
    const raw = draft.trim()
    const parsed = Number(raw)
    const message = !raw || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(parsed) ? 'Enter a valid number'
      : min !== undefined && parsed < min ? `Must be at least ${min}`
        : max !== undefined && parsed > max ? `Must be at most ${max}`
          : Number.isInteger(step) && !Number.isInteger(parsed) ? 'Enter a whole number' : validate?.(parsed)
    if (message) { setError(message); return }
    setError('')
    setDraft(String(parsed))
    if (parsed !== value) onChange(parsed)
  }
  return <Field label={label}><div className="input-unit"><input className={defaultValue !== undefined && value === defaultValue && !editing.current && draft === String(defaultValue) ? 'default-value' : undefined} type="text" inputMode="decimal" aria-invalid={!!error} value={draft} onFocus={() => { editing.current = true }} onChange={e => { setDraft(e.target.value); setError('') }} onBlur={() => { editing.current = false; if (cancelCommit.current) { cancelCommit.current = false; setDraft(String(value)); setError('') } else commit() }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelCommit.current = true; e.currentTarget.blur() } }} />{suffix && <small>{suffix}</small>}</div>{error && <small className="field-error" role="alert">{error}</small>}</Field>
}
const portTargets = (port: Port) => port.allowedTypeIds === null ? 'Any related type' : port.allowedTypeIds.length ? port.allowedTypeIds.join(', ') : 'No target types'
function PortFields({ port, module, project, onChange }: { port: Port; module: Module; project: RuntimeProject; onChange: (next: Port) => void }) {
  const [id, setId] = useState(port.id)
  const [x, setX] = useState(meters(port.x))
  const [y, setY] = useState(meters(port.y))
  const [z, setZ] = useState(meters(port.z))
  const [error, setError] = useState('')
  const cancelId = useRef(false)
  const xyz = useRef<HTMLDivElement>(null)
  const resetId = () => setId(port.id)
  const resetPosition = () => { setX(meters(port.x)); setY(meters(port.y)); setZ(meters(port.z)) }
  useEffect(resetId, [port.id])
  useEffect(resetPosition, [port.x, port.y, port.z])
  const commitId = () => {
    const nextId = id.trim()
    if (nextId === port.id) { resetId(); return }
    if (!isId(nextId) || module.ports.some(p => p.id === nextId && p !== port)) { setError('Enter a unique port ID.'); resetId(); return }
    setError(''); onChange({ ...port, id: nextId })
  }
  // X, Y and Z are one group: they are checked and saved together on Enter or when focus leaves the group.
  const positionDirty = x !== meters(port.x) || y !== meters(port.y) || z !== meters(port.z)
  const commitPosition = () => {
    if (!positionDirty) return
    if (![x, y, z].every(value => /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) { setError('Enter valid X, Y and Z coordinates.'); resetPosition(); return }
    const placement = portAtBoundary(module.bounds, toMm(Number(x)), toMm(Number(y)), toMm(Number(z)), project.settings.doorWidth, project.settings.doorHeight)
    if (!placement) { setError('The full connector rectangle must fit on a vertical side face.'); resetPosition(); return }
    setError('')
    if (placement.edge === port.edge && placement.x === port.x && placement.y === port.y && placement.z === port.z) resetPosition()
    else onChange({ ...port, ...placement })
  }
  const positionKeys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitPosition()
    if (e.key === 'Escape') { e.stopPropagation(); resetPosition(); setError('') }
  }
  const axis = (label: string, value: string, set: (value: string) => void) => <label><span>{label}</span><input inputMode="decimal" aria-label={`Local ${label} (m)`} value={value} onChange={e => { set(e.target.value); setError('') }} onKeyDown={positionKeys} /></label>
  return <>
    <Field label="Port ID"><input value={id} onChange={e => { setId(e.target.value); setError('') }} onBlur={() => { if (cancelId.current) { cancelId.current = false; resetId() } else commitId() }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.stopPropagation(); cancelId.current = true; e.currentTarget.blur() } }} /></Field>
    <div className="field"><span>Local position (m){positionDirty && <em className="xyz-pending"> · press Enter to apply</em>}</span><div ref={xyz} className={`xyz-input ${positionDirty ? 'editing' : ''}`} onBlur={e => { if (!xyz.current?.contains(e.relatedTarget as Node | null)) commitPosition() }}>{axis('X', x, setX)}{axis('Y', y, setY)}{axis('Z', z, setZ)}</div></div>
    {error && <small className="field-error" role="alert">{error}</small>}
    <div className="field"><span>Allowed target types</span><details className="type-multiselect"><summary>{portTargets(port)}</summary><div><button className="quiet" onClick={() => onChange({ ...port, allowedTypeIds: null })}>Any related type</button>{project.types.map(t => <label key={t.id}><input type="checkbox" checked={port.allowedTypeIds?.includes(t.id) ?? false} onChange={e => { const ids = e.target.checked ? [...(port.allowedTypeIds ?? []), t.id] : (port.allowedTypeIds ?? []).filter(id => id !== t.id); onChange({ ...port, allowedTypeIds: ids }) }} />{t.id}</label>)}</div></details></div><p className="hint">Both connected ports must accept the other module's type.</p>
  </>
}
function PortEditor({ port, module, project, onChange, onDuplicate, onDelete }: { port: Port; module: Module; project: RuntimeProject; onChange: (next: Port) => void; onDuplicate: () => void; onDelete: () => void }) {
  return <details className="port-editor"><summary className="port-editor-head"><strong>{port.id}</strong><span>{edgeNames[port.edge]}</span><span className="port-editor-summary">({port.x / 1000}, {port.y / 1000}, {port.z / 1000}) m · {portTargets(port)}</span><button className="quiet port-duplicate" aria-label={`Duplicate port ${port.id}`} onClick={e => { e.preventDefault(); onDuplicate() }}>Duplicate</button><button className="icon danger" aria-label={`Remove port ${port.id}`} onClick={e => { e.preventDefault(); onDelete() }}>×</button></summary><PortFields port={port} module={module} project={project} onChange={onChange} /></details>
}
function TypeIdInput({ type, project, onCommit }: { type: ModuleType; project: RuntimeProject; onCommit: (nextId: string) => void }) {
  const [draft, setDraft] = useState(type.id)
  const [error, setError] = useState('')
  useEffect(() => { setDraft(type.id); setError('') }, [type.id])
  const commit = () => { const next = draft.trim(); if (next === type.id) return; if (!isId(next) || project.types.some(t => t.id === next)) { setError('Type ID must be unique and start with a letter.'); return } setError(''); onCommit(next) }
  return <Field label="Type ID"><input value={draft} onChange={e => { setDraft(e.target.value); setError('') }} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />{error && <small className="field-error">{error}</small>}</Field>
}

export default function App() {
  const [project, setProject] = useState<RuntimeProject>(emptyProject)
  const [editor, setEditor] = useState<EditorState>(emptyEditor)
  const [files, setFiles] = useState<Map<string, File>>(new Map())
  const [hydrated, setHydrated] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'Saving' | 'Saved' | 'Save failed'>('Saved')
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const saveVersion = useRef(0)
  const [activeRelationKey, setActiveRelationKey] = useState('')
  const [graphMenu, setGraphMenu] = useState<GraphMenu>(null)
  const [connectSource, setConnectSource] = useState('')
  const [pointer, setPointer] = useState({ x: 0, y: 0 })
  const [createPosition, setCreatePosition] = useState<{ x: number; y: number } | null>(null)
  const graphRef = useRef<HTMLDivElement>(null)
  const pressRef = useRef<{ timer: number; x: number; y: number } | null>(null)
  const fbxMode = useRef<FbxMode | null>(null)
  const [focusType, setFocusType] = useState('')
  const [pendingNodeFocus, setPendingNodeFocus] = useState('')
  const flowRef = useRef<ReactFlowInstance | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const [selectedModule, setSelectedModule] = useState('')
  const [newTypeId, setNewTypeId] = useState('')
  const [seed, setSeed] = useState(1)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const noticeIsError = /failed|error|invalid|resolve|enter a|shorter|thinner|already exists|no complete|10-second|stopped/i.test(notice)
  const workerRef = useRef<Worker | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const jsonInput = useRef<HTMLInputElement>(null)
  const fbxInput = useRef<HTMLInputElement>(null)
  const libraryFilesInput = useRef<HTMLInputElement>(null)
  const libraryFolderInput = useRef<HTMLInputElement>(null)
  // Unassigned FBX files keyed by file name; the module ID defaults to the name without .fbx and can be edited (editor.libraryIds) before assigning.
  const [library, setLibrary] = useState<Map<string, File>>(new Map())
  const [libraryInfo, setLibraryInfo] = useState<Map<string, LibraryInfo>>(new Map())
  const parsing = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    loadDraft().then(saved => { if (!cancelled && saved) { setProject(saved.project); setEditor(saved.editor); setFiles(saved.files); setLibrary(saved.library); setSeed(saved.editor.seed); setNotice('Local draft restored') } }).catch(error => { if (!cancelled) { setSaveStatus('Save failed'); setNotice(`Autosave failed: ${errorText(error)}`) } }).finally(() => { if (!cancelled) setHydrated(true) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!hydrated) return
    setSaveStatus('Saving')
    const snapshot = { project, editor, files, library }
    const version = ++saveVersion.current
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => saveDraft(snapshot)).then(() => { if (version === saveVersion.current) setSaveStatus('Saved') }).catch(error => { if (version === saveVersion.current) { setSaveStatus('Save failed'); setNotice(`Autosave failed: ${errorText(error)}. Use Save ZIP for a backup.`) } })
  }, [project, editor, files, library, hydrated])
  useEffect(() => {
    for (const [name, file] of library) {
      if (libraryInfo.has(name) || parsing.current.has(name)) continue
      parsing.current.add(name)
      importFbx(file).then((bounds): LibraryInfo => bounds, (error): LibraryInfo => ({ error: errorText(error) })).then(info => {
        parsing.current.delete(name)
        setLibraryInfo(current => new Map(current).set(name, info))
      })
    }
  }, [library, libraryInfo])
  useEffect(() => { if (hydrated && editor.seed !== seed) setEditor(current => ({ ...current, seed })) }, [seed, hydrated])

  const errors = useMemo(() => validateProject(project), [project])
  const targets = useMemo(() => typeTargets(project), [project])
  const stopWorker = useCallback(() => { workerRef.current?.terminate(); workerRef.current = null; if (timeoutRef.current) window.clearTimeout(timeoutRef.current); timeoutRef.current = null; setGenerating(false) }, [])
  const mutate = useCallback((change: (draft: RuntimeProject) => void) => { stopWorker(); setProject(current => { const next = structuredClone(current); change(next); return next }); setPreview(null) }, [stopWorker])
  const updateType = (id: string, change: (type: ModuleType) => void) => mutate(draft => { const target = draft.types.find(t => t.id === id); if (target) change(target) })
  const setTypeColor = (id: string, color: string) => setProject(current => {
    const type = current.types.find(value => value.id === id)
    if (!type || type.color === color) return current
    const next = structuredClone(current)
    next.types.find(value => value.id === id)!.color = color
    return next
  })
  const updateModule = (id: string, change: (module: Module) => void) => mutate(draft => { const target = draft.modules.find(m => m.id === id); if (target) change(target) })
  useEffect(() => () => { workerRef.current?.terminate(); if (timeoutRef.current) window.clearTimeout(timeoutRef.current) }, [])
  useEffect(() => { if (workerRef.current) stopWorker() }, [project, stopWorker])
  useEffect(() => {
    if (!notice || noticeIsError || notice.startsWith('Generating preview')) return
    const timer = window.setTimeout(() => setNotice(''), 3800)
    return () => window.clearTimeout(timer)
  }, [notice, noticeIsError])
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false) }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown) }
  }, [menuOpen])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if (!graphMenu && !connectSource && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName)) closePanel(); setGraphMenu(null); setConnectSource('') }
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes((event.target as HTMLElement)?.tagName)) return
      if (graphRef.current?.contains(document.activeElement) && event.key === 'Enter' && focusType) { event.preventDefault(); openType(focusType) }
      if (graphRef.current?.contains(document.activeElement) && (event.key === 'Delete' || event.key === 'Backspace') && focusType) { event.preventDefault(); removeType(focusType) }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })
  // The inspector renders `shownPanel`, which trails `editor.panel` when switching between items so the old view can fade out before the new one fades in.
  const [shownPanel, setShownPanel] = useState<PanelRef | null>(editor.panel)
  const [panelPhase, setPanelPhase] = useState<PanelPhase>('idle')
  const panelTimers = useRef<number[]>([])
  const panelKey = editor.panel ? `${editor.panel.kind}:${editor.panel.id}` : ''
  const panelExists = (ref: PanelRef) => ref.kind === 'create-type' || (ref.kind === 'type' ? project.types : project.modules).some(item => item.id === ref.id)
  useEffect(() => {
    panelTimers.current.forEach(timer => window.clearTimeout(timer)); panelTimers.current = []
    const next = editor.panel
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    // Opening, closing, renames (the shown item no longer exists) and reduced motion switch at once.
    if (!next || !shownPanel || (shownPanel.kind === next.kind && shownPanel.id === next.id) || !panelExists(shownPanel) || reduceMotion) { setShownPanel(next); setPanelPhase('idle'); return }
    setPanelPhase('out')
    panelTimers.current.push(window.setTimeout(() => { setShownPanel(next); setPanelPhase('in') }, 120), window.setTimeout(() => setPanelPhase('idle'), 120 + 220))
  }, [panelKey])
  useEffect(() => () => panelTimers.current.forEach(timer => window.clearTimeout(timer)), [])
  // Every detail view opens in the one inspector panel; opening another replaces it.
  const openPanel = (kind: PanelRef['kind'], id: string) => { setEditor(current => ({ ...current, panel: { kind, id } })); setGraphMenu(null) }
  const closePanel = () => setEditor(current => current.panel ? { ...current, panel: null } : current)
  const closePanelFor = (kind: PanelRef['kind'], id: string) => setEditor(current => current.panel?.kind === kind && current.panel.id === id ? { ...current, panel: null } : current)
  const openType = (id: string) => { setFocusType(id); setActiveRelationKey(''); openPanel('type', id) }
  const openModule = (id: string) => { setSelectedModule(id); const owner = project.modules.find(m => m.id === id); if (owner) setFocusType(owner.typeId); openPanel('module', id) }
  const openRelation = (key: string) => { const target = project.connections.find(c => relationKey(c.from, c.to) === key); if (!target) return; openType(target.from); setActiveRelationKey(key) }
  const showMenu = (kind: 'pane' | 'node' | 'edge', x: number, y: number, id?: string) => {
    const point = flowRef.current?.screenToFlowPosition({ x, y })
    setGraphMenu({ kind, id, x: Math.min(x, window.innerWidth - 190), y: Math.min(y, window.innerHeight - 150), flowX: point?.x, flowY: point?.y })
  }
  const load = (next: RuntimeProject, nextEditor = emptyEditor(), nextFiles = new Map<string, File>(), nextLibrary = new Map<string, File>()) => {
    stopWorker(); setProject(next); setEditor(nextEditor); setSeed(nextEditor.seed); setFiles(nextFiles); setLibrary(nextLibrary); setLibraryInfo(new Map()); setPreview(null); setSelectedModule(next.modules[0]?.id ?? ''); setFocusType(''); setGraphMenu(null); setConnectSource(''); setNotice('Project opened')
  }
  const addType = () => {
    const id = newTypeId.trim()
    if (!isId(id) || project.types.some(t => t.id === id)) { setNotice('Enter a unique type ID. Start with a letter; use letters, numbers, _ or -.'); return }
    const color = nextTypeColor(project.types.map(type => type.color))
    mutate(draft => { draft.types.push({ id, color, percent: 0, requiredMin: 0 }); if (!draft.settings.startTypeId) draft.settings.startTypeId = id })
    if (createPosition) setEditor(current => ({ ...current, graphPositions: { ...current.graphPositions, [id]: createPosition } }))
    openType(id); setPendingNodeFocus(id); setNewTypeId(''); setCreatePosition(null)
  }
  useEffect(() => {
    if (!pendingNodeFocus) return
    let frame = 0
    let attempts = 0
    const focus = () => {
      const flow = flowRef.current
      const node = flow?.getNode(pendingNodeFocus)
      if (node?.measured?.width) {
        void flow?.fitView({ nodes: [{ id: pendingNodeFocus }], padding: .4, maxZoom: 1, duration: 260 })
        setPendingNodeFocus('')
      } else if (attempts++ < 30) frame = window.requestAnimationFrame(focus)
      else setPendingNodeFocus('')
    }
    frame = window.requestAnimationFrame(focus)
    return () => window.cancelAnimationFrame(frame)
  }, [pendingNodeFocus])
  const removeType = (id: string) => {
    const moduleCount = project.modules.filter(m => m.typeId === id).length
    const relationCount = project.connections.filter(c => c.from === id || c.to === id).length
    if (!window.confirm(`Delete type ${id}, ${moduleCount} modules and ${relationCount} connections?`)) return
    const removedModuleIds = new Set(project.modules.filter(m => m.typeId === id).map(m => m.id))
    mutate(draft => { draft.types = draft.types.filter(t => t.id !== id); draft.modules = draft.modules.filter(m => m.typeId !== id); draft.connections = draft.connections.filter(c => c.from !== id && c.to !== id); draft.modules.forEach(m => m.ports.forEach(p => { if (p.allowedTypeIds) p.allowedTypeIds = p.allowedTypeIds.filter(value => value !== id) })); if (draft.settings.startTypeId === id) draft.settings.startTypeId = '' })
    setFiles(current => new Map([...current].filter(([moduleId]) => !removedModuleIds.has(moduleId))))
    setEditor(current => {
      const graphPositions = { ...current.graphPositions }, modelNames = { ...current.modelNames }
      delete graphPositions[id]
      removedModuleIds.forEach(moduleId => { delete modelNames[moduleId] })
      const panel = current.panel && ((current.panel.kind === 'type' && current.panel.id === id) || (current.panel.kind === 'module' && removedModuleIds.has(current.panel.id))) ? null : current.panel
      return { ...current, graphPositions, modelNames, panel }
    })
    setSelectedModule(project.modules.find(m => m.typeId !== id)?.id ?? '')
    setFocusType(''); setGraphMenu(null); setConnectSource('')
  }
  const commitTypeId = (oldId: string, nextId: string) => {
    const changed = renameType(project, editor, oldId, nextId)
    stopWorker()
    setProject(changed.project); setEditor(changed.editor); setPreview(null)
    setFocusType(nextId); setActiveRelationKey('')
  }
  // The module ID comes from the file name unless the Models library supplies an edited one. Returns whether the import succeeded.
  const importModuleFile = async (file: File, mode: FbxMode, requestedId?: string, knownBounds?: Bounds): Promise<boolean> => {
    const id = requestedId ?? fbxStem(file.name)
    const renameHint = requestedId === undefined ? 'Rename the FBX file' : 'Edit its ID in Models'
    if (!isFbxName(file.name) || !isId(id)) { setNotice(`Import failed: ${id} is not a valid module ID. ${renameHint} (start with a letter; use letters, numbers, _ or -).`); return false }
    const oldId = mode.kind === 'replace' ? mode.moduleId : ''
    if (project.modules.some(m => m.id === id && m.id !== oldId)) { setNotice(`Import failed: Module ID ${id} already exists. ${renameHint}.`); return false }
    try {
      const bounds = knownBounds ?? await importFbx(file)
      if (mode.kind === 'new') {
        mutate(draft => draft.modules.push({ id, typeId: mode.typeId, bounds, ports: [] }))
      } else {
        const old = project.modules.find(m => m.id === oldId)
        if (!old) throw new Error('Module no longer exists')
        mutate(draft => {
          const target = draft.modules.find(m => m.id === oldId)!
          target.ports = remapPorts(target.ports, target.bounds, bounds, draft.settings.doorWidth, draft.settings.doorHeight)
          target.bounds = bounds
          target.id = id
        })
      }
      setFiles(current => { const next = new Map(current); if (oldId) next.delete(oldId); next.set(id, file); return next })
      setEditor(current => { const modelNames = { ...current.modelNames }; if (oldId) delete modelNames[oldId]; modelNames[id] = file.name; return { ...current, modelNames } })
      openModule(id); setNotice(bounds.maxY - bounds.minY < project.settings.doorHeight ? `Imported ${file.name}. The model is thinner than the connector height; open Advanced bounds to add usable height before placing connectors.` : `Imported ${file.name} as ${id}. Check bounds and ports.`)
      return true
    } catch (error) { setNotice(`Import failed: ${errorText(error)}`); return false }
  }
  const chooseFbx = (mode: FbxMode) => { fbxMode.current = mode; fbxInput.current?.click() }
  const dropFbx = (event: React.DragEvent<HTMLElement>, mode: FbxMode) => {
    event.preventDefault()
    const name = event.dataTransfer.getData(LIBRARY_DRAG)
    if (name) { void assignFromLibrary(name, mode); return }
    const file = event.dataTransfer.files[0]
    if (file) void importModuleFile(file, mode)
  }
  const addToLibrary = (incoming: File[]) => {
    const models = incoming.filter(file => isFbxName(file.name)), skipped = incoming.length - models.length
    if (!models.length) { setNotice(skipped ? 'Import failed: no .fbx files found.' : 'No files selected'); return }
    setLibrary(current => { const next = new Map(current); models.forEach(file => next.set(file.name, file)); return next })
    setLibraryInfo(current => { const next = new Map(current); models.forEach(file => next.delete(file.name)); return next })
    setNotice(`Added ${models.length} model${models.length === 1 ? '' : 's'} to Models${skipped ? ` · skipped ${skipped} non-FBX file${skipped === 1 ? '' : 's'}` : ''}`)
  }
  const removeFromLibrary = (name: string) => {
    setLibrary(current => { const next = new Map(current); next.delete(name); return next })
    setLibraryInfo(current => { const next = new Map(current); next.delete(name); return next })
    setEditor(current => { if (!(name in current.libraryIds)) return current; const libraryIds = { ...current.libraryIds }; delete libraryIds[name]; return { ...current, libraryIds } })
  }
  const libraryId = (name: string) => editor.libraryIds[name] ?? fbxStem(name)
  const assignFromLibrary = async (name: string, mode: FbxMode) => {
    const file = library.get(name), info = libraryInfo.get(name)
    if (!file) return
    if (info && 'error' in info) { setNotice(`Import failed: ${info.error}`); return }
    if (await importModuleFile(file, mode, libraryId(name), info)) removeFromLibrary(name)
  }
  const removeModule = (id: string) => {
    if (!window.confirm(`Delete module ${id}?`)) return
    mutate(draft => { draft.modules = draft.modules.filter(m => m.id !== id) })
    setFiles(current => { const next = new Map(current); next.delete(id); return next })
    setEditor(current => { const modelNames = { ...current.modelNames }; delete modelNames[id]; return { ...current, modelNames } })
    setSelectedModule(project.modules.find(m => m.id !== id)?.id ?? '')
    closePanelFor('module', id)
  }
  const addConnection = (a: string, b: string) => {
    if (!a || !b) return
    if (b === project.settings.startTypeId) { setNotice('Connections cannot point to the start type'); return }
    if (project.connections.some(c => c.from === a && c.to === b)) { setNotice('This connection already exists'); return }
    mutate(draft => draft.connections.push({ from: a, to: b, weight: 1 }))
  }
  const neighbors = new Set([focusType, ...project.connections.filter(c => c.from === focusType).map(c => c.to)])
  const graphColumns = Math.max(2, Math.ceil(Math.sqrt(project.types.length)))
  const graphNodes: FlowNode[] = project.types.map((t, i) => ({ id: t.id, measured: { width: 370, height: project.modules.filter(m => m.typeId === t.id).length > 1 ? 320 : 220 }, position: editor.graphPositions[t.id] ?? { x: (i % graphColumns) * 470, y: Math.floor(i / graphColumns) * 480 }, data: { label: <div className="graph-node-content" onDoubleClick={e => { e.stopPropagation(); openType(t.id) }}><div className="graph-node-title"><strong>{t.id}</strong><button className="node-more nodrag nopan" aria-label={`Actions for ${t.id}`} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); showMenu('node', rect.right, rect.bottom, t.id) }}>⋯</button></div><span>{t.id === project.settings.startTypeId ? 'Start · 1 module' : `${t.percent}% · ${targets[t.id] ?? 0} target`}</span><div className="node-modules nowheel nodrag nopan" onPointerDown={e => e.stopPropagation()}>{project.modules.filter(m => m.typeId === t.id).map(m => <button key={m.id} className="slot-button nodrag nopan" onClick={e => { e.stopPropagation(); openModule(m.id) }} onDoubleClick={e => e.stopPropagation()}><ModuleSlot module={m} selected={selectedModule === m.id} /></button>)}<button type="button" className="slot-add nodrag nopan" onClick={e => { e.stopPropagation(); chooseFbx({ kind: 'new', typeId: t.id }) }} onDragOver={e => { e.preventDefault(); e.stopPropagation() }} onDrop={e => { e.preventDefault(); e.stopPropagation(); dropFbx(e, { kind: 'new', typeId: t.id }) }}><strong>+ Add module</strong><small>Choose FBX or drop from Models</small></button></div></div> }, className: focusType && !neighbors.has(t.id) ? 'graph-node-dim' : 'graph-node', style: { backgroundColor: '#1a2b33', backgroundImage: t.id === project.settings.startTypeId ? 'repeating-linear-gradient(135deg, #e8f4f21b 0 14px, transparent 14px 34px)' : undefined, color: '#f4f8f6', border: `2px solid ${t.color}`, borderRadius: 2, padding: 13, width: 370, height: project.modules.filter(m => m.typeId === t.id).length > 1 ? 320 : 220 }, selected: focusType === t.id }))
  const graphEdges: FlowEdge[] = project.connections.map(c => ({ id: relationKey(c.from, c.to), source: c.from, target: c.to, type: 'relation', data: { weight: c.weight, reverse: project.connections.some(other => other.from === c.to && other.to === c.from) }, selected: activeRelationKey === relationKey(c.from, c.to), style: { stroke: '#b8d9d7', opacity: focusType && c.from !== focusType ? .62 : 1 } }))
  const arrange = () => {
    const positions: Record<string, { x: number; y: number }> = {}
    let y = 0
    for (let start = 0; start < project.types.length; start += graphColumns) {
      const row = project.types.slice(start, start + graphColumns)
      let x = 0
      let rowHeight = 0
      for (const t of row) {
        const measured = flowRef.current?.getNode(t.id)?.measured
        positions[t.id] = { x, y }
        x += (measured?.width ?? 370) + 90
        rowHeight = Math.max(rowHeight, measured?.height ?? 340)
      }
      y += rowHeight + 110
    }
    setEditor(current => ({ ...current, graphPositions: positions }))
    window.requestAnimationFrame(() => flowRef.current?.fitView({ padding: .24, duration: 260 }))
  }
  const setBounds = (id: string, key: keyof Bounds, value: number) => {
    updateModule(id, m => {
      m.bounds[key] = toMm(value)
      const b = m.bounds, half = project.settings.doorWidth / 2, halfHeight = project.settings.doorHeight / 2
      for (const p of m.ports) {
        if (p.edge === 'N' || p.edge === 'S') { p.z = p.edge === 'N' ? b.maxZ : b.minZ; p.x = Math.round(Math.max(b.minX + half, Math.min(b.maxX - half, p.x))) }
        else { p.x = p.edge === 'E' ? b.maxX : b.minX; p.z = Math.round(Math.max(b.minZ + half, Math.min(b.maxZ - half, p.z))) }
        p.y = Math.round(Math.max(b.minY + halfHeight, Math.min(b.maxY - halfHeight, p.y)))
      }
    })
  }
  const startPreview = () => {
    if (errors.length) { setNotice('Resolve validation errors first'); return }
    stopWorker(); setPreview(null); setGenerating(true); setNotice('Generating preview…')
    const worker = new Worker(new URL('./generator.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    let latest: PreviewResult | null = null
    worker.onmessage = event => {
      if (workerRef.current !== worker) return
      const message = event.data as { kind: string; result?: PreviewResult; message?: string }
      if (message.kind === 'progress' && message.result) { latest = message.result; setPreview(latest) }
      if (message.kind === 'done' && message.result) { setPreview(message.result); setNotice(message.result.complete ? 'All targets met' : 'No complete map found. Showing the best result.'); stopWorker() }
      if (message.kind === 'error') { setNotice(message.message ?? 'Generation failed'); stopWorker() }
    }
    worker.onerror = event => { if (workerRef.current !== worker) return; setNotice(event.message || 'Preview worker failed'); stopWorker() }
    worker.postMessage({ project, seed: seed >>> 0 })
    timeoutRef.current = window.setTimeout(() => { if (workerRef.current !== worker) return; setPreview(latest); setNotice('Search reached the 10-second limit. Showing the best result.'); stopWorker() }, 10000)
  }
  useEffect(() => { if (hydrated && project.types.length && !errors.length) startPreview() }, [hydrated])
  const exportJson = () => {
    if (errors.length) { setNotice('Resolve validation errors first'); return }
    if (!preview?.complete && !window.confirm('The rules have not produced a complete preview. Export runtime JSON anyway?')) return
    downloadJson(project); setNotice('Runtime JSON exported')
  }
  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>, kind: 'project' | 'json') => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
    try {
      if (kind === 'project') { const saved = await openProject(file); load(saved.project, saved.editor, saved.files, saved.library) }
      else if (kind === 'json') load(await readJson(file))
    } catch (error) { setNotice(`Import failed: ${errorText(error)}`) }
  }
  const clearLongPress = () => { if (pressRef.current) { window.clearTimeout(pressRef.current.timer); pressRef.current = null } }
  const previewNode = connectSource ? flowRef.current?.getNode(connectSource) : undefined
  const graphRect = graphRef.current?.getBoundingClientRect()
  const previewPoint = previewNode && graphRect ? flowRef.current?.flowToScreenPosition({ x: previewNode.position.x + (previewNode.measured?.width ?? 370) / 2, y: previewNode.position.y + (previewNode.measured?.height ?? 340) / 2 }) : null

  // Closing is immediate, and a renamed or removed item falls back to the current panel so the card never blanks for a frame.
  const panel = !editor.panel ? null : shownPanel && panelExists(shownPanel) ? shownPanel : editor.panel
  const panelType = panel?.kind === 'type' ? project.types.find(value => value.id === panel.id) : undefined
  const panelModule = panel?.kind === 'module' ? project.modules.find(value => value.id === panel.id) : undefined
  const panelOpen = panel?.kind === 'create-type' || !!panelType || !!panelModule
  return <div className={`app-shell ${panelOpen ? 'inspector-open' : ''}`}>
    <header className="topbar"><div className="file-menu" ref={menuRef}>
      <button className="menu-trigger" aria-label="File menu" title="File menu" aria-expanded={menuOpen} aria-controls="file-menu-panel" onClick={() => setMenuOpen(open => !open)}><span aria-hidden="true">{menuOpen ? '×' : '☰'}</span></button>
      {menuOpen && <div id="file-menu-panel" className="menu-panel"><button onClick={() => { setMenuOpen(false); if (window.confirm('Create a new project and clear the local draft? Save ZIP first if you need a backup.')) { void saveQueue.current.then(() => clearDraft()).then(() => load(emptyProject())).catch(error => setNotice(`New project failed: ${errorText(error)}`)) } }}>New project</button><button onClick={() => { setMenuOpen(false); if (!project.types.length || window.confirm('Replace the current project with the example?')) load(exampleProject()) }}>Load example</button><button onClick={() => { setMenuOpen(false); projectInput.current?.click() }}>Open ZIP</button><button onClick={() => { setMenuOpen(false); jsonInput.current?.click() }}>Import JSON</button><button onClick={() => { setMenuOpen(false); saveProject(project, editor, files, library).then(() => setNotice('Project ZIP saved')).catch(e => setNotice(errorText(e))) }}>Save ZIP</button><button onClick={() => { setMenuOpen(false); exportJson() }}>Export JSON</button><div className="menu-meta">{project.types.length} types · {project.modules.length} modules · {library.size} in Models<br />Format v4 · 1 unit = 1 m<br />Files stay in this browser</div></div>}
    </div><span className={`save-indicator ${saveStatus === 'Save failed' ? 'failed' : ''}`} role="status">{saveStatus}</span><input hidden type="file" accept=".zip" ref={projectInput} onChange={e => handleFile(e, 'project')} /><input hidden type="file" accept=".json" ref={jsonInput} onChange={e => handleFile(e, 'json')} /><input hidden type="file" accept=".fbx" ref={fbxInput} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file && fbxMode.current) void importModuleFile(file, fbxMode.current) }} /><input hidden type="file" accept=".fbx" multiple ref={libraryFilesInput} onChange={e => { const picked = Array.from(e.target.files ?? []); e.target.value = ''; if (picked.length) addToLibrary(picked) }} /><input hidden type="file" multiple ref={libraryFolderInput} {...{ webkitdirectory: '' }} onChange={e => { const picked = Array.from(e.target.files ?? []); e.target.value = ''; if (picked.length) addToLibrary(picked) }} /></header>
    {notice && <div role={noticeIsError ? 'alert' : 'status'} className={`notice ${noticeIsError ? 'notice-error' : 'notice-success'}`}><span>{notice}</span><button aria-label="Dismiss notification" title="Dismiss" onClick={() => setNotice('')}>×</button></div>}
    <main className="editor-workspace">
      <div className="main-column">
      <section className="editor-panel rules-panel" aria-label="Rule network">
        <div className="panel-heading"><div><span className="eyebrow">01</span><h1>Rule network</h1></div></div>
        <div className="map-settings row four"><NumberField label="Modules after start" value={project.settings.modulesAfterStart} min={1} max={500} onChange={n => mutate(d => { d.settings.modulesAfterStart = n })} /><Field label="Start type"><select value={project.settings.startTypeId} onChange={e => { const nextId = e.target.value; mutate(d => { const oldStart = d.types.find(t => t.id === d.settings.startTypeId); const newStart = d.types.find(t => t.id === nextId); if (oldStart && newStart && oldStart !== newStart) { oldStart.percent = newStart.percent; newStart.percent = 0; newStart.requiredMin = 0 } d.settings.startTypeId = nextId }) }}><option value="">Select type</option>{project.types.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}</select></Field><NumberField label="Connector width" value={project.settings.doorWidth / 1000} min={0.001} step={0.001} suffix="m" onChange={n => mutate(d => { d.settings.doorWidth = toMm(n) })} /><NumberField label="Connector height" value={project.settings.doorHeight / 1000} min={0.001} step={0.001} suffix="m" onChange={n => mutate(d => { d.settings.doorHeight = toMm(n) })} /></div>
        <div className="graph-head"><span>Type connections</span><span>Right-click for actions · double-click a type to edit</span></div>
        <div className="graph" ref={graphRef} tabIndex={0} aria-label="Type connection graph" onPointerMove={e => { if (connectSource) setPointer({ x: e.clientX, y: e.clientY }); if (pressRef.current && Math.hypot(e.clientX - pressRef.current.x, e.clientY - pressRef.current.y) > 8) clearLongPress() }} onPointerUp={clearLongPress} onPointerCancel={clearLongPress} onPointerDownCapture={e => { if (e.pointerType !== 'touch') return; const x = e.clientX, y = e.clientY; const target = e.target as HTMLElement; const node = target.closest('.react-flow__node') as HTMLElement | null; const edge = target.closest('.react-flow__edge') as HTMLElement | null; clearLongPress(); pressRef.current = { x, y, timer: window.setTimeout(() => { showMenu(node ? 'node' : edge ? 'edge' : 'pane', x, y, node?.dataset.id ?? edge?.dataset.id); pressRef.current = null }, 500) } }}>
          <button className="graph-more" aria-label="Graph actions" title="Graph actions" onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); showMenu('pane', rect.right, rect.bottom) }}>⋯</button>
          <ReactFlow nodes={graphNodes} edges={graphEdges} edgeTypes={relationEdgeTypes} fitView fitViewOptions={{ padding: .24 }} minZoom={0.3} maxZoom={2} nodesConnectable={false} zoomOnDoubleClick={false} onInit={instance => { flowRef.current = instance }} onNodeClick={(_, node) => { setGraphMenu(null); if (connectSource) { addConnection(connectSource, node.id); setConnectSource(''); setFocusType(connectSource); return } setFocusType(node.id) }} onNodeDoubleClick={(_, node) => { if (!connectSource) openType(node.id) }} onNodeContextMenu={(event, node) => { event.preventDefault(); setFocusType(node.id); showMenu('node', event.clientX, event.clientY, node.id) }} onEdgeClick={(_, edge) => { if (!connectSource) openRelation(edge.id) }} onEdgeContextMenu={(event, edge) => { event.preventDefault(); showMenu('edge', event.clientX, event.clientY, edge.id) }} onPaneClick={() => { setGraphMenu(null); setConnectSource(''); setFocusType('') }} onPaneContextMenu={event => { event.preventDefault(); showMenu('pane', event.clientX, event.clientY) }} onNodesChange={changes => { const moved: Record<string, { x: number; y: number }> = {}; for (const change of changes) if (change.type === 'position' && change.position) moved[change.id] = change.position; if (Object.keys(moved).length) setEditor(current => ({ ...current, graphPositions: { ...current.graphPositions, ...moved } })) }}><Background color="#415962" gap={24} size={1} /><Controls /></ReactFlow>
          {connectSource && previewPoint && graphRect && <svg className="connection-preview" aria-hidden="true"><line x1={previewPoint.x - graphRect.left} y1={previewPoint.y - graphRect.top} x2={pointer.x - graphRect.left} y2={pointer.y - graphRect.top} /></svg>}
          {connectSource && <div className="connect-hint">Select a target node · Esc to cancel</div>}
        </div>
        <div className="targets-block"><div className="section-head"><h2>Map composition</h2><span className={Math.abs(project.types.filter(t => t.id !== project.settings.startTypeId).reduce((n, t) => n + t.percent, 0) - 100) < 0.000001 ? 'badge good' : 'badge warn'}>{project.types.filter(t => t.id !== project.settings.startTypeId).reduce((n, t) => n + t.percent, 0)}% / 100%</span></div>{project.types.length ? <div className="target-list">{project.types.map(t => <button key={t.id} className={focusType === t.id ? 'target-chip active' : 'target-chip'} onClick={() => openType(t.id)}><i style={{ background: t.color }} /><span>{t.id}</span><strong>{t.id === project.settings.startTypeId ? 'Start' : `${t.percent}%`}</strong><small>{targets[t.id] ?? 0} / {t.id === project.settings.startTypeId ? 1 : project.settings.modulesAfterStart}</small></button>)}</div> : <p className="empty">Add a type to begin defining your map.</p>}</div>
        {errors.length > 0 && <Validation errors={errors} />}
      </section>
      <section className="editor-panel models-panel" aria-label="Models" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={e => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); void collectFbxFiles(e.dataTransfer).then(addToLibrary).catch(error => setNotice(`Import failed: ${errorText(error)}`)) }}>
        <div className="panel-heading"><div><span className="eyebrow">02</span><h2>Models</h2></div><div className="panel-actions"><button onClick={() => libraryFolderInput.current?.click()}>Upload folder</button><button onClick={() => libraryFilesInput.current?.click()}>Add FBX files</button></div></div>
        <p className="hint">Drop a folder or FBX files here. Each model waits here until you assign it to a type: pick a type and press Assign, or drag the row onto a type's “+ Add module” slot.</p>
        {library.size ? <div className="library-list">{[...library.keys()].map(name => <LibraryRow key={name} name={name} id={libraryId(name)} info={libraryInfo.get(name)} project={project} onIdChange={next => setEditor(current => ({ ...current, libraryIds: { ...current.libraryIds, [name]: next } }))} onAssign={typeId => void assignFromLibrary(name, { kind: 'new', typeId })} onRemove={() => removeFromLibrary(name)} />)}</div> : <div className="library-empty">No unassigned models</div>}
      </section>
      </div>
      <div className="preview-column">
        <section className="editor-panel preview-panel"><div className="panel-heading"><div><span className="eyebrow">03</span><h2>Map preview</h2></div>{preview && <span className={preview.complete ? 'badge good' : 'badge warn'}>{preview.complete ? 'Complete' : 'Partial'}</span>}</div><div className="preview-stage">{preview?.placements.length ? <ThreeCanvas project={project} result={preview} doorWidth={project.settings.doorWidth} doorHeight={project.settings.doorHeight} /> : <div className="placeholder"><span>◇</span><h2>No preview yet</h2><p>Set up types, modules and connections, then generate a map.</p></div>}</div></section>
        <section className="editor-panel results-panel"><div className="panel-heading"><div><span className="eyebrow">04</span><h2>Generation</h2></div></div><div className="preview-controls"><Field label="Seed"><input type="number" min="0" max="4294967295" value={seed} onChange={e => setSeed(num(e.target.value) >>> 0)} /></Field><button className="quiet" onClick={() => setSeed(Math.floor(Math.random() * 4294967295))}>New seed</button><button className="primary" disabled={generating || !!errors.length} onClick={startPreview}>{generating ? 'Generating…' : 'Generate'}</button>{generating && <button onClick={() => { stopWorker(); setNotice('Search stopped') }}>Stop</button>}</div>{preview ? <><div className={`result-status ${preview.complete ? 'success' : 'warning'}`}>{preview.complete ? '✓ All targets met' : '⚠ Best partial result'}</div><div className="stats"><div><span>Placed</span><strong>{preview.placements.length} / {project.settings.modulesAfterStart + 1}</strong></div><div><span>Candidates checked</span><strong>{preview.checks.toLocaleString()}</strong></div><div><span>Restarts</span><strong>{preview.restarts}</strong></div></div><h3>Type counts</h3>{project.types.map(t => <div className="quota-line" key={t.id}><span><i style={{ background: t.color }} />{t.id}</span><b>{preview.placements.filter(p => p.typeId === t.id).length} / {preview.targets[t.id] ?? 0}</b></div>)}{preview.warnings.length > 0 && <><h3>Warnings</h3><ul className="warnings">{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></>}</> : <p className="empty">Generate a map to see counts and warnings.</p>}</section>
      </div>
    </main>
    {graphMenu && <><div className="context-dismiss" onPointerDown={() => setGraphMenu(null)} /><div className="graph-context-menu" role="menu" style={{ left: graphMenu.x, top: graphMenu.y }}>
      {graphMenu.kind === 'pane' && <><button role="menuitem" onClick={() => { setFocusType(''); setActiveRelationKey(''); setCreatePosition(graphMenu.flowX === undefined ? null : { x: graphMenu.flowX, y: graphMenu.flowY ?? 0 }); setNewTypeId(''); openPanel('create-type', 'new') }}>New type</button><button role="menuitem" onClick={() => { arrange(); setGraphMenu(null) }}>Arrange</button></>}
      {graphMenu.kind === 'node' && <><button role="menuitem" onClick={() => openType(graphMenu.id!)}>Edit</button><button role="menuitem" onClick={() => { setConnectSource(graphMenu.id!); setPointer({ x: graphMenu.x, y: graphMenu.y }); setGraphMenu(null) }}>New connection</button><button role="menuitem" className="danger-text" onClick={() => removeType(graphMenu.id!)}>Delete type</button></>}
      {graphMenu.kind === 'edge' && <><button role="menuitem" onClick={() => openRelation(graphMenu.id!)}>Edit weights</button><button role="menuitem" className="danger-text" onClick={() => { mutate(d => { d.connections = d.connections.filter(c => relationKey(c.from, c.to) !== graphMenu.id) }); setGraphMenu(null); setActiveRelationKey('') }}>Delete connection</button></>}
    </div></>}
    {panel?.kind === 'create-type' && <InspectorPanel key="inspector" phase={panelPhase} kind="New type" title="" onClose={closePanel}>
        <Field label="Type ID"><input autoFocus placeholder="e.g. corridor" value={newTypeId} onChange={e => setNewTypeId(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addType() }} /></Field>
        <p className="hint">Start with a letter; use letters, numbers, _ or -. The ID is kept exactly as typed.</p>
        <button className="primary full-width" onClick={addType}>Create type</button>
      </InspectorPanel>}
    {panelType && (() => {
        const t = panelType
        const connections = project.connections.filter(c => c.from === t.id || c.to === t.id)
        const selectedRelation = connections.find(c => relationKey(c.from, c.to) === activeRelationKey)
        return <InspectorPanel key="inspector" phase={panelPhase} kind="Type" title={t.id} onClose={closePanel}>
          <div className="row two"><TypeIdInput type={t} project={project} onCommit={next => commitTypeId(t.id, next)} /><div className="field"><span>Color</span><div className="type-color-picker"><div className="color-swatches" role="group" aria-label="Preset type colors">{typeColorSwatches.map(color => <button key={color} type="button" className="color-swatch" style={{ backgroundColor: color }} aria-label={`Set type color ${color}`} aria-pressed={t.color.toLowerCase() === color} title={color} onClick={() => setTypeColor(t.id, color)} />)}</div><label className="custom-color"><span>Custom</span><input type="color" value={t.color} aria-label="Custom type color" onChange={e => setTypeColor(t.id, e.target.value)} /></label></div></div></div>
          {t.id === project.settings.startTypeId ? <p className="hint">Unique start type · one module per map. This type is outside the percentage allocation.</p> : <>
            <NumberField label="Share of map modules (%)" value={t.percent} min={0} max={100} step={0.1} suffix="%" onChange={n => updateType(t.id, value => { value.percent = n })} /><p className="hint">{targets[t.id] ?? 0} of {project.settings.modulesAfterStart} modules after start</p>
            <NumberField label="Required minimum" value={t.requiredMin} min={0} defaultValue={0} onChange={n => updateType(t.id, value => { value.requiredMin = n })} /><p className="hint">Included in the target above.</p>
          </>}
          <section className="subsection"><div className="section-head"><h3>Directed connections</h3><button className="quiet" onClick={() => { setConnectSource(t.id); closePanel() }}>New connection</button></div>
            {connections.map(c => <button className={activeRelationKey === relationKey(c.from, c.to) ? 'list-item selected' : 'list-item'} key={relationKey(c.from, c.to)} onClick={() => setActiveRelationKey(relationKey(c.from, c.to))}>{c.from} → {c.to}<small>Weight {c.weight}</small></button>)}
            {!connections.length && <p className="empty">No connections yet.</p>}
            {selectedRelation && <div className="relation-editor"><h3>{selectedRelation.from} → {selectedRelation.to}</h3><p className="hint">Allows a placed {selectedRelation.from} module to generate a {selectedRelation.to} module. Weight is relative to other legal candidates.</p><NumberField label="Relative weight" value={selectedRelation.weight} min={0.001} step={0.1} defaultValue={1} onChange={n => mutate(d => { const target = d.connections.find(c => relationKey(c.from, c.to) === activeRelationKey); if (target) target.weight = n })} /><button className="danger-text" onClick={() => { mutate(d => { d.connections = d.connections.filter(c => relationKey(c.from, c.to) !== activeRelationKey) }); setActiveRelationKey('') }}>Remove this direction</button></div>}
          </section>
        </InspectorPanel>
      })()}
    {panelModule && (() => {
      const m = panelModule
      const updatePort = (oldId: string, next: Port) => updateModule(m.id, draft => { const index = draft.ports.findIndex(p => p.id === oldId); if (index >= 0) draft.ports[index] = next })
      const removePort = (id: string) => updateModule(m.id, draft => { draft.ports = draft.ports.filter(p => p.id !== id) })
      // Copies a port's side, height and target types, one connector width along the same face where it fits.
      const duplicatePort = (id: string) => {
        const source = m.ports.find(p => p.id === id)
        if (!source) return undefined
        const nextId = uniqueId(m.ports.map(p => p.id), source.id), width = project.settings.doorWidth
        const alongX = source.edge === 'N' || source.edge === 'S'
        const placement = [width, -width].map(offset => portAtBoundary(m.bounds, source.x + (alongX ? offset : 0), source.y, source.z + (alongX ? 0 : offset), width, project.settings.doorHeight)).find(p => p?.edge === source.edge)
        updateModule(m.id, draft => { draft.ports.push({ ...source, ...(placement ?? {}), id: nextId, allowedTypeIds: source.allowedTypeIds && [...source.allowedTypeIds] }) })
        return nextId
      }
      return <InspectorPanel key="inspector" phase={panelPhase} kind="Module" title={m.id} onClose={closePanel}>
        <p className="hint">{editor.modelNames[m.id] ? `Model file: ${editor.modelNames[m.id]}` : 'No FBX loaded. Bounds remain editable.'}</p><div className="section-head"><h3>Model & footprint</h3><button className="danger-text" onClick={() => removeModule(m.id)}>Delete module</button></div>
        <div className="fbx-drop" onDragOver={e => e.preventDefault()} onDrop={e => dropFbx(e, { kind: 'replace', moduleId: m.id })}><strong>Replace model</strong><span className="hint">Drop an FBX or a Models row here. The module is renamed to the new model's ID and its ports are kept.</span><div className="fbx-drop-actions"><button onClick={() => chooseFbx({ kind: 'replace', moduleId: m.id })}>Choose FBX</button>{library.size > 0 && <select aria-label="Replace from Models" value="" onChange={e => { if (e.target.value) void assignFromLibrary(e.target.value, { kind: 'replace', moduleId: m.id }) }}><option value="">From Models…</option>{[...library.keys()].map(name => <option key={name} value={name}>{libraryId(name)}</option>)}</select>}</div></div>
        <Field label="Type"><select value={m.typeId} onChange={e => updateModule(m.id, draft => { draft.typeId = e.target.value })}>{project.types.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}</select></Field>
        <div className="row three"><div className="metric"><span>Width X</span><strong>{meters(m.bounds.maxX - m.bounds.minX)} m</strong></div><div className="metric"><span>Height Y</span><strong>{meters(m.bounds.maxY - m.bounds.minY)} m</strong></div><div className="metric"><span>Depth Z</span><strong>{meters(m.bounds.maxZ - m.bounds.minZ)} m</strong></div></div>
        <section className="subsection"><h3>3D bounds & connectors</h3><ThreeCanvas module={m} doorWidth={project.settings.doorWidth} doorHeight={project.settings.doorHeight} onPortChange={updatePort} onAddPort={point => updateModule(m.id, draft => { draft.ports.push({ id: uniqueId(draft.ports.map(p => p.id), 'port'), ...point, allowedTypeIds: null }) })} onDeletePort={removePort} onDuplicatePort={duplicatePort} onError={setNotice} portPanel={(portId, select) => { const port = m.ports.find(p => p.id === portId); return port && <PortFields key={port.id} port={port} module={m} project={project} onChange={next => { updatePort(port.id, next); if (next.id !== port.id) select(next.id) }} /> }} /></section>
        <details className="subsection advanced-bounds"><summary>Advanced · adjust bounds relative to model origin</summary><div className="row two">{(['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'] as const).map(key => <NumberField key={`${m.id}-${key}`} label={key} value={m.bounds[key] / 1000} step={0.001} suffix="m" validate={n => { const mm = toMm(n); const axis = key.slice(-1) as 'X' | 'Y' | 'Z'; const other = key.startsWith('min') ? m.bounds[`max${axis}`] : m.bounds[`min${axis}`]; return key.startsWith('min') ? mm >= other ? 'Minimum must be below maximum' : undefined : mm <= other ? 'Maximum must exceed minimum' : undefined }} onChange={n => setBounds(m.id, key, n)} />)}</div></details>
        <section className="subsection"><h3>Ports</h3>{m.ports.map(port => <PortEditor key={port.id} port={port} module={m} project={project} onChange={next => updatePort(port.id, next)} onDuplicate={() => duplicatePort(port.id)} onDelete={() => removePort(port.id)} />)}{!m.ports.length && <p className="empty">Add a port on the canvas above.</p>}</section>
      </InspectorPanel>
    })()}

  </div>
}

function LibraryRow({ name, id, info, project, onIdChange, onAssign, onRemove }: { name: string; id: string; info: LibraryInfo | undefined; project: RuntimeProject; onIdChange: (id: string) => void; onAssign: (typeId: string) => void; onRemove: () => void }) {
  const [typeId, setTypeId] = useState('')
  const problem = !isId(id) ? 'Rename needed: start with a letter; use letters, numbers, _ or -' : project.modules.some(m => m.id === id) ? 'ID already used by a module' : !info ? 'Reading model…' : 'error' in info ? `Unreadable: ${info.error}` : ''
  const ready = !problem && !!project.types.some(t => t.id === typeId)
  return <div className={`library-row ${problem ? 'has-problem' : ''}`} draggable={!problem} onDragStart={e => { e.dataTransfer.setData(LIBRARY_DRAG, name); e.dataTransfer.effectAllowed = 'copy' }}>
    <div className="library-main"><span className="library-file" title={name}>{name}</span><small className={problem ? 'library-status warn' : 'library-status'}>{problem || (info && !('error' in info) ? footprint(info) : '')}</small></div>
    <label className="library-id"><span>Module ID</span><input value={id} aria-invalid={!isId(id)} onChange={e => onIdChange(e.target.value.trim())} /></label>
    <select aria-label={`Type for ${name}`} value={typeId} onChange={e => setTypeId(e.target.value)}><option value="">Type…</option>{project.types.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}</select>
    <button className="primary" disabled={!ready} onClick={() => onAssign(typeId)}>Assign</button>
    <button className="icon danger" aria-label={`Remove ${name} from Models`} onClick={onRemove}>×</button>
  </div>
}
function Validation({ errors }: { errors: string[] }) { return <section className={`card validation ${errors.length ? 'has-errors' : 'valid'}`}><h2>{errors.length ? `Fix ${errors.length} issues` : '✓ Rules valid'}</h2>{errors.length > 0 ? <ul>{errors.map((error, i) => <li key={i}>{error}</li>)}</ul> : <p>Ready to preview and export runtime JSON.</p>}</section> }
