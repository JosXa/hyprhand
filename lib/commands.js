import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as act from './act.js'
import { agentColor, agentName, rememberWindow, tempFile, withAgent, workWindowSpec } from './agent.js'
import { check, DEFAULTS, drive, locate, waitFor } from './autopilot.js'
import { captureArea, grab, MAX_CAPTURE_SIDE } from './capture.js'
import { forgetCursor, listCursors, startOverlay, stopOverlay } from './cursor.js'
import { cursorPosition, dispatch, focusAddress, hyprctlJson, listWindows, monitors, resolveWindow, workspaces } from './hypr.js'
import { jevAvailable, jevModel } from './jev.js'
import { observe, formatObservation } from './observe.js'
import { recordingStatus, startRecording, stopRecording } from './record.js'
import { hasCommand, run, sleep, spawnDetached } from './session.js'
import { resolveTarget, tryWindow } from './target.js'

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const FALSE_WORDS = new Set(['false', '0', 'no', 'off'])

const flag = (description, type = 'string', { required = false, default: fallback } = {}) => ({ description, type, required, default: fallback })

async function pick(o, key) {
  if (!o.find) return resolveTarget(o[key], { relativeTo: o.in })
  const { target, report } = await locate(o.find, { window: workWindowSpec(o.in), minConfidence: o['min-confidence'] })
  return { ...target, found: report }
}

const withFound = (target, result) => (target?.found ? { ...result, found: target.found } : result)

const findFlag = () => flag('Describe the target instead; Jev picks it from the accessibility tree or the screenshot of --in (or the last used window)')
const minConfidenceFlag = () => flag('Stop and report when Jev is less sure than this', 'number', { default: DEFAULTS.minConfidence })

