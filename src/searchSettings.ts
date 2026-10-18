import { useSyncExternalStore } from 'react'

// The longest time one map search may run, remembered in this browser (not part of the project).
export const SEARCH_SECONDS_DEFAULT = 30, SEARCH_SECONDS_MIN = 5, SEARCH_SECONDS_MAX = 600
const KEY = 'dungeon-rule-editor.search-seconds'
const listeners = new Set<() => void>()
const clamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.min(SEARCH_SECONDS_MAX, Math.max(SEARCH_SECONDS_MIN, Math.round(value))) : SEARCH_SECONDS_DEFAULT

function load(): number {
  try { const saved = localStorage.getItem(KEY); return saved === null ? SEARCH_SECONDS_DEFAULT : clamp(Number(saved)) } catch { return SEARCH_SECONDS_DEFAULT }
}
let seconds = load()

export const getSearchSeconds = () => seconds
export function setSearchSeconds(value: number): void {
  seconds = clamp(value)
  try { localStorage.setItem(KEY, String(seconds)) } catch { /* Storage can be unavailable; the limit still applies for this page. */ }
  listeners.forEach(listener => listener())
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useSearchSeconds = () => useSyncExternalStore(subscribe, getSearchSeconds)
