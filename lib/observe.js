import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentName, withOverlayHidden } from './cursor.js'
import { listWindows, monitors, resolveWindow } from './hypr.js'
import { hasCommand, run } from './session.js'

const libDir = path.dirname(fileURLToPath(import.meta.url))

function cacheFile() {
  const dir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'hyprhand')
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `observe-${agentName().replace(/[^\w.-]/g, '_')}.json`)
}

export function a11y(command, request, { timeoutMs = 15000 } = {}) {
  const output = run('python3', [path.join(libDir, 'a11y.py'), command], { input: JSON.stringify(request), timeout: timeoutMs })
  return JSON.parse(output)
}

export function loadObservation() {
  try {
    return JSON.parse(readFileSync(cacheFile(), 'utf8'))
  } catch {
    return null
  }
}

function saveObservation(observation) {
  writeFileSync(cacheFile(), JSON.stringify(observation))
}

export async function captureRegion(region, out) {
  if (!hasCommand('grim')) throw new Error('grim is required for screenshots')
  const geometry = region ? `${region[0]},${region[1]} ${region[2]}x${region[3]}` : null
  await withOverlayHidden(() => run('grim', [...(geometry ? ['-g', geometry] : []), out]))
  return out
}

export function regionFor({ window, monitor } = {}) {
  if (window) return resolveWindow(window).bounds
  if (monitor) {
    const found = monitors().find((m) => m.name === monitor || String(m.id) === String(monitor) || (monitor === 'focused' && m.focused))
    if (!found) throw new Error(`No monitor "${monitor}"`)
    return [found.x, found.y, Math.round(found.width / found.scale), Math.round(found.height / found.scale)]
  }
  return null
}

function screenshotScale(region) {
  const reference = region ?? [0, 0]
  const monitor = monitors().find((m) => reference[0] >= m.x && reference[0] < m.x + m.width / m.scale && reference[1] >= m.y && reference[1] < m.y + m.height / m.scale)
  return monitor?.scale ?? 1
}

export async function observe({ window, all = false, screenshot = false, annotated = false, out, interactiveOnly = false } = {}) {
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
  if (screenshot || annotated) {
    const region = window ? targets[0].bounds : null
    const file = out || path.join(os.tmpdir(), `hyprhand-${agentName()}-${Date.now()}.png`)
    await captureRegion(region, file)
    const scale = screenshotScale(region)
    observation.screenshot = { path: file, origin: region ? region.slice(0, 2) : [0, 0], scale }
    if (annotated) {
      run('python3', [path.join(libDir, 'annotate.py')], {
        input: JSON.stringify({ image: file, out: file, origin: observation.screenshot.origin, scale, elements }),
      })
    }
  }
  saveObservation(observation)
  return observation
}

export function findElement(id) {
  const observation = loadObservation()
  const element = observation?.elements.find((candidate) => candidate.id === id)
  if (!element) throw new Error(`Unknown element "${id}" for agent "${agentName()}"; run observe first`)
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
