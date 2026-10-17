import { useSyncExternalStore } from 'react'

// Camera speed multipliers shared by every 3D view and remembered in this browser (not part of the project).
export type CameraSpeeds = { rotate: number; pan: number; zoom: number }
export const defaultCameraSpeeds: CameraSpeeds = { rotate: 1, pan: 1, zoom: 1 }
export const CAMERA_SPEED_MIN = 0.2, CAMERA_SPEED_MAX = 3
const KEY = 'dungeon-rule-editor.camera'
const listeners = new Set<() => void>()
const clamp = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(CAMERA_SPEED_MAX, Math.max(CAMERA_SPEED_MIN, value)) : fallback

function load(): CameraSpeeds {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<CameraSpeeds> | null
    return { rotate: clamp(saved?.rotate, 1), pan: clamp(saved?.pan, 1), zoom: clamp(saved?.zoom, 1) }
  } catch { return { ...defaultCameraSpeeds } }
}
let speeds = load()

export const getCameraSpeeds = () => speeds
export function setCameraSpeeds(change: Partial<CameraSpeeds>): void {
  speeds = { rotate: clamp(change.rotate, speeds.rotate), pan: clamp(change.pan, speeds.pan), zoom: clamp(change.zoom, speeds.zoom) }
  try { localStorage.setItem(KEY, JSON.stringify(speeds)) } catch { /* Storage can be unavailable; the speeds still apply for this page. */ }
  listeners.forEach(listener => listener())
}
export function subscribeCameraSpeeds(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const useCameraSpeeds = () => useSyncExternalStore(subscribeCameraSpeeds, getCameraSpeeds)
