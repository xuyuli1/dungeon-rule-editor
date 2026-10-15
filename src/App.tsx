import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, Controls, type Connection as FlowConnection, type Edge as FlowEdge, type Node as FlowNode } from '@xyflow/react'
import { downloadJson, importFbx, openProject, readJson, saveProject } from './io'
import { canonicalConnection, emptyEditor, emptyProject, exampleProject, isId, meters, pairKey, toMm, type Bounds, type Edge, type EditorState, type Module, type ModuleType, type Port, type RuntimeProject, type SpawnRule, validateProject, typeTargets } from './model'
import { rotatedBounds, type PreviewResult } from './generator'
import { gridStep, remapPorts, unitsPerPixel } from './geometry'

type Tab = 'global' | 'types' | 'modules' | 'preview'
const edges: Edge[] = ['N', 'E', 'S', 'W']
const edgeNames: Record<Edge, string> = { N: 'North (+Z)', E: 'East (+X)', S: 'South (-Z)', W: 'West (-X)' }
const newSpawn = (): SpawnRule => ({ min: 0, max: 0, entries: [] })
const num = (value: string, fallback = 0) => value === '' ? fallback : Number(value)
const uniqueId = (existing: string[], prefix: string) => { let i = 1; while (existing.includes(`${prefix}_${i}`)) i++; return `${prefix}_${i}` }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{children}</label> }
function NumberField({ label, value, onChange, step = 1, min, max, suffix, validate }: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; suffix?: string; validate?: (n: number) => string | undefined }) {
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
  return <Field label={label}><div className="input-unit"><input type="text" inputMode="decimal" aria-invalid={!!error} value={draft} onFocus={() => { editing.current = true }} onChange={e => { setDraft(e.target.value); setError('') }} onBlur={() => { editing.current = false; if (cancelCommit.current) { cancelCommit.current = false; setDraft(String(value)); setError('') } else commit() }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelCommit.current = true; e.currentTarget.blur() } }} />{suffix && <small>{suffix}</small>}</div>{error && <small className="field-error" role="alert">{error}</small>}</Field>
}
function SpawnEditor({ title, rule, onChange }: { title: string; rule: SpawnRule; onChange: (next: SpawnRule) => void }) {
  return <section className="subsection"><div className="section-head"><h3>{title}</h3></div><div className="row two">
    <NumberField label="Minimum" value={rule.min} min={0} onChange={min => onChange({ ...rule, min })} />
    <NumberField label="Maximum" value={rule.max} min={0} onChange={max => onChange({ ...rule, max })} />
  </div><div className="list compact">{rule.entries.map((entry, index) => <div className="entry-row" key={index}>
    <input aria-label="Asset ID" placeholder="Asset ID" value={entry.id} onChange={e => onChange({ ...rule, entries: rule.entries.map((v, i) => i === index ? { ...v, id: e.target.value } : v) })} />
    <input aria-label="Weight" title="Relative weight" type="number" min="0.001" step="0.1" value={entry.weight} onChange={e => onChange({ ...rule, entries: rule.entries.map((v, i) => i === index ? { ...v, weight: num(e.target.value) } : v) })} />
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
  const [tab, setTab] = useState<Tab | null>(null)
  const [navOpen, setNavOpen] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const [selectedType, setSelectedType] = useState('')
  const [selectedModule, setSelectedModule] = useState('')
  const [newTypeId, setNewTypeId] = useState('')
  const [newTypeName, setNewTypeName] = useState('')
  const [newModuleId, setNewModuleId] = useState('')
  const [newModuleType, setNewModuleType] = useState('')
  const [edgeA, setEdgeA] = useState('')
  const [edgeB, setEdgeB] = useState('')
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
  const selectTab = (next: Tab) => {
    setTab(current => current === next ? null : next)
    if (window.matchMedia('(max-width: 900px)').matches) setNavOpen(false)
  }
  const load = (next: RuntimeProject, nextEditor = emptyEditor(), nextFiles = new Map<string, File>()) => {
    stopWorker(); setProject(next); setEditor(nextEditor); setFiles(nextFiles); setPreview(null); setSelectedType(next.types[0]?.id ?? ''); setSelectedModule(next.modules[0]?.id ?? ''); setTab('global'); if (window.matchMedia('(max-width: 900px)').matches) setNavOpen(false); setNotice('Project opened')
  }
  const addType = () => {
    const id = newTypeId.trim(), name = newTypeName.trim()
    if (!isId(id) || project.types.some(t => t.id === id) || !name) { setNotice('Enter a unique type ID and name. IDs must start with a letter.'); return }
    mutate(draft => { draft.types.push({ id, name, color: '#65b9d4', percent: 0, requiredMin: 0, items: newSpawn(), enemies: newSpawn() }); if (!draft.settings.startTypeId) draft.settings.startTypeId = id })
    setSelectedType(id); setNewTypeId(''); setNewTypeName('')
  }
  const removeType = (id: string) => {
    if (!window.confirm(`Delete type ${id}, its modules and all connections?`)) return
    mutate(draft => { draft.types = draft.types.filter(t => t.id !== id); draft.modules = draft.modules.filter(m => m.typeId !== id); draft.connections = draft.connections.filter(c => c.a !== id && c.b !== id); if (draft.settings.startTypeId === id) draft.settings.startTypeId = draft.types[0]?.id ?? '' })
    setFiles(current => new Map([...current].filter(([moduleId]) => project.modules.find(m => m.id === moduleId)?.typeId !== id)))
    setSelectedType(project.types.find(t => t.id !== id)?.id ?? '')
    setSelectedModule(project.modules.find(m => m.typeId !== id)?.id ?? '')
  }
  const addModule = () => {
    const id = newModuleId.trim(), typeId = newModuleType || project.types[0]?.id
    if (!isId(id) || project.modules.some(m => m.id === id) || !typeId) { setNotice('Create a type, then enter a unique module ID.'); return }
    mutate(draft => draft.modules.push({ id, typeId, bounds: { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 }, ports: [] }))
    setSelectedModule(id); setNewModuleId('')
  }
  const removeModule = (id: string) => {
    if (!window.confirm(`Delete module ${id}?`)) return
    mutate(draft => { draft.modules = draft.modules.filter(m => m.id !== id) })
    setFiles(current => { const next = new Map(current); next.delete(id); return next })
    setSelectedModule(project.modules.find(m => m.id !== id)?.id ?? '')
  }
  const addConnection = (a: string, b: string) => {
    if (!a || !b) return
    if (project.connections.some(c => pairKey(c.a, c.b) === pairKey(a, b))) { setNotice('This connection already exists'); return }
    mutate(draft => draft.connections.push(canonicalConnection(a, b)))
  }
  const onConnect = (connection: FlowConnection) => addConnection(connection.source, connection.target)
  const graphNodes: FlowNode[] = project.types.map((t, i) => ({ id: t.id, position: editor.graphPositions[t.id] ?? { x: (i % 3) * 240, y: Math.floor(i / 3) * 160 }, data: { label: `${t.name} · ${t.percent}%` }, style: { background: '#1a2b33', color: '#f4f8f6', border: `2px solid ${t.color}`, borderRadius: 2, padding: 14, width: 170 }, selected: selectedType === t.id }))
  const graphEdges: FlowEdge[] = project.connections.map(c => ({ id: pairKey(c.a, c.b), source: c.a, target: c.b, label: c.a === c.b ? `${c.weightAB}` : `${c.weightAB} / ${c.weightBA}`, style: { stroke: '#b8d9d7', strokeWidth: 1.5 }, labelStyle: { fill: '#f4f8f6', fontWeight: 700 }, labelBgStyle: { fill: '#172830' } }))
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
  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>, kind: 'project' | 'json' | 'fbx') => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
    try {
      if (kind === 'project') { const saved = await openProject(file); load(saved.project, saved.editor, saved.files) }
      else if (kind === 'json') load(await readJson(file))
      else if (module) {
        const bounds = await importFbx(file)
        updateModule(module.id, m => {
          m.ports = remapPorts(m.ports, m.bounds, bounds, project.settings.doorWidth)
          m.bounds = bounds
        })
        setFiles(current => new Map(current).set(module.id, file))
        setEditor(current => ({ ...current, modelNames: { ...current.modelNames, [module.id]: file.name } }))
        setNotice(`Read ${file.name} bounds. Check port positions and Unity import dimensions.`)
      }
    } catch (error) { setNotice(`Import failed: ${errorText(error)}`) }
  }

  return <div className={`app-shell ${navOpen ? 'nav-open' : 'nav-closed'}`}>
    <header className="topbar"><div className="file-menu" ref={menuRef}><button className="menu-trigger" aria-expanded={menuOpen} aria-controls="file-menu-panel" onClick={() => setMenuOpen(open => !open)}>MENU <span aria-hidden="true">{menuOpen ? '×' : '☰'}</span></button>
      {menuOpen && <div id="file-menu-panel" className="menu-panel"><div className="menu-caption">PROJECT FILES</div><button onClick={() => { setMenuOpen(false); if (!project.types.length || window.confirm('Replace the current project with the example?')) load(exampleProject()) }}>Load example</button><button onClick={() => { setMenuOpen(false); projectInput.current?.click() }}>Open ZIP</button><button onClick={() => { setMenuOpen(false); jsonInput.current?.click() }}>Import JSON</button><button onClick={() => { setMenuOpen(false); saveProject(project, editor, files).then(() => setNotice('Project ZIP saved')).catch(e => setNotice(errorText(e))) }}>Save ZIP</button><button onClick={() => { setMenuOpen(false); exportJson() }}>Export JSON</button><div className="menu-meta">{project.types.length} TYPES · {project.modules.length} MODULES<br />V1 · X-Z PLANE · 1 UNIT = 1 M<br />FILES STAY IN THIS BROWSER</div></div>}
    </div>
      <input hidden type="file" accept=".zip" ref={projectInput} onChange={e => handleFile(e, 'project')} /><input hidden type="file" accept=".json" ref={jsonInput} onChange={e => handleFile(e, 'json')} /><input hidden type="file" accept=".fbx" ref={fbxInput} onChange={e => handleFile(e, 'fbx')} />
    </header>
    <div className="workspace"><aside className="app-sidebar"><button className="nav-toggle" aria-label={navOpen ? 'Collapse workspace navigation' : 'Expand workspace navigation'} aria-expanded={navOpen} onClick={() => setNavOpen(open => !open)}><span className="nav-chevron" aria-hidden="true">{navOpen ? '‹' : '›'}</span><span className="nav-toggle-label">WORKSPACE</span></button>
      {navOpen && <><div className="nav-stripes" aria-hidden="true" /><nav className="tabs" aria-label="Editor sections">{([['global', 'Map rules'], ['types', 'Types & links'], ['modules', 'Modules'], ['preview', 'Preview']] as const).map(([id, label], index) => <button key={id} className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => selectTab(id)}><span className="step-number">0{index + 1}</span><span>{label}</span></button>)}</nav></>}
    </aside><div className="workspace-main">
    {notice && <div role={noticeIsError ? 'alert' : 'status'} className={`notice ${noticeIsError ? 'notice-error' : 'notice-success'}`}><span>{notice}</span><button aria-label="Dismiss notification" title="Dismiss" onClick={() => setNotice('')}>×</button></div>}
    <main key={tab ?? 'home'} className="content">
      {tab === null && <section className="home-screen" aria-label="Dungeon rule editor home"><div className="home-orbit" aria-hidden="true" /><div className="home-wordmark">DUNGEON <span>RULE EDITOR</span></div><p>BUILD THE RULES. SHAPE THE MAP.</p></section>}
      {tab === 'global' && <div className="page narrow"><div className="page-title"><div><span className="eyebrow">01 / MAP RULES</span><h1>Map rules</h1><p>Percentages set target counts; required counts are minimums.</p></div><span className="page-corner" aria-hidden="true">01</span></div>
        <section className="card"><h2>Map size</h2><div className="row three"><NumberField label="Total modules" value={project.settings.totalModules} min={1} max={500} onChange={n => mutate(d => { d.settings.totalModules = n })} /><Field label="Start type"><select value={project.settings.startTypeId} onChange={e => mutate(d => { d.settings.startTypeId = e.target.value })}><option value="">Select type</option>{project.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field><NumberField label="Door width" value={project.settings.doorWidth / 1000} min={0.001} step={0.001} suffix="m" onChange={n => mutate(d => { d.settings.doorWidth = toMm(n) })} /></div></section>
        <section className="card"><div className="section-head"><h2>Type targets</h2><span className={Math.abs(project.types.reduce((n, t) => n + t.percent, 0) - 100) < 0.000001 ? 'badge good' : 'badge warn'}>Total {project.types.reduce((n, t) => n + t.percent, 0)}%</span></div>
          <div className="target-table"><div className="target-head"><span>Type</span><span>Share</span><span>Target</span><span>Required min</span></div>{project.types.map(t => <div className="target-row" key={t.id}><span><i style={{ background: t.color }} />{t.name}</span><span>{t.percent}%</span><strong>{targets[t.id] ?? 0}</strong><span>{t.requiredMin}</span></div>)}</div>
          {!project.types.length && <p className="empty">Create a type in Types & links first.</p>}
        </section><Validation errors={errors} /></div>}
      {tab === 'types' && <div className="page types-page"><div className="page-title"><div><span className="eyebrow">02 / TYPES & RELATIONS</span><h1>Types & links</h1><p>Links define allowed connections, not map positions. Each direction has its own weight.</p></div><span className="page-corner" aria-hidden="true">02</span></div>
        <div className="split-layout"><aside className="side-panel"><section className="card"><h2>Types</h2><div className="list">{project.types.map(t => <button key={t.id} className={`list-item ${selectedType === t.id ? 'selected' : ''}`} onClick={() => setSelectedType(t.id)}><i style={{ background: t.color }} /><span>{t.name}<small>{t.id} · {t.percent}%</small></span></button>)}</div><div className="add-form"><input placeholder="Type ID, e.g. entrance" value={newTypeId} onChange={e => setNewTypeId(e.target.value)} /><input placeholder="Name, e.g. Entrance" value={newTypeName} onChange={e => setNewTypeName(e.target.value)} /><button onClick={addType}>＋ Add type</button></div></section>
          {type && <section className="card"><div className="section-head"><h2>{type.name}</h2><button className="danger-text" onClick={() => removeType(type.id)}>Remove type</button></div><Field label="Name"><input value={type.name} onChange={e => updateType(type.id, t => { t.name = e.target.value })} /></Field><Field label="Color"><input type="color" value={type.color} onChange={e => updateType(type.id, t => { t.color = e.target.value })} /></Field><div className="row two"><NumberField label="Map share" value={type.percent} min={0} max={100} step={0.1} suffix="%" onChange={n => updateType(type.id, t => { t.percent = n })} /><NumberField label="Required min" value={type.requiredMin} min={0} onChange={n => updateType(type.id, t => { t.requiredMin = n })} /></div><SpawnEditor title="Items" rule={type.items} onChange={rule => updateType(type.id, t => { t.items = rule })} /><SpawnEditor title="Enemies" rule={type.enemies} onChange={rule => updateType(type.id, t => { t.enemies = rule })} /></section>}</aside>
          <div className="main-panel"><section className="card graph-card"><div className="section-head"><h2>Connection graph</h2><span className="hint">Drag nodes to arrange. Connect handles or use the form below.</span></div><div className="graph"><ReactFlow nodes={graphNodes} edges={graphEdges} fitView onConnect={onConnect} onNodesChange={changes => { const moved: Record<string, { x: number; y: number }> = {}; for (const change of changes) if (change.type === 'position' && change.position) moved[change.id] = change.position; if (Object.keys(moved).length) setEditor(current => ({ ...current, graphPositions: { ...current.graphPositions, ...moved } })) }} onNodeClick={(_, node) => setSelectedType(node.id)} minZoom={0.3} maxZoom={2}><Background color="#c7c2ff" /><Controls /></ReactFlow></div></section>
            <section className="card"><h2>Connection weights</h2><div className="connection-add"><select value={edgeA} onChange={e => setEdgeA(e.target.value)}><option value="">Type A</option>{project.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><span>↔</span><select value={edgeB} onChange={e => setEdgeB(e.target.value)}><option value="">Type B</option>{project.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><button onClick={() => addConnection(edgeA, edgeB)}>Add link</button></div>
              <div className="relations">{project.connections.map(c => <div className="relation" key={pairKey(c.a, c.b)}><strong>{project.types.find(t => t.id === c.a)?.name ?? c.a} ↔ {project.types.find(t => t.id === c.b)?.name ?? c.b}</strong><label>{c.a} → {c.b}<input type="number" min="0.001" step="0.1" value={c.weightAB} onChange={e => mutate(d => { const target = d.connections.find(v => pairKey(v.a, v.b) === pairKey(c.a, c.b))!; target.weightAB = num(e.target.value) })} /></label>{c.a !== c.b && <label>{c.b} → {c.a}<input type="number" min="0.001" step="0.1" value={c.weightBA} onChange={e => mutate(d => { const target = d.connections.find(v => pairKey(v.a, v.b) === pairKey(c.a, c.b))!; target.weightBA = num(e.target.value) })} /></label>}<button className="icon danger" title="Remove both directions" onClick={() => mutate(d => { d.connections = d.connections.filter(v => pairKey(v.a, v.b) !== pairKey(c.a, c.b)) })}>×</button></div>)}</div>{!project.connections.length && <p className="empty">No links yet.</p>}
            </section></div></div></div>}
      {tab === 'modules' && <div className="page modules-page"><div className="page-title"><div><span className="eyebrow">03 / MODULE LIBRARY</span><h1>Modules</h1><p>Import FBX for bounds, then drag ports along the edges. The cross marks the origin.</p></div><span className="page-corner" aria-hidden="true">03</span></div><div className="split-layout"><aside className="side-panel"><section className="card"><h2>Module library</h2><div className="list">{project.modules.map(m => <button key={m.id} className={`list-item ${selectedModule === m.id ? 'selected' : ''}`} onClick={() => setSelectedModule(m.id)}><i style={{ background: project.types.find(t => t.id === m.typeId)?.color ?? '#64748b' }} /><span>{m.id}<small>{project.types.find(t => t.id === m.typeId)?.name ?? m.typeId} · {m.ports.length} ports</small></span></button>)}</div><div className="add-form"><input placeholder="Module ID, e.g. room_a" value={newModuleId} onChange={e => setNewModuleId(e.target.value)} /><select value={newModuleType} onChange={e => setNewModuleType(e.target.value)}><option value="">Select type</option>{project.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><button onClick={addModule}>＋ Add module</button></div></section></aside>
          <div className="main-panel">{module ? <><section className="card"><div className="section-head"><div><h2>{module.id}</h2><p className="hint">{editor.modelNames[module.id] ?? 'No FBX loaded. Bounds can be edited manually.'}</p></div><div className="inline-actions"><button onClick={() => fbxInput.current?.click()}>Import / replace FBX</button><button className="danger-text" onClick={() => removeModule(module.id)}>Remove module</button></div></div><div className="row three"><Field label="Type"><select value={module.typeId} onChange={e => updateModule(module.id, m => { m.typeId = e.target.value })}>{project.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field><div className="metric"><span>Width X</span><strong>{meters(module.bounds.maxX - module.bounds.minX)} m</strong></div><div className="metric"><span>Depth Z</span><strong>{meters(module.bounds.maxZ - module.bounds.minZ)} m</strong></div></div></section>
            <section className="card"><h2>2D bounds & ports</h2><ModuleCanvas module={module} doorWidth={project.settings.doorWidth} onPortChange={(id, next) => updateModule(module.id, m => { const i = m.ports.findIndex(p => p.id === id); if (i >= 0) m.ports[i] = next })} onAddPort={edge => updateModule(module.id, m => { const b = m.bounds; const half = project.settings.doorWidth / 2; if ((edge === 'N' || edge === 'S' ? b.maxX - b.minX : b.maxZ - b.minZ) < project.settings.doorWidth) { setNotice('This edge is shorter than the door width'); return } const id = uniqueId(m.ports.map(p => p.id), 'port'); const centerX = Math.round((b.minX + b.maxX) / 2), centerZ = Math.round((b.minZ + b.maxZ) / 2); m.ports.push({ id, edge, x: edge === 'E' ? b.maxX : edge === 'W' ? b.minX : Math.max(b.minX + half, Math.min(b.maxX - half, centerX)), z: edge === 'N' ? b.maxZ : edge === 'S' ? b.minZ : Math.max(b.minZ + half, Math.min(b.maxZ - half, centerZ)) }) })} onDeletePort={id => updateModule(module.id, m => { m.ports = m.ports.filter(p => p.id !== id) })} /></section>
            <section className="card"><h2>Bounds relative to model origin</h2><div className="row four">{(['minX', 'maxX', 'minZ', 'maxZ'] as const).map(key => <NumberField key={`${module.id}-${key}`} label={key} value={module.bounds[key] / 1000} step={0.001} suffix="m" validate={n => { const mm = toMm(n); const other = key.endsWith('X') ? (key === 'minX' ? module.bounds.maxX : module.bounds.minX) : (key === 'minZ' ? module.bounds.maxZ : module.bounds.minZ); return key.startsWith('min') ? mm >= other ? 'Minimum must be below maximum' : undefined : mm <= other ? 'Maximum must exceed minimum' : undefined }} onChange={n => setBounds(key, n)} />)}</div><p className="hint">Editing bounds keeps the origin offset and constrains ports to their edges.</p></section>
            <section className="card"><h2>Ports</h2>{module.ports.map(port => <div className="port-row" key={port.id}><strong>{port.id}</strong><span>{edgeNames[port.edge]}</span><span>({meters(port.x)}, {meters(port.z)}) m</span><button className="icon danger" aria-label={`Remove port ${port.id}`} onClick={() => updateModule(module.id, m => { m.ports = m.ports.filter(p => p.id !== port.id) })}>×</button></div>)}{!module.ports.length && <p className="empty">Add a port on the canvas above.</p>}</section>
          </> : <div className="card empty large">Select or create a module.</div>}</div></div></div>}
      {tab === 'preview' && <div className="page preview-page"><div className="page-title"><div><span className="eyebrow">04 / GENERATION PREVIEW</span><h1>Map preview</h1><p>Rectangles use saved bounds. A seed reproduces the same layout.</p></div><div className="preview-controls"><Field label="Seed"><input type="number" min="0" max="4294967295" value={seed} onChange={e => setSeed(num(e.target.value) >>> 0)} /></Field><button className="quiet" onClick={() => setSeed(Math.floor(Math.random() * 4294967295))}>New seed</button><button className="primary" disabled={generating || !!errors.length} onClick={startPreview}>{generating ? 'Generating…' : 'Generate'}</button>{generating && <button onClick={() => { stopWorker(); setNotice('Search stopped') }}>Stop</button>}</div><span className="page-corner" aria-hidden="true">04</span></div>
        {errors.length > 0 && <Validation errors={errors} />}
        <div className="preview-layout"><section className="card preview-stage">{preview?.placements.length ? <PreviewCanvas project={project} result={preview} /> : <div className="placeholder"><span>◇</span><h2>No preview yet</h2><p>Create types, modules and links, then generate a preview.</p></div>}</section><aside className="card preview-info"><h2>Results</h2>{preview ? <><div className={`result-status ${preview.complete ? 'success' : 'warning'}`}>{preview.complete ? '✓ All targets met' : '⚠ Best partial result'}</div><div className="stats"><div><span>Placed</span><strong>{preview.placements.length} / {project.settings.totalModules}</strong></div><div><span>Seed</span><strong>{preview.seed}</strong></div><div><span>Candidates checked</span><strong>{preview.checks.toLocaleString()}</strong></div><div><span>Restarts</span><strong>{preview.restarts}</strong></div></div><h3>Type counts</h3>{project.types.map(t => <div className="quota-line" key={t.id}><span><i style={{ background: t.color }} />{t.name}</span><b>{preview.placements.filter(p => p.typeId === t.id).length} / {preview.targets[t.id] ?? 0}</b></div>)}{preview.warnings.length > 0 && <><h3>Warnings</h3><ul className="warnings">{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></>}</> : <p className="empty">Generate a map to see counts and warnings.</p>}</aside></div></div>}
    </main></div></div>
  </div>
}

function Validation({ errors }: { errors: string[] }) { return <section className={`card validation ${errors.length ? 'has-errors' : 'valid'}`}><h2>{errors.length ? `Fix ${errors.length} issues` : '✓ Rules valid'}</h2>{errors.length > 0 ? <ul>{errors.map((error, i) => <li key={i}>{error}</li>)}</ul> : <p>Ready to preview and export runtime JSON.</p>}</section> }
