import { useInternalNode, type EdgeProps } from '@xyflow/react'

type Rect = { x: number; y: number; width: number; height: number }

function rectFor(node: ReturnType<typeof useInternalNode>): Rect | null {
  if (!node) return null
  return { x: node.internals.positionAbsolute.x, y: node.internals.positionAbsolute.y, width: node.measured.width ?? 190, height: node.measured.height ?? 76 }
}

function boundary(rect: Rect, dx: number, dy: number) {
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2
  const scale = Math.min(dx ? rect.width / 2 / Math.abs(dx) : Infinity, dy ? rect.height / 2 / Math.abs(dy) : Infinity)
  return { x: cx + dx * scale, y: cy + dy * scale }
}

export function RelationEdge({ id, source, target, selected, style }: EdgeProps) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  const a = rectFor(sourceNode), b = rectFor(targetNode)
  if (!a || !b) return null
  const markerId = `relation-arrow-${source}-${target}`
  const color = String(style?.stroke ?? '#b8d9d7')
  const opacity = Number(style?.opacity ?? 1)
  const common = { fill: 'none', stroke: color, strokeWidth: selected ? 2.4 : 1.8, opacity, className: 'relation-stroke' }

  if (source === target) {
    const x = a.x + a.width, y = a.y + a.height / 2
    const path = `M ${x} ${y + 10} L ${x + 36} ${y + 10} L ${x + 36} ${y - a.height / 2 - 30} L ${x + a.width * -0.28} ${y - a.height / 2 - 30} L ${x + a.width * -0.28} ${a.y}`
    return <g className="react-flow__edge-path-group" data-edge-id={id}>
      <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={color} /></marker></defs>
      <path d={path} {...common} markerEnd={`url(#${markerId})`} /><path d={path} fill="none" stroke="transparent" strokeWidth="20" className="relation-hit" />
    </g>
  }

  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  const dx = bc.x - ac.x, dy = bc.y - ac.y
  const length = Math.hypot(dx, dy) || 1
  const start = boundary(a, dx, dy), end = boundary(b, -dx, -dy)
  const nx = -dy / length * 6, ny = dx / length * 6
  const forward = `M ${start.x + nx} ${start.y + ny} L ${end.x + nx} ${end.y + ny}`
  const backward = `M ${end.x - nx} ${end.y - ny} L ${start.x - nx} ${start.y - ny}`
  return <g className="react-flow__edge-path-group" data-edge-id={id}>
    <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={color} /></marker></defs>
    <path d={forward} {...common} markerEnd={`url(#${markerId})`} />
    <path d={backward} {...common} markerEnd={`url(#${markerId})`} />
    <path d={forward} fill="none" stroke="transparent" strokeWidth="18" className="relation-hit" />
    <path d={backward} fill="none" stroke="transparent" strokeWidth="18" className="relation-hit" />
  </g>
}
