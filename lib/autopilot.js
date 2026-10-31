import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as act from './act.js'
import { agentSlug, cacheDir } from './agent.js'
import { snapshotWindow, zoomAround } from './capture.js'
import { askJev, box, choice, noul } from './jev.js'
import { readScreen, fieldContent, isTextField, workWindow } from './screen.js'
import { sleep } from './session.js'
import { center, elementTarget, pointTarget, windowTarget } from './target.js'

export const DEFAULTS = { minConfidence: 0.4, steps: 25, timeoutMs: 30000, intervalMs: 1000 }
export const CHECK_THRESHOLDS = { yes: 0.7, no: 0.3 }

const MAX_IDLE = 3
const MAX_REPEATS = 2
const MAX_STALLS = 3
const HISTORY = 8
const SETTLE_MS = 350
const SATISFIED = 0.8
const SATISFIED_WHEN_NOTHING_LEFT = 0.5
const CHECK_ITEMS = 150
const ZOOM = 3
const ZOOM_MIN = 420
const ABSENT = 0.1

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

function decisionConfidence(answers) {
  const kind = answers.kind
  const parts = [kind.confidence]
  if (kind.choice === 'click_item' && answers.item) parts.push(answers.item.confidence)
  if (kind.choice === 'click_visual' && answers.click_target) parts.push(answers.click_target.confidence)
  if (kind.choice === 'type_input' && answers.input) parts.push(answers.input.confidence)
  return Math.min(...parts)
}

