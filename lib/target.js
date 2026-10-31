import { listWindows, resolveWindow } from './hypr.js'
import { findElement } from './observe.js'

export const center = ([x, y, w, h]) => [Math.round(x + w / 2), Math.round(y + h / 2)]

export function parsePair(text) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text))
  return match ? [Number(match[1]), Number(match[2])] : null
}

export function elementTarget(element, window) {
  return { kind: 'element', element, point: center(element.bounds), bounds: element.bounds, window, label: element.name || element.role }
}

export function pointTarget(point, window = windowAt(point)) {
  return { kind: 'point', point: point.map(Math.round), window }
}

export function windowTarget(window) {
  return { kind: 'window', point: center(window.bounds), bounds: window.bounds, window, label: window.app }
}

export function tryWindow(spec) {
  try {
    return resolveWindow(spec)
  } catch {
    return null
  }
}

function windowAt([x, y]) {
  return listWindows().find((w) => x >= w.bounds[0] && x < w.bounds[0] + w.bounds[2] && y >= w.bounds[1] && y < w.bounds[1] + w.bounds[3]) ?? null
}

export function resolveTarget(ref, { relativeTo } = {}) {
  if (ref === undefined || ref === null || ref === '') throw new Error('A target is required: eN, a window id, or x,y')
  const text = String(ref)
  if (/^e\d+$/.test(text)) {
    const element = findElement(text)
    return elementTarget(element, tryWindow(element.window))
  }
  const pair = parsePair(text)
  if (pair) {
    const window = relativeTo ? resolveWindow(relativeTo) : null
    return window ? pointTarget([window.bounds[0] + pair[0], window.bounds[1] + pair[1]], window) : pointTarget(pair)
  }
  return windowTarget(resolveWindow(text))
}
