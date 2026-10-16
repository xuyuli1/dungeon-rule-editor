import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, Controls, type Edge as FlowEdge, type Node as FlowNode, type ReactFlowInstance } from '@xyflow/react'
import { RelationEdge } from './RelationEdge'
import { renameType } from './editorActions'
import { downloadJson, importFbx, openProject, readJson, saveProject } from './io'
import { canonicalConnection, emptyEditor, emptyProject, exampleProject, isId, meters, pairKey, toMm, type Bounds, type Edge, type EditorState, type Module, type ModuleType, type Port, type RuntimeProject, type SpawnRule, validateProject, typeTargets } from './model'
import { rotatedBounds, type PreviewResult } from './generator'
import { gridStep, remapPorts, unitsPerPixel } from './geometry'

type Drawer = { kind: 'type'; id: string } | { kind: 'module'; id: string } | { kind: 'create-type' } | null
type GraphMenu = { kind: 'pane' | 'node' | 'edge'; id?: string; x: number; y: number; flowX?: number; flowY?: number } | null
type FbxMode = { kind: 'new'; typeId: string } | { kind: 'replace'; moduleId: string }
const edges: Edge[] = ['N', 'E', 'S', 'W']
const edgeNames: Record<Edge, string> = { N: 'North (+Z)', E: 'East (+X)', S: 'South (-Z)', W: 'West (-X)' }
const relationEdgeTypes = { relation: RelationEdge }
const newSpawn = (): SpawnRule => ({ min: 0, max: 0, entries: [] })
const num = (value: string, fallback = 0) => value === '' ? fallback : Number(value)
const uniqueId = (existing: string[], prefix: string) => { let i = 1; while (existing.includes(`${prefix}_${i}`)) i++; return `${prefix}_${i}` }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

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
function SpawnEditor({ title, rule, onChange }: { title: string; rule: SpawnRule; onChange: (next: SpawnRule) => void }) {
  return <section className="subsection"><div className="section-head"><h3>{title}</h3></div><div className="row two">
    <NumberField label="Minimum" value={rule.min} min={0} defaultValue={0} onChange={min => onChange({ ...rule, min })} />
    <NumberField label="Maximum" value={rule.max} min={0} defaultValue={0} onChange={max => onChange({ ...rule, max })} />
  </div><div className="list compact">{rule.entries.map((entry, index) => <div className="entry-row" key={index}>
    <input aria-label="Asset ID" placeholder="Asset ID" value={entry.id} onChange={e => onChange({ ...rule, entries: rule.entries.map((v, i) => i === index ? { ...v, id: e.target.value } : v) })} />
    <input className={entry.weight === 1 ? 'default-value' : undefined} aria-label="Weight" title="Relative weight" type="number" min="0.001" step="0.1" value={entry.weight} onChange={e => onChange({ ...rule, entries: rule.entries.map((v, i) => i === index ? { ...v, weight: num(e.target.value) } : v) })} />
    <button className="icon danger" title="Remove" onClick={() => onChange({ ...rule, entries: rule.entries.filter((_, i) => i !== index) })}>×</button>
  </div>)}</div><button className="quiet" onClick={() => onChange({ ...rule, entries: [...rule.entries, { id: '', weight: 1 }] })}>＋ Add {title === 'Items' ? 'item' : 'enemy'} ID</button>
  </section>
}

