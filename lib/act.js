import { rememberedWindow, rememberWindow } from './agent.js'
import { showCursor } from './cursor.js'
import { moveCursor } from './hypr.js'
import { pointerClick, pointerDrag, pointerScroll, pressKeys, typeText, withRealInput } from './input.js'
import { a11y } from './python.js'
import { sleep } from './session.js'
import { center, tryWindow } from './target.js'

function elementRequest(element, extra = {}) {
  return { pid: element.pid, path: element.path, role: element.role, name: element.name, ...extra }
}

function keyboardWindow(target) {
  if (target) return target.window
  const remembered = rememberedWindow()
  if (!remembered) throw new Error('No target window yet; pass --into W or --to W')
  const window = tryWindow(remembered)
  if (!window) throw new Error(`Your last window ${remembered} is gone; pass --into W or --to W so input cannot land in another window`)
  return window
}

export async function click(target, { button = 'left', double = false, physical = false, action, stay = false, label } = {}) {
  await showCursor.click(target.point, { bounds: target.bounds, label: label ?? target.label })
  rememberWindow(target.window)
  if (target.kind === 'element' && !physical && !double && button === 'left') {
    const result = a11y('act', elementRequest(target.element, { action }))
    if (result.ok) return { delivered: 'accessibility', action: result.action, target: target.element.id }
    if (!result.fallback) throw new Error(result.error)
  }
  await withRealInput(target.window, () => pointerClick(target.point, { button, count: double ? 2 : 1 }), { stay })
  return { delivered: 'pointer', at: target.point }
}

export async function move(target, { physical = false, label } = {}) {
  await showCursor.moveTo(target.point, { bounds: target.bounds, label })
  if (physical) await withRealInput(null, () => moveCursor(...target.point), { stay: true })
  return { at: target.point }
}

export async function drag(from, to, { durationMs = 700, button = 'left', stay = false } = {}) {
  await showCursor.moveTo(from.point, { bounds: from.bounds, label: 'drag' })
  rememberWindow(from.window)
  let travel
  const followDrag = () => {
    travel = showCursor.moveTo(to.point, { bounds: to.bounds, travel_ms: durationMs, straight: true, label: 'drag' })
  }
  await withRealInput(from.window, () => pointerDrag(from.point, to.point, { button, durationMs, onPressed: followDrag }), { stay })
  await travel
  return { from: from.point, to: to.point }
}

export async function type(target, text, { append = false, submit = false, keyboard = false, stay = false } = {}) {
  const window = keyboardWindow(target)
  const point = target?.point ?? (window ? center(window.bounds) : null)
  if (point) await showCursor.typing(point, Math.min(4, 0.4 + text.length * 0.02), { bounds: target?.bounds })
  rememberWindow(window)
  const address = window?.address
  if (target?.kind === 'element' && !keyboard) {
    const result = a11y('set-text', elementRequest(target.element, { text, append }))
    if (result.ok && !submit) return { delivered: 'accessibility', text: result.text }
    if (result.ok) {
      await withRealInput(window, async () => pressKeys(['Return'], { window: address }), { stay, keyboardFocus: true })
      return { delivered: 'accessibility+keyboard', text: result.text }
    }
    if (!result.fallback) throw new Error(result.error)
  }
  await withRealInput(window, async () => {
    if (target?.kind === 'element') {
      if (!a11y('focus', elementRequest(target.element)).ok) await pointerClick(target.point)
      await sleep(40)
    }
    await typeText(text, { window: address })
    if (submit) pressKeys(['Return'], { window: address })
  }, { stay, keyboardFocus: true })
  return { delivered: 'keyboard', window: window?.id ?? 'focused' }
}

export async function keys(target, combos, { stay = false } = {}) {
  const window = keyboardWindow(target)
  rememberWindow(window)
  if (window) await showCursor.typing(center(window.bounds), 0.6, { label: combos.join(' ') })
  await withRealInput(window, async () => pressKeys(combos, { window: window?.address }), { stay, keyboardFocus: true })
  return { pressed: combos, window: window?.id ?? 'focused' }
}

export async function scroll(target, direction = 'down', amount = 3) {
  const window = target?.window ?? keyboardWindow()
  const point = target?.point ?? center(window.bounds)
  await showCursor.moveTo(point, { bounds: target?.bounds })
  rememberWindow(window)
  await withRealInput(window, () => pointerScroll(point, direction, amount))
  return { scrolled: direction, at: point }
}

export async function setValue(target, value) {
  await showCursor.click(target.point, { bounds: target.bounds })
  const result = a11y('set-value', elementRequest(target.element, { value }))
  if (!result.ok) throw new Error(result.error)
  return result
}

export function read(target) {
  const result = a11y('read', elementRequest(target.element))
  if (!result.ok) throw new Error(result.error)
  return result
}
