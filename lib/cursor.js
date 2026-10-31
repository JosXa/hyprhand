import { createConnection } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentColor, agentName } from './agent.js'
import { cursorPosition } from './hypr.js'
import { sleep, spawnDetached, stateDir } from './session.js'

const overlayScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'overlay.py')
function overlayEnabled() {
  return !['0', 'false', 'off', 'no'].includes(String(process.env.HYPRHAND_CURSOR ?? '1').toLowerCase())
}

function socketPath() {
  return path.join(stateDir(), 'cursors.sock')
}

function request(message, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socketPath())
    let buffer = ''
    const timer = setTimeout(() => {
      connection.destroy()
      reject(new Error('cursor overlay timed out'))
    }, timeoutMs)
    connection.on('connect', () => connection.write(`${JSON.stringify(message)}\n`))
    connection.on('data', (chunk) => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      clearTimeout(timer)
      connection.end()
      resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
    })
    connection.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function overlayRunning() {
  try {
    return (await request({ op: 'ping' }, 800)).ok === true
  } catch {
    return false
  }
}

export async function startOverlay() {
  if (await overlayRunning()) return true
  spawnDetached('python3', [overlayScript, socketPath()])
  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(100)
    if (await overlayRunning()) return true
  }
  throw new Error('cursor overlay did not start; run "python3 lib/overlay.py /tmp/test.sock" to see the error')
}

export async function stopOverlay() {
  if (await overlayRunning()) await request({ op: 'quit' })
}

export async function listCursors() {
  if (!(await overlayRunning())) return []
  return (await request({ op: 'ping' })).agents
}

export async function forgetCursor(name = agentName()) {
  if (await overlayRunning()) await request({ op: 'forget', agent: name })
}

async function send(message) {
  if (!overlayEnabled()) return
  try {
    await startOverlay()
    const name = agentName()
    let from
    try {
      const position = cursorPosition()
      from = [position.x, position.y]
    } catch {}
    await request({ agent: name, color: agentColor(name), from, ...message })
  } catch (error) {
    if (process.env.HYPRHAND_DEBUG) console.error(`cursor overlay: ${error.message}`)
  }
}

export const showCursor = {
  moveTo: (point, extra = {}) => send({ op: 'move', to: point, ...extra }),
  click: (point, extra = {}) => send({ op: 'click', to: point, ...extra }),
  typing: (point, seconds, extra = {}) => send({ op: 'type', to: point, seconds, ...extra }),
}

export async function withOverlayHidden(action) {
  if (!overlayEnabled() || !(await overlayRunning())) return action()
  await request({ op: 'hide' })
  try {
    return await action()
  } finally {
    await request({ op: 'show' }).catch(() => {})
  }
}
