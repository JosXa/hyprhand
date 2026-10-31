import { run } from './session.js'

export function hyprctlJson(...args) {
  return JSON.parse(run('hyprctl', ['-j', ...args]) || 'null')
}

export function dispatch(dispatcher, ...args) {
  const output = run('hyprctl', ['dispatch', dispatcher, ...args.map(String)]).trim()
  if (output && output !== 'ok') throw new Error(`hyprctl dispatch ${dispatcher} ${args.join(' ')}: ${output}`)
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

export function activeWindowAddress() {
  return hyprctlJson('activewindow')?.address || null
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
