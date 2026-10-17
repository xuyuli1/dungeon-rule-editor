import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { nearestValidPort, portAtBoundary } from './geometry'
import { previewDoors, rotatedBounds, type PreviewResult } from './generator'
import { CAMERA_SPEED_MAX, CAMERA_SPEED_MIN, defaultCameraSpeeds, getCameraSpeeds, setCameraSpeeds, subscribeCameraSpeeds, useCameraSpeeds, type CameraSpeeds } from './cameraSettings'
import type { Bounds, Module, Port, RuntimeProject } from './model'

type PortPoint = Pick<Port, 'edge' | 'x' | 'y' | 'z'>
type Props = {
  module?: Module
  project?: RuntimeProject
  result?: PreviewResult
  doorWidth: number
  doorHeight: number
  onPortChange?: (id: string, next: Port) => void
  onAddPort?: (point: PortPoint) => void
  onDeletePort?: (id: string) => void
  onError?: (message: string) => void
  portPanel?: (portId: string, select: (id: string) => void) => ReactNode
}
type View = { scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; renderer: THREE.WebGLRenderer; content: THREE.Group; box?: THREE.Mesh; picks: THREE.Object3D[]; bounds: THREE.Box3; frame: number; resize: ResizeObserver; fit: (box?: THREE.Box3) => void }

const m = (millimetres: number) => millimetres / 1000
function box3(b: Bounds): THREE.Box3 { return new THREE.Box3(new THREE.Vector3(m(b.minX), m(b.minY), m(b.minZ)), new THREE.Vector3(m(b.maxX), m(b.maxY), m(b.maxZ))) }
function disposeTree(object: THREE.Object3D) {
  object.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Sprite) {
      child.geometry?.dispose()
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      materials.forEach(material => { if (material instanceof THREE.SpriteMaterial) material.map?.dispose(); material?.dispose() })
    }
  })
}
const portColor = 0xffffff, portHighlight = 0xffc65c
// fitHeight sizes the label to its text at a fixed on-screen height; otherwise it is a 3.1 m wide world-space label
function makeLabel(text: string, fitHeight?: number): THREE.Sprite {
  const canvas = document.createElement('canvas'); canvas.height = 96
  const font = 'bold 42px sans-serif'
  const measure = canvas.getContext('2d')!; measure.font = font
  canvas.width = fitHeight ? Math.min(512, Math.ceil(measure.measureText(text).width) + 40) : 512
  const context = canvas.getContext('2d')!, width = canvas.width
  context.fillStyle = '#071922dc'; context.fillRect(0, 0, width, 96)
  context.fillStyle = '#ffffff'; context.font = font; context.textAlign = 'center'; context.textBaseline = 'middle'
  context.fillText(text, width / 2, 49, width - 22)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false, sizeAttenuation: !fitHeight }))
  if (fitHeight) sprite.scale.set(fitHeight * width / 96, fitHeight, 1); else sprite.scale.set(3.1, .58, 1)
  sprite.renderOrder = 8; sprite.raycast = () => {}
  return sprite
}
const boxOpacity = .23
// `id` identifies the box for picking; `label` is the floating text (omitted in the module editor, whose box is the module itself).
function addBox(group: THREE.Group, b: Bounds, color: string, id: string, pickable = false, label?: string): THREE.Mesh {
  const size = new THREE.Vector3(m(b.maxX - b.minX), m(b.maxY - b.minY), m(b.maxZ - b.minZ))
  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z)
  const center = new THREE.Vector3(m((b.minX + b.maxX) / 2), m((b.minY + b.maxY) / 2), m((b.minZ + b.maxZ) / 2))
  const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: boxOpacity, side: THREE.DoubleSide, depthWrite: false })
  const mesh = new THREE.Mesh(geometry, fill)
  const edgeMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: .95 })
  mesh.position.copy(center); mesh.userData = { id, box: pickable, fill, edges: edgeMaterial, color }; group.add(mesh)
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial)
  edges.position.copy(center); group.add(edges)
  if (label) { const sprite = makeLabel(label, .045); sprite.position.set(center.x, m(b.maxY) + .3, center.z); sprite.visible = false; mesh.userData.label = sprite; group.add(sprite) }
  return mesh
}
function frame(port: PortPoint, width: number, height: number, connected: boolean, id?: string): THREE.Group {
  const group = new THREE.Group()
  group.position.set(m(port.x), m(port.y), m(port.z))
  group.rotation.y = port.edge === 'E' ? Math.PI / 2 : port.edge === 'S' ? Math.PI : port.edge === 'W' ? -Math.PI / 2 : 0
  group.translateZ(.008)
  const w = m(width), h = m(height), points = [
    -w / 2, -h / 2, 0, w / 2, -h / 2, 0,
    w / 2, -h / 2, 0, w / 2, h / 2, 0,
    w / 2, h / 2, 0, -w / 2, h / 2, 0,
    -w / 2, h / 2, 0, -w / 2, -h / 2, 0,
  ]
  const outline = new THREE.BufferGeometry(); outline.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  const outlineMaterial = new THREE.LineBasicMaterial({ color: connected ? portColor : 0xffd89a, depthTest: false })
  group.add(new THREE.LineSegments(outline, outlineMaterial))
  if (!connected) {
    const hatch: number[] = []
    const step = Math.max(.12, Math.min(w, h) / 5)
    for (let sum = -w / 2 - h / 2 + step; sum < w / 2 + h / 2; sum += step) {
      const low = Math.max(-w / 2, sum - h / 2), high = Math.min(w / 2, sum + h / 2)
      if (high > low) hatch.push(low, sum - low, .002, high, sum - high, .002)
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(hatch, 3))
    group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xffd89a, transparent: true, opacity: .65, depthTest: false })))
  }
  if (id) {
    const fill = new THREE.MeshBasicMaterial({ color: portHighlight, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, depthTest: false })
    const pick = new THREE.Mesh(new THREE.PlaneGeometry(w, h), fill)
    pick.userData.portId = id; group.add(pick)
    const label = makeLabel(id, .05); label.position.set(0, h / 2 + .25, .05); group.add(label)
    group.userData = { portId: id, outline: outlineMaterial, fill }
  }
  return group
}

