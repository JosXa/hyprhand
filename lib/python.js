import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './session.js'

const libDir = path.dirname(fileURLToPath(import.meta.url))

export function callHelper(script, command, request, { timeoutMs = 15000 } = {}) {
  return JSON.parse(run('python3', [path.join(libDir, script), command], { input: JSON.stringify(request), timeout: timeoutMs }))
}

export function a11y(command, request) {
  return callHelper('a11y.py', command, request)
}
