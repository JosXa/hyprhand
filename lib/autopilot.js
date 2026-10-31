import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentName } from './cursor.js'
import { activeWindowAddress, listWindows, resolveWindow } from './hypr.js'
import { askJev, box, choice, noul } from './jev.js'
import { captureRegion, observe } from './observe.js'
import { run, sleep } from './session.js'

const MAX_ITEMS = 250
const ROW_MATES = 3
const MAX_IDLE = 3
const MAX_REPEATS = 2
const MAX_STALLS = 3
const HISTORY = 8
const SETTLE_MS = 350
const TEXT_ROLES = new Set(['entry', 'password text', 'text', 'terminal', 'editbar', 'paragraph', 'combo box'])

export const DEFAULT_MIN_CONFIDENCE = 0.4

const ACTIONS = {
  click_item: 'Click one of the listed on-screen items (chosen in the item question).',
  click_visual: 'Click the spot on the screenshot that the click_target question marks. Only for windows that list no items.',
  type_input: 'Type one of the provided inputs (chosen in the input question) into the text field that needs it: the item question names the field when it is listed, otherwise the focused field gets it.',
  press_enter: 'Press Return to submit the focused form or field.',
  press_escape: 'Press Escape to dismiss a dialog, menu, or popup.',
  go_back: 'Go back to the previous page or screen, as a Back button does. Use when the last click led somewhere that does not help.',
  scroll_down: 'Scroll down to reveal more of the window.',
  scroll_up: 'Scroll up.',
  wait: 'Nothing to do yet; the window is still loading or changing.',
  none: 'Nothing on screen or in this list helps with the goal.',
}

const SATISFIED = 0.8
const SATISFIED_WHEN_NOTHING_LEFT = 0.5

const firstLine = (value, max) => String(value ?? '').split('\n')[0].trim().slice(0, max)

function label(element) {
  if (isTextField(element)) return firstLine(element.name, 80)
  return firstLine(element.name || element.value || element.text, 80)
}

function content(element) {
  if (!isTextField(element)) return null
  const value = element.text || element.value
  return value ? String(value).slice(0, 120) : null
}

function isTextField(element) {
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
  const labelled = elements.filter((element) => element.interactive || label(element) || content(element))
  const ranked = labelled.length > MAX_ITEMS ? labelled.filter((element) => element.interactive).slice(0, MAX_ITEMS) : labelled
  const items = ranked
    .map((element) => ({ key: element.id, element, label: label(element), where: regionWord(element.bounds, window.bounds) }))
    .sort((a, b) => a.element.bounds[1] - b.element.bounds[1] || a.element.bounds[0] - b.element.bounds[0])
  const mates = rowMates(items)
  for (const item of items) {
    const details = [item.where]
    const contained = content(item.element)
    if (contained !== null) details.push(`contains ${JSON.stringify(contained)}`)
    else if (item.element.value && item.element.value !== item.label) details.push(`value ${JSON.stringify(String(item.element.value).slice(0, 40))}`)
    const flags = (item.element.states ?? []).filter((state) => ['focused', 'checked', 'selected', 'pressed', 'expanded'].includes(state))
    if (flags.length) details.push(flags.join(', '))
    if (mates.has(item.key)) details.push(`in the row of ${mates.get(item.key).map((text) => JSON.stringify(text)).join(', ')}`)
    item.criterion = `${item.element.role} ${JSON.stringify(item.label || '(unlabeled)')} (${details.join('; ')})`
  }
  return items
}

const ZOOM = 3
const ZOOM_MIN = 420
const ZOOM_UPSCALE = 1200
const ABSENT = 0.1

async function snapshotWindow(window) {
  const file = path.join(os.tmpdir(), `hyprhand-jev-${agentName()}-${process.pid}-${Date.now()}.png`)
  await captureRegion(window.bounds, file)
  return { file, bounds: window.bounds }
}

let preparedImages = 0

function prepareImages(snapshot, specs) {
  const images = specs.map((spec) => ({ ...spec, out: snapshot.file.replace(/\.png$/, `-${++preparedImages}.jpg`) }))
  const results = JSON.parse(run('python3', [new URL('./jevimage.py', import.meta.url).pathname, JSON.stringify({ source: snapshot.file, images })]))
  return results.map((result, index) => ({ ...result, crop: specs[index].crop ?? [0, 0, snapshot.bounds[2], snapshot.bounds[3]] }))
}