function ModuleCanvas({ module, doorWidth, onPortChange, onAddPort, onDeletePort }: { module: Module; doorWidth: number; onPortChange: (id: string, next: Port) => void; onAddPort: (edge: Edge) => void; onDeletePort: (id: string) => void }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [active, setActive] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<Edge>('N')
  const b = module.bounds
  const width = b.maxX - b.minX, depth = b.maxZ - b.minZ
  const displayMinX = Math.min(b.minX, 0), displayMaxX = Math.max(b.maxX, 0)
  const displayMinZ = Math.min(b.minZ, 0), displayMaxZ = Math.max(b.maxZ, 0)
  const displayWidth = displayMaxX - displayMinX, displayDepth = displayMaxZ - displayMinZ
  const pad = Math.max(displayWidth, displayDepth) * 0.18 + 500
  const viewWidth = displayWidth + pad * 2, viewHeight = displayDepth + pad * 2
  const viewBox = `${displayMinX - pad} ${-displayMaxZ - pad} ${viewWidth} ${viewHeight}`
  const [pixelSize, setPixelSize] = useState({ width: 800, height: 380 })
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const measure = () => { const rect = svg.getBoundingClientRect(); setPixelSize({ width: rect.width, height: rect.height }) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [])
  const unit = unitsPerPixel(viewWidth, viewHeight, pixelSize.width, pixelSize.height)
  const step = gridStep(Math.max(width, depth))
  const labelFontSize = Math.min(unit * 12, 4000)
  const labelScale = unit * 12 / labelFontSize
  const placePort = useCallback((port: Port, clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return
    const point = svg.createSVGPoint(); point.x = clientX; point.y = clientY
    const local = point.matrixTransform(svg.getScreenCTM()!.inverse())
    const half = doorWidth / 2
    const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)))
    const next = { ...port }
    if (port.edge === 'N' || port.edge === 'S') { next.x = clamp(local.x, b.minX + half, b.maxX - half); next.z = port.edge === 'N' ? b.maxZ : b.minZ }
    else { next.x = port.edge === 'E' ? b.maxX : b.minX; next.z = clamp(-local.y, b.minZ + half, b.maxZ - half) }
    onPortChange(port.id, next)
  }, [b, doorWidth, onPortChange])
  return <div className="module-canvas"><div className="canvas-toolbar"><span>X →　Z ↑　meters</span><select value={selectedEdge} onChange={e => setSelectedEdge(e.target.value as Edge)}>{edges.map(edge => <option key={edge} value={edge}>{edgeNames[edge]}</option>)}</select><button onClick={() => onAddPort(selectedEdge)}>＋ Add port</button></div>
    <svg ref={svgRef} viewBox={viewBox} className="module-svg" onPointerMove={e => { if (active) { const port = module.ports.find(p => p.id === active); if (port) placePort(port, e.clientX, e.clientY) } }} onPointerUp={() => setActive(null)} onPointerCancel={() => setActive(null)}>
      <defs><pattern id="grid" width={step} height={step} patternUnits="userSpaceOnUse"><path d={`M ${step} 0 L 0 0 0 ${step}`} fill="none" stroke="#35474c" strokeWidth={unit} /></pattern></defs>
      <rect x={displayMinX - pad} y={-displayMaxZ - pad} width={viewWidth} height={viewHeight} fill="url(#grid)" />
      <rect x={b.minX} y={-b.maxZ} width={width} height={depth} fill="#172830" stroke="#e5eeeb" strokeWidth={unit * 2} />
      <line x1={-unit * 8} y1="0" x2={unit * 8} y2="0" stroke="#e5eeeb" strokeWidth={unit * 2} /><line x1="0" y1={-unit * 8} x2="0" y2={unit * 8} stroke="#e5eeeb" strokeWidth={unit * 2} />
      {module.ports.map(port => <g key={port.id} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setActive(port.id) }} onDoubleClick={() => onDeletePort(port.id)} className="port-handle">
        <circle cx={port.x} cy={-port.z} r={unit * 15} fill="transparent" />
        <circle cx={port.x} cy={-port.z} r={unit * 7} fill={active === port.id ? '#ffffff' : '#b8d9d7'} stroke="#071219" strokeWidth={unit * 2} pointerEvents="none" />
        <text transform={`translate(${port.x + unit * 10} ${-port.z - unit * 10}) scale(${labelScale})`} fill="#f6faf8" fontSize={labelFontSize} paintOrder="stroke" stroke="#071219" strokeWidth={unit * 3 / labelScale} pointerEvents="none">{port.id}</text>
      </g>)}
    </svg><p className="hint">Drag a port along its edge. Double click to remove. The cross marks the model origin.</p>
  </div>
}

function PreviewCanvas({ project, result }: { project: RuntimeProject; result: PreviewResult }) {
  const moduleMap = new Map(project.modules.map(m => [m.id, m]))
  const typeMap = new Map(project.types.map(t => [t.id, t]))
  const boxes = result.placements.map(p => rotatedBounds(moduleMap.get(p.moduleId)!.bounds, p.rotation, p.x, p.z))
  const minX = Math.min(...boxes.map(b => b.minX)), maxX = Math.max(...boxes.map(b => b.maxX))
  const minZ = Math.min(...boxes.map(b => b.minZ)), maxZ = Math.max(...boxes.map(b => b.maxZ))
  const pad = 4000
  return <svg className="preview-svg" viewBox={`${minX - pad} ${-maxZ - pad} ${maxX - minX + 2 * pad} ${maxZ - minZ + 2 * pad}`} preserveAspectRatio="xMidYMid meet">
    {result.placements.map((p, index) => { const b = boxes[index], color = typeMap.get(p.typeId)?.color ?? '#65b9d4'; return <g key={p.instanceId}>
      <rect x={b.minX} y={-b.maxZ} width={b.maxX - b.minX} height={b.maxZ - b.minZ} fill={color} fillOpacity="0.24" stroke={color} strokeWidth="110" />
      <circle cx={p.x} cy={-p.z} r="170" fill={color} />
      <text x={(b.minX + b.maxX) / 2} y={-(b.minZ + b.maxZ) / 2} textAnchor="middle" dominantBaseline="middle" fill="#f4f8f6" fontSize="900" stroke="#071219" strokeWidth="170" paintOrder="stroke">{p.moduleId}</text>
    </g> })}
  </svg>
}

