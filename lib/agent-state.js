import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { agentName } from './cursor.js'
import { stateDir } from './session.js'

function stateFile() {
  const dir = path.join(stateDir(), 'agents')
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `${agentName().replace(/[^\w.-]/g, '_')}.json`)
}

export function readAgentState() {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    return {}
  }
}

export function updateAgentState(patch) {
  writeFileSync(stateFile(), JSON.stringify({ ...readAgentState(), ...patch }))
}
