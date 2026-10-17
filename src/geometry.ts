import { doorTypeName, isId, sameDoorSize, type Bounds, type DoorType, type Edge, type Port } from './model'

type PortPosition = Pick<Port, 'edge' | 'x' | 'y' | 'z'>

// A port's centre must lie on one of the box's four vertical side faces (within `tolerance` of the plane, then snapped onto
// it, and within the face's extent). The door rectangle itself may overhang the face's edges, top or bottom.
// `top` is where the side faces end: the box top, or higher when the module reserves space above (Infinity = open to sky).
export function portAtBoundary(bounds: Bounds, x: number, y: number, z: number, tolerance = 0, top = bounds.maxY): PortPosition | null {
  if (y < bounds.minY || y > top) return null
  const sides: { edge: Edge; distance: number; along: number; min: number; max: number }[] = [
    { edge: 'N', distance: Math.abs(z - bounds.maxZ), along: x, min: bounds.minX, max: bounds.maxX },
    { edge: 'E', distance: Math.abs(x - bounds.maxX), along: z, min: bounds.minZ, max: bounds.maxZ },
    { edge: 'S', distance: Math.abs(z - bounds.minZ), along: x, min: bounds.minX, max: bounds.maxX },
    { edge: 'W', distance: Math.abs(x - bounds.minX), along: z, min: bounds.minZ, max: bounds.maxZ },
  ]
  const side = sides.filter(s => s.along >= s.min && s.along <= s.max).sort((a, b) => a.distance - b.distance)[0]
  if (!side || side.distance > tolerance) return null
  return side.edge === 'N' || side.edge === 'S'
    ? { edge: side.edge, x: Math.round(x), y: Math.round(y), z: side.edge === 'N' ? bounds.maxZ : bounds.minZ }
    : { edge: side.edge, x: side.edge === 'E' ? bounds.maxX : bounds.minX, y: Math.round(y), z: Math.round(z) }
}

// The closest point on a side face for a dragged port centre (the door may overhang the face).
export function nearestValidPort(bounds: Bounds, x: number, y: number, z: number, top = bounds.maxY): PortPosition | null {
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)))
  const vertical = clamp(y, bounds.minY, top)
  const candidates: PortPosition[] = [
    { edge: 'N', x: clamp(x, bounds.minX, bounds.maxX), y: vertical, z: bounds.maxZ },
    { edge: 'S', x: clamp(x, bounds.minX, bounds.maxX), y: vertical, z: bounds.minZ },
    { edge: 'E', x: bounds.maxX, y: vertical, z: clamp(z, bounds.minZ, bounds.maxZ) },
    { edge: 'W', x: bounds.minX, y: vertical, z: clamp(z, bounds.minZ, bounds.maxZ) },
  ]
  candidates.sort((a, b) => (a.x - x) ** 2 + (a.y - y) ** 2 + (a.z - z) ** 2 - ((b.x - x) ** 2 + (b.y - y) ** 2 + (b.z - z) ** 2))
  return candidates[0] ?? null
}

// A door marker is a mesh whose name contains "door"; `box` is its axis-aligned extent in model millimetres.
export type DoorMarker = { name: string; box: Bounds }
export type DoorImport = { ports: Port[]; newDoorTypes: DoorType[]; errors: string[] }
// A marker's centre must lie within this distance of a side face; that face gives the port's side (its outward direction).
export const DOOR_FACE_TOLERANCE = 50

// Turns door markers into ports. Names are kept exactly as the port IDs; any problem is an error and no ports are returned.
export function portsFromDoorMarkers(bounds: Bounds, markers: DoorMarker[], doorTypes: DoorType[], top = bounds.maxY): DoorImport {
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
    const placement = portAtBoundary(bounds, x, y, z, DOOR_FACE_TOLERANCE, top)
    if (!placement || placement.edge !== face.edge) { errors.push(`Door mesh "${name}" is not on a side face of the model`); continue }
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

export function remapPorts(ports: Port[], before: Bounds, after: Bounds): Port[] {
  const clamp = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, value)))
  return ports.map(port => {
    const horizontal = port.edge === 'N' || port.edge === 'S'
    const oldMin = horizontal ? before.minX : before.minZ
    const oldSize = horizontal ? before.maxX - before.minX : before.maxZ - before.minZ
    const newMin = horizontal ? after.minX : after.minZ
    const newMax = horizontal ? after.maxX : after.maxZ
    const fraction = oldSize > 0 ? ((horizontal ? port.x : port.z) - oldMin) / oldSize : .5
    const position = clamp(newMin + fraction * (newMax - newMin), newMin, newMax)
    const yFraction = before.maxY > before.minY ? (port.y - before.minY) / (before.maxY - before.minY) : .5
    const y = clamp(after.minY + yFraction * (after.maxY - after.minY), after.minY, after.maxY)
    return horizontal
      ? { ...port, x: position, y, z: port.edge === 'N' ? after.maxZ : after.minZ }
      : { ...port, x: port.edge === 'E' ? after.maxX : after.minX, y, z: position }
  })
}