export const commands = {
  do: {
    summary: 'Pursue a goal in one window with Jev choosing each next action (fast, cheap); returns a step report',
    positional: ['goal'],
    options: {
      goal: flag('What should be achieved, in plain words; quoted text in it becomes typeable input', 'string', { required: true }),
      in: flag('Window to work in (default: last used or focused window)'),
      input: flag('Text the run may type, as value or name=value; repeat for several', 'array'),
      steps: flag('Maximum actions', 'number', { default: DEFAULTS.steps }),
      'min-confidence': minConfidenceFlag(),
      'dry-run': flag('Decide one step without acting', 'boolean'),
    },
    async run(o) {
      const report = await drive({ goal: o.goal, window: workWindowSpec(o.in), inputs: o.input, steps: o.steps, minConfidence: o['min-confidence'], dryRun: o['dry-run'] })
      rememberWindow(tryWindow(report.window))
      return report
    },
  },
  find: {
    summary: 'Locate a described control with Jev: accessibility items first, screenshot vision otherwise; eN results stay valid for later commands',
    positional: ['description'],
    options: { description: flag('What to find, such as "the Send button"', 'string', { required: true }), in: flag('Window to search (default: last used or focused window)'), 'min-confidence': minConfidenceFlag() },
    async run(o) {
      return (await locate(o.description, { window: workWindowSpec(o.in), minConfidence: o['min-confidence'], publish: true })).report
    },
  },
  check: {
    summary: 'Ask Jev whether a statement about a window is true right now (verdict yes, no, or unsure)',
    positional: ['statement'],
    options: { statement: flag('What should be true, such as "the message was sent"', 'string', { required: true }), in: flag('Window to look at (default: last used or focused window)') },
    run: (o) => check(o.statement, { window: workWindowSpec(o.in) }),
  },
  'wait-for': {
    summary: 'Repeat a Jev check until the condition holds; fails after --timeout',
    positional: ['condition'],
    options: {
      condition: flag('What to wait for, such as "the upload finished"', 'string', { required: true }),
      in: flag('Window to watch; keeps polling while it does not exist yet'),
      timeout: flag('Milliseconds before giving up', 'number', { default: DEFAULTS.timeoutMs }),
      interval: flag('Milliseconds between checks', 'number', { default: DEFAULTS.intervalMs }),
    },
    run: (o) => waitFor(o.condition, { window: workWindowSpec(o.in), timeoutMs: o.timeout, intervalMs: o.interval }),
  },
  observe: {
    summary: 'List windows and accessible UI elements with ids, optionally with a screenshot',
    options: {
      window: flag('Limit to one window (id, class, or title regex)'),
      all: flag('Include windows on hidden workspaces', 'boolean'),
      screenshot: flag('Capture a screenshot of --window too (needs --window)', 'boolean'),
      annotated: flag('Capture a screenshot of --window with element ids drawn on it', 'boolean'),
      region: flag('Screenshot only x,y,w,h relative to --window'),
      interactive: flag('Only list interactive elements', 'boolean'),
      out: flag('Screenshot path'),
      format: flag('text or json', 'string', { default: 'text' }),
    },
    async run(o) {
      const observation = await observe({ window: o.window, region: o.region, all: o.all, screenshot: o.screenshot, annotated: o.annotated, out: o.out, interactiveOnly: o.interactive, publish: true })
      return o.format === 'json' ? observation : formatObservation(observation)
    },
  },
  screenshot: {
    summary: `Capture one window or region, at most ${MAX_CAPTURE_SIDE} px per side (cursor overlay is hidden)`,
    options: { window: flag('Window target'), region: flag('x,y,w,h relative to --window or --in, global without them'), in: flag('Window that --region is relative to, same as --window'), out: flag('Output PNG path') },
    async run(o) {
      const { scale, ...shot } = await grab(captureArea(o), o.out || tempFile('screen', '.png'))
      return shot
    },
  },
  click: {
    summary: 'Click an element (accessibility action first), a window, or x,y',
    positional: ['target'],
    options: {
      target: flag('eN, window id, or x,y'),
      find: findFlag(),
      in: flag('Treat x,y as relative to this window; window that --find searches'),
      'min-confidence': minConfidenceFlag(),
      button: flag('left, right, middle', 'string', { default: 'left' }),
      double: flag('Double click', 'boolean'),
      physical: flag('Skip the accessibility action and use real pointer input', 'boolean'),
      action: flag('Accessibility action name to invoke'),
      stay: flag('Leave focus and pointer at the target (needed for menus that close on focus loss)', 'boolean'),
      label: flag('Short intent text shown next to this agent\'s cursor'),
    },
    async run(o) {
      const target = await pick(o, 'target')
      return withFound(target, await act.click(target, { button: o.button, double: o.double, physical: o.physical, action: o.action, stay: o.stay, label: o.label }))
    },
  },
  move: {
    summary: 'Move this agent\'s cursor to a target (add --physical to also move the real pointer)',
    positional: ['target'],
    options: { target: flag('eN, window id, or x,y'), find: findFlag(), in: flag('Relative window'), 'min-confidence': minConfidenceFlag(), physical: flag('Move the real pointer too', 'boolean'), label: flag('Short intent text shown next to this agent\'s cursor') },
    async run(o) {
      const target = await pick(o, 'target')
      return withFound(target, await act.move(target, { physical: o.physical, label: o.label }))
    },
  },
  drag: {
    summary: 'Drag with the real pointer from one target to another',
    options: {
      from: flag('Source eN, window, or x,y', 'string', { required: true }),
      to: flag('Destination eN, window, or x,y', 'string', { required: true }),
      in: flag('Relative window'),
      duration: flag('Milliseconds', 'number', { default: 700 }),
      button: flag('Mouse button', 'string', { default: 'left' }),
      stay: flag('Keep focus at the target', 'boolean'),
    },
    run: (o) => act.drag(resolveTarget(o.from, { relativeTo: o.in }), resolveTarget(o.to, { relativeTo: o.in }), { durationMs: o.duration, button: o.button, stay: o.stay }),
  },
  type: {
    summary: 'Type text: sets accessible text fields directly, otherwise types into the target or last used window',
    positional: ['text'],
    options: {
      text: flag('Text to type', 'string', { required: true }),
      into: flag('eN text field or window to type into'),
      find: flag('Describe the text field instead of --into; Jev locates it in --in or the last used window'),
      in: flag('Window that --find searches'),
      'min-confidence': minConfidenceFlag(),
      append: flag('Append to an accessible text field instead of replacing it', 'boolean'),
      submit: flag('Press Enter afterwards', 'boolean'),
      keyboard: flag('Force real keystrokes even for accessible text fields', 'boolean'),
      stay: flag('Keep focus on the target window', 'boolean'),
    },
    async run(o) {
      const target = o.find ? await pick(o) : o.into ? resolveTarget(o.into) : null
      return withFound(target, await act.type(target, o.text, { append: o.append, submit: o.submit, keyboard: o.keyboard, stay: o.stay }))
    },
  },
  key: {
    summary: 'Press key combos such as ctrl+l, Return, alt+F4 in the target or last used window',
    positional: ['keys'],
    variadic: true,
    options: { keys: flag('Key combos', 'array', { required: true }), to: flag('Window or element receiving the keys'), stay: flag('Keep focus on the target window', 'boolean') },
    run: (o) => act.keys(o.to ? resolveTarget(o.to) : null, o.keys.flatMap((k) => k.split(/\s+/)).filter(Boolean), { stay: o.stay }),
  },
  scroll: {
    summary: 'Scroll the wheel over a target',
    positional: ['direction'],
    options: {
      direction: flag('up, down, left, right', 'string', { default: 'down' }),
      amount: flag('Wheel notches', 'number', { default: 3 }),
      at: flag('eN, window, or x,y (default: last used window)'),
      find: flag('Describe the area to scroll; Jev locates it'),
      in: flag('Relative window'),
      'min-confidence': minConfidenceFlag(),
    },
    async run(o) {
      const target = o.find || o.at ? await pick(o, 'at') : null
      return withFound(target, await act.scroll(target, o.direction, o.amount))
    },
  },
  'set-value': {
    summary: 'Set a slider or spin button value through accessibility',
    positional: ['target', 'value'],
    options: { target: flag('eN', 'string', { required: true }), value: flag('Number', 'number', { required: true }) },
    run: (o) => act.setValue(resolveTarget(o.target), o.value),
  },
  read: {
    summary: 'Read the live text, states, and value of an element',
    positional: ['target'],
    options: { target: flag('eN', 'string', { required: true }) },
    run: (o) => act.read(resolveTarget(o.target)),
  },
  'open-app': {
    summary: 'Launch an app (desktop id, binary, or command line) and wait for its window',
    positional: ['app'],
    options: { app: flag('Desktop file id or command', 'string', { required: true }), wait: flag('Window class or title regex to wait for'), timeout: flag('Seconds', 'number', { default: 15 }) },
    async run(o) {
      const before = new Set(listWindows({ all: true }).map((w) => w.address))
      const app = String(o.app)
      if (hasCommand('gtk-launch') && !app.includes(' ') && desktopEntryExists(app)) spawnDetached('gtk-launch', [app])
      else dispatch('exec', app)
      const deadline = Date.now() + o.timeout * 1000
      const pattern = new RegExp(o.wait ?? app.split(/[\s/]/).pop().replace(/\.desktop$/, '').split('.').pop(), 'i')
      while (Date.now() < deadline) {
        await sleep(250)
        const fresh = listWindows({ all: true }).filter((w) => !before.has(w.address))
        const match = fresh.find((w) => pattern.test(w.app) || pattern.test(w.title)) ?? (o.wait ? null : fresh[0])
        if (match) {
          rememberWindow(match)
          return match
        }
      }
      throw new Error(`No new window matching ${pattern} appeared`)
    },
  },
  windows: {
    summary: 'List windows (visible ones unless --all)',
    options: { all: flag('Include hidden workspaces', 'boolean') },
    run: (o) => listWindows({ all: o.all }),
  },
  'focus-window': {
    summary: 'Focus a window (switches workspace if needed)',
    positional: ['target'],
    options: { target: flag('Window id, class, or title regex', 'string', { required: true }) },
    async run(o) {
      const window = resolveWindow(o.target)
      focusAddress(window.address)
      rememberWindow(window)
      return window
    },
  },
  'close-window': {
    summary: 'Close a window gracefully',
    positional: ['target'],
    options: { target: flag('Window id, class, or title regex', 'string', { required: true }) },
    run(o) {
      const window = resolveWindow(o.target)
      dispatch('closewindow', `address:${window.address}`)
      return { closed: window.id }
    },
  },
  workspace: {
    summary: 'Switch to a workspace',
    positional: ['workspace'],
    options: { workspace: flag('Workspace id or name', 'string', { required: true }) },
    run: (o) => (dispatch('workspace', o.workspace), { workspace: o.workspace }),
  },
  'move-window-workspace': {
    summary: 'Move a window to a workspace',
    positional: ['workspace'],
    options: { workspace: flag('Workspace id or name', 'string', { required: true }), target: flag('Window'), silent: flag('Do not follow the window', 'boolean') },
    run(o) {
      const window = o.target ? resolveWindow(o.target) : null
      dispatch(o.silent ? 'movetoworkspacesilent' : 'movetoworkspace', window ? `${o.workspace},address:${window.address}` : o.workspace)
      return { moved: window?.id ?? 'active', workspace: o.workspace }
    },
  },
  dispatch: {
    summary: 'Run any Hyprland dispatcher',
    positional: ['dispatcher', 'args'],
    variadic: true,
    options: { dispatcher: flag('Dispatcher name', 'string', { required: true }), args: flag('Arguments', 'array') },
    run: (o) => (dispatch(o.dispatcher, ...(o.args ?? [])), { ok: true }),
  },
  'active-window': { summary: 'Show the focused window', run: () => listWindows({ all: true }).find((w) => w.focused) ?? null },
  monitors: { summary: 'List monitors', run: () => monitors() },
  workspaces: { summary: 'List workspaces', run: () => workspaces() },
  cursor: { summary: 'Show the real pointer position', run: () => cursorPosition() },
  keybindings: { summary: 'List Hyprland keybindings', run: () => hyprctlJson('binds') },
  cursors: {
    summary: 'Manage agent cursors: list (default), start, stop, forget',
    positional: ['action'],
    options: { action: flag('list, start, stop, forget', 'string', { default: 'list' }) },
    async run(o) {
      const action = o.action
      if (action === 'start') return { started: await startOverlay() }
      if (action === 'stop') return (await stopOverlay(), { stopped: true })
      if (action === 'forget') return (await forgetCursor(), { forgot: agentName() })
      if (action === 'list') return { me: { name: agentName(), color: agentColor() }, active: await listCursors() }
      throw new Error(`Unknown cursors action "${action}"`)
    },
  },
  record: {
    summary: 'Record the screen with the agent cursors to an mp4: start, stop, status',
    positional: ['action'],
    options: {
      action: flag('start, stop, status', 'string', { default: 'status' }),
      monitor: flag('Monitor name to record, such as DP-3'),
      window: flag('Record the area of this window'),
      region: flag('Global area x,y,w,h to record'),
      out: flag('Output file, ~/Videos/hyprhand/<time>-<agent>.mp4 when omitted'),
      fps: flag('Frames per second', 'number', { default: 30 }),
    },
    async run(o) {
      const action = o.action
      if (action === 'start') return startRecording({ monitor: o.monitor, window: o.window, region: o.region, out: o.out, fps: o.fps })
      if (action === 'stop') return stopRecording()
      if (action === 'status') return recordingStatus()
      throw new Error(`Unknown record action "${action}"`)
    },
  },
  doctor: {
    summary: 'Check dependencies and session access',
    run() {
      const checks = {}
      const probe = (name, fn) => {
        try {
          checks[name] = fn() ?? true
        } catch (error) {
          checks[name] = `FAIL: ${error.message.split('\n')[0]}`
        }
      }
      for (const command of ['hyprctl', 'grim', 'ydotool', 'wtype', 'python3', 'gtk-launch']) checks[command] = hasCommand(command) || 'missing'
      probe('hyprland', () => `${listWindows({ all: true }).length} windows`)
      probe('ydotoold', () => (run('ydotool', ['click', '--help']), process.env.YDOTOOL_SOCKET ?? 'default socket'))
      probe('pyatspi', () => (run('python3', ['-c', 'import pyatspi']), 'ok'))
      probe('overlay', () => (run('python3', ['-c', 'import gi; gi.require_version("GtkLayerShell","0.1"); from gi.repository import GtkLayerShell']), 'gtk-layer-shell ok'))
      probe('pillow', () => (run('python3', ['-c', 'import PIL']), 'ok'))
      checks.jev = jevAvailable() ? jevModel() : 'TYPESAFE_API_KEY missing: find, --find and do are unavailable'
      checks.agent = agentName()
      return checks
    },
  },
  'skill-path': { summary: 'Print the agent skill path', run: () => path.join(rootDir, 'skills', 'hyprhand-computer-use', 'SKILL.md') },
}

