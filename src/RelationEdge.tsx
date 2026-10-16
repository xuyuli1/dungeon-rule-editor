import { useInternalNode, type EdgeProps } from '@xyflow/react'

type Rect = { x: number; y: number; width: number; height: number }

function rectFor(node: ReturnType<typeof useInternalNode>): Rect | null {
  if (!node) return null
  return { x: node.internals.positionAbsolute.x, y: node.internals.positionAbsolute.y, width: node.measured.width ?? 190, height: node.measured.height ?? 76 }
}

function boundary(rect: Rect, dx: number, dy: number, offsetX = 0, offsetY = 0) {
  const cx = rect.x + rect.width / 2 + offsetX, cy = rect.y + rect.height / 2 + offsetY
  const tx = dx > 0 ? (rect.x + rect.width - cx) / dx : dx < 0 ? (rect.x - cx) / dx : Infinity
  const ty = dy > 0 ? (rect.y + rect.height - cy) / dy : dy < 0 ? (rect.y - cy) / dy : Infinity
  const scale = Math.min(tx, ty)
  return { x: cx + dx * scale, y: cy + dy * scale }
}

export function RelationEdge({ id, source, target, selected, style, data }: EdgeProps) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  const a = rectFor(sourceNode), b = rectFor(targetNode)
  if (!a || !b) return null
  const markerId = `relation-arrow-${source.length}-${source}-${target}`
  const color = String(style?.stroke ?? '#b8d9d7')
  const opacity = Number(style?.opacity ?? 1)
  const { weight = 1, reverse = false } = (data ?? {}) as { weight?: number; reverse?: boolean }
  const label = (x: number, y: number) => <g><rect x={x - 18} y={y - 11} width="36" height="22" fill="transparent" className="relation-label-hit" /><text x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="relation-weight" opacity={opacity} fill="#f4f8f6" stroke="#091922" strokeWidth="5" paintOrder="stroke" pointerEvents="none">{weight}</text></g>
  const common = { fill: 'none', stroke: color, strokeWidth: selected ? 2.4 : 1.8, opacity, className: 'relation-stroke' }
  const arrow = <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill={color} /></marker></defs>

  if (source === target) {
    const left = a.x + a.width * .28, right = a.x + a.width * .72, top = a.y - 18
    const path = `M ${right} ${a.y} L ${right} ${top} L ${left} ${top} L ${left} ${a.y}`
    return <g className="react-flow__edge-path-group" data-edge-id={id}>{arrow}
      <path d={path} {...common} markerEnd={`url(#${markerId})`} /><path d={path} fill="none" stroke="transparent" strokeWidth="18" className="relation-hit" />
      {label(a.x + a.width / 2, top - 7)}
    </g>
  }

  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  const dx = bc.x - ac.x, dy = bc.y - ac.y
  const length = Math.hypot(dx, dy) || 1
  // Opposite arrows use opposite normals, so the same offset separates both tracks.
  const nx = reverse ? -dy / length * 13 : 0, ny = reverse ? dx / length * 13 : 0
  const start = boundary(a, dx, dy, nx, ny), end = boundary(b, -dx, -dy, nx, ny)
  const x1 = start.x, y1 = start.y, x2 = end.x, y2 = end.y
  const path = `M ${x1} ${y1} L ${x2} ${y2}`
  return <g className="react-flow__edge-path-group" data-edge-id={id}>{arrow}
    <path d={path} {...common} markerEnd={`url(#${markerId})`} />
    <path d={path} fill="none" stroke="transparent" strokeWidth="16" className="relation-hit" />
    {label(x1 + (x2 - x1) * .5, y1 + (y2 - y1) * .5 - 8)}
  </g>
}
