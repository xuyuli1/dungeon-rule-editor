import { meters, type Module } from './model'

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
// The docked panel on the right that shows one type, module or new-type view at a time. `title` is a user ID and is shown as typed.
// `phase` drives the switch animation: 'out' dims the old content, 'in' brings the new content back.
export function InspectorPanel({ kind, title, phase = 'idle', onClose, children }: { kind: string; title: string; phase?: 'idle' | 'out' | 'in'; onClose: () => void; children: React.ReactNode }) {
  const label = title ? `${kind} ${title}` : kind
  return <aside className={`inspector ${phase === 'idle' ? '' : `inspector--${phase}`}`} aria-label={label} aria-busy={phase === 'out'}>
    <header className="inspector-head"><div><span className="inspector-kind">{kind}</span>{title && <strong className="inspector-title">{title}</strong>}</div><button className="icon" aria-label={`Close ${label}`} title="Close (Esc)" onClick={onClose}>×</button></header>
    <div className="inspector-body">{children}</div>
  </aside>
}
