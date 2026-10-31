import { readFileSync, writeFileSync } from 'node:fs'
import { agentFile, agentName, cacheDir, tempFile } from './agent.js'
import { captureArea, grab } from './capture.js'
import { listWindows, resolveWindow } from './hypr.js'
import { settleLayout } from './input.js'
import { a11y, callHelper } from './python.js'

const observationFile = () => agentFile(cacheDir('observations'), '.json')

function loadObservation() {
  try {
    return JSON.parse(readFileSync(observationFile(), 'utf8'))
  } catch {
    return null
  }
}

export async function observe({ window, region, all = false, screenshot = false, annotated = false, out, interactiveOnly = false, publish = false } = {}) {
  await settleLayout()
  const box = screenshot || annotated ? captureArea({ window, region }) : null
  const windows = listWindows({ all })
  const targets = window ? [resolveWindow(window, windows)] : windows.filter((w) => w.visible)
  const tree = targets.length ? a11y('dump', { windows: targets }) : { ok: true, elements: [], accessible_windows: [] }
  if (!tree.ok) throw new Error(tree.error)
  const elements = tree.elements
    .filter((element) => !interactiveOnly || element.interactive)
    .map((element, index) => ({ id: `e${index + 1}`, ...element }))
  const observation = {
    agent: agentName(),
    takenAt: new Date().toISOString(),
    windows: window ? targets : windows,
    accessibleWindows: tree.accessible_windows,
    truncated: tree.truncated,
    elements,
  }
  if (box) {
    observation.screenshot = await grab(box, out || tempFile('screen', '.png'))
    if (annotated) callHelper('images.py', 'annotate', { image: observation.screenshot.path, origin: box.slice(0, 2), layout: box.slice(2), elements })
  }
  if (publish) writeFileSync(observationFile(), JSON.stringify(observation))
  return observation
}

export function findElement(id) {
  const element = loadObservation()?.elements.find((candidate) => candidate.id === id)
  if (!element) throw new Error(`Unknown element "${id}" for agent "${agentName()}"; ids come from your latest observe or find`)
  return element
}

export function formatObservation(observation) {
  const lines = []
  const accessible = new Set(observation.accessibleWindows)
  for (const window of observation.windows) {
    const marks = [window.focused && 'focused', !window.visible && 'hidden', !accessible.has(window.id) && window.visible && 'no-a11y'].filter(Boolean)
    lines.push(`${window.id} ${window.app} "${window.title}" ws:${window.workspace} @${window.bounds.join(',')}${marks.length ? ` [${marks.join(' ')}]` : ''}`)
    for (const element of observation.elements.filter((e) => e.window === window.id)) {
      const extra = [element.states?.join(' '), element.text && element.text !== element.name && `text="${element.text.slice(0, 80)}"`, element.value && `value=${element.value.current}`].filter(Boolean)
      lines.push(`  ${element.id} ${element.role} "${element.name}" @${element.bounds.join(',')}${extra.length ? ` (${extra.join('; ')})` : ''}`)
    }
  }
  if (observation.truncated) lines.push('(element tree truncated; observe a single window with --window for more)')
  if (observation.screenshot) lines.push(`screenshot: ${observation.screenshot.path} origin=${observation.screenshot.origin.join(',')} scale=${observation.screenshot.scale}`)
  return lines.join('\n')
}
