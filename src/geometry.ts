import { doorTypeName, isId, sameDoorSize, type Bounds, type DoorType, type Edge, type Port } from './model'

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

// A door marker is a mesh whose name contains "door"; `box` is its axis-aligned extent in model millimetres.
export type DoorMarker = { name: string; box: Bounds }
export type DoorImport = { ports: Port[]; newDoorTypes: DoorType[]; errors: string[] }
// A marker's centre must lie within this distance of a side face; that face gives the port's side (its outward direction).
export const DOOR_FACE_TOLERANCE = 50

// Turns door markers into ports. Names are kept exactly as the port IDs; any problem is an error and no ports are returned.
export function portsFromDoorMarkers(bounds: Bounds, markers: DoorMarker[], doorTypes: DoorType[]): DoorImport {
  const errors: string[] = [], ports: Port[] = [], newDoorTypes: DoorType[] = [], seen = new Set<string>()
  for (const { name, box } of markers) {
    if (!isId(name)) { errors.push(`Door mesh "${name}" is not a valid port ID: start with a letter; use letters, numbers, _ or -`); continue }
    if (seen.has(name)) { errors.push(`Two door meshes are named "${name}"`); continue }
    seen.add(name)
    const x = (box.minX + box.maxX) / 2, y = (box.minY + box.maxY) / 2, z = (box.minZ + box.maxZ) / 2
    const faces: { edge: Edge; distance: number }[] = [
      { edge: 'N', distance: Math.abs(z - bounds.maxZ) }, { edge: 'E', distance: Math.abs(x - bounds.maxX) },
      { edge: 'S', distance: Math.abs(z - bounds.minZ) }, { edge: 'W', distance: Math.abs(x - bounds.minX) },
    ]
    const face = faces.sort((a, b) => a.distance - b.distance)[0]
    if (face.distance > DOOR_FACE_TOLERANCE) { errors.push(`Door mesh "${name}" is not on a side face of the model`); continue }
    const width = Math.round(face.edge === 'N' || face.edge === 'S' ? box.maxX - box.minX : box.maxZ - box.minZ), height = Math.round(box.maxY - box.minY)
    if (width <= 0 || height <= 0) { errors.push(`Door mesh "${name}" has no width or height on its face`); continue }
    const placement = portAtBoundary(bounds, x, y, z, width, height, DOOR_FACE_TOLERANCE)
    if (!placement || placement.edge !== face.edge) { errors.push(`Door mesh "${name}" does not fit within its side face`); continue }
    let door = [...doorTypes, ...newDoorTypes].find(type => sameDoorSize(type, { width, height }))
    if (!door) {
      const base = doorTypeName(width, height), taken = new Set([...doorTypes, ...newDoorTypes].map(type => type.id))
      let id = base
      for (let n = 2; taken.has(id); n++) id = `${base}_${n}`
      door = { id, width, height }
      newDoorTypes.push(door)
    }
    ports.push({ id: name, edge: placement.edge, doorTypeId: door.id, x: placement.x, y: placement.y, z: placement.z, allowedTypeIds: null })
  }
  return errors.length ? { ports: [], newDoorTypes: [], errors } : { ports, newDoorTypes, errors }
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
