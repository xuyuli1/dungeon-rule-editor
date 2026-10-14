import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, Controls, type Connection as FlowConnection, type Edge as FlowEdge, type Node as FlowNode } from '@xyflow/react'
import { downloadJson, importFbx, openProject, readJson, saveProject } from './io'
import { canonicalConnection, emptyEditor, emptyProject, exampleProject, isId, meters, pairKey, toMm, type Bounds, type Edge, type EditorState, type Module, type ModuleType, type Port, type RuntimeProject, type SpawnRule, validateProject, typeTargets } from './model'
import { rotatedBounds, type PreviewResult } from './generator'

type Tab = 'global' | 'types' | 'modules' | 'preview'
const edges: Edge[] = ['N', 'E', 'S', 'W']
const edgeNames: Record<Edge, string> = { N: '北 (+Z)', E: '东 (+X)', S: '南 (-Z)', W: '西 (-X)' }
const newSpawn = (): SpawnRule => ({ min: 0, max: 0, entries: [] })
const num = (value: string, fallback = 0) => value === '' ? fallback : Number(value)
const uniqueId = (existing: string[], prefix: string) => { let i = 1; while (existing.includes(`${prefix}_${i}`)) i++; return `${prefix}_${i}` }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{children}</label> }
function NumberField({ label, value, onChange, step = 1, min, max, suffix }: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  return <Field label={label}><div className="input-unit"><input type="number" value={Number.isFinite(value) ? value : ''} step={step} min={min} max={max} onChange={e => onChange(num(e.target.value))} />{suffix && <small>{suffix}</small>}</div></Field>
}
function SpawnEditor({ title, rule, onChange }: { title: string; rule: SpawnRule; onChange: (next: SpawnRule) => void }) {
  return <section className="subsection"><div className="section-head"><h3>{title}</h3></div><div className="row two">
    <NumberField label="最少数量" value={rule.min} min={0} onChange={min => onChange({ ...rule, min })} />
    <NumberField label="最多数量" value={rule.max} min={0} onChange={max => onChange({ ...rule, max })} />
  </div><div className="list compact">{rule.entries.map((entry, index) => <div className="entry-row" key={index}>
    <input aria-label="资源 ID" placeholder="资源 ID" value={entry.id} onChange={e => onChange({ ...rule, entries: rule.entries.map((v, i) => i === index ? { ...v, id: e.target.value } : v) })} />
    <input aria-label="权重" title="相对权重" type="number" min="0.001" step="0.1" value={entry.weight} onChange={e => onChange({ ...rule, entries: rule.entries.map((v, i) => i === index ? { ...v, weight: num(e.target.value) } : v) })} />
    <button className="icon danger" title="删除" onClick={() => onChange({ ...rule, entries: rule.entries.filter((_, i) => i !== index) })}>×</button>
  </div>)}</div><button className="quiet" onClick={() => onChange({ ...rule, entries: [...rule.entries, { id: '', weight: 1 }] })}>＋ 添加 {title} ID</button>
  </section>
}

