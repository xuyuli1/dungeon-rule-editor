import type { Bounds, Port } from './model'

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
