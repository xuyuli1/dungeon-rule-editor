import { generate, searchBudget } from './generator'
import type { RuntimeProject } from './model'

self.onmessage = (event: MessageEvent<{ project: RuntimeProject; seed: number; seconds: number }>) => {
  try {
    const { maxChecks, maxRestarts } = searchBudget(event.data.seconds)
    const final = generate(event.data.project, event.data.seed, progress => self.postMessage({ kind: 'progress', result: progress }), maxChecks, maxRestarts)
    self.postMessage({ kind: 'done', result: final })
  } catch (error) {
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
