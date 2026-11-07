import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { snapshotWindow } from './capture.js'
import { activeWindowAddress, dispatch, dispatcher, listWindows, noWindowError, resolveWindow } from './hypr.js'
import { observe } from './observe.js'

const MAX_ITEMS = 250
const ROW_MATES = 3
const TEXT_ROLES = new Set(['entry', 'password text', 'text', 'terminal', 'editbar', 'paragraph', 'combo box'])

const firstLine = (value, max) => String(value ?? '').split('\n')[0].trim().slice(0, max)

function label(element) {
  if (isTextField(element)) return firstLine(element.name, 80)
  return firstLine(element.name || element.value || element.text, 80)
}

export function fieldContent(element) {
  if (!isTextField(element)) return null
  const value = element.text || element.value
  return value ? String(value).slice(0, 120) : null
}

export function isTextField(element) {
  return TEXT_ROLES.has(element.role) || (element.states ?? []).includes('editable')
}

function regionWord([x, y, w, h], [wx, wy, ww, wh]) {
  const cx = (x + w / 2 - wx) / ww
  const cy = (y + h / 2 - wy) / wh
  const vertical = cy < 1 / 3 ? 'top' : cy < 2 / 3 ? 'middle' : 'bottom'
  const horizontal = cx < 1 / 3 ? 'left' : cx < 2 / 3 ? 'center' : 'right'
  if (vertical === 'middle' && horizontal === 'center') return 'center'
  return `${vertical}-${horizontal}`
}

function rowMates(items) {
  const counts = new Map()
  for (const item of items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1)
  const mates = new Map()
  for (const item of items) {
    if (counts.get(item.label) < 2) continue
    const [, y, , h] = item.element.bounds
    const middle = y + h / 2
    const row = items
      .filter((other) => other !== item && other.label && Math.abs(other.element.bounds[1] + other.element.bounds[3] / 2 - middle) < Math.max(1, h / 2))
      .sort((a, b) => a.element.bounds[0] - b.element.bounds[0])
      .slice(0, ROW_MATES)
      .map((other) => other.label)
    if (row.length) mates.set(item.key, row)
  }
  return mates
}

export function screenItems(elements, window) {
  const labelled = elements.filter((element) => element.interactive || label(element) || fieldContent(element))
  const ranked = labelled.length > MAX_ITEMS ? labelled.filter((element) => element.interactive).slice(0, MAX_ITEMS) : labelled
  const items = ranked
    .map((element) => ({ key: element.id, element, label: label(element), where: regionWord(element.bounds, window.bounds) }))
    .sort((a, b) => a.element.bounds[1] - b.element.bounds[1] || a.element.bounds[0] - b.element.bounds[0])
  const mates = rowMates(items)
  for (const item of items) {
    const details = [item.where]
    const contained = fieldContent(item.element)
    if (contained !== null) details.push(`contains ${JSON.stringify(contained)}`)
    else if (item.element.value && item.element.value !== item.label) details.push(`value ${JSON.stringify(String(item.element.value).slice(0, 40))}`)
    const flags = (item.element.states ?? []).filter((state) => ['focused', 'checked', 'selected', 'pressed', 'expanded'].includes(state))
    if (flags.length) details.push(flags.join(', '))
    if (mates.has(item.key)) details.push(`in the row of ${mates.get(item.key).map((text) => JSON.stringify(text)).join(', ')}`)
    item.criterion = `${item.element.role} ${JSON.stringify(item.label || '(unlabeled)')} (${details.join('; ')})`
  }
  return items
}

const isStrayDialog = (candidate, window) =>
  candidate.pid === window.pid && candidate.floating && !candidate.pinned && candidate.workspace !== window.workspace

export function gatherDialogs(window, windows, move = dispatch) {
  const strays = windows.filter((candidate) => isStrayDialog(candidate, window))
  for (const stray of strays) {
    const [x, y, width, height] = window.bounds
    const [, , dialogWidth, dialogHeight] = stray.bounds
    const target = `address:${stray.address}`
    move(dispatcher('window.move', { workspace: String(window.workspaceId), follow: false, window: target }))
    move(dispatcher('window.move', { x: Math.round(x + (width - dialogWidth) / 2), y: Math.round(y + (height - dialogHeight) / 2), window: target }))
  }
  return strays.length > 0
}

export function frontmostSibling(window, windows) {
  return windows
    .filter((candidate) => candidate.pid === window.pid && candidate.workspace === window.workspace)
    .sort((a, b) => Number(b.floating) - Number(a.floating) || a.focusRank - b.focusRank)[0] ?? null
}

function siblingsGathered(window, windows) {
  return gatherDialogs(window, windows) ? listWindows({ all: true }) : windows
}

export function workWindow(spec, windows = listWindows({ all: true })) {
  const chosen = spec ? resolveWindow(spec, windows) : windows.find((candidate) => candidate.address === activeWindowAddress())
  if (!chosen) throw noWindowError('No focused window; pass --in <window>')
  return frontmostSibling(chosen, siblingsGathered(chosen, windows))
}

function screenSignature(items, imageFile) {
  const hash = createHash('sha1')
  if (imageFile) hash.update(readFileSync(imageFile))
  for (const item of items) hash.update(`${item.criterion}|${item.element.bounds.join(',')}\n`)
  return hash.digest('hex').slice(0, 16)
}

export async function readScreen(anchor, { screenshot = 'if-no-items', publish = false } = {}) {
  const window = frontmostSibling(anchor, siblingsGathered(anchor, listWindows({ all: true })))
  if (!window) return null
  const observation = await observe({ window: window.id, publish })
  const items = screenItems(observation.elements, window)
  const wanted = screenshot === 'always' || (screenshot === 'if-no-items' && !items.length)
  const snapshot = wanted ? await snapshotWindow(window) : null
  const image = snapshot?.image() ?? null
  return { window, items, image, signature: screenSignature(items, image?.file), dispose: () => snapshot?.dispose() }
}