function currentTime() {
  return new Date().toLocaleString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function decide(askJev, { goal, window, items, imageFile, inputs, history, tried }) {
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
    now: currentTime(),
    window: { app: window.app, title: window.title },
    focused_field: focused ? focused.criterion : null,
    provided_inputs: inputs.map(describeInput),
    previous_actions: history.slice(-HISTORY),
    already_tried_on_this_screen: tried,
    ...(items.length ? { screen_items_in_reading_order: items.map((item) => ({ id: item.key, role: item.element.role, text: item.label, where: item.where, ...(fieldContent(item.element) !== null ? { contains: fieldContent(item.element) } : {}) })) } : {}),
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

function perform(act, kind, { answers, items, inputs, screen, focused, confidence }) {
  const label = `jev ${kind.replace('_', ' ')} ${confidence.toFixed(2)}`
  const window = windowTarget(screen.window)
  if (kind === 'click_item') {
    const item = items.find((candidate) => candidate.key === answers.item.choice)
    return act.click(elementTarget(item.element, screen.window), { label })
  }
  if (kind === 'click_visual') return act.click(pointTarget(center(screen.image.toScreen(answers.click_target.box)), screen.window), { label })
  if (kind === 'type_input') {
    const named = answers.item ? items.find((item) => item.key === answers.item.choice && isTextField(item.element)) : null
    const field = named ?? focused
    return act.type(field ? elementTarget(field.element, screen.window) : window, inputs[Number(answers.input.choice)].value)
  }
  if (kind === 'press_enter') return act.keys(window, ['Return'])
  if (kind === 'press_escape') return act.keys(window, ['Escape'])
  if (kind === 'go_back') return act.keys(window, ['alt+Left'])
  if (kind === 'scroll_down' || kind === 'scroll_up') return act.scroll(window, kind === 'scroll_down' ? 'down' : 'up', 5)
}

function defaultRunLog() {
  const dir = cacheDir('runs')
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `${new Date().toISOString().replaceAll(':', '-')}-${agentSlug()}.json`)
}

const round = (value) => Math.round(value * 100) / 100

export function createAutopilot({ workWindow, readScreen, snapshotWindow, askJev, act, sleep, runLog = defaultRunLog }) {
  async function spotByVision(description, window) {
    const snapshot = await snapshotWindow(window)
    try {
      const subject = JSON.stringify(description)
      const context = { app: window.app, title: window.title }
      const whole = snapshot.image()
      const first = await askJev({
        state: { window: context, screen: 'screen' },
        questions: { present: noul(`Is ${subject} visible in \`screen\`?`), spot: box(`${description} in \`screen\``) },
        images: { screen: whole.file },
      })
      if (first.answers.present.noul < ABSENT) return { found: false, present: first.answers.present.noul }
      const zoomed = snapshot.image({ crop: zoomAround(whole.toWindow(first.answers.spot.box), window.bounds.slice(2), { factor: ZOOM, minimum: ZOOM_MIN }) })
      const second = await askJev({
        state: { window: context, zoomed: 'zoomed', note: '`zoomed` is an enlarged part of the window around where the control probably is.' },
        questions: { present: noul(`Is ${subject} visible in \`zoomed\`?`), spot: box(`${description} in \`zoomed\``) },
        images: { zoomed: zoomed.file },
      })
      const bounds = zoomed.toScreen(second.answers.spot.box).map(Math.round)
      return { found: true, bounds, confidence: second.answers.present.noul, present: first.answers.present.noul, boxConfidence: second.answers.spot.confidence, ms: first.ms + second.ms }
    } finally {
      snapshot.dispose()
    }
  }

  async function locate(description, { window, minConfidence = DEFAULTS.minConfidence, publish = false } = {}) {
    const anchor = workWindow(window)
    const screen = await readScreen(anchor, { screenshot: 'never', publish })
    const target = screen.window
    if (screen.items.length) {
      const result = await askJev({
        state: { looking_for: description, window: { app: target.app, title: target.title } },
        questions: {
          item: choice(`Which on-screen item is ${JSON.stringify(description)}? Pick "none" when no item matches.`, {
            ...Object.fromEntries(screen.items.map((item) => [item.key, item.criterion])),
            none: 'No listed item matches.',
          }),
        },
      })
      const answer = result.answers.item
      if (answer.choice !== 'none' && answer.confidence >= minConfidence) {
        const item = screen.items.find((candidate) => candidate.key === answer.choice)
        return {
          target: { ...elementTarget(item.element, target), label: item.label || item.element.role },
          report: { target: item.key, via: 'accessibility', confidence: answer.confidence, label: item.label, role: item.element.role, window: target.id, ms: result.ms },
        }
      }
    }
    const spotted = await spotByVision(description, target)
    if (!spotted.found) throw new Error(`Jev does not see ${JSON.stringify(description)} in ${target.id} (visible ${spotted.present.toFixed(2)})`)
    const point = center(spotted.bounds)
    if (spotted.confidence < minConfidence) throw new Error(`Jev found something for ${JSON.stringify(description)} at ${point.join(',')} in ${target.id}, but a close look rejected it (${spotted.confidence.toFixed(2)})`)
    return {
      target: { ...pointTarget(point, target), bounds: spotted.bounds },
      report: { target: point.join(','), via: 'vision', confidence: spotted.confidence, bounds: spotted.bounds, present: spotted.present, box_confidence: spotted.boxConfidence, window: target.id, ms: spotted.ms },
    }
  }

  async function check(statement, { window } = {}) {
    const screen = await readScreen(workWindow(window), { screenshot: 'always' })
    try {
      const result = await askJev({
        state: { window: { app: screen.window.app, title: screen.window.title }, screenshot: 'screen', screen_items: screen.items.slice(0, CHECK_ITEMS).map((item) => item.criterion) },
        questions: { holds: noul(`Looking at \`screen\` and the listed items, is this true right now: ${JSON.stringify(statement)}?`) },
        images: { screen: screen.image.file },
      })
      const score = result.answers.holds.noul
      const verdict = score >= CHECK_THRESHOLDS.yes ? 'yes' : score <= CHECK_THRESHOLDS.no ? 'no' : 'unsure'
      return { statement, verdict, score, window: screen.window.id, ms: result.ms }
    } finally {
      screen.dispose()
    }
  }

  async function waitFor(condition, { window, timeoutMs = DEFAULTS.timeoutMs, intervalMs = DEFAULTS.intervalMs } = {}) {
    const began = Date.now()
    let checks = 0
    let last = null
    while (Date.now() - began < timeoutMs) {
      try {
        last = await check(condition, { window })
        checks++
        if (last.verdict === 'yes') return { ...last, checks, waitedMs: Date.now() - began }
      } catch (error) {
        if (error.code !== 'NO_WINDOW') throw error
        last = { verdict: 'no', reason: error.message }
      }
      await sleep(intervalMs)
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for ${JSON.stringify(condition)} (last: ${last?.verdict ?? 'none'}${last?.score != null ? ` ${last.score.toFixed(2)}` : ''}${last?.reason ? `, ${last.reason}` : ''})`)
  }

  async function drive({ goal, window, steps = DEFAULTS.steps, inputs, minConfidence = DEFAULTS.minConfidence, dryRun = false }) {
    const anchor = workWindow(window)
    const provided = parseInputs(goal, inputs)
    const history = []
    const triedOn = new Map()
    const seenAt = new Map()
    const report = { goal, window: anchor.id, status: 'step_limit', steps: [], log: runLog() }
    const logged = []
    let previousSignature = null
    let idle = 0
    let stalls = 0
    let tokens = 0
    try {
      for (let step = 1; step <= (dryRun ? 1 : steps); step++) {
        const screen = await readScreen(anchor)
        if (!screen) {
          report.status = 'window_closed'
          break
        }
        try {
          const { items, signature } = screen
          report.window = screen.window.id
          if (history.length) history[history.length - 1] += ` → ${outcome(screen.window, seenAt.get(signature), previousSignature === signature)}`
          if (!seenAt.has(signature)) seenAt.set(signature, step)
          idle = signature === previousSignature ? idle + 1 : 0
          if (idle >= MAX_IDLE) {
            report.status = 'stuck'
            report.reason = `the screen stayed the same for ${MAX_IDLE} actions`
            break
          }
          const tried = triedOn.get(signature) ?? []
          const decision = await decide(askJev, { goal, window: screen.window, items, imageFile: screen.image?.file, inputs: provided, history, tried })
          tokens += (decision.usage?.input_tokens ?? 0) + (decision.usage?.output_tokens ?? 0)
          const kind = decision.answers.kind.choice
          const confidence = decisionConfidence(decision.answers)
          const action = describeAction(kind, decision.answers, items, provided)
          const satisfied = decision.answers.satisfied.noul
          const nothingLeft = kind === 'none' && confidence >= minConfidence
          logged.push({ step, state: decision.state, answers: decision.answers })
          if (satisfied >= SATISFIED || (nothingLeft && satisfied >= SATISFIED_WHEN_NOTHING_LEFT)) {
            report.steps.push({ step, action: 'done', confidence: round(satisfied), ms: decision.ms })
            report.status = 'done'
            break
          }
          report.steps.push({ step, action, confidence: round(confidence), ms: decision.ms })
          if (nothingLeft) {
            report.status = 'no_way_forward'
            report.goal_met = round(satisfied)
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
          if (tried.filter((entry) => entry === action).length >= MAX_REPEATS && ++stalls >= MAX_STALLS) {
            report.status = 'stuck'
            report.reason = `kept choosing actions that lead back to the same screen, last: ${action}`
            break
          }
          if (kind === 'wait') await sleep(800)
          else await perform(act, kind, { answers: decision.answers, items, inputs: provided, screen, focused: decision.focused, confidence })
          triedOn.set(signature, [...tried, action])
          history.push(action)
          previousSignature = signature
        } finally {
          screen.dispose()
        }
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

  return { locate, check, waitFor, drive }
}

export const { locate, check, waitFor, drive } = createAutopilot({ workWindow, readScreen, snapshotWindow, askJev, act, sleep })
