import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentName, withOverlayHidden } from './cursor.js'
import { listWindows, monitors, resolveWindow } from './hypr.js'
import { settleLayout } from './input.js'
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

export async function captureRegion(region, out, { scale, jpeg = false } = {}) {
  if (!hasCommand('grim')) throw new Error('grim is required for screenshots')
  const geometry = region ? `${region[0]},${region[1]} ${region[2]}x${region[3]}` : null
  await withOverlayHidden(() => run('grim', [...(jpeg ? ['-t', 'jpeg', '-q', '90'] : []), ...(geometry ? ['-g', geometry] : []), out]))
  if (scale && scale !== 1) {
    run('python3', ['-c', 'import sys; from PIL import Image; image = Image.open(sys.argv[1]); size = tuple(max(1, round(side * float(sys.argv[2]))) for side in image.size); image.convert("RGB").resize(size, Image.LANCZOS).save(sys.argv[1], quality=90) if sys.argv[1].lower().endswith((".jpg", ".jpeg")) else image.resize(size, Image.LANCZOS).save(sys.argv[1])', out, String(scale)])
  }
  return out
}

export const MAX_CAPTURE_SIDE = 1568

export function captureBox({ window, region, in: relativeTo } = {}) {
  let box
  let hint
  if (region) {
    const parts = String(region).split(',').map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) throw new Error(`Invalid region "${region}"; expected x,y,w,h`)
    const base = relativeTo ? resolveWindow(relativeTo) : null
    box = base ? [base.bounds[0] + parts[0], base.bounds[1] + parts[1], parts[2], parts[3]] : parts
    hint = 'Use a smaller region.'
  } else if (window) {
    const target = resolveWindow(window)
    box = target.bounds
    hint = `Capture part of it with --region x,y,w,h --in ${target.id} (window-relative).`
  } else {
    throw new Error(`Pick what to capture: --window W, or --region x,y,w,h [--in W]. Captures are limited to ${MAX_CAPTURE_SIDE} px per side.`)
  }
  const scale = screenshotScale(box)
  const [width, height] = [Math.round(box[2] * scale), Math.round(box[3] * scale)]
  if (width > MAX_CAPTURE_SIDE || height > MAX_CAPTURE_SIDE) throw new Error(`Capture would be ${width}x${height} px; the limit is ${MAX_CAPTURE_SIDE} px per side. ${hint}`)
  return box
}

function screenshotScale(region) {
  const reference = region ?? [0, 0]
  const monitor = monitors().find((m) => reference[0] >= m.x && reference[0] < m.x + m.width / m.scale && reference[1] >= m.y && reference[1] < m.y + m.height / m.scale)
  return monitor?.scale ?? 1
}

export async function observe({ window, region, all = false, screenshot = false, annotated = false, out, interactiveOnly = false } = {}) {
  await settleLayout()
  const box = screenshot || annotated ? captureBox({ window, region, in: region ? window : undefined }) : null
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
    const file = out || path.join(os.tmpdir(), `hyprhand-${agentName()}-${Date.now()}.png`)
    await captureRegion(box, file)
    const scale = screenshotScale(box)
    observation.screenshot = { path: file, origin: box.slice(0, 2), size: box.slice(2), scale }
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
