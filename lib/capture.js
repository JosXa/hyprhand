import { rmSync } from 'node:fs'
import { tempFile } from './agent.js'
import { withOverlayHidden } from './cursor.js'
import { monitors, resolveWindow } from './hypr.js'
import { settleLayout } from './input.js'
import { callHelper } from './python.js'
import { hasCommand, run } from './session.js'

export const MAX_CAPTURE_SIDE = 1568
const JEV_MIN_SIDE = 280
const JEV_UPSCALE = 1200

export function parseBox(text) {
  const parts = String(text).split(',').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) throw new Error(`Invalid region "${text}"; expected x,y,w,h`)
  return parts
}

export function outputScale([x, y, w, h], outputs = monitors()) {
  const overlapping = outputs.filter((m) => x < m.x + m.width / m.scale && x + w > m.x && y < m.y + m.height / m.scale && y + h > m.y)
  return overlapping.length ? Math.max(...overlapping.map((m) => m.scale)) : 1
}

export function captureArea({ window, region, in: relativeTo } = {}) {
  let box
  let hint
  if (region) {
    const parts = parseBox(region)
    const base = relativeTo || window ? resolveWindow(relativeTo ?? window) : null
    box = base ? [base.bounds[0] + parts[0], base.bounds[1] + parts[1], parts[2], parts[3]] : parts
    hint = 'Use a smaller region.'
  } else if (window) {
    const target = resolveWindow(window)
    box = target.bounds
    hint = `Capture part of it with --window ${target.id} --region x,y,w,h (window-relative).`
  } else {
    throw new Error(`Pick what to capture: --window W [--region x,y,w,h relative to it], or a global --region x,y,w,h. Captures are limited to ${MAX_CAPTURE_SIDE} px per side.`)
  }
  const scale = outputScale(box)
  const [width, height] = [Math.round(box[2] * scale), Math.round(box[3] * scale)]
  if (width > MAX_CAPTURE_SIDE || height > MAX_CAPTURE_SIDE) throw new Error(`Capture would be ${width}x${height} px; the limit is ${MAX_CAPTURE_SIDE} px per side. ${hint}`)
  return box
}

export async function grab(box, out) {
  if (!hasCommand('grim')) throw new Error('grim is required for screenshots')
  await settleLayout()
  await withOverlayHidden(() => run('grim', ['-g', `${box[0]},${box[1]} ${box[2]}x${box[3]}`, out]))
  return { path: out, origin: box.slice(0, 2), size: box.slice(2), scale: outputScale(box) }
}

export function boxToCrop({ top, bottom, left, right }, [fx, fy, fw, fh], [cx, cy, cw, ch]) {
  const x = (value) => cx + ((value - fx) / fw) * cw
  const y = (value) => cy + ((value - fy) / fh) * ch
  return [x(left), y(top), x(right) - x(left), y(bottom) - y(top)]
}

export function zoomAround([x, y, w, h], [width, height], { factor, minimum }) {
  const zoomWidth = Math.min(width, Math.max(minimum, w * factor))
  const zoomHeight = Math.min(height, Math.max(minimum, h * factor))
  const clamp = (value, high) => Math.min(Math.max(value, 0), high)
  return [clamp(x + w / 2 - zoomWidth / 2, width - zoomWidth), clamp(y + h / 2 - zoomHeight / 2, height - zoomHeight), zoomWidth, zoomHeight]
}

export async function snapshotWindow(window) {
  const source = tempFile('snapshot', '.png')
  await grab(window.bounds, source)
  const files = [source]
  const [originX, originY, width, height] = window.bounds
  return {
    bounds: window.bounds,
    image({ crop = [0, 0, width, height], upscaleTo = JEV_UPSCALE } = {}) {
      const out = tempFile('jev', '.jpg')
      files.push(out)
      const { frame } = callHelper('images.py', 'prepare', { source, layout: [width, height], crop, upscale_to: upscaleTo, min_side: JEV_MIN_SIDE, max_side: MAX_CAPTURE_SIDE, out })
      const toWindow = (box) => boxToCrop(box, frame, crop)
      return {
        file: out,
        toWindow,
        toScreen(box) {
          const [x, y, w, h] = toWindow(box)
          return [x + originX, y + originY, w, h]
        },
      }
    },
    dispose() {
      for (const file of files) rmSync(file, { force: true })
    },
  }
}