export function ThreeCanvas(props: Props) {
  const root = useRef<HTMLDivElement>(null)
  const view = useRef<View | null>(null)
  const current = useRef(props); current.current = props
  const [placing, setPlacing] = useState(false)
  const placingRef = useRef(false); placingRef.current = placing
  // Map preview: `selected`/`hovered` hold placement instance IDs.
  const [selected, setSelected] = useState('')
  const selectedRef = useRef(''); selectedRef.current = selected
  const [hovered, setHovered] = useState('')
  const hoveredRef = useRef(''); hoveredRef.current = hovered
  const [cameraOpen, setCameraOpen] = useState(false)
  const cameraSpeeds = useCameraSpeeds()
  const drag = useRef<{ id: string; point: PortPoint | null } | null>(null)
  const ghost = useRef<THREE.Group | null>(null)
  const lastFitSource = useRef<unknown>(null)
  const [selectedPort, setSelectedPort] = useState('')
  const selectedPortRef = useRef(''); selectedPortRef.current = selectedPort
  const hoveredPort = useRef('')
  const popover = useRef<HTMLDivElement>(null)
  const paintPorts = () => view.current?.content.children.forEach(child => {
    const { portId, outline, fill } = child.userData as { portId?: string; outline?: THREE.LineBasicMaterial; fill?: THREE.MeshBasicMaterial }
    if (!portId || !outline || !fill) return
    const active = portId === hoveredPort.current || portId === selectedPortRef.current
    outline.color.set(active ? portHighlight : portColor); fill.opacity = portId === selectedPortRef.current ? .45 : active ? .28 : 0
  })
  useEffect(paintPorts, [selectedPort])
  const paintBoxes = () => view.current?.picks.forEach(pick => {
    const { id, fill, edges, color, label } = pick.userData as { id?: string; fill?: THREE.MeshBasicMaterial; edges?: THREE.LineBasicMaterial; color?: string; label?: THREE.Sprite }
    if (!id || !fill || !edges || !current.current.result) return
    const isSelected = id === selectedRef.current, isHovered = id === hoveredRef.current
    fill.opacity = isSelected ? .55 : isHovered ? .42 : boxOpacity
    edges.color.set(isSelected || isHovered ? '#ffffff' : color ?? '#ffffff')
    if (label) label.visible = isSelected || isHovered // Labels on every box overlap; show the ones you point at or pick.
  })
  useEffect(paintBoxes, [selected, hovered])
  // The box the camera should focus with F: the hovered item, then the selected one; null fits everything.
  const focusTarget = (): THREE.Box3 | null => {
    const state = view.current
    if (!state) return null
    const portId = hoveredPort.current || selectedPortRef.current
    const boxId = hoveredRef.current || selectedRef.current
    const object = props.module ? state.content.children.find(child => portId && child.userData.portId === portId) : state.picks.find(pick => boxId && pick.userData.id === boxId)
    return object ? new THREE.Box3().setFromObject(object) : null
  }
  const focusRef = useRef(focusTarget); focusRef.current = focusTarget

  useEffect(() => {
    const host = root.current!
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#091922')
    const camera = new THREE.PerspectiveCamera(48, 1, .01, 100000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); host.appendChild(renderer.domElement)
    // No damping: the view stops as soon as the mouse is released.
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = false
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN; controls.mouseButtons.RIGHT = THREE.MOUSE.PAN
    const applySpeeds = () => { const speeds = getCameraSpeeds(); controls.rotateSpeed = speeds.rotate; controls.panSpeed = speeds.pan; controls.zoomSpeed = speeds.zoom }
    applySpeeds()
    const unsubscribeSpeeds = subscribeCameraSpeeds(applySpeeds)
    const content = new THREE.Group(); scene.add(content)
    const axes = new THREE.AxesHelper(2); scene.add(axes)
    const state: View = { scene, camera, controls, renderer, content, picks: [], bounds: new THREE.Box3(), frame: 0, resize: null!, fit: () => {} }
    state.fit = (target = state.bounds) => {
      if (target.isEmpty()) return
      const center = target.getCenter(new THREE.Vector3()), size = target.getSize(new THREE.Vector3())
      const radius = Math.max(size.length() * .8, 2)
      controls.target.copy(center); camera.position.copy(center).add(new THREE.Vector3(radius, radius * .75, radius)); camera.near = Math.max(.001, radius / 10000); camera.far = Math.max(1000, radius * 100); camera.updateProjectionMatrix(); controls.update()
    }
    const resize = () => { const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight); renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix() }
    state.resize = new ResizeObserver(resize); state.resize.observe(host); resize()
    const animate = () => { state.frame = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera) }; animate()
    view.current = state

    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2()
    const cast = (event: PointerEvent, objects: THREE.Object3D[]) => {
      const rect = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
      raycaster.setFromCamera(pointer, camera); return raycaster.intersectObjects(objects, true)
    }
    const pointOnBox = (event: PointerEvent, nearest: boolean): PortPoint | null => {
      const box = state.box, module = current.current.module
      if (!box || !module) return null
      const hit = cast(event, [box])[0]
      if (!hit?.face) return null
      const normal = hit.face.normal
      if (Math.abs(normal.y) > .5) return null
      const x = Math.round(hit.point.x * 1000), y = Math.round(hit.point.y * 1000), z = Math.round(hit.point.z * 1000)
      return nearest
        ? nearestValidPort(module.bounds, x, y, z, current.current.doorWidth, current.current.doorHeight)
        : portAtBoundary(module.bounds, x, y, z, current.current.doorWidth, current.current.doorHeight, 3)
    }
    const showGhost = (point: PortPoint | null) => {
      if (ghost.current) { state.scene.remove(ghost.current); disposeTree(ghost.current); ghost.current = null }
      if (point) { ghost.current = frame(point, current.current.doorWidth, current.current.doorHeight, true); ghost.current.traverse(obj => { if (obj instanceof THREE.LineSegments) (obj.material as THREE.LineBasicMaterial).color.set('#91e6dc') }); state.scene.add(ghost.current) }
    }
    let down: { x: number; y: number } | null = null
    const onDown = (event: PointerEvent) => {
      host.focus()
      if (event.button !== 0) return
      down = { x: event.clientX, y: event.clientY }
      if (current.current.module) {
        if (!placingRef.current) {
          const portHit = cast(event, state.picks).find(hit => hit.object.userData.portId)
          if (portHit) { drag.current = { id: String(portHit.object.userData.portId), point: null }; controls.enabled = false; renderer.domElement.setPointerCapture(event.pointerId); event.stopPropagation(); event.preventDefault(); return }
        }
        if (placingRef.current) { controls.enabled = false; renderer.domElement.setPointerCapture(event.pointerId); event.stopPropagation(); event.preventDefault() }
      }
    }
    const onMove = (event: PointerEvent) => {
      if (drag.current || placingRef.current) {
        const point = pointOnBox(event, !!drag.current)
        if (drag.current) drag.current.point = point
        showGhost(point)
      } else if (current.current.module && event.buttons === 0) {
        const id = String(cast(event, state.picks).find(hit => hit.object.userData.portId)?.object.userData.portId ?? '')
        if (id !== hoveredPort.current) { hoveredPort.current = id; renderer.domElement.style.cursor = id ? 'pointer' : ''; paintPorts() }
      } else if (current.current.result && event.buttons === 0) {
        const id = String(cast(event, state.picks)[0]?.object.userData.id ?? '')
        if (id !== hoveredRef.current) { hoveredRef.current = id; setHovered(id); renderer.domElement.style.cursor = id ? 'pointer' : '' }
      }
    }
    const onLeave = () => {
      if (hoveredPort.current) { hoveredPort.current = ''; paintPorts() }
      if (hoveredRef.current) { hoveredRef.current = ''; setHovered('') }
      renderer.domElement.style.cursor = ''
    }
    const onDoubleClick = (event: MouseEvent) => {
      const hits = cast(event as PointerEvent, state.picks)
      const target = current.current.module ? hits.find(hit => hit.object.userData.portId)?.object.parent : hits[0]?.object
      state.fit(target ? new THREE.Box3().setFromObject(target) : undefined)
    }
    const onUp = (event: PointerEvent) => {
      controls.enabled = true
      const clicked = !!down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5
      if (drag.current) {
        const { id, point } = drag.current; drag.current = null; showGhost(null); down = null
        if (clicked) { setSelectedPort(id); return }
        const original = current.current.module?.ports.find(port => port.id === id)
        if (point && original) current.current.onPortChange?.(id, { ...original, ...point })
        return
      }
      if (placingRef.current) {
        const point = pointOnBox(event, false); showGhost(null)
        if (point) { current.current.onAddPort?.(point); setPlacing(false) }
        else current.current.onError?.('The full connector rectangle must fit on a vertical side face.')
        return
      }
      if (clicked && current.current.module) setSelectedPort('')
      if (clicked && current.current.result) setSelected(String(cast(event, state.picks)[0]?.object.userData.id ?? ''))
      down = null
    }
    // Capture phase, so closing the port popup or placement with Esc does not also close the inspector panel.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && placingRef.current) { setPlacing(false); showGhost(null); event.stopImmediatePropagation() }
      else if (event.key === 'Escape' && selectedPortRef.current && (host.contains(document.activeElement) || popover.current?.contains(document.activeElement) || document.activeElement === document.body)) { setSelectedPort(''); event.stopImmediatePropagation() }
      if (event.key.toLowerCase() === 'f' && host.contains(document.activeElement)) { event.preventDefault(); state.fit(focusRef.current() ?? undefined) }
    }
    const onWheel = (event: WheelEvent) => event.preventDefault()
    renderer.domElement.addEventListener('pointerdown', onDown, true)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onUp)
    renderer.domElement.addEventListener('pointerleave', onLeave)
    renderer.domElement.addEventListener('dblclick', onDoubleClick)
    host.addEventListener('wheel', onWheel, { passive: false })
    document.addEventListener('keydown', onKey, true)
    return () => {
      cancelAnimationFrame(state.frame); state.resize.disconnect(); controls.dispose(); unsubscribeSpeeds()
      renderer.domElement.removeEventListener('pointerdown', onDown, true); renderer.domElement.removeEventListener('pointermove', onMove); renderer.domElement.removeEventListener('pointerup', onUp); renderer.domElement.removeEventListener('pointercancel', onUp); renderer.domElement.removeEventListener('pointerleave', onLeave); renderer.domElement.removeEventListener('dblclick', onDoubleClick)
      host.removeEventListener('wheel', onWheel); document.removeEventListener('keydown', onKey, true)
      if (ghost.current) { state.scene.remove(ghost.current); disposeTree(ghost.current) }
      disposeTree(content); scene.remove(content); renderer.dispose(); renderer.domElement.remove(); view.current = null; lastFitSource.current = null
    }
  }, [])

  useEffect(() => {
    const state = view.current
    if (!state) return
    disposeTree(state.content); state.content.clear(); state.picks = []; state.box = undefined; state.bounds.makeEmpty()
    const { module, project, result, doorWidth, doorHeight } = props
    if (module) {
      state.box = addBox(state.content, module.bounds, '#8ed6e5', module.id, true)
      state.picks.push(state.box); state.bounds.copy(box3(module.bounds))
      for (const port of module.ports) { const shape = frame(port, doorWidth, doorHeight, true, port.id); state.content.add(shape); state.picks.push(shape) }
      if (selectedPortRef.current && !module.ports.some(port => port.id === selectedPortRef.current)) setSelectedPort('')
      paintPorts()
    } else if (project && result) {
      const types = new Map(project.types.map(type => [type.id, type]))
      const modules = new Map(project.modules.map(item => [item.id, item]))
      for (const placement of result.placements) {
        const module = modules.get(placement.moduleId)
        if (!module) continue
        const bounds = rotatedBounds(module.bounds, placement.rotation, placement.x, placement.y, placement.z)
        const mesh = addBox(state.content, bounds, types.get(placement.typeId)?.color ?? '#91e6dc', placement.instanceId, true, placement.moduleId)
        state.picks.push(mesh); state.bounds.union(box3(bounds))
      }
      for (const door of previewDoors(project, result.placements)) state.content.add(frame(door, door.width, door.height, door.connected))
      paintBoxes()
    }
    if (selectedRef.current && result && !result.placements.some(p => p.instanceId === selectedRef.current)) setSelected('')
    if (hoveredRef.current && result && !result.placements.some(p => p.instanceId === hoveredRef.current)) setHovered('')
    const fitSource = module ? `module:${module.id}` : result
    if (lastFitSource.current !== fitSource && !state.bounds.isEmpty()) {
      lastFitSource.current = fitSource
      requestAnimationFrame(() => { if (view.current === state) state.fit() })
    }
  }, [props.module?.id, props.module?.bounds, props.module?.ports, props.project, props.result, props.doorWidth, props.doorHeight])

  const placementLabel = (id: string) => {
    const placement = props.result?.placements.find(p => p.instanceId === id)
    return placement ? `${placement.instanceId} · ${placement.moduleId} · ${placement.typeId} · Y ${m(placement.y).toFixed(3)} m` : ''
  }
  const shownPlacement = hovered || selected
  const speedRows: [keyof CameraSpeeds, string][] = [['rotate', 'Rotate'], ['pan', 'Pan'], ['zoom', 'Zoom']]
  return <div className="three-canvas-shell">
    <div className="three-canvas-toolbar">
      {props.module && <button className={placing ? 'primary' : 'quiet'} onClick={() => setPlacing(value => !value)}>{placing ? 'Cancel placement' : '+ Add port'}</button>}
      <button className={cameraOpen ? 'primary' : 'quiet'} aria-expanded={cameraOpen} onClick={() => setCameraOpen(value => !value)}>Camera</button>
      <button className="quiet" title="Fit everything in view" onClick={() => view.current?.fit()}>Fit</button>
    </div>
    {cameraOpen && <div className="camera-popover" role="group" aria-label="Camera speed">
      <div className="camera-popover-head"><strong>Camera speed</strong><span>All 3D views</span></div>
      {speedRows.map(([key, label]) => <label key={key} className="camera-speed"><span>{label}</span><input type="range" min={CAMERA_SPEED_MIN} max={CAMERA_SPEED_MAX} step={0.1} value={cameraSpeeds[key]} onChange={e => setCameraSpeeds({ [key]: Number(e.target.value) })} /><output>{cameraSpeeds[key].toFixed(1)}×</output></label>)}
      <button className="quiet" onClick={() => setCameraSpeeds(defaultCameraSpeeds)}>Reset</button>
    </div>}
    {/* The stage wraps only the 3D view, so overlays anchor to its corners rather than to the help line below. */}
    <div className="three-canvas-stage">
      <div className="three-canvas" ref={root} tabIndex={0} aria-label={props.module ? '3D module and connector editor' : '3D map preview'} />
      {shownPlacement && props.result && <div className="three-selection">{placementLabel(shownPlacement)}</div>}
      {selectedPort && props.module && props.portPanel && <div className="port-popover" ref={popover} role="dialog" aria-label={`Port ${selectedPort}`}>
        <div className="port-popover-head"><strong>{selectedPort}</strong>{props.onDeletePort && <button className="danger-text" onClick={() => { props.onDeletePort?.(selectedPort); setSelectedPort('') }}>Delete</button>}<button className="icon" aria-label="Close port properties" onClick={() => setSelectedPort('')}>×</button></div>
        {props.portPanel(selectedPort, setSelectedPort)}
      </div>}
    </div>
    <div className="three-canvas-help">Drag to orbit · Right-drag to pan · Wheel to zoom · Double-click to focus · F focuses the {props.module ? 'hovered port' : 'hovered module'}{props.module ? ' · Drag a port along a side face' : ''}</div>
  </div>
}
