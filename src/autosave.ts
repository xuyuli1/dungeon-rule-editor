import { normalizeEditor, parseRuntime, type EditorState, type RuntimeProject } from './model'

const DATABASE = 'dungeon-rule-editor-v2' // Upgrade the existing database and clear its unsupported v3 draft.
const STATE = 'draft'
const ASSETS = 'assets'
// Module FBX files are stored under their module ID; unassigned library files under `library:<file name>` (":" never appears in an ID).
const LIBRARY_PREFIX = 'library:'
export type Draft = { project: RuntimeProject; editor: EditorState; files: Map<string, File>; library: Map<string, File> }
let lastFiles: Map<string, File> | null = null
let lastLibrary: Map<string, File> | null = null

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) })
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error) })
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 4)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STATE)) open.result.createObjectStore(STATE)
      if (!open.result.objectStoreNames.contains(ASSETS)) open.result.createObjectStore(ASSETS)
      open.transaction?.objectStore(STATE).clear()
      open.transaction?.objectStore(ASSETS).clear()
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
}

export async function loadDraft(): Promise<Draft | null> {
  const db = await database()
  try {
    const tx = db.transaction([STATE, ASSETS], 'readonly')
    const done = complete(tx)
    const [saved, keys, values] = await Promise.all([
      request(tx.objectStore(STATE).get('current')) as Promise<Partial<Draft> | undefined>,
      request(tx.objectStore(ASSETS).getAllKeys()),
      request(tx.objectStore(ASSETS).getAll()) as Promise<File[]>,
      done,
    ])
    if (!saved) return null
    const files = new Map<string, File>(), library = new Map<string, File>()
    keys.forEach((key, i) => { const name = String(key); if (name.startsWith(LIBRARY_PREFIX)) library.set(name.slice(LIBRARY_PREFIX.length), values[i]); else files.set(name, values[i]) })
    if (!keys.length) for (const [id, file] of saved.files ?? []) files.set(id, file)
    lastFiles = keys.length ? files : null // The next save migrates an earlier local draft's embedded files.
    lastLibrary = keys.length ? library : null
    return { project: parseRuntime(saved.project), editor: normalizeEditor(saved.editor), files, library }
  } finally { db.close() }
}

export async function saveDraft(draft: Draft): Promise<void> {
  const db = await database()
  try {
    const changedFiles = draft.files !== lastFiles || draft.library !== lastLibrary
    const tx = db.transaction([STATE, ASSETS], 'readwrite')
    const done = complete(tx)
    tx.objectStore(STATE).put({ project: draft.project, editor: draft.editor }, 'current')
    if (changedFiles) {
      const store = tx.objectStore(ASSETS)
      store.clear()
      for (const [id, file] of draft.files) store.put(file, id)
      for (const [name, file] of draft.library) store.put(file, LIBRARY_PREFIX + name)
    }
    await done
    if (changedFiles) { lastFiles = draft.files; lastLibrary = draft.library }
  } finally { db.close() }
}

export async function clearDraft(): Promise<void> {
  const db = await database()
  try {
    const tx = db.transaction([STATE, ASSETS], 'readwrite')
    const done = complete(tx)
    tx.objectStore(STATE).delete('current')
    tx.objectStore(ASSETS).clear()
    await done
    lastFiles = null; lastLibrary = null
  } finally { db.close() }
}