export default function App() {
  const [project, setProject] = useState<RuntimeProject>(emptyProject)
  const [editor, setEditor] = useState<EditorState>(emptyEditor)
  const [files, setFiles] = useState<Map<string, File>>(new Map())
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [typeTab, setTypeTab] = useState<'basics' | 'modules' | 'spawns'>('basics')
  const [activeRelationKey, setActiveRelationKey] = useState('')
  const [typeIdDraft, setTypeIdDraft] = useState('')
  const [graphMenu, setGraphMenu] = useState<GraphMenu>(null)
  const [connectSource, setConnectSource] = useState('')
  const [pointer, setPointer] = useState({ x: 0, y: 0 })
  const [createPosition, setCreatePosition] = useState<{ x: number; y: number } | null>(null)
  const graphRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLElement>(null)
  const pressRef = useRef<{ timer: number; x: number; y: number } | null>(null)
  const fbxMode = useRef<FbxMode | null>(null)
  const [focusType, setFocusType] = useState('')
  const flowRef = useRef<ReactFlowInstance | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const [selectedType, setSelectedType] = useState('')
  const [selectedModule, setSelectedModule] = useState('')
  const [newTypeId, setNewTypeId] = useState('')
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 4294967295))
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const noticeIsError = /failed|error|invalid|resolve|enter a|shorter|already exists|no complete|10-second|stopped/i.test(notice)
  const workerRef = useRef<Worker | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const jsonInput = useRef<HTMLInputElement>(null)
  const fbxInput = useRef<HTMLInputElement>(null)

  const errors = useMemo(() => validateProject(project), [project])
  const targets = useMemo(() => typeTargets(project), [project])
  const type = project.types.find(t => t.id === selectedType)
  const module = project.modules.find(m => m.id === selectedModule)
  const relation = project.connections.find(c => pairKey(c.a, c.b) === activeRelationKey)
  const mutate = useCallback((change: (draft: RuntimeProject) => void) => { setProject(current => { const next = structuredClone(current); change(next); return next }); setPreview(null) }, [])
  const updateType = (id: string, change: (type: ModuleType) => void) => mutate(draft => { const target = draft.types.find(t => t.id === id); if (target) change(target) })
  const updateModule = (id: string, change: (module: Module) => void) => mutate(draft => { const target = draft.modules.find(m => m.id === id); if (target) change(target) })
  const stopWorker = useCallback(() => { workerRef.current?.terminate(); workerRef.current = null; if (timeoutRef.current) window.clearTimeout(timeoutRef.current); timeoutRef.current = null; setGenerating(false) }, [])
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
    if (!drawer) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawer(null) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [drawer])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setGraphMenu(null); setConnectSource('') }
      if (drawer || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes((event.target as HTMLElement)?.tagName)) return
      if (graphRef.current?.contains(document.activeElement) && event.key === 'Enter' && focusType) { event.preventDefault(); openType(focusType) }
      if (graphRef.current?.contains(document.activeElement) && (event.key === 'Delete' || event.key === 'Backspace') && focusType) { event.preventDefault(); removeType(focusType) }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })
  useEffect(() => {
    if (!drawer) return
    const panel = modalRef.current
    panel?.querySelector<HTMLElement>(drawer.kind === 'create-type' ? 'input' : '.detail-tabs .active')?.focus()
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'))
      if (!items.length) return
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus() }
    }
    document.addEventListener('keydown', trapFocus)
    return () => document.removeEventListener('keydown', trapFocus)
  }, [drawer])
  const openType = (id: string, tab: 'basics' | 'modules' | 'spawns' = 'basics') => { setSelectedType(id); setFocusType(id); setTypeIdDraft(id); setTypeTab(tab); setActiveRelationKey(''); setGraphMenu(null); setDrawer({ kind: 'type', id }) }
  const openRelation = (key: string) => { const target = project.connections.find(c => pairKey(c.a, c.b) === key); if (!target) return; openType(target.a); setActiveRelationKey(key) }
  const showMenu = (kind: 'pane' | 'node' | 'edge', x: number, y: number, id?: string) => {
    const point = flowRef.current?.screenToFlowPosition({ x, y })
    setGraphMenu({ kind, id, x: Math.min(x, window.innerWidth - 190), y: Math.min(y, window.innerHeight - 150), flowX: point?.x, flowY: point?.y })
  }
  const load = (next: RuntimeProject, nextEditor = emptyEditor(), nextFiles = new Map<string, File>()) => {
    stopWorker(); setProject(next); setEditor(nextEditor); setFiles(nextFiles); setPreview(null); setSelectedType(next.types[0]?.id ?? ''); setSelectedModule(next.modules[0]?.id ?? ''); setFocusType(''); setDrawer(null); setGraphMenu(null); setConnectSource(''); setNotice('Project opened')
  }
  const addType = () => {
    const id = newTypeId.trim()
    if (!isId(id) || project.types.some(t => t.id === id)) { setNotice('Enter a unique type ID. Start with a letter; use letters, numbers, _ or -.'); return }
    mutate(draft => { draft.types.push({ id, color: '#65b9d4', percent: 0, requiredMin: 0, items: newSpawn(), enemies: newSpawn() }); if (!draft.settings.startTypeId) draft.settings.startTypeId = id })
    if (createPosition) setEditor(current => ({ ...current, graphPositions: { ...current.graphPositions, [id]: createPosition } }))
    openType(id); setNewTypeId(''); setCreatePosition(null)
  }
  const removeType = (id: string) => {
    const moduleCount = project.modules.filter(m => m.typeId === id).length
    const relationCount = project.connections.filter(c => c.a === id || c.b === id).length
    if (!window.confirm(`Delete type ${id}, ${moduleCount} modules and ${relationCount} connections?`)) return
    const removedModuleIds = new Set(project.modules.filter(m => m.typeId === id).map(m => m.id))
    mutate(draft => { draft.types = draft.types.filter(t => t.id !== id); draft.modules = draft.modules.filter(m => m.typeId !== id); draft.connections = draft.connections.filter(c => c.a !== id && c.b !== id); if (draft.settings.startTypeId === id) draft.settings.startTypeId = draft.types[0]?.id ?? '' })
    setFiles(current => new Map([...current].filter(([moduleId]) => !removedModuleIds.has(moduleId))))
    setEditor(current => {
      const graphPositions = { ...current.graphPositions }, modelNames = { ...current.modelNames }
      delete graphPositions[id]
      removedModuleIds.forEach(moduleId => { delete modelNames[moduleId] })
      return { ...current, graphPositions, modelNames }
    })
    setSelectedType(project.types.find(t => t.id !== id)?.id ?? '')
    setSelectedModule(project.modules.find(m => m.typeId !== id)?.id ?? '')
    setFocusType(''); setDrawer(null); setGraphMenu(null); setConnectSource('')
  }
  const commitTypeId = () => {
    if (!type || typeIdDraft === type.id) return
    const nextId = typeIdDraft.trim()
    if (!isId(nextId) || project.types.some(t => t.id === nextId)) { setNotice('Type ID must be unique and start with a letter. Use letters, numbers, _ or -.'); setTypeIdDraft(type.id); return }
    const changed = renameType(project, editor, type.id, nextId)
    setProject(changed.project); setEditor(changed.editor); setPreview(null)
    setSelectedType(nextId); setFocusType(nextId); setDrawer({ kind: 'type', id: nextId }); setActiveRelationKey('')
  }
  const importModuleFile = async (file: File, mode: FbxMode) => {
    const id = file.name.replace(/\.fbx$/i, '')
    if (!file.name.toLowerCase().endsWith('.fbx') || !isId(id)) { setNotice('Import failed: Rename the FBX file to a valid module ID (letters, numbers, _ or -).'); return }
    const oldId = mode.kind === 'replace' ? mode.moduleId : ''
    if (project.modules.some(m => m.id === id && m.id !== oldId)) { setNotice(`Import failed: Module ID ${id} already exists. Rename the FBX file.`); return }
    try {
      const bounds = await importFbx(file)
      if (mode.kind === 'new') {
        mutate(draft => draft.modules.push({ id, typeId: mode.typeId, bounds, ports: [] }))
      } else {
        const old = project.modules.find(m => m.id === oldId)
        if (!old) throw new Error('Module no longer exists')
        mutate(draft => {
          const target = draft.modules.find(m => m.id === oldId)!
          target.ports = remapPorts(target.ports, target.bounds, bounds, draft.settings.doorWidth)
          target.bounds = bounds
          target.id = id
        })
      }
      setFiles(current => { const next = new Map(current); if (oldId) next.delete(oldId); next.set(id, file); return next })
      setEditor(current => { const modelNames = { ...current.modelNames }; if (oldId) delete modelNames[oldId]; modelNames[id] = file.name; return { ...current, modelNames } })
      setSelectedModule(id); setTypeTab('modules'); setDrawer({ kind: 'module', id }); setNotice(`Imported ${file.name}. Check bounds and ports.`)
    } catch (error) { setNotice(`Import failed: ${errorText(error)}`) }
  }
  const chooseFbx = (mode: FbxMode) => { fbxMode.current = mode; fbxInput.current?.click() }
  const dropFbx = (event: React.DragEvent<HTMLElement>, mode: FbxMode) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void importModuleFile(file, mode) }
  const removeModule = (id: string) => {
    if (!window.confirm(`Delete module ${id}?`)) return
    mutate(draft => { draft.modules = draft.modules.filter(m => m.id !== id) })
    setFiles(current => { const next = new Map(current); next.delete(id); return next })
    setEditor(current => { const modelNames = { ...current.modelNames }; delete modelNames[id]; return { ...current, modelNames } })
    setSelectedModule(project.modules.find(m => m.id !== id)?.id ?? '')
    if (module) openType(module.typeId, 'modules'); else setDrawer(null)
  }
  const addConnection = (a: string, b: string) => {
    if (!a || !b) return
    if (project.connections.some(c => pairKey(c.a, c.b) === pairKey(a, b))) { setNotice('This connection already exists'); return }
    mutate(draft => draft.connections.push(canonicalConnection(a, b)))
  }
  const neighbors = new Set(project.connections.filter(c => c.a === focusType || c.b === focusType).flatMap(c => [c.a, c.b]))
  const graphColumns = Math.max(2, Math.ceil(Math.sqrt(project.types.length)))
  const graphNodes: FlowNode[] = project.types.map((t, i) => ({ id: t.id, position: editor.graphPositions[t.id] ?? { x: (i % graphColumns) * 260, y: Math.floor(i / graphColumns) * 160 }, data: { label: <div className="graph-node-content" onDoubleClick={e => { e.stopPropagation(); openType(t.id) }}><div className="graph-node-title"><strong>{t.id}</strong><button className="node-more nodrag nopan" aria-label={`Actions for ${t.id}`} title="Node actions" onClick={e => { e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); showMenu('node', rect.right, rect.bottom, t.id) }}>⋯</button></div><span>{t.percent}% · {targets[t.id] ?? 0} target · {project.modules.filter(m => m.typeId === t.id).length} defined</span></div> }, className: focusType && !neighbors.has(t.id) ? 'graph-node-dim' : 'graph-node', style: { background: '#1a2b33', color: '#f4f8f6', border: `2px solid ${t.color}`, borderRadius: 2, padding: 13, width: 190 }, selected: focusType === t.id }))
  const graphEdges: FlowEdge[] = project.connections.map(c => ({ id: pairKey(c.a, c.b), source: c.a, target: c.b, type: 'relation', data: { weightAB: c.weightAB, weightBA: c.weightBA }, selected: activeRelationKey === pairKey(c.a, c.b), style: { stroke: '#b8d9d7', opacity: focusType && c.a !== focusType && c.b !== focusType ? .16 : 1 } }))
  const arrange = () => {
    setEditor(current => ({ ...current, graphPositions: Object.fromEntries(project.types.map((t, i) => [t.id, { x: (i % graphColumns) * 260, y: Math.floor(i / graphColumns) * 160 }])) }))
    window.requestAnimationFrame(() => flowRef.current?.fitView({ padding: .24, duration: 260 }))
  }
  const setBounds = (key: keyof Bounds, value: number) => {
    if (!module) return
    updateModule(module.id, m => {
      m.bounds[key] = toMm(value)
      const b = m.bounds, half = project.settings.doorWidth / 2
      for (const p of m.ports) {
        if (p.edge === 'N' || p.edge === 'S') { p.z = p.edge === 'N' ? b.maxZ : b.minZ; p.x = Math.round(Math.max(b.minX + half, Math.min(b.maxX - half, p.x))) }
        else { p.x = p.edge === 'E' ? b.maxX : b.minX; p.z = Math.round(Math.max(b.minZ + half, Math.min(b.maxZ - half, p.z))) }
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
      const message = event.data as { kind: string; result?: PreviewResult; message?: string }
      if (message.kind === 'progress' && message.result) { latest = message.result; setPreview(latest) }
      if (message.kind === 'done' && message.result) { setPreview(message.result); setNotice(message.result.complete ? 'All targets met' : 'No complete map found. Showing the best result.'); stopWorker() }
      if (message.kind === 'error') { setNotice(message.message ?? 'Generation failed'); stopWorker() }
    }
    worker.onerror = event => { setNotice(event.message || 'Preview worker failed'); stopWorker() }
    worker.postMessage({ project, seed: seed >>> 0 })
    timeoutRef.current = window.setTimeout(() => { setPreview(latest); setNotice('Search reached the 10-second limit. Showing the best result.'); stopWorker() }, 10000)
  }
  const exportJson = () => {
    if (errors.length) { setNotice('Resolve validation errors first'); return }
    if (!preview?.complete && !window.confirm('The rules have not produced a complete preview. Export runtime JSON anyway?')) return
    downloadJson(project); setNotice('Runtime JSON exported')
  }
  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>, kind: 'project' | 'json') => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
    try {
      if (kind === 'project') { const saved = await openProject(file); load(saved.project, saved.editor, saved.files) }
      else if (kind === 'json') load(await readJson(file))
    } catch (error) { setNotice(`Import failed: ${errorText(error)}`) }
  }
  const clearLongPress = () => { if (pressRef.current) { window.clearTimeout(pressRef.current.timer); pressRef.current = null } }
  const previewNode = connectSource ? flowRef.current?.getNode(connectSource) : undefined
  const graphRect = graphRef.current?.getBoundingClientRect()
  const previewPoint = previewNode && graphRect ? flowRef.current?.flowToScreenPosition({ x: previewNode.position.x + (previewNode.measured?.width ?? 190) / 2, y: previewNode.position.y + (previewNode.measured?.height ?? 76) / 2 }) : null

  return <div className="app-shell">
    <header className="topbar"><div className="file-menu" ref={menuRef}>
      <button className="menu-trigger" aria-label="File menu" title="File menu" aria-expanded={menuOpen} aria-controls="file-menu-panel" onClick={() => setMenuOpen(open => !open)}><span aria-hidden="true">{menuOpen ? '×' : '☰'}</span></button>
      {menuOpen && <div id="file-menu-panel" className="menu-panel"><button onClick={() => { setMenuOpen(false); if (!project.types.length || window.confirm('Replace the current project with the example?')) load(exampleProject()) }}>Load example</button><button onClick={() => { setMenuOpen(false); projectInput.current?.click() }}>Open ZIP</button><button onClick={() => { setMenuOpen(false); jsonInput.current?.click() }}>Import JSON</button><button onClick={() => { setMenuOpen(false); saveProject(project, editor, files).then(() => setNotice('Project ZIP saved')).catch(e => setNotice(errorText(e))) }}>Save ZIP</button><button onClick={() => { setMenuOpen(false); exportJson() }}>Export JSON</button><div className="menu-meta">{project.types.length} TYPES · {project.modules.length} MODULES<br />V1 · X-Z PLANE · 1 UNIT = 1 M<br />FILES STAY IN THIS BROWSER</div></div>}
    </div><input hidden type="file" accept=".zip" ref={projectInput} onChange={e => handleFile(e, 'project')} /><input hidden type="file" accept=".json" ref={jsonInput} onChange={e => handleFile(e, 'json')} /><input hidden type="file" accept=".fbx" ref={fbxInput} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file && fbxMode.current) void importModuleFile(file, fbxMode.current) }} /></header>
    {notice && <div role={noticeIsError ? 'alert' : 'status'} className={`notice ${noticeIsError ? 'notice-error' : 'notice-success'}`}><span>{notice}</span><button aria-label="Dismiss notification" title="Dismiss" onClick={() => setNotice('')}>×</button></div>}
    <main className="editor-workspace">
      <section className="editor-panel rules-panel" aria-label="Rule network">
        <div className="panel-heading"><div><span className="eyebrow">01 / RULE NETWORK</span><h1>Rule network</h1></div></div>
        <div className="map-settings row three"><NumberField label="Total modules" value={project.settings.totalModules} min={1} max={500} onChange={n => mutate(d => { d.settings.totalModules = n })} /><Field label="Start type"><select value={project.settings.startTypeId} onChange={e => mutate(d => { d.settings.startTypeId = e.target.value })}><option value="">Select type</option>{project.types.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}</select></Field><NumberField label="Door width" value={project.settings.doorWidth / 1000} min={0.001} step={0.001} suffix="m" onChange={n => mutate(d => { d.settings.doorWidth = toMm(n) })} /></div>
        <div className="graph-head"><span>TYPE CONNECTIONS</span><span>Right click for actions · double click to edit</span></div>
        <div className="graph" ref={graphRef} tabIndex={0} aria-label="Type connection graph" onPointerMove={e => { setPointer({ x: e.clientX, y: e.clientY }); if (pressRef.current && Math.hypot(e.clientX - pressRef.current.x, e.clientY - pressRef.current.y) > 8) clearLongPress() }} onPointerUp={clearLongPress} onPointerCancel={clearLongPress} onPointerDownCapture={e => { if (e.pointerType !== 'touch') return; const x = e.clientX, y = e.clientY; const target = e.target as HTMLElement; const node = target.closest('.react-flow__node') as HTMLElement | null; const edge = target.closest('.react-flow__edge') as HTMLElement | null; clearLongPress(); pressRef.current = { x, y, timer: window.setTimeout(() => { showMenu(node ? 'node' : edge ? 'edge' : 'pane', x, y, node?.dataset.id ?? edge?.dataset.id); pressRef.current = null }, 500) } }}>
          <button className="graph-more" aria-label="Graph actions" title="Graph actions" onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); showMenu('pane', rect.right, rect.bottom) }}>⋯</button>
          <ReactFlow nodes={graphNodes} edges={graphEdges} edgeTypes={relationEdgeTypes} fitView fitViewOptions={{ padding: .24 }} minZoom={0.3} maxZoom={2} nodesConnectable={false} zoomOnDoubleClick={false} onInit={instance => { flowRef.current = instance }} onNodeClick={(_, node) => { setGraphMenu(null); if (connectSource) { addConnection(connectSource, node.id); setConnectSource(''); setFocusType(connectSource); return } setSelectedType(node.id); setFocusType(node.id) }} onNodeDoubleClick={(_, node) => { if (!connectSource) openType(node.id) }} onNodeContextMenu={(event, node) => { event.preventDefault(); setFocusType(node.id); showMenu('node', event.clientX, event.clientY, node.id) }} onEdgeClick={(_, edge) => { if (!connectSource) openRelation(edge.id) }} onEdgeContextMenu={(event, edge) => { event.preventDefault(); showMenu('edge', event.clientX, event.clientY, edge.id) }} onPaneClick={() => { setGraphMenu(null); setConnectSource(''); setFocusType('') }} onPaneContextMenu={event => { event.preventDefault(); showMenu('pane', event.clientX, event.clientY) }} onNodesChange={changes => { const moved: Record<string, { x: number; y: number }> = {}; for (const change of changes) if (change.type === 'position' && change.position) moved[change.id] = change.position; if (Object.keys(moved).length) setEditor(current => ({ ...current, graphPositions: { ...current.graphPositions, ...moved } })) }}><Background color="#415962" gap={24} size={1} /><Controls /></ReactFlow>
          {connectSource && previewPoint && graphRect && <svg className="connection-preview" aria-hidden="true"><line x1={previewPoint.x - graphRect.left} y1={previewPoint.y - graphRect.top} x2={pointer.x - graphRect.left} y2={pointer.y - graphRect.top} /></svg>}
          {connectSource && <div className="connect-hint">Select a target node · Esc to cancel</div>}
        </div>
        <div className="targets-block"><div className="section-head"><h2>Map composition</h2><span className={Math.abs(project.types.reduce((n, t) => n + t.percent, 0) - 100) < 0.000001 ? 'badge good' : 'badge warn'}>{project.types.reduce((n, t) => n + t.percent, 0)}% / 100%</span></div>{project.types.length ? <div className="target-list">{project.types.map(t => <button key={t.id} className={focusType === t.id ? 'target-chip active' : 'target-chip'} onClick={() => openType(t.id)}><i style={{ background: t.color }} /><span>{t.id}</span><strong>{t.percent}%</strong><small>{targets[t.id] ?? 0} / {project.settings.totalModules}</small></button>)}</div> : <p className="empty">Add a type to begin defining your map.</p>}</div>
        {errors.length > 0 && <Validation errors={errors} />}
      </section>
      <div className="preview-column">
        <section className="editor-panel preview-panel"><div className="panel-heading"><div><span className="eyebrow">02 / MAP PREVIEW</span><h2>Map preview</h2></div>{preview && <span className={preview.complete ? 'badge good' : 'badge warn'}>{preview.complete ? 'COMPLETE' : 'PARTIAL'}</span>}</div><div className="preview-stage">{preview?.placements.length ? <PreviewCanvas project={project} result={preview} /> : <div className="placeholder"><span>◇</span><h2>No preview yet</h2><p>Set up types, modules and connections, then generate a map.</p></div>}</div></section>
        <section className="editor-panel results-panel"><div className="panel-heading"><div><span className="eyebrow">03 / GENERATION</span><h2>Generate & results</h2></div></div><div className="preview-controls"><Field label="Seed"><input type="number" min="0" max="4294967295" value={seed} onChange={e => setSeed(num(e.target.value) >>> 0)} /></Field><button className="quiet" onClick={() => setSeed(Math.floor(Math.random() * 4294967295))}>New seed</button><button className="primary" disabled={generating || !!errors.length} onClick={startPreview}>{generating ? 'Generating…' : 'Generate'}</button>{generating && <button onClick={() => { stopWorker(); setNotice('Search stopped') }}>Stop</button>}</div>{preview ? <><div className={`result-status ${preview.complete ? 'success' : 'warning'}`}>{preview.complete ? '✓ All targets met' : '⚠ Best partial result'}</div><div className="stats"><div><span>Placed</span><strong>{preview.placements.length} / {project.settings.totalModules}</strong></div><div><span>Candidates checked</span><strong>{preview.checks.toLocaleString()}</strong></div><div><span>Restarts</span><strong>{preview.restarts}</strong></div></div><h3>Type counts</h3>{project.types.map(t => <div className="quota-line" key={t.id}><span><i style={{ background: t.color }} />{t.id}</span><b>{preview.placements.filter(p => p.typeId === t.id).length} / {preview.targets[t.id] ?? 0}</b></div>)}{preview.warnings.length > 0 && <><h3>Warnings</h3><ul className="warnings">{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></>}</> : <p className="empty">Generate a map to see counts and warnings.</p>}</section>
      </div>
    </main>
    {graphMenu && <><div className="context-dismiss" onPointerDown={() => setGraphMenu(null)} /><div className="graph-context-menu" role="menu" style={{ left: graphMenu.x, top: graphMenu.y }}>
      {graphMenu.kind === 'pane' && <><button role="menuitem" onClick={() => { setCreatePosition(graphMenu.flowX === undefined ? null : { x: graphMenu.flowX, y: graphMenu.flowY ?? 0 }); setNewTypeId(''); setDrawer({ kind: 'create-type' }); setGraphMenu(null) }}>New type</button><button role="menuitem" onClick={() => { arrange(); setGraphMenu(null) }}>Arrange</button></>}
      {graphMenu.kind === 'node' && <><button role="menuitem" onClick={() => openType(graphMenu.id!)}>Edit</button><button role="menuitem" onClick={() => { setConnectSource(graphMenu.id!); setPointer({ x: graphMenu.x, y: graphMenu.y }); setGraphMenu(null); setDrawer(null) }}>New connection</button><button role="menuitem" className="danger-text" onClick={() => removeType(graphMenu.id!)}>Delete type</button></>}
      {graphMenu.kind === 'edge' && <><button role="menuitem" onClick={() => openRelation(graphMenu.id!)}>Edit weights</button><button role="menuitem" className="danger-text" onClick={() => { mutate(d => { d.connections = d.connections.filter(c => pairKey(c.a, c.b) !== graphMenu.id) }); setGraphMenu(null); setActiveRelationKey('') }}>Delete connection</button></>}
    </div></>}
    {drawer && <div className="modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) setDrawer(null) }}><section className="editor-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label={drawer.kind === 'create-type' ? 'New type' : drawer.kind === 'module' ? 'Module details' : 'Type details'}>
      <div className="modal-top"><span>DETAILS</span><button className="icon" aria-label="Close details" onClick={() => setDrawer(null)}>×</button></div>
      {drawer.kind === 'create-type' && <div className="modal-body"><h2>New type</h2><Field label="Type ID"><input autoFocus placeholder="e.g. entrance" value={newTypeId} onChange={e => setNewTypeId(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addType() }} /></Field><button className="primary full-width" onClick={addType}>Create type</button></div>}
      {(drawer.kind === 'type' || drawer.kind === 'module') && type && <><div className="modal-title"><h2>{type.id}</h2><nav className="detail-tabs" aria-label="Type details tabs"><button className={typeTab === 'basics' ? 'active' : ''} onClick={() => { setTypeTab('basics'); setDrawer({ kind: 'type', id: type.id }) }}>Basics & connections</button><button className={typeTab === 'modules' ? 'active' : ''} onClick={() => { setTypeTab('modules'); setDrawer({ kind: 'type', id: type.id }) }}>Modules</button><button className={typeTab === 'spawns' ? 'active' : ''} onClick={() => { setTypeTab('spawns'); setDrawer({ kind: 'type', id: type.id }) }}>Items & enemies</button></nav></div><div className="modal-body">
        {typeTab === 'basics' && <><div className="row two"><Field label="Type ID"><input value={typeIdDraft} onChange={e => setTypeIdDraft(e.target.value)} onBlur={commitTypeId} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /></Field><Field label="Color"><input type="color" value={type.color} onChange={e => updateType(type.id, t => { t.color = e.target.value })} /></Field></div><NumberField label="Share of map modules (%)" value={type.percent} min={0} max={100} step={0.1} suffix="%" onChange={n => updateType(type.id, t => { t.percent = n })} /><p className="hint target-explainer">{type.percent}% → {targets[type.id] ?? 0} of {project.settings.totalModules} modules in the map</p><NumberField label="Required minimum" value={type.requiredMin} min={0} defaultValue={0} onChange={n => updateType(type.id, t => { t.requiredMin = n })} /><p className="hint">Included in the target count above.</p>
          <section className="subsection"><div className="section-head"><h3>Connections</h3><button className="quiet" onClick={() => { setConnectSource(type.id); setDrawer(null) }}>New connection</button></div>{project.connections.filter(c => c.a === type.id || c.b === type.id).map(c => <button className={activeRelationKey === pairKey(c.a, c.b) ? 'list-item selected' : 'list-item'} key={pairKey(c.a, c.b)} onClick={() => setActiveRelationKey(pairKey(c.a, c.b))}>{c.a === c.b ? `${type.id} ↻ self` : `${c.a} ↔ ${c.b}`}<small>{c.a === c.b ? `↻ ${c.weightAB}` : `→ ${c.weightAB} · ← ${c.weightBA}`}</small></button>)}{!project.connections.some(c => c.a === type.id || c.b === type.id) && <p className="empty">No connections yet.</p>}{relation && <div className="relation-editor"><h3>{relation.a === relation.b ? `${relation.a} ↻ self` : `${relation.a} ↔ ${relation.b}`}</h3><p className="hint">Relative weights, not fixed percentages.</p><div className="row two"><NumberField label={relation.a === relation.b ? `${relation.a} → itself` : `${relation.a} → ${relation.b}`} value={relation.weightAB} min={0.001} step={0.1} defaultValue={1} onChange={n => mutate(d => { const target = d.connections.find(c => pairKey(c.a, c.b) === activeRelationKey); if (target) target.weightAB = n })} />{relation.a !== relation.b && <NumberField label={`${relation.b} → ${relation.a}`} value={relation.weightBA} min={0.001} step={0.1} defaultValue={1} onChange={n => mutate(d => { const target = d.connections.find(c => pairKey(c.a, c.b) === activeRelationKey); if (target) target.weightBA = n })} />}</div><button className="danger-text" onClick={() => { mutate(d => { d.connections = d.connections.filter(c => pairKey(c.a, c.b) !== activeRelationKey) }); setActiveRelationKey('') }}>Remove both directions</button></div>}</section></>}
        {typeTab === 'modules' && <>{drawer.kind === 'module' && module ? <><button className="quiet back-button" onClick={() => setDrawer({ kind: 'type', id: type.id })}>← All modules</button><div className="section-head"><div><h3>{module.id}</h3><p className="hint">{editor.modelNames[module.id] ?? 'No FBX loaded. Bounds can be edited manually.'}</p></div><button className="danger-text" onClick={() => removeModule(module.id)}>Remove</button></div><div className="fbx-drop" onDragOver={e => e.preventDefault()} onDrop={e => dropFbx(e, { kind: 'replace', moduleId: module.id })}><strong>Drop FBX to replace model</strong><button onClick={() => chooseFbx({ kind: 'replace', moduleId: module.id })}>Choose FBX</button></div><Field label="Type"><select value={module.typeId} onChange={e => { updateModule(module.id, m => { m.typeId = e.target.value }); setSelectedType(e.target.value); setTypeIdDraft(e.target.value); setDrawer({ kind: 'module', id: module.id }) }}>{project.types.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}</select></Field><div className="row two"><div className="metric"><span>Width X</span><strong>{meters(module.bounds.maxX - module.bounds.minX)} m</strong></div><div className="metric"><span>Depth Z</span><strong>{meters(module.bounds.maxZ - module.bounds.minZ)} m</strong></div></div><section className="subsection"><h3>2D bounds & ports</h3><ModuleCanvas module={module} doorWidth={project.settings.doorWidth} onPortChange={(id, next) => updateModule(module.id, m => { const i = m.ports.findIndex(p => p.id === id); if (i >= 0) m.ports[i] = next })} onAddPort={edge => updateModule(module.id, m => { const b = m.bounds; const half = project.settings.doorWidth / 2; if ((edge === 'N' || edge === 'S' ? b.maxX - b.minX : b.maxZ - b.minZ) < project.settings.doorWidth) { setNotice('This edge is shorter than the door width'); return } const id = uniqueId(m.ports.map(p => p.id), 'port'); const centerX = Math.round((b.minX + b.maxX) / 2), centerZ = Math.round((b.minZ + b.maxZ) / 2); m.ports.push({ id, edge, x: edge === 'E' ? b.maxX : edge === 'W' ? b.minX : Math.max(b.minX + half, Math.min(b.maxX - half, centerX)), z: edge === 'N' ? b.maxZ : edge === 'S' ? b.minZ : Math.max(b.minZ + half, Math.min(b.maxZ - half, centerZ)) }) })} onDeletePort={id => updateModule(module.id, m => { m.ports = m.ports.filter(p => p.id !== id) })} /></section><section className="subsection"><h3>Bounds relative to model origin</h3><div className="row two">{(['minX', 'maxX', 'minZ', 'maxZ'] as const).map(key => <NumberField key={`${module.id}-${key}`} label={key} value={module.bounds[key] / 1000} step={0.001} suffix="m" validate={n => { const mm = toMm(n); const other = key.endsWith('X') ? (key === 'minX' ? module.bounds.maxX : module.bounds.minX) : (key === 'minZ' ? module.bounds.maxZ : module.bounds.minZ); return key.startsWith('min') ? mm >= other ? 'Minimum must be below maximum' : undefined : mm <= other ? 'Maximum must exceed minimum' : undefined }} onChange={n => setBounds(key, n)} />)}</div><p className="hint">Bounds retain the origin offset. Ports stay on their edges.</p></section><section className="subsection"><h3>Ports</h3>{module.ports.map(port => <div className="port-row" key={port.id}><strong>{port.id}</strong><span>{edgeNames[port.edge]}</span><span>({meters(port.x)}, {meters(port.z)}) m</span><button className="icon danger" aria-label={`Remove port ${port.id}`} onClick={() => updateModule(module.id, m => { m.ports = m.ports.filter(p => p.id !== port.id) })}>×</button></div>)}{!module.ports.length && <p className="empty">Add a port on the canvas above.</p>}</section></> : <><div className="fbx-drop" onDragOver={e => e.preventDefault()} onDrop={e => dropFbx(e, { kind: 'new', typeId: type.id })}><strong>Drop FBX to create a module</strong><span>Module ID comes from the filename.</span><button onClick={() => chooseFbx({ kind: 'new', typeId: type.id })}>Choose FBX</button></div>{project.modules.filter(m => m.typeId === type.id).map(m => <button className="list-item" key={m.id} onClick={() => { setSelectedModule(m.id); setDrawer({ kind: 'module', id: m.id }) }}>{m.id}<small>{m.ports.length} ports</small></button>)}{!project.modules.some(m => m.typeId === type.id) && <p className="empty">No modules yet.</p>}</>}</>}
        {typeTab === 'spawns' && <><SpawnEditor title="Items" rule={type.items} onChange={rule => updateType(type.id, t => { t.items = rule })} /><SpawnEditor title="Enemies" rule={type.enemies} onChange={rule => updateType(type.id, t => { t.enemies = rule })} /></>}
      </div></>}
    </section></div>}

  </div>
}

function Validation({ errors }: { errors: string[] }) { return <section className={`card validation ${errors.length ? 'has-errors' : 'valid'}`}><h2>{errors.length ? `Fix ${errors.length} issues` : '✓ Rules valid'}</h2>{errors.length > 0 ? <ul>{errors.map((error, i) => <li key={i}>{error}</li>)}</ul> : <p>Ready to preview and export runtime JSON.</p>}</section> }
