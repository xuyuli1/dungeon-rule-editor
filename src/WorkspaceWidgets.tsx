import { useEffect, useRef, useState } from 'react'
import { meters, type Module, type WindowLayout } from './model'

export function ModuleSlot({ module, selected }: { module: Module; selected: boolean }) {
  const b = module.bounds
  const w = b.maxX - b.minX, h = b.maxZ - b.minZ
  const pad = Math.max(w, h) * .08
  return <div className={`module-slot ${selected ? 'selected' : ''}`}>
    <svg viewBox={`${b.minX - pad} ${-b.maxZ - pad} ${w + 2 * pad} ${h + 2 * pad}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <rect x={b.minX} y={-b.maxZ} width={w} height={h} fill="none" stroke="currentColor" strokeWidth={Math.max(w, h) / 70} />
      {module.ports.map(p => <circle key={p.id} cx={p.x} cy={-p.z} r={Math.max(w, h) / 35} fill="currentColor" />)}
    </svg><strong>{module.id}</strong><small>{meters(w)} × {meters(b.maxY - b.minY)} × {meters(h)} m · {module.ports.length} ports</small>
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
