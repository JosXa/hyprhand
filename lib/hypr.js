import { createConnection } from 'node:net'
import path from 'node:path'
import { prepareSession, run } from './session.js'

export function hyprctlJson(...args) {
  return JSON.parse(run('hyprctl', ['-j', ...args]) || 'null')
}

export function dispatch(dispatcher, ...args) {
  const output = run('hyprctl', ['dispatch', dispatcher, ...args.map(String)]).trim()
  if (output && output !== 'ok') throw new Error(`hyprctl dispatch ${dispatcher} ${args.join(' ')}: ${output}`)
}

export function option(name) {
  return hyprctlJson('getoption', name)
}

export function setKeyword(name, value) {
  const output = run('hyprctl', ['keyword', name, String(value)]).trim()
  if (output && output !== 'ok') throw new Error(`hyprctl keyword ${name} ${value}: ${output}`)
}

export function monitors() {
  return hyprctlJson('monitors')
}

export function workspaces() {
  return hyprctlJson('workspaces')
}

export function cursorPosition() {
  return hyprctlJson('cursorpos')
}

export function moveCursor(x, y) {
  dispatch('movecursor', Math.round(x), Math.round(y))
}

export function watchFocus(onFocus) {
  prepareSession()
  const socket = createConnection(path.join(process.env.XDG_RUNTIME_DIR, 'hypr', process.env.HYPRLAND_INSTANCE_SIGNATURE, '.socket2.sock'))
  let pending = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    const lines = (pending + chunk).split('\n')
    pending = lines.pop()
    for (const line of lines) {
      const match = /^activewindowv2>>(.*)$/.exec(line)
      if (match) onFocus(match[1] ? `0x${match[1].replace(/^0x/, '')}` : null)
    }
  })
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', () => resolve(() => socket.destroy()))
  })
}

export function activeWindowAddress() {
  return hyprctlJson('activewindow')?.address || null
}

export function layerNamespaces() {
  const names = Object.values(hyprctlJson('layers') ?? {}).flatMap((monitor) => Object.values(monitor.levels ?? {}).flat().map((layer) => layer.namespace))
  return [...new Set(names)].filter((name) => name && name !== 'hyprhand')
}

export function focusAddress(address) {
  dispatch('focuswindow', `address:${address}`)
}

export function windowId(address) {
  return `w${address.slice(-4)}`
}

export function listWindows({ all = false } = {}) {
  const visibleWorkspaces = new Set()
  for (const monitor of monitors()) {
    visibleWorkspaces.add(monitor.activeWorkspace?.id)
    if (monitor.specialWorkspace?.id) visibleWorkspaces.add(monitor.specialWorkspace.id)
  }
  const activeAddress = activeWindowAddress()
  return hyprctlJson('clients')
    .filter((client) => client.mapped && !client.hidden && client.size[0] > 1 && client.size[1] > 1)
    .map((client) => ({
      id: windowId(client.address),
      address: client.address,
      app: client.class || client.initialClass || '',
      title: client.title || '',
      pid: client.pid,
      bounds: [client.at[0], client.at[1], client.size[0], client.size[1]],
      workspace: client.workspace?.name ?? null,
      visible: visibleWorkspaces.has(client.workspace?.id),
      focused: client.address === activeAddress,
      xwayland: client.xwayland,
      focusRank: client.focusHistoryID,
    }))
    .filter((window) => all || window.visible)
    .sort((a, b) => a.focusRank - b.focusRank)
}

export function resolveWindow(target, windows = listWindows({ all: true })) {
  const needle = String(target)
  const exact = windows.find((window) => window.id === needle || window.address === needle || `address:${window.address}` === needle)
  if (exact) return exact
  const lowered = needle.toLowerCase()
  const byClass = windows.filter((window) => window.app.toLowerCase() === lowered)
  if (byClass.length) return preferVisible(byClass)
  const pattern = new RegExp(needle, 'i')
  const byText = windows.filter((window) => pattern.test(window.app) || pattern.test(window.title))
  if (byText.length) return preferVisible(byText)
  throw new Error(`No window matches "${target}". Run "hyprhand windows --all" to list windows.`)
}

function preferVisible(windows) {
  return windows.find((window) => window.visible) ?? windows[0]
}