async function captureForJev(window) {
  const [image] = prepareImages(await snapshotWindow(window), [{ upscale_to: ZOOM_UPSCALE }])
  return image.file
}

function pointFromBox(answer, [x, y, w, h]) {
  const { top, bottom, left, right } = answer.box
  return [Math.round(x + ((left + right) / 2) * w), Math.round(y + ((top + bottom) / 2) * h)]
}

function boxInWindow(answer, image) {
  const [fx, fy, fw, fh] = image.frame
  const [cx, cy, cw, ch] = image.crop
  const along = (value, offset, size, origin, extent) => origin + ((value - offset) / size) * extent
  const left = along(answer.box.left, fx, fw, cx, cw)
  const right = along(answer.box.right, fx, fw, cx, cw)
  const top = along(answer.box.top, fy, fh, cy, ch)
  const bottom = along(answer.box.bottom, fy, fh, cy, ch)
  return [left, top, right - left, bottom - top]
}

function regionAround([x, y, w, h], [, , windowWidth, windowHeight], { factor, minimum }) {
  const width = Math.min(windowWidth, Math.max(minimum, w * factor))
  const height = Math.min(windowHeight, Math.max(minimum, h * factor))
  const clamp = (value, high) => Math.min(Math.max(value, 0), high)
  const left = clamp(x + w / 2 - width / 2, windowWidth - width)
  const top = clamp(y + h / 2 - height / 2, windowHeight - height)
  return [left, top, width, height]
}

async function spotByVision(description, target) {
  const snapshot = await snapshotWindow(target)
  const subject = JSON.stringify(description)
  const context = { app: target.app, title: target.title }
  const [whole] = prepareImages(snapshot, [{ upscale_to: ZOOM_UPSCALE }])
  const first = await askJev({
    state: { window: context, screen: 'screen' },
    questions: { present: noul(`Is ${subject} visible in \`screen\`?`), spot: box(`${description} in \`screen\``) },
    images: { screen: whole.file },
  })
  if (first.answers.present.noul < ABSENT) return { found: false, present: first.answers.present.noul, ms: first.ms }
  const rough = boxInWindow(first.answers.spot, whole)
  const [zoomed] = prepareImages(snapshot, [{ crop: regionAround(rough, target.bounds, { factor: ZOOM, minimum: ZOOM_MIN }), upscale_to: ZOOM_UPSCALE }])
  const second = await askJev({
    state: { window: context, zoomed: 'zoomed', note: '`zoomed` is an enlarged part of the window around where the control probably is.' },
    questions: { present: noul(`Is ${subject} visible in \`zoomed\`?`), spot: box(`${description} in \`zoomed\``) },
    images: { zoomed: zoomed.file },
  })
  const tight = boxInWindow(second.answers.spot, zoomed)
  return {
    found: true,
    point: [Math.round(target.bounds[0] + tight[0] + tight[2] / 2), Math.round(target.bounds[1] + tight[1] + tight[3] / 2)],
    bounds: tight.map(Math.round).map((value, index) => value + (index < 2 ? target.bounds[index] : 0)),
    confidence: second.answers.present.noul,
    present: first.answers.present.noul,
    boxConfidence: second.answers.spot.confidence,
    ms: first.ms + second.ms,
  }
}

function targetWindow(window) {
  const windows = listWindows({ all: true })
  const active = activeWindowAddress()
  const chosen = window ? resolveWindow(window, windows) : windows.find((candidate) => candidate.address === active)
  if (!chosen) throw new Error('No focused window; pass --in <window>')
  return windows
    .filter((candidate) => candidate.pid === chosen.pid && candidate.workspace === chosen.workspace)
    .sort((a, b) => a.focusRank - b.focusRank)[0]
}