function ModuleCanvas({ module, doorWidth, onPortChange, onAddPort, onDeletePort }: { module: Module; doorWidth: number; onPortChange: (id: string, next: Port) => void; onAddPort: (edge: Edge) => void; onDeletePort: (id: string) => void }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [active, setActive] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<Edge>('N')
  const b = module.bounds
  const width = b.maxX - b.minX, depth = b.maxZ - b.minZ
  const pad = Math.max(width, depth) * 0.18 + 500
  const viewBox = `${b.minX - pad} ${-b.maxZ - pad} ${width + pad * 2} ${depth + pad * 2}`
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
  return <div className="module-canvas"><div className="canvas-toolbar"><span>X →　Z ↑　单位：米</span><select value={selectedEdge} onChange={e => setSelectedEdge(e.target.value as Edge)}>{edges.map(edge => <option key={edge} value={edge}>{edgeNames[edge]}</option>)}</select><button onClick={() => onAddPort(selectedEdge)}>＋ 接口</button></div>
    <svg ref={svgRef} viewBox={viewBox} className="module-svg" onPointerMove={e => { if (active) { const port = module.ports.find(p => p.id === active); if (port) placePort(port, e.clientX, e.clientY) } }} onPointerUp={() => setActive(null)} onPointerCancel={() => setActive(null)}>
      <defs><pattern id="grid" width="1000" height="1000" patternUnits="userSpaceOnUse"><path d="M 1000 0 L 0 0 0 1000" fill="none" stroke="#263349" strokeWidth="35" /></pattern></defs>
      <rect x={b.minX - pad} y={-b.maxZ - pad} width={width + pad * 2} height={depth + pad * 2} fill="url(#grid)" />
      <rect x={b.minX} y={-b.maxZ} width={width} height={depth} fill="#21354a" stroke="#65b9d4" strokeWidth="90" />
      <line x1="-300" y1="0" x2="300" y2="0" stroke="#f4ca7b" strokeWidth="70" /><line x1="0" y1="-300" x2="0" y2="300" stroke="#f4ca7b" strokeWidth="70" />
      {module.ports.map(port => <g key={port.id} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setActive(port.id) }} onDoubleClick={() => onDeletePort(port.id)} className="port-handle">
        <circle cx={port.x} cy={-port.z} r="240" fill={active === port.id ? '#fff' : '#f4ca7b'} stroke="#111d2d" strokeWidth="70" />
        <text x={port.x + 260} y={-port.z - 260} fill="#e7eff8" fontSize="420" paintOrder="stroke" stroke="#172233" strokeWidth="90">{port.id}</text>
      </g>)}
    </svg><p className="hint">拖动圆点调整接口位置；双击圆点删除。黄色十字是模型原点。</p>
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
      <text x={(b.minX + b.maxX) / 2} y={-(b.minZ + b.maxZ) / 2} textAnchor="middle" dominantBaseline="middle" fill="#eff7ff" fontSize="900" stroke="#111b2a" strokeWidth="170" paintOrder="stroke">{p.moduleId}</text>
    </g> })}
  </svg>
}