function desktopEntryExists(id) {
  const name = id.endsWith('.desktop') ? id : `${id}.desktop`
  const dirs = [path.join(os.homedir(), '.local/share/applications'), ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').map((d) => path.join(d, 'applications'))]
  return dirs.some((dir) => {
    try {
      readFileSync(path.join(dir, name))
      return true
    } catch {
      return false
    }
  })
}

function normalizeValue(key, spec, value) {
  if (spec.type === 'boolean') return typeof value === 'string' ? !FALSE_WORDS.has(value.toLowerCase()) : Boolean(value)
  if (spec.type === 'number') {
    const number = Number(value)
    if (value === '' || value === true || !Number.isFinite(number)) throw new Error(`--${key} must be a number, got ${JSON.stringify(value)}`)
    return number
  }
  if (spec.type === 'array') return [].concat(value).map(String)
  if (Array.isArray(value)) return String(value.at(-1))
  if (value === true) throw new Error(`--${key} needs a value`)
  return String(value)
}

export function normalizeInput(command, input = {}) {
  const normalized = {}
  for (const [key, spec] of Object.entries(command.options ?? {})) {
    const value = input[key] ?? spec.default
    if (value === undefined || value === null) {
      if (spec.required) throw new Error(`Missing ${(command.positional ?? []).includes(key) ? `<${key}>` : `--${key}`}`)
      continue
    }
    normalized[key] = normalizeValue(key, spec, value)
  }
  return normalized
}

export function invokeCommand(name, input, { agent } = {}) {
  const command = commands[name]
  if (!command) throw new Error(`Unknown command "${name}"`)
  return withAgent(agent, async () => command.run(normalizeInput(command, input)))
}
