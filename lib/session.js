import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

let prepared = false
const commandCache = new Map()

export function prepareSession() {
  if (prepared) return
  prepared = true
  const env = process.env
  env.XDG_RUNTIME_DIR ||= `/run/user/${process.getuid()}`
  const runtime = env.XDG_RUNTIME_DIR
  const instance = newestHyprlandInstance()
  if (instance && !hyprlandSocketExists(runtime, env.HYPRLAND_INSTANCE_SIGNATURE)) env.HYPRLAND_INSTANCE_SIGNATURE = instance.instance
  if (instance && !socketExists(runtime, env.WAYLAND_DISPLAY)) env.WAYLAND_DISPLAY = instance.wl_socket
  env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=${runtime}/bus`
  const ydotoolSocket = path.join(runtime, '.ydotool_socket')
  if (!env.YDOTOOL_SOCKET && existsSync(ydotoolSocket)) env.YDOTOOL_SOCKET = ydotoolSocket
  env.XDG_SESSION_TYPE ||= 'wayland'
  env.XDG_CURRENT_DESKTOP ||= 'Hyprland'
}

function newestHyprlandInstance() {
  const result = spawnSync('hyprctl', ['instances', '-j'], { encoding: 'utf8' })
  if (result.status !== 0) return null
  try {
    return JSON.parse(result.stdout).sort((a, b) => b.time - a.time)[0] ?? null
  } catch {
    return null
  }
}

function hyprlandSocketExists(runtime, signature) {
  return Boolean(signature) && existsSync(path.join(runtime, 'hypr', signature, '.socket.sock'))
}

function socketExists(runtime, name) {
  return Boolean(name) && existsSync(path.isAbsolute(name) ? name : path.join(runtime, name))
}

export function stateDir() {
  prepareSession()
  const dir = path.join(process.env.XDG_RUNTIME_DIR, 'hyprhand')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function hasCommand(command) {
  if (!commandCache.has(command)) {
    const found = (process.env.PATH || '').split(':').some((dir) => {
      try {
        accessSync(path.join(dir, command), constants.X_OK)
        return true
      } catch {
        return false
      }
    })
    commandCache.set(command, found)
  }
  return commandCache.get(command)
}

export function run(command, args = [], options = {}) {
  prepareSession()
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return result.stdout ?? ''
}

export function spawnDetached(command, args = [], options = {}) {
  prepareSession()
  const child = spawn(command, args, { detached: true, stdio: 'ignore', ...options })
  child.unref()
  return child.pid
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