export default function App() {
  const [project, setProject] = useState<RuntimeProject>(emptyProject)
  const [editor, setEditor] = useState<EditorState>(emptyEditor)
  const [files, setFiles] = useState<Map<string, File>>(new Map())
  const [tab, setTab] = useState<Tab>('global')
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
  const load = (next: RuntimeProject, nextEditor = emptyEditor(), nextFiles = new Map<string, File>()) => {
    stopWorker(); setProject(next); setEditor(nextEditor); setFiles(nextFiles); setPreview(null); setSelectedType(next.types[0]?.id ?? ''); setSelectedModule(next.modules[0]?.id ?? ''); setNotice('已打开项目')
  }
  const addType = () => {
    const id = newTypeId.trim(), name = newTypeName.trim()
    if (!isId(id) || project.types.some(t => t.id === id) || !name) { setNotice('请输入不重复的类型 ID 和名称；ID 以英文字母开头'); return }
    mutate(draft => { draft.types.push({ id, name, color: '#65b9d4', percent: 0, requiredMin: 0, items: newSpawn(), enemies: newSpawn() }); if (!draft.settings.startTypeId) draft.settings.startTypeId = id })
    setSelectedType(id); setNewTypeId(''); setNewTypeName('')
  }
  const removeType = (id: string) => {
    if (!window.confirm(`删除类型 ${id}，以及其所有具体模块和连接关系？`)) return
    mutate(draft => { draft.types = draft.types.filter(t => t.id !== id); draft.modules = draft.modules.filter(m => m.typeId !== id); draft.connections = draft.connections.filter(c => c.a !== id && c.b !== id); if (draft.settings.startTypeId === id) draft.settings.startTypeId = draft.types[0]?.id ?? '' })
    setFiles(current => new Map([...current].filter(([moduleId]) => project.modules.find(m => m.id === moduleId)?.typeId !== id)))
    setSelectedType(project.types.find(t => t.id !== id)?.id ?? '')
    setSelectedModule(project.modules.find(m => m.typeId !== id)?.id ?? '')
  }
  const addModule = () => {
    const id = newModuleId.trim(), typeId = newModuleType || project.types[0]?.id
    if (!isId(id) || project.modules.some(m => m.id === id) || !typeId) { setNotice('请输入不重复的模块 ID，并先创建类型'); return }
    mutate(draft => draft.modules.push({ id, typeId, bounds: { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 }, ports: [] }))
    setSelectedModule(id); setNewModuleId('')
  }
  const removeModule = (id: string) => {
    if (!window.confirm(`删除模块 ${id}？`)) return
    mutate(draft => { draft.modules = draft.modules.filter(m => m.id !== id) })
    setFiles(current => { const next = new Map(current); next.delete(id); return next })
    setSelectedModule(project.modules.find(m => m.id !== id)?.id ?? '')
  }
  const addConnection = (a: string, b: string) => {
    if (!a || !b) return
    if (project.connections.some(c => pairKey(c.a, c.b) === pairKey(a, b))) { setNotice('该类型连接已存在'); return }
    mutate(draft => draft.connections.push(canonicalConnection(a, b)))
  }
  const onConnect = (connection: FlowConnection) => addConnection(connection.source, connection.target)
  const graphNodes: FlowNode[] = project.types.map((t, i) => ({ id: t.id, position: editor.graphPositions[t.id] ?? { x: (i % 3) * 240, y: Math.floor(i / 3) * 160 }, data: { label: `${t.name} · ${t.percent}%` }, style: { background: '#1d2b3c', color: '#f0f4fa', border: `2px solid ${t.color}`, borderRadius: 12, padding: 14, width: 170 }, selected: selectedType === t.id }))
  const graphEdges: FlowEdge[] = project.connections.map(c => ({ id: pairKey(c.a, c.b), source: c.a, target: c.b, label: c.a === c.b ? `${c.weightAB}` : `${c.weightAB} / ${c.weightBA}`, style: { stroke: '#8aa7c4', strokeWidth: 2 }, labelStyle: { fill: '#e8f0fa', fontWeight: 700 }, labelBgStyle: { fill: '#1b2a3c' } }))
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
    if (errors.length) { setNotice('请先修正规则校验错误'); return }
    stopWorker(); setPreview(null); setGenerating(true); setNotice('正在生成预览…')
    const worker = new Worker(new URL('./generator.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    let latest: PreviewResult | null = null
    worker.onmessage = event => {
      const message = event.data as { kind: string; result?: PreviewResult; message?: string }
      if (message.kind === 'progress' && message.result) { latest = message.result; setPreview(latest) }
      if (message.kind === 'done' && message.result) { setPreview(message.result); setNotice(message.result.complete ? '已找到满足全部目标的地图' : '未找到完整地图，已展示最佳结果'); stopWorker() }
      if (message.kind === 'error') { setNotice(message.message ?? '生成失败'); stopWorker() }
    }
    worker.onerror = event => { setNotice(event.message || '工作线程发生错误'); stopWorker() }
    worker.postMessage({ project, seed: seed >>> 0 })
    timeoutRef.current = window.setTimeout(() => { setPreview(latest); setNotice('搜索达到 10 秒上限，已展示当前最佳结果'); stopWorker() }, 10000)
  }
  const exportJson = () => {
    if (errors.length) { setNotice('请先修正规则校验错误'); return }
    if (!preview?.complete && !window.confirm('当前规则未通过完整预览。仍要导出运行时 JSON 吗？')) return
    downloadJson(project); setNotice('已导出运行时 JSON')
  }
  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>, kind: 'project' | 'json' | 'fbx') => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
    try {
      if (kind === 'project') { const saved = await openProject(file); load(saved.project, saved.editor, saved.files) }
      else if (kind === 'json') load(await readJson(file))
      else if (module) {
        const bounds = await importFbx(file)
        updateModule(module.id, m => {
          m.bounds = bounds
          const half = project.settings.doorWidth / 2
          for (const port of m.ports) {
            if (port.edge === 'N' || port.edge === 'S') { port.z = port.edge === 'N' ? bounds.maxZ : bounds.minZ; port.x = Math.round(Math.max(bounds.minX + half, Math.min(bounds.maxX - half, port.x))) }
            else { port.x = port.edge === 'E' ? bounds.maxX : bounds.minX; port.z = Math.round(Math.max(bounds.minZ + half, Math.min(bounds.maxZ - half, port.z))) }
          }
        })
        setFiles(current => new Map(current).set(module.id, file))
        setEditor(current => ({ ...current, modelNames: { ...current.modelNames, [module.id]: file.name } }))
        setNotice(`已读取 ${file.name} 的占地范围；请检查接口位置与 Unity 导入尺寸`)
      }
    } catch (error) { setNotice(`导入失败：${errorText(error)}`) }
  }

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">▦</span><div><strong>随机副本规则编辑器</strong><small>2D 地图 · FBX 占地 · JSON 规则</small></div></div>
      <div className="top-actions"><button className="quiet" onClick={() => { if (!project.types.length || window.confirm('用示例项目替换当前内容？')) load(exampleProject()) }}>加载示例</button><button className="quiet" onClick={() => projectInput.current?.click()}>打开项目 ZIP</button><button className="quiet" onClick={() => jsonInput.current?.click()}>导入 JSON</button><button className="quiet" onClick={() => saveProject(project, editor, files).then(() => setNotice('已保存项目 ZIP')).catch(e => setNotice(errorText(e)))}>保存项目 ZIP</button><button className="primary" onClick={exportJson}>导出运行时 JSON</button></div>
      <input hidden type="file" accept=".zip" ref={projectInput} onChange={e => handleFile(e, 'project')} /><input hidden type="file" accept=".json" ref={jsonInput} onChange={e => handleFile(e, 'json')} /><input hidden type="file" accept=".fbx" ref={fbxInput} onChange={e => handleFile(e, 'fbx')} />
    </header>
    <nav className="tabs">{([['global', '全局地图'], ['types', '类型与连接'], ['modules', '具体模块'], ['preview', '随机预览']] as const).map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {notice && <div role="status" className="notice" onClick={() => setNotice('')}>{notice}<button title="关闭">×</button></div>}
    <main className="content">
      {tab === 'global' && <div className="page narrow"><div className="page-title"><div><span className="eyebrow">01 / MAP RULES</span><h1>全局地图规则</h1><p>比例决定每张地图的目标数量；必出数量是类型最低要求。</p></div></div>
        <section className="card"><h2>地图规模</h2><div className="row three"><NumberField label="模块总数" value={project.settings.totalModules} min={1} max={500} onChange={n => mutate(d => { d.settings.totalModules = n })} /><Field label="起始类型"><select value={project.settings.startTypeId} onChange={e => mutate(d => { d.settings.startTypeId = e.target.value })}><option value="">选择类型</option>{project.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field><NumberField label="统一门洞宽度" value={project.settings.doorWidth / 1000} min={0.001} step={0.001} suffix="m" onChange={n => mutate(d => { d.settings.doorWidth = toMm(n) })} /></div></section>
        <section className="card"><div className="section-head"><h2>类型目标</h2><span className={Math.abs(project.types.reduce((n, t) => n + t.percent, 0) - 100) < 0.000001 ? 'badge good' : 'badge warn'}>合计 {project.types.reduce((n, t) => n + t.percent, 0)}%</span></div>
          <div className="target-table"><div className="target-head"><span>类型</span><span>比例</span><span>目标个数</span><span>必出至少</span></div>{project.types.map(t => <div className="target-row" key={t.id}><span><i style={{ background: t.color }} />{t.name}</span><span>{t.percent}%</span><strong>{targets[t.id] ?? 0}</strong><span>{t.requiredMin}</span></div>)}</div>
          {!project.types.length && <p className="empty">先到“类型与连接”创建类型。</p>}
        </section><Validation errors={errors} /></div>}
      {tab === 'types' && <div className="page types-page"><div className="page-title"><div><span className="eyebrow">02 / TYPES & RELATIONS</span><h1>类型与连接</h1><p>图中的线表示允许连接，不代表实际地图位置。连线两端可分别设置权重。</p></div></div>
        <div className="split-layout"><aside className="side-panel"><section className="card"><h2>类型</h2><div className="list">{project.types.map(t => <button key={t.id} className={`list-item ${selectedType === t.id ? 'selected' : ''}`} onClick={() => setSelectedType(t.id)}><i style={{ background: t.color }} /><span>{t.name}<small>{t.id} · {t.percent}%</small></span></button>)}</div><div className="add-form"><input placeholder="类型 ID，如 entrance" value={newTypeId} onChange={e => setNewTypeId(e.target.value)} /><input placeholder="名称，如 入口" value={newTypeName} onChange={e => setNewTypeName(e.target.value)} /><button onClick={addType}>＋ 创建类型</button></div></section>
          {type && <section className="card"><div className="section-head"><h2>{type.name}</h2><button className="danger-text" onClick={() => removeType(type.id)}>删除类型</button></div><Field label="名称"><input value={type.name} onChange={e => updateType(type.id, t => { t.name = e.target.value })} /></Field><Field label="颜色"><input type="color" value={type.color} onChange={e => updateType(type.id, t => { t.color = e.target.value })} /></Field><div className="row two"><NumberField label="地图比例" value={type.percent} min={0} max={100} step={0.1} suffix="%" onChange={n => updateType(type.id, t => { t.percent = n })} /><NumberField label="必出至少" value={type.requiredMin} min={0} onChange={n => updateType(type.id, t => { t.requiredMin = n })} /></div><SpawnEditor title="物品" rule={type.items} onChange={rule => updateType(type.id, t => { t.items = rule })} /><SpawnEditor title="敌人" rule={type.enemies} onChange={rule => updateType(type.id, t => { t.enemies = rule })} /></section>}</aside>
          <div className="main-panel"><section className="card graph-card"><div className="section-head"><h2>类型连接图</h2><span className="hint">拖动节点调整布局；拖线或用下方表单添加连接</span></div><div className="graph"><ReactFlow nodes={graphNodes} edges={graphEdges} fitView onConnect={onConnect} onNodesChange={changes => { const moved: Record<string, { x: number; y: number }> = {}; for (const change of changes) if (change.type === 'position' && change.position) moved[change.id] = change.position; if (Object.keys(moved).length) setEditor(current => ({ ...current, graphPositions: { ...current.graphPositions, ...moved } })) }} onNodeClick={(_, node) => setSelectedType(node.id)} minZoom={0.3} maxZoom={2}><Background color="#324154" /><Controls /></ReactFlow></div></section>
            <section className="card"><h2>连接权重</h2><div className="connection-add"><select value={edgeA} onChange={e => setEdgeA(e.target.value)}><option value="">类型 A</option>{project.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><span>↔</span><select value={edgeB} onChange={e => setEdgeB(e.target.value)}><option value="">类型 B</option>{project.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><button onClick={() => addConnection(edgeA, edgeB)}>添加关系</button></div>
              <div className="relations">{project.connections.map(c => <div className="relation" key={pairKey(c.a, c.b)}><strong>{project.types.find(t => t.id === c.a)?.name ?? c.a} ↔ {project.types.find(t => t.id === c.b)?.name ?? c.b}</strong><label>{c.a} → {c.b}<input type="number" min="0.001" step="0.1" value={c.weightAB} onChange={e => mutate(d => { const target = d.connections.find(v => pairKey(v.a, v.b) === pairKey(c.a, c.b))!; target.weightAB = num(e.target.value) })} /></label>{c.a !== c.b && <label>{c.b} → {c.a}<input type="number" min="0.001" step="0.1" value={c.weightBA} onChange={e => mutate(d => { const target = d.connections.find(v => pairKey(v.a, v.b) === pairKey(c.a, c.b))!; target.weightBA = num(e.target.value) })} /></label>}<button className="icon danger" title="删除双向连接" onClick={() => mutate(d => { d.connections = d.connections.filter(v => pairKey(v.a, v.b) !== pairKey(c.a, c.b)) })}>×</button></div>)}</div>{!project.connections.length && <p className="empty">尚无连接关系。</p>}
            </section></div></div></div>}
      {tab === 'modules' && <div className="page modules-page"><div className="page-title"><div><span className="eyebrow">03 / MODULE LIBRARY</span><h1>具体模块</h1><p>导入 FBX 提取占地；在矩形边缘拖动连接口。黄色十字标出模型原点。</p></div></div><div className="split-layout"><aside className="side-panel"><section className="card"><h2>模块库</h2><div className="list">{project.modules.map(m => <button key={m.id} className={`list-item ${selectedModule === m.id ? 'selected' : ''}`} onClick={() => setSelectedModule(m.id)}><i style={{ background: project.types.find(t => t.id === m.typeId)?.color ?? '#64748b' }} /><span>{m.id}<small>{project.types.find(t => t.id === m.typeId)?.name ?? m.typeId} · {m.ports.length} 个接口</small></span></button>)}</div><div className="add-form"><input placeholder="模块 ID，如 room_a" value={newModuleId} onChange={e => setNewModuleId(e.target.value)} /><select value={newModuleType} onChange={e => setNewModuleType(e.target.value)}><option value="">选择类型</option>{project.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><button onClick={addModule}>＋ 创建模块</button></div></section></aside>
          <div className="main-panel">{module ? <><section className="card"><div className="section-head"><div><h2>{module.id}</h2><p className="hint">{editor.modelNames[module.id] ?? '尚未导入 FBX，可先手动编辑占地'}</p></div><div className="inline-actions"><button onClick={() => fbxInput.current?.click()}>导入 / 替换 FBX</button><button className="danger-text" onClick={() => removeModule(module.id)}>删除模块</button></div></div><div className="row three"><Field label="所属类型"><select value={module.typeId} onChange={e => updateModule(module.id, m => { m.typeId = e.target.value })}>{project.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field><div className="metric"><span>宽度 X</span><strong>{meters(module.bounds.maxX - module.bounds.minX)} m</strong></div><div className="metric"><span>深度 Z</span><strong>{meters(module.bounds.maxZ - module.bounds.minZ)} m</strong></div></div></section>
            <section className="card"><h2>2D 占地与接口</h2><ModuleCanvas module={module} doorWidth={project.settings.doorWidth} onPortChange={(id, next) => updateModule(module.id, m => { const i = m.ports.findIndex(p => p.id === id); if (i >= 0) m.ports[i] = next })} onAddPort={edge => updateModule(module.id, m => { const b = m.bounds; const half = project.settings.doorWidth / 2; if ((edge === 'N' || edge === 'S' ? b.maxX - b.minX : b.maxZ - b.minZ) < project.settings.doorWidth) { setNotice('该边短于门洞宽度'); return } const id = uniqueId(m.ports.map(p => p.id), 'port'); const centerX = Math.round((b.minX + b.maxX) / 2), centerZ = Math.round((b.minZ + b.maxZ) / 2); m.ports.push({ id, edge, x: edge === 'E' ? b.maxX : edge === 'W' ? b.minX : Math.max(b.minX + half, Math.min(b.maxX - half, centerX)), z: edge === 'N' ? b.maxZ : edge === 'S' ? b.minZ : Math.max(b.minZ + half, Math.min(b.maxZ - half, centerZ)) }) })} onDeletePort={id => updateModule(module.id, m => { m.ports = m.ports.filter(p => p.id !== id) })} /></section>
            <section className="card"><h2>占地边界（相对模型原点）</h2><div className="row four">{(['minX', 'maxX', 'minZ', 'maxZ'] as const).map(key => <NumberField key={key} label={key} value={module.bounds[key] / 1000} step={0.001} suffix="m" onChange={n => setBounds(key, n)} />)}</div><p className="hint">手动修改边界会保留原点偏移，并自动把接口约束在所在边上。</p></section>
            <section className="card"><h2>连接口</h2>{module.ports.map(port => <div className="port-row" key={port.id}><strong>{port.id}</strong><span>{edgeNames[port.edge]}</span><span>({meters(port.x)}, {meters(port.z)}) m</span><button className="icon danger" onClick={() => updateModule(module.id, m => { m.ports = m.ports.filter(p => p.id !== port.id) })}>×</button></div>)}{!module.ports.length && <p className="empty">使用上方画布的“＋ 接口”添加。</p>}</section>
          </> : <div className="card empty large">选择或创建一个模块。</div>}</div></div></div>}
      {tab === 'preview' && <div className="page preview-page"><div className="page-title"><div><span className="eyebrow">04 / GENERATION PREVIEW</span><h1>随机地图预览</h1><p>矩形按真实占地绘制；同一随机种子可复现布局。</p></div><div className="preview-controls"><Field label="随机种子"><input type="number" min="0" max="4294967295" value={seed} onChange={e => setSeed(num(e.target.value) >>> 0)} /></Field><button className="quiet" onClick={() => setSeed(Math.floor(Math.random() * 4294967295))}>换种子</button><button className="primary" disabled={generating || !!errors.length} onClick={startPreview}>{generating ? '生成中…' : '生成预览'}</button>{generating && <button onClick={() => { stopWorker(); setNotice('已停止搜索') }}>停止</button>}</div></div>
        {errors.length > 0 && <Validation errors={errors} />}
        <div className="preview-layout"><section className="card preview-stage">{preview?.placements.length ? <PreviewCanvas project={project} result={preview} /> : <div className="placeholder"><span>◇</span><h2>等待生成地图</h2><p>先创建类型、模块与连接规则，再点击“生成预览”。</p></div>}</section><aside className="card preview-info"><h2>生成结果</h2>{preview ? <><div className={`result-status ${preview.complete ? 'success' : 'warning'}`}>{preview.complete ? '✓ 满足全部目标' : '⚠ 当前最佳结果'}</div><div className="stats"><div><span>已放置</span><strong>{preview.placements.length} / {project.settings.totalModules}</strong></div><div><span>随机种子</span><strong>{preview.seed}</strong></div><div><span>候选检查</span><strong>{preview.checks.toLocaleString()}</strong></div><div><span>重新尝试</span><strong>{preview.restarts}</strong></div></div><h3>类型数量</h3>{project.types.map(t => <div className="quota-line" key={t.id}><span><i style={{ background: t.color }} />{t.name}</span><b>{preview.placements.filter(p => p.typeId === t.id).length} / {preview.targets[t.id] ?? 0}</b></div>)}{preview.warnings.length > 0 && <><h3>偏差与告警</h3><ul className="warnings">{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></>}</> : <p className="empty">生成后在此查看数量、比例和失败原因。</p>}</aside></div></div>}
    </main><footer>v1 · 浏览器本地处理文件 · X-Z 平面 · 1 单位 = 1 米</footer>
  </div>
}

function Validation({ errors }: { errors: string[] }) { return <section className={`card validation ${errors.length ? 'has-errors' : 'valid'}`}><h2>{errors.length ? `需要修正 ${errors.length} 项` : '✓ 规则校验通过'}</h2>{errors.length > 0 ? <ul>{errors.map((error, i) => <li key={i}>{error}</li>)}</ul> : <p>可以生成预览并导出运行时 JSON。</p>}</section> }
