import type { Bounds, Edge, Port } from './model'

export function portAtBoundary(bounds: Bounds, x: number, z: number, doorWidth: number, tolerance = 0): Pick<Port, 'edge' | 'x' | 'z'> | null {
  const sides: { edge: Edge; distance: number; along: number; min: number; max: number }[] = [
    { edge: 'N', distance: Math.abs(z - bounds.maxZ), along: x, min: bounds.minX, max: bounds.maxX },
    { edge: 'E', distance: Math.abs(x - bounds.maxX), along: z, min: bounds.minZ, max: bounds.maxZ },
    { edge: 'S', distance: Math.abs(z - bounds.minZ), along: x, min: bounds.minX, max: bounds.maxX },
    { edge: 'W', distance: Math.abs(x - bounds.minX), along: z, min: bounds.minZ, max: bounds.maxZ },
  ]
  const side = sides.filter(s => s.max - s.min >= doorWidth && s.along >= s.min + doorWidth / 2 && s.along <= s.max - doorWidth / 2).sort((a, b) => a.distance - b.distance)[0]
  if (!side || side.distance > tolerance) return null
  return side.edge === 'N' || side.edge === 'S'
    ? { edge: side.edge, x: Math.round(x), z: side.edge === 'N' ? bounds.maxZ : bounds.minZ }
    : { edge: side.edge, x: side.edge === 'E' ? bounds.maxX : bounds.minX, z: Math.round(z) }
}

export function nearestValidPort(bounds: Bounds, x: number, z: number, doorWidth: number): Pick<Port, 'edge' | 'x' | 'z'> | null {
  const half = doorWidth / 2
  const candidates: Array<Pick<Port, 'edge' | 'x' | 'z'>> = []
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)))
  if (bounds.maxX - bounds.minX >= doorWidth) {
    candidates.push({ edge: 'N', x: clamp(x, bounds.minX + half, bounds.maxX - half), z: bounds.maxZ })
    candidates.push({ edge: 'S', x: clamp(x, bounds.minX + half, bounds.maxX - half), z: bounds.minZ })
  }
  if (bounds.maxZ - bounds.minZ >= doorWidth) {
    candidates.push({ edge: 'E', x: bounds.maxX, z: clamp(z, bounds.minZ + half, bounds.maxZ - half) })
    candidates.push({ edge: 'W', x: bounds.minX, z: clamp(z, bounds.minZ + half, bounds.maxZ - half) })
  }
  candidates.sort((a, b) => (a.x - x) ** 2 + (a.z - z) ** 2 - (b.x - x) ** 2 - (b.z - z) ** 2)
  return candidates[0] ?? null
}

export function remapPorts(ports: Port[], before: Bounds, after: Bounds, doorWidth: number): Port[] {
  const half = doorWidth / 2
  return ports.map(port => {
    const horizontal = port.edge === 'N' || port.edge === 'S'
    const oldMin = horizontal ? before.minX : before.minZ
    const oldSize = horizontal ? before.maxX - before.minX : before.maxZ - before.minZ
    const newMin = horizontal ? after.minX : after.minZ
    const newMax = horizontal ? after.maxX : after.maxZ
    const offset = (horizontal ? port.x : port.z) - oldMin
    const target = newMin + (oldSize > 0 ? offset / oldSize : 0.5) * (newMax - newMin)
    const center = Math.round((newMin + newMax) / 2)
    const position = newMax - newMin >= doorWidth ? Math.round(Math.max(newMin + half, Math.min(newMax - half, target))) : center
    return horizontal
      ? { ...port, x: position, z: port.edge === 'N' ? after.maxZ : after.minZ }
      : { ...port, x: port.edge === 'E' ? after.maxX : after.minX, z: position }
  })
}

export function unitsPerPixel(viewWidth: number, viewHeight: number, pixelWidth: number, pixelHeight: number): number {
  if (pixelWidth <= 0 || pixelHeight <= 0) return Math.max(viewWidth / 800, viewHeight / 380)
  return Math.max(viewWidth / pixelWidth, viewHeight / pixelHeight)
}

export function gridStep(maxSize: number): number {
  const rough = Math.max(1, maxSize / 10)
  const power = 10 ** Math.floor(Math.log10(rough))
  const scaled = rough / power
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power
}
