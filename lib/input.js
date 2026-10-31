import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { activeWindowAddress, cursorPosition, focusAddress, moveCursor, option, setKeyword } from './hypr.js'
import { hasCommand, run, sleep, stateDir } from './session.js'

const buttonCodes = { left: 0x00, right: 0x01, middle: 0x02, back: 0x06, forward: 0x05 }
const keyAliases = {
  enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'space',
  backspace: 'BackSpace', bs: 'BackSpace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
  pageup: 'Prior', pgup: 'Prior', pagedown: 'Next', pgdn: 'Next', menu: 'Menu', print: 'Print',
  plus: 'plus', minus: 'minus', comma: 'comma', period: 'period', slash: 'slash', backslash: 'backslash',
  semicolon: 'semicolon', apostrophe: 'apostrophe', grave: 'grave', equal: 'equal',
}
const modifierAliases = {
  ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', altgr: 'altgr',
  super: 'logo', win: 'logo', meta: 'logo', cmd: 'logo', logo: 'logo',
}

function lockDir() {
  return path.join(stateDir(), 'input.lock')
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function withInputLock(action, { timeoutMs = 20000 } = {}) {
  const dir = lockDir()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(dir)
      writeFileSync(path.join(dir, 'owner'), String(process.pid))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner = 0
      try {
        owner = Number(readFileSync(path.join(dir, 'owner'), 'utf8'))
      } catch {}
      if (owner && !processAlive(owner)) rmSync(dir, { recursive: true, force: true })
      else if (Date.now() > deadline) throw new Error('Another agent holds the input lock; try again')
      else await sleep(25)
    }
  }
  try {
    return await action()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function withHoverFocusPaused(action) {
  const followMouse = option('input:follow_mouse').int
  if (followMouse) setKeyword('input:follow_mouse', 0)
  try {
    return await action()
  } finally {
    if (followMouse) setKeyword('input:follow_mouse', followMouse)
  }
}

export function assertFocus(address) {
  if (!address) return
  const focused = activeWindowAddress()
  if (focused !== address) throw new Error(`Keyboard focus moved to ${focused ?? 'nothing'} before input finished; nothing more was sent`)
}

function restoreEnabled() {
  return !['0', 'false', 'off', 'no'].includes(String(process.env.HYPRHAND_RESTORE ?? '1').toLowerCase())
}

export async function withUserPointerRestored(action) {
  if (!restoreEnabled()) return action()
  const pointer = cursorPosition()
  const focused = activeWindowAddress()
  try {
    return await action()
  } finally {
    await sleep(40)
    if (focused) {
      try {
        focusAddress(focused)
      } catch {}
    }
    moveCursor(pointer.x, pointer.y)
    markLayoutChange()
  }
}

const LAYOUT_SETTLE_MS = 450

function layoutSettleFile() {
  return path.join(stateDir(), 'layout-settles-at')
}

function markLayoutChange() {
  writeFileSync(layoutSettleFile(), String(Date.now() + LAYOUT_SETTLE_MS))
}

export async function settleLayout() {
  let settlesAt = 0
  try {
    settlesAt = Number(readFileSync(layoutSettleFile(), 'utf8'))
  } catch {}
  const remaining = Math.min(settlesAt - Date.now(), LAYOUT_SETTLE_MS)
  if (remaining > 0) await sleep(remaining)
}

function ydotool(...args) {
  if (!hasCommand('ydotool')) throw new Error('ydotool is required for pointer input')
  run('ydotool', args.map(String))
}

export function buttonCode(button = 'left') {
  const code = buttonCodes[button]
  if (code === undefined) throw new Error(`Unknown button "${button}". Use ${Object.keys(buttonCodes).join(', ')}`)
  return code
}

export async function pointerClick([x, y], { button = 'left', count = 1 } = {}) {
  moveCursor(x, y)
  await sleep(35)
  const code = 0xc0 | buttonCode(button)
  ydotool('click', '-r', count, '-D', 60, `0x${code.toString(16)}`)
}

export async function pointerDrag(from, to, { button = 'left', durationMs = 600, steps } = {}) {
  const code = buttonCode(button)
  const stepCount = steps ?? Math.max(8, Math.round(durationMs / 16))
  moveCursor(...from)
  await sleep(50)
  ydotool('click', `0x${(0x40 | code).toString(16)}`)
  await sleep(80)
  for (let step = 1; step <= stepCount; step++) {
    const t = step / stepCount
    moveCursor(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t)
    await sleep(durationMs / stepCount)
  }
  await sleep(80)
  ydotool('click', `0x${(0x80 | code).toString(16)}`)
}

export async function pointerScroll([x, y], direction, amount = 3) {
  moveCursor(x, y)
  await sleep(30)
  const vertical = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] }[direction]
  if (!vertical) throw new Error('Scroll direction must be up, down, left, or right')
  for (let notch = 0; notch < amount; notch++) {
    ydotool('mousemove', '--wheel', '-x', vertical[0], '-y', vertical[1])
    await sleep(20)
  }
}

export function parseKeyCombo(combo) {
  const parts = combo.split('+').map((part) => part.trim()).filter(Boolean)
  if (!parts.length) throw new Error(`Empty key combo "${combo}"`)
  const key = parts.pop()
  const modifiers = parts.map((part) => {
    const modifier = modifierAliases[part.toLowerCase()]
    if (!modifier) throw new Error(`Unknown modifier "${part}" in "${combo}"`)
    return modifier
  })
  const keysym = keyAliases[key.toLowerCase()] ?? (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key.length === 1 && modifiers.length ? key.toLowerCase() : key)
  return { modifiers, keysym }
}

function wtype(args, input) {
  if (!hasCommand('wtype')) throw new Error('wtype is required for keyboard input')
  run('wtype', args, input === undefined ? {} : { input })
}

export function pressKeys(combos, { window } = {}) {
  assertFocus(window)
  const args = []
  for (const combo of combos) {
    const { modifiers, keysym } = parseKeyCombo(combo)
    for (const modifier of modifiers) args.push('-M', modifier)
    args.push('-k', keysym)
    for (const modifier of [...modifiers].reverse()) args.push('-m', modifier)
  }
  wtype(args)
}

const TYPE_CHUNK = 24

export function typeText(text, { delayMs = 4, window } = {}) {
  const characters = [...(text ?? '')]
  for (let start = 0; start < characters.length; start += TYPE_CHUNK) {
    assertFocus(window)
    wtype(['-d', String(delayMs), '-'], characters.slice(start, start + TYPE_CHUNK).join(''))
  }
}
