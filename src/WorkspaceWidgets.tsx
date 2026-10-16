import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { nearestValidPort, portAtBoundary, unitsPerPixel } from './geometry'
import { previewDoors, rotatedBounds, type PreviewResult, type SpawnMarker } from './generator'
import { meters, type Module, type Port, type RuntimeProject, type WindowLayout } from './model'

export function ModuleSlot({ module, selected }: { module: Module; selected: boolean }) {
  const b = module.bounds
  const w = b.maxX - b.minX, h = b.maxZ - b.minZ
  const pad = Math.max(w, h) * .08
  return <div className={`module-slot ${selected ? 'selected' : ''}`}>
    <svg viewBox={`${b.minX - pad} ${-b.maxZ - pad} ${w + 2 * pad} ${h + 2 * pad}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <rect x={b.minX} y={-b.maxZ} width={w} height={h} fill="none" stroke="currentColor" strokeWidth={Math.max(w, h) / 70} />
      {module.ports.map(p => <circle key={p.id} cx={p.x} cy={-p.z} r={Math.max(w, h) / 35} fill="currentColor" />)}
    </svg><strong>{module.id}</strong><small>{meters(w)} × {meters(h)} m · {module.ports.length} ports</small>
  </div>
}

export function FloatingWindow({ layout, title, onChange, onFocus, onClose, children }: { layout: WindowLayout; title: string; onChange: (next: WindowLayout) => void; onFocus: () => void; onClose: () => void; children: React.ReactNode }) {
  const pointer = useRef<{ x: number; y: number; original: WindowLayout; mode: 'move' | 'resize' } | null>(null)
  const [screen, setScreen] = useState({ width: window.innerWidth, height: window.innerHeight })
  useEffect(() => { const resize = () => setScreen({ width: window.innerWidth, height: window.innerHeight }); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize) }, [])
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const p = pointer.current
    if (!p) return
    const dx = event.clientX - p.x, dy = event.clientY - p.y
    const screenW = screen.width, screenH = screen.height
    if (p.mode === 'move') onChange({ ...layout, x: clamp(p.original.x + dx, 8, Math.max(8, screenW - Math.min(layout.width, screenW - 16))), y: clamp(p.original.y + dy, 8, Math.max(8, screenH - 50)) })
    else onChange({ ...layout, width: clamp(p.original.width + dx, 300, Math.max(300, screenW - p.original.x - 8)), height: clamp(p.original.height + dy, 240, Math.max(240, screenH - p.original.y - 8)) })
  }
  const start = (event: React.PointerEvent<HTMLElement>, mode: 'move' | 'resize') => { event.stopPropagation(); onFocus(); pointer.current = { x: event.clientX, y: event.clientY, original: { ...layout, x, y, width, height }, mode }; event.currentTarget.setPointerCapture(event.pointerId) }
  const width = Math.min(layout.width, Math.max(280, screen.width - 16))
  const x = clamp(layout.x, 8, Math.max(8, screen.width - width - 8))
  const y = clamp(layout.y, 8, Math.max(8, screen.height - 250))
  const height = Math.min(layout.height, Math.max(240, screen.height - y - 8))
  return <section className="floating-window" style={{ left: x, top: y, width, height, zIndex: layout.z }} onPointerDown={onFocus} aria-label={`${title} details`}>
    <header className="floating-title" onPointerDown={e => start(e, 'move')} onPointerMove={move} onPointerUp={() => { pointer.current = null }} onPointerCancel={() => { pointer.current = null }}><span>{title}</span><button className="icon" aria-label={`Close ${title}`} onPointerDown={e => e.stopPropagation()} onClick={onClose}>×</button></header>
    <div className="floating-body">{children}</div><div className="window-resize" role="button" aria-label={`Resize ${title}`} onPointerDown={e => start(e, 'resize')} onPointerMove={move} onPointerUp={() => { pointer.current = null }} onPointerCancel={() => { pointer.current = null }} />
  </section>
}

export function ModuleCanvas({ module, doorWidth, onPortChange, onAddPort, onError }: { module: Module; doorWidth: number; onPortChange: (id: string, next: Port) => void; onAddPort: (point: Pick<Port, 'edge' | 'x' | 'z'>) => void; onError: (message: string) => void }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [placing, setPlacing] = useState(false)
  const [ghost, setGhost] = useState<Pick<Port, 'edge' | 'x' | 'z'> | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [pixelSize, setPixelSize] = useState({ width: 800, height: 380 })
  const b = module.bounds
  const displayMinX = Math.min(b.minX, 0), displayMaxX = Math.max(b.maxX, 0)
  const displayMinZ = Math.min(b.minZ, 0), displayMaxZ = Math.max(b.maxZ, 0)
  const spanX = displayMaxX - displayMinX, spanZ = displayMaxZ - displayMinZ
  const pad = Math.max(spanX, spanZ) * .2 + 500
  const viewWidth = spanX + pad * 2, viewHeight = spanZ + pad * 2
  const unit = unitsPerPixel(viewWidth, viewHeight, pixelSize.width, pixelSize.height)
  useLayoutEffect(() => { const svg = svgRef.current; if (!svg) return; const resize = () => { const r = svg.getBoundingClientRect(); setPixelSize({ width: r.width, height: r.height }) }; resize(); const observer = new ResizeObserver(resize); observer.observe(svg); return () => observer.disconnect() }, [])
  useEffect(() => { if (!placing) return; const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPlacing(false); setGhost(null) } }; document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape) }, [placing])
  const point = (e: React.PointerEvent<SVGSVGElement>) => { const svg = svgRef.current!; const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; const local = p.matrixTransform(svg.getScreenCTM()!.inverse()); return { x: local.x, z: -local.y } }
  const update = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = point(e)
    if (dragging) { const original = module.ports.find(port => port.id === dragging); const next = nearestValidPort(b, p.x, p.z, doorWidth); if (original && next) onPortChange(dragging, { ...original, ...next }) }
    if (placing) setGhost(portAtBoundary(b, p.x, p.z, doorWidth, unit * 22))
  }
  return <div className="module-canvas"><div className="canvas-toolbar"><span>X →　Z ↑　meters</span><button className={placing ? 'primary' : 'quiet'} onClick={() => { setPlacing(!placing); setGhost(null) }}>{placing ? 'Cancel placement (Esc)' : '+ Add port'}</button></div>
    <svg ref={svgRef} className={`module-svg ${placing ? 'placing' : ''}`} viewBox={`${displayMinX - pad} ${-displayMaxZ - pad} ${viewWidth} ${viewHeight}`} onPointerMove={update} onPointerUp={e => { if (dragging) { setDragging(null); e.currentTarget.releasePointerCapture(e.pointerId) } }} onPointerCancel={() => setDragging(null)} onClick={e => { if (!placing) return; e.stopPropagation(); if (!ghost) { onError('Place the port near a valid boundary, clear of corners by half the door width.'); return } onAddPort(ghost); setPlacing(false); setGhost(null) }}>
      <rect x={displayMinX - pad} y={-displayMaxZ - pad} width={viewWidth} height={viewHeight} fill="#102029" />
      <rect x={b.minX} y={-b.maxZ} width={b.maxX - b.minX} height={b.maxZ - b.minZ} fill="#20343c" stroke="#e5eeeb" strokeWidth={unit * 2} />
      <path d={`M ${-unit * 9} 0 H ${unit * 9} M 0 ${-unit * 9} V ${unit * 9}`} stroke="#fff" strokeWidth={unit * 2} />
      {module.ports.map(port => <g key={port.id} className="port-handle" onPointerDown={e => { e.stopPropagation(); e.currentTarget.parentElement?.setPointerCapture(e.pointerId); setDragging(port.id) }}><circle cx={port.x} cy={-port.z} r={unit * 16} fill="transparent" /><circle cx={port.x} cy={-port.z} r={unit * 7} fill="#d8f5f1" stroke="#06131b" strokeWidth={unit * 2} pointerEvents="none" /><text x={port.x + unit * 10} y={-port.z - unit * 10} fontSize={unit * 12} fill="#fff" stroke="#06131b" strokeWidth={unit * 3} paintOrder="stroke" pointerEvents="none">{port.id}</text></g>)}
      {placing && ghost && <circle cx={ghost.x} cy={-ghost.z} r={unit * 9} fill="#d8f5f1" opacity=".7" pointerEvents="none" />}
    </svg><p className="hint">Click a boundary to place. Drag a port across any side. Esc cancels.</p>
  </div>
}

export function PreviewCanvas({ project, result }: { project: RuntimeProject; result: PreviewResult }) {
  const previewRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; view: { x: number; y: number; width: number; height: number } } | null>(null)
  const [selected, setSelected] = useState<SpawnMarker | null>(null)
  const modules = new Map(project.modules.map(m => [m.id, m]))
  const types = new Map(project.types.map(t => [t.id, t]))
  const boxes = result.placements.map(p => rotatedBounds(modules.get(p.moduleId)!.bounds, p.rotation, p.x, p.z))
  const doors = previewDoors(project, result.placements)
  const minX = Math.min(...boxes.map(b => b.minX)), maxX = Math.max(...boxes.map(b => b.maxX)), minZ = Math.min(...boxes.map(b => b.minZ)), maxZ = Math.max(...boxes.map(b => b.maxZ))
  const pad = Math.max(maxX - minX, maxZ - minZ) * .12 + 1000
  const fitted = { x: minX - pad, y: -maxZ - pad, width: maxX - minX + pad * 2, height: maxZ - minZ + pad * 2 }
  const [view, setView] = useState(fitted)
  useEffect(() => { setView(fitted); setSelected(null) }, [result])
  const unit = view.width / (svgRef.current?.clientWidth || 420)
  const placementById = new Map(result.placements.map((p, i) => [p.instanceId, boxes[i]]))
  const zoom = (factor: number, clientX?: number, clientY?: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const fx = clientX === undefined ? .5 : (clientX - rect.left) / rect.width
    const fy = clientY === undefined ? .5 : (clientY - rect.top) / rect.height
    setView(v => { const width = Math.max(100, Math.min(fitted.width * 20, v.width * factor)), height = Math.max(100, Math.min(fitted.height * 20, v.height * factor)); return { x: v.x + (v.width - width) * fx, y: v.y + (v.height - height) * fy, width, height } })
  }
  useEffect(() => {
    const preview = previewRef.current
    if (!preview) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.deltaY !== 0) zoom(event.deltaY > 0 ? 1.1 : 1 / 1.1, event.clientX, event.clientY)
    }
    preview.addEventListener('wheel', handleWheel, { passive: false })
    return () => preview.removeEventListener('wheel', handleWheel)
  }, [fitted.width, fitted.height])
  return <div ref={previewRef} className="preview-interactive"><div className="preview-tools"><button aria-label="Zoom in" onClick={() => zoom(.8)}>+</button><button aria-label="Zoom out" onClick={() => zoom(1.25)}>−</button><button onClick={() => setView(fitted)}>Fit</button></div>
    <svg ref={svgRef} className="preview-svg" viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} preserveAspectRatio="xMidYMid meet" onPointerDown={e => { if ((e.target as Element).closest('.spawn-marker')) return; drag.current = { x: e.clientX, y: e.clientY, view }; e.currentTarget.setPointerCapture(e.pointerId) }} onPointerMove={e => { const p = drag.current; const rect = svgRef.current?.getBoundingClientRect(); if (p && rect) setView({ ...p.view, x: p.view.x - (e.clientX - p.x) * p.view.width / rect.width, y: p.view.y - (e.clientY - p.y) * p.view.height / rect.height }) }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      {result.placements.map((p, index) => { const b = boxes[index], color = types.get(p.typeId)?.color ?? '#65b9d4', font = Math.min(unit * 11, (b.maxX - b.minX) * .16); return <g key={p.instanceId}><rect x={b.minX} y={-b.maxZ} width={b.maxX - b.minX} height={b.maxZ - b.minZ} fill={color} fillOpacity=".24" stroke={color} strokeWidth={unit * 1.5} /><circle cx={p.x} cy={-p.z} r={unit * 2} fill={color} /><text x={(b.minX + b.maxX) / 2} y={-(b.minZ + b.maxZ) / 2} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={font} stroke="#071219" strokeWidth={unit * 2} paintOrder="stroke">{p.moduleId}</text></g> })}
      {doors.map(door => <line key={`${door.instanceId}-${door.portId}`} x1={door.x1} y1={-door.z1} x2={door.x2} y2={-door.z2} stroke="#f4f8f6" strokeWidth={unit * 3} strokeDasharray={door.connected ? `${project.settings.doorWidth / 5} ${project.settings.doorWidth / 9}` : undefined} strokeLinecap="butt" pointerEvents="none" aria-hidden="true" />)}
      {result.markers.map((m, i) => { const box = placementById.get(m.instanceId)!, r = Math.min(unit * 5, Math.min(box.maxX - box.minX, box.maxZ - box.minZ) * .11); return <g key={`${m.instanceId}-${m.kind}-${i}`} className="spawn-marker" onClick={e => { e.stopPropagation(); setSelected(m) }}><title>{m.kind}: {m.id} · {m.instanceId}</title>{m.kind === 'item' ? <circle cx={m.x} cy={-m.z} r={r} fill="#fff" stroke="#071219" strokeWidth={r * .25} /> : <path d={`M ${m.x} ${-m.z - r * 1.2} l ${r * 1.15} ${r * 2.1} h ${-r * 2.3} Z`} fill="#ff9a80" stroke="#071219" strokeWidth={r * .25} />}</g> })}
    </svg><div className="door-legend">SOLID · UNUSED <span>┄</span> DASHED · CONNECTED</div>{selected && <div className="marker-detail">{selected.kind.toUpperCase()} · {selected.id} · {selected.instanceId}<button onClick={() => setSelected(null)} aria-label="Close marker details">×</button></div>}</div>
}
