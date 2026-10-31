import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stateDir } from './session.js'

const currentAgent = new AsyncLocalStorage()
const palette = ['#4299FF', '#FF5C8A', '#2BD9A0', '#FFB020', '#A66CFF', '#FF7A3D', '#3DD6F5', '#E8E84A']
let tempFiles = 0

export function agentName() {
  return currentAgent.getStore() || process.env.HYPRHAND_AGENT || 'agent'
}

export function withAgent(name, action) {
  return name ? currentAgent.run(String(name), action) : action()
}

export function agentColor(name = agentName()) {
  if (process.env.HYPRHAND_COLOR) return process.env.HYPRHAND_COLOR
  const digest = createHash('sha1').update(name).digest()
  return palette[digest[0] % palette.length]
}

export function agentSlug() {
  return agentName().replace(/[^\w.-]/g, '_')
}

export function agentFile(dir, extension) {
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `${agentSlug()}${extension}`)
}

export function cacheDir(...parts) {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'hyprhand', ...parts)
}

export function tempFile(purpose, extension) {
  return path.join(os.tmpdir(), `hyprhand-${agentSlug()}-${purpose}-${process.pid}-${Date.now()}-${++tempFiles}${extension}`)
}

function stateFile() {
  return agentFile(path.join(stateDir(), 'agents'), '.json')
}

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    return {}
  }
}

export function rememberWindow(window) {
  if (window) writeFileSync(stateFile(), JSON.stringify({ ...readState(), window: window.address }))
}

export function rememberedWindow() {
  return readState().window ?? null
}

export function workWindowSpec(explicit) {
  return explicit ?? rememberedWindow()
}
