import { generate } from './generator'
import type { RuntimeProject } from './model'

self.onmessage = (event: MessageEvent<{ project: RuntimeProject; seed: number }>) => {
  try {
    const final = generate(event.data.project, event.data.seed, progress => self.postMessage({ kind: 'progress', result: progress }))
    self.postMessage({ kind: 'done', result: final })
  } catch (error) {
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
