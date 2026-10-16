import type { Bounds, Edge, Port } from './model'

type PortPosition = Pick<Port, 'edge' | 'x' | 'y' | 'z'>

export function portAtBoundary(bounds: Bounds, x: number, y: number, z: number, width: number, height: number, tolerance = 0): PortPosition | null {
  if (bounds.maxY - bounds.minY < height || y < bounds.minY + height / 2 || y > bounds.maxY - height / 2) return null
  const sides: { edge: Edge; distance: number; along: number; min: number; max: number }[] = [
    { edge: 'N', distance: Math.abs(z - bounds.maxZ), along: x, min: bounds.minX, max: bounds.maxX },
    { edge: 'E', distance: Math.abs(x - bounds.maxX), along: z, min: bounds.minZ, max: bounds.maxZ },
    { edge: 'S', distance: Math.abs(z - bounds.minZ), along: x, min: bounds.minX, max: bounds.maxX },
    { edge: 'W', distance: Math.abs(x - bounds.minX), along: z, min: bounds.minZ, max: bounds.maxZ },
  ]
  const side = sides.filter(s => s.max - s.min >= width && s.along >= s.min + width / 2 && s.along <= s.max - width / 2).sort((a, b) => a.distance - b.distance)[0]
  if (!side || side.distance > tolerance) return null
  return side.edge === 'N' || side.edge === 'S'
    ? { edge: side.edge, x: Math.round(x), y: Math.round(y), z: side.edge === 'N' ? bounds.maxZ : bounds.minZ }
    : { edge: side.edge, x: side.edge === 'E' ? bounds.maxX : bounds.minX, y: Math.round(y), z: Math.round(z) }
}

export function nearestValidPort(bounds: Bounds, x: number, y: number, z: number, width: number, height: number): PortPosition | null {
  if (bounds.maxY - bounds.minY < height) return null
  const half = width / 2
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)))
  const vertical = clamp(y, bounds.minY + height / 2, bounds.maxY - height / 2)
  const candidates: PortPosition[] = []
  if (bounds.maxX - bounds.minX >= width) {
    candidates.push({ edge: 'N', x: clamp(x, bounds.minX + half, bounds.maxX - half), y: vertical, z: bounds.maxZ })
    candidates.push({ edge: 'S', x: clamp(x, bounds.minX + half, bounds.maxX - half), y: vertical, z: bounds.minZ })
  }
  if (bounds.maxZ - bounds.minZ >= width) {
    candidates.push({ edge: 'E', x: bounds.maxX, y: vertical, z: clamp(z, bounds.minZ + half, bounds.maxZ - half) })
    candidates.push({ edge: 'W', x: bounds.minX, y: vertical, z: clamp(z, bounds.minZ + half, bounds.maxZ - half) })
  }
  candidates.sort((a, b) => (a.x - x) ** 2 + (a.y - y) ** 2 + (a.z - z) ** 2 - ((b.x - x) ** 2 + (b.y - y) ** 2 + (b.z - z) ** 2))
  return candidates[0] ?? null
}

export function remapPorts(ports: Port[], before: Bounds, after: Bounds, width: number, height: number): Port[] {
  const half = width / 2
  const clamp = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, value)))
  return ports.map(port => {
    const horizontal = port.edge === 'N' || port.edge === 'S'
    const oldMin = horizontal ? before.minX : before.minZ
    const oldSize = horizontal ? before.maxX - before.minX : before.maxZ - before.minZ
    const newMin = horizontal ? after.minX : after.minZ
    const newMax = horizontal ? after.maxX : after.maxZ
    const fraction = oldSize > 0 ? ((horizontal ? port.x : port.z) - oldMin) / oldSize : .5
    const position = newMax - newMin >= width ? clamp(newMin + fraction * (newMax - newMin), newMin + half, newMax - half) : Math.round((newMin + newMax) / 2)
    const yFraction = before.maxY > before.minY ? (port.y - before.minY) / (before.maxY - before.minY) : .5
    const y = after.maxY - after.minY >= height ? clamp(after.minY + yFraction * (after.maxY - after.minY), after.minY + height / 2, after.maxY - height / 2) : Math.round((after.minY + after.maxY) / 2)
    return horizontal
      ? { ...port, x: position, y, z: port.edge === 'N' ? after.maxZ : after.minZ }
      : { ...port, x: port.edge === 'E' ? after.maxX : after.minX, y, z: position }
  })
}