export async function locate(description, { window, minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const target = targetWindow(window)
  const observation = await observe({ window: target.id })
  const items = screenItems(observation.elements, target)
  if (items.length) {
    const result = await askJev({
      state: { looking_for: description, window: { app: target.app, title: target.title } },
      questions: {
        item: choice(`Which on-screen item is ${JSON.stringify(description)}? Pick "none" when no item matches.`, {
          ...Object.fromEntries(items.map((item) => [item.key, item.criterion])),
          none: 'No listed item matches.',
        }),
      },
    })
    const answer = result.answers.item
    if (answer.choice !== 'none' && answer.confidence >= minConfidence) {
      const item = items.find((candidate) => candidate.key === answer.choice)
      return { target: item.key, via: 'accessibility', confidence: answer.confidence, label: item.label, role: item.element.role, window: target.id, ms: result.ms }
    }
  }
  const spotted = await spotByVision(description, target)
  if (!spotted.found) throw new Error(`Jev does not see ${JSON.stringify(description)} in ${target.id} (visible ${spotted.present.toFixed(2)})`)
  if (spotted.confidence < minConfidence) throw new Error(`Jev found something for ${JSON.stringify(description)} at ${spotted.point.join(',')} in ${target.id}, but a close look rejected it (${spotted.confidence.toFixed(2)})`)
  return { target: spotted.point.join(','), via: 'vision', confidence: spotted.confidence, bounds: spotted.bounds, present: spotted.present, box_confidence: spotted.boxConfidence, window: target.id, ms: spotted.ms }
}

export const CHECK_THRESHOLDS = { yes: 0.7, no: 0.3 }

export async function check(statement, { window } = {}) {
  const target = targetWindow(window)
  const observation = await observe({ window: target.id })
  const items = screenItems(observation.elements, target).slice(0, 150).map((item) => item.criterion)
  const image = await captureForJev(target)
  const result = await askJev({
    state: { window: { app: target.app, title: target.title }, screenshot: 'screen', screen_items: items },
    questions: { holds: noul(`Looking at \`screen\` and the listed items, is this true right now: ${JSON.stringify(statement)}?`) },
    images: { screen: image },
  })
  const score = result.answers.holds.noul
  const verdict = score >= CHECK_THRESHOLDS.yes ? 'yes' : score <= CHECK_THRESHOLDS.no ? 'no' : 'unsure'
  return { statement, verdict, score, window: target.id, ms: result.ms }
}

export async function waitFor(condition, { window, timeoutMs = 30000, intervalMs = 1000 } = {}) {
  const began = Date.now()
  let checks = 0
  let last = null
  while (Date.now() - began < timeoutMs) {
    try {
      last = await check(condition, { window })
      checks++
      if (last.verdict === 'yes') return { ...last, checks, waitedMs: Date.now() - began }
    } catch (error) {
      if (!/No window matches|No active window/.test(error.message)) throw error
      last = { verdict: 'no', reason: error.message }
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${JSON.stringify(condition)} (last: ${last?.verdict ?? 'none'}${last?.score != null ? ` ${last.score.toFixed(2)}` : ''}${last?.reason ? `, ${last.reason}` : ''})`)
}

function parseInputs(goal, inputs) {
  const given = [].concat(inputs ?? []).filter((value) => typeof value === 'string')
  const named = given.map((entry) => {
    const match = /^([\w.-]+)=(.*)$/s.exec(entry)
    return match ? { name: match[1], value: match[2] } : { name: null, value: entry }
  })
  const quoted = [...goal.matchAll(/"([^"]+)"|“([^”]+)”/g)].map((match) => ({ name: null, value: match[1] ?? match[2] }))
  const seen = new Set()
  return [...named, ...quoted].filter((input) => !seen.has(input.value) && seen.add(input.value))
}

function describeInput(input) {
  return input.name ? `${input.name}: ${JSON.stringify(input.value)}` : JSON.stringify(input.value)
}

function outcome(window, seenAtStep, unchanged) {
  if (unchanged) return 'nothing changed'
  const title = `window title ${JSON.stringify(window.title)}`
  return seenAtStep ? `${title}, back to the screen from before step ${seenAtStep}` : title
}

function screenSignature(items, imageFile) {
  const hash = createHash('sha1')
  if (imageFile) hash.update(readFileSync(imageFile))
  for (const item of items) hash.update(`${item.criterion}|${item.element.bounds.join(',')}\n`)
  return hash.digest('hex').slice(0, 16)
}

function decisionConfidence(answers) {
  const kind = answers.kind
  const parts = [kind.confidence]
  if (kind.choice === 'click_item' && answers.item) parts.push(answers.item.confidence)
  if (kind.choice === 'click_visual' && answers.click_target) parts.push(answers.click_target.confidence)
  if (kind.choice === 'type_input' && answers.input) parts.push(answers.input.confidence)
  return Math.min(...parts)
}

function now() {
  return new Date().toLocaleString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function decide({ goal, window, items, imageFile, inputs, history, tried }) {
  const focused = items.find((item) => (item.element.states ?? []).includes('focused') && isTextField(item.element))
  const kinds = Object.fromEntries(Object.entries(ACTIONS).filter(([kind]) => {
    if (kind === 'click_item') return items.length > 0
    if (kind === 'click_visual') return Boolean(imageFile)
    if (kind === 'type_input') return inputs.length > 0
    return true
  }))
  const questions = {
    kind: choice(
      'You are driving this window one action at a time. Which kind of action makes the most progress toward the goal right now? Do not repeat an action that was just taken unless the screen changed, and never one listed as already tried on this screen: each of those led straight back here.',
      kinds,
    ),
  }
  if (items.length) {
    questions.item = choice(
      'If clicking an item or typing into a listed field is the right move, which item? Never pick an item that an action listed as already tried on this screen used.',
      Object.fromEntries(items.map((item) => [item.key, item.criterion])),
    )
  }
  if (inputs.length) {
    questions.input = choice('If typing is the right move, which provided input belongs in the field?', Object.fromEntries(inputs.map((input, index) => [String(index), describeInput(input)])))
  }
  questions.satisfied = noul('Has every step of the goal been carried out? previous_actions lists each action taken and the screen it led to. Judge steps that are no longer visible by previous_actions, and the final result by the current screen. A goal that ends by returning to an earlier screen is achieved once that return has happened. Answer no while any step is still missing.')
  if (imageFile) questions.click_target = box('If clicking is the right move, which control in `screen` should be clicked next to make progress toward the goal?')
  const state = {
    goal,
    now: now(),
    window: { app: window.app, title: window.title },
    focused_field: focused ? focused.criterion : null,
    provided_inputs: inputs.map(describeInput),
    previous_actions: history.slice(-HISTORY),
    already_tried_on_this_screen: tried,
    ...(items.length ? { screen_items_in_reading_order: items.map((item) => ({ id: item.key, role: item.element.role, text: item.label, where: item.where, ...(content(item.element) !== null ? { contains: content(item.element) } : {}) })) } : {}),
    ...(imageFile ? { screenshot: 'screen' } : {}),
  }
  const result = await askJev({ state, questions, images: imageFile ? { screen: imageFile } : {} })
  return { ...result, state, focused }
}

function describeAction(kind, answers, items, inputs) {
  if (kind === 'click_item') {
    const item = items.find((candidate) => candidate.key === answers.item.choice)
    return `click ${item?.criterion ?? answers.item.choice}`
  }
  if (kind === 'click_visual') return `click spot ${JSON.stringify(answers.click_target.box)}`
  if (kind === 'type_input') return `type ${describeInput(inputs[Number(answers.input.choice)])}`
  return kind
}

async function perform(kind, { answers, items, inputs, window, focused, run, confidence }) {
  const cursorLabel = `jev ${kind.replace('_', ' ')} ${confidence.toFixed(2)}`
  if (kind === 'click_item') return run('click', { target: answers.item.choice, label: cursorLabel })
  if (kind === 'click_visual') return run('click', { target: pointFromBox(answers.click_target, window.bounds).join(','), label: cursorLabel })
  if (kind === 'type_input') {
    const text = inputs[Number(answers.input.choice)].value
    const named = answers.item ? items.find((item) => item.key === answers.item.choice && isTextField(item.element)) : null
    const field = named ?? focused
    return run('type', { text, into: field ? field.key : window.id })
  }
  if (kind === 'press_enter') return run('key', { keys: ['Return'], to: window.id })
  if (kind === 'press_escape') return run('key', { keys: ['Escape'], to: window.id })
  if (kind === 'go_back') return run('key', { keys: ['alt+Left'], to: window.id })
  if (kind === 'scroll_down' || kind === 'scroll_up') return run('scroll', { direction: kind === 'scroll_down' ? 'down' : 'up', amount: 5, at: window.id })
  if (kind === 'wait') return sleep(800)
}

function runLog() {
  const dir = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'hyprhand', 'runs')
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `${new Date().toISOString().replaceAll(':', '-')}-${agentName()}.json`)
}

export async function drive({ goal, window, steps = 25, inputs, minConfidence = DEFAULT_MIN_CONFIDENCE, dryRun = false, run }) {
  const start = targetWindow(window)
  const provided = parseInputs(goal, inputs)
  const history = []
  const triedOn = new Map()
  const seenAt = new Map()
  const report = { goal, window: start.id, status: 'step_limit', steps: [], log: runLog() }
  const logged = []
  let previousSignature = null
  let idle = 0
  let stalls = 0
  let tokens = 0
  try {
    for (let step = 1; step <= (dryRun ? 1 : steps); step++) {
      const current = listWindows({ all: true }).find((candidate) => candidate.address === start.address)
      if (!current) {
        report.status = 'window_closed'
        break
      }
      const observation = await observe({ window: current.id })
      const items = screenItems(observation.elements, current)
      const imageFile = items.length ? null : await captureForJev(current)
      const signature = screenSignature(items, imageFile)
      if (history.length) history[history.length - 1] += ` → ${outcome(current, seenAt.get(signature), previousSignature === signature)}`
      if (!seenAt.has(signature)) seenAt.set(signature, step)
      idle = signature === previousSignature ? idle + 1 : 0
      if (idle >= MAX_IDLE) {
        report.status = 'stuck'
        report.reason = `the screen stayed the same for ${MAX_IDLE} actions`
        break
      }
      const tried = triedOn.get(signature) ?? []
      const decision = await decide({ goal, window: current, items, imageFile, inputs: provided, history, tried })
      tokens += (decision.usage?.input_tokens ?? 0) + (decision.usage?.output_tokens ?? 0)
      const kind = decision.answers.kind.choice
      const confidence = decisionConfidence(decision.answers)
      const action = describeAction(kind, decision.answers, items, provided)
      const satisfied = decision.answers.satisfied.noul
      const nothingLeft = kind === 'none' && confidence >= minConfidence
      if (satisfied >= SATISFIED || (nothingLeft && satisfied >= SATISFIED_WHEN_NOTHING_LEFT)) {
        report.steps.push({ step, action: 'done', confidence: Math.round(satisfied * 100) / 100, ms: decision.ms })
        logged.push({ step, state: decision.state, answers: decision.answers })
        report.status = 'done'
        break
      }
      report.steps.push({ step, action, confidence: Math.round(confidence * 100) / 100, ms: decision.ms })
      logged.push({ step, state: decision.state, answers: decision.answers })
      if (nothingLeft) {
        report.status = 'no_way_forward'
        report.goal_met = Math.round(satisfied * 100) / 100
        break
      }
      if (confidence < minConfidence) {
        report.status = 'unsure'
        report.reason = `confidence ${confidence.toFixed(2)} is below ${minConfidence}`
        report.alternatives = Object.entries(decision.answers.kind.probabilities ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([option, p]) => `${option} ${p.toFixed(2)}`)
        break
      }
      if (dryRun) {
        report.status = 'dry_run'
        break
      }
      if (tried.filter((entry) => entry === action).length >= MAX_REPEATS) {
        stalls++
        if (stalls >= MAX_STALLS) {
          report.status = 'stuck'
          report.reason = `kept choosing actions that lead back to the same screen, last: ${action}`
          break
        }
      }
      await perform(kind, { answers: decision.answers, items, inputs: provided, window: current, focused: decision.focused, run, confidence })
      triedOn.set(signature, [...tried, action])
      history.push(action)
      previousSignature = signature
      await sleep(SETTLE_MS)
    }
  } catch (error) {
    report.status = 'error'
    report.reason = error.message
  }
  report.tokens = tokens
  writeFileSync(report.log, JSON.stringify({ ...report, requests: logged }, null, 2))
  return report
}
