import { parseRuntime, type EditorState, type RuntimeProject } from './model'

const DATABASE = 'dungeon-rule-editor-v2'
const STATE = 'draft'
const ASSETS = 'assets'
export type Draft = { project: RuntimeProject; editor: EditorState; files: Map<string, File> }
let lastFiles: Map<string, File> | null = null

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) })
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error) })
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 2)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STATE)) open.result.createObjectStore(STATE)
      if (!open.result.objectStoreNames.contains(ASSETS)) open.result.createObjectStore(ASSETS)
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
    const files = keys.length ? new Map(keys.map((key, i) => [String(key), values[i]])) : new Map(saved.files ?? [])
    lastFiles = keys.length ? files : null // The next save migrates an earlier local draft's embedded files.
    return { project: parseRuntime(saved.project), editor: saved.editor!, files }
  } finally { db.close() }
}

export async function saveDraft(draft: Draft): Promise<void> {
  const db = await database()
  try {
    const changedFiles = draft.files !== lastFiles
    const tx = db.transaction([STATE, ASSETS], 'readwrite')
    const done = complete(tx)
    tx.objectStore(STATE).put({ project: draft.project, editor: draft.editor }, 'current')
    if (changedFiles) {
      const store = tx.objectStore(ASSETS)
      store.clear()
      for (const [id, file] of draft.files) store.put(file, id)
    }
    await done
    if (changedFiles) lastFiles = draft.files
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
    lastFiles = null
  } finally { db.close() }
}
