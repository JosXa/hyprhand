import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAgentState, updateAgentState } from './agent-state.js'
import { check, DEFAULT_MIN_CONFIDENCE, drive, locate, waitFor } from './autopilot.js'
import { agentColor, agentName, forgetCursor, listCursors, showCursor, startOverlay, stopOverlay } from './cursor.js'
import { cursorPosition, dispatch, focusAddress, hyprctlJson, listWindows, monitors, resolveWindow, workspaces } from './hypr.js'
import { pointerClick, pointerDrag, pointerScroll, pressKeys, settleLayout, typeText, withHoverFocusPaused, withInputLock, withUserPointerRestored } from './input.js'
import { a11y, captureBox, captureRegion, findElement, formatObservation, MAX_CAPTURE_SIDE, observe } from './observe.js'
import { jevAvailable, jevModel } from './jev.js'
import { recordingStatus, startRecording, stopRecording } from './record.js'
import { hasCommand, run, sleep, spawnDetached } from './session.js'

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const center = ([x, y, w, h]) => [Math.round(x + w / 2), Math.round(y + h / 2)]

function parsePair(text) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text))
  return match ? [Number(match[1]), Number(match[2])] : null
}

function resolveTarget(target, relativeTo) {
  if (target === undefined || target === null || target === '') throw new Error('A target is required: eN, a window id, or x,y')
  const text = String(target)
  if (/^e\d+$/.test(text)) {
    const element = findElement(text)
    return { kind: 'element', element, point: center(element.bounds), bounds: element.bounds, window: tryWindow(element.window), label: element.name || element.role }
  }
  const pair = parsePair(text)
  if (pair) {
    const window = relativeTo ? resolveWindow(relativeTo) : null
    const point = window ? [window.bounds[0] + pair[0], window.bounds[1] + pair[1]] : pair
    return { kind: 'point', point, window: window ?? windowAt(point) }
  }
  const window = resolveWindow(text)
  return { kind: 'window', point: center(window.bounds), bounds: window.bounds, window, label: window.app }
}

async function findTarget(description, relativeTo) {
  const found = await locate(String(description), { window: relativeTo ?? readAgentState().window })
  const target = resolveTarget(found.target)
  return { ...target, label: found.label ?? target.label, found }
}

function tryWindow(id) {
  try {
    return resolveWindow(id)
  } catch {
    return null
  }
}

function windowAt([x, y]) {
  return listWindows().find((w) => x >= w.bounds[0] && x < w.bounds[0] + w.bounds[2] && y >= w.bounds[1] && y < w.bounds[1] + w.bounds[3]) ?? null
}

function elementRequest(element, extra = {}) {
  return { pid: element.pid, path: element.path, role: element.role, name: element.name, ...extra }
}

async function physically(window, action, { stay = false } = {}) {
  return withInputLock(async () => {
    const perform = async () => {
      if (window && !window.visible) {
        focusAddress(window.address)
        await sleep(120)
      }
      return action()
    }
    return withHoverFocusPaused(() => (stay ? perform() : withUserPointerRestored(perform)))
  })
}

function rememberWindow(window) {
  if (window) updateAgentState({ window: window.address })
}

function keyboardWindow(target) {
  if (target) return resolveTarget(target).window
  const remembered = readAgentState().window
  if (!remembered) throw new Error('No target window yet; pass --into W or --to W')
  const window = tryWindow(remembered)
  if (!window) throw new Error(`Your last window ${remembered} is gone; pass --into W or --to W so input cannot land in another window`)
  return window
}

async function withKeyboardFocus(window, action, options) {
  return physically(window, async () => {
    if (window) {
      focusAddress(window.address)
      await sleep(60)
    }
    return action()
  }, options)
}

const flag = (description, type = 'string') => ({ description, type })

export const commands = {
  do: {
    summary: 'Pursue a goal in one window with Jev choosing each next action (fast, cheap); returns a step report',
    positional: ['goal'],
    options: {
      goal: flag('What should be achieved, in plain words; quoted text in it becomes typeable input'),
      in: flag('Window to work in (default: last used or focused window)'),
      input: flag('Text the run may type, as value or name=value; repeat for several', 'array'),
      steps: flag('Maximum actions (default 25)', 'number'),
      'min-confidence': flag(`Stop and report when Jev is less sure than this (default ${DEFAULT_MIN_CONFIDENCE})`, 'number'),
      'dry-run': flag('Decide one step without acting', 'boolean'),
    },
    async run(o) {
      if (!o.goal) throw new Error('Pass a goal')
      const window = o.in ?? readAgentState().window
      const report = await drive({
        goal: String(o.goal),
        window,
        inputs: o.input,
        steps: Number(o.steps ?? 25),
        minConfidence: Number(o['min-confidence'] ?? DEFAULT_MIN_CONFIDENCE),
        dryRun: Boolean(o['dry-run']),
        run: (name, options) => commands[name].run(options),
      })
      rememberWindow(tryWindow(report.window))
      return report
    },
  },
  find: {
    summary: 'Locate a described control with Jev: accessibility items first, screenshot vision otherwise',
    positional: ['description'],
    options: { description: flag('What to find, such as "the Send button"'), in: flag('Window to search (default: last used or focused window)'), 'min-confidence': flag('Minimum confidence', 'number') },
    async run(o) {
      if (!o.description) throw new Error('Describe what to find')
      return locate(String(o.description), { window: o.in ?? readAgentState().window, minConfidence: Number(o['min-confidence'] ?? DEFAULT_MIN_CONFIDENCE) })
    },
  },
  check: {
    summary: 'Ask Jev whether a statement about a window is true right now (verdict yes, no, or unsure)',
    positional: ['statement'],
    options: { statement: flag('What should be true, such as "the message was sent"'), in: flag('Window to look at (default: last used or focused window)') },
    async run(o) {
      if (!o.statement) throw new Error('Say what to check')
      return check(String(o.statement), { window: o.in ?? readAgentState().window })
    },
  },
  'wait-for': {
    summary: 'Repeat a Jev check until the condition holds; fails after --timeout',
    positional: ['condition'],
    options: {
      condition: flag('What to wait for, such as "the upload finished"'),
      in: flag('Window to watch; keeps polling while it does not exist yet'),
      timeout: flag('Milliseconds before giving up (default 30000)', 'number'),
      interval: flag('Milliseconds between checks (default 1000)', 'number'),
    },
    async run(o) {
      if (!o.condition) throw new Error('Say what to wait for')
      return waitFor(String(o.condition), { window: o.in ?? readAgentState().window, timeoutMs: Number(o.timeout ?? 30000), intervalMs: Number(o.interval ?? 1000) })
    },
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
      format: flag('text or json'),
    },
    async run(o) {
      const observation = await observe({ window: o.window, region: o.region, all: o.all, screenshot: o.screenshot, annotated: o.annotated, out: o.out, interactiveOnly: o.interactive })
      return o.format === 'json' ? observation : formatObservation(observation)
    },
  },
  screenshot: {
    summary: `Capture one window or region, at most ${MAX_CAPTURE_SIDE} px per side (cursor overlay is hidden)`,
    options: { window: flag('Window target'), region: flag('x,y,w,h relative to --window or --in, global without them'), in: flag('Window that --region is relative to, same as --window'), out: flag('Output PNG path') },
    async run(o) {
      await settleLayout()
      const box = captureBox(o)
      const out = o.out || path.join(os.tmpdir(), `hyprhand-${agentName()}-${Date.now()}.png`)
      await captureRegion(box, out)
      return { path: out, origin: box.slice(0, 2), size: box.slice(2) }
    },
  },
  click: {
    summary: 'Click an element (accessibility action first), a window, or x,y',
    positional: ['target'],
    options: {
      target: flag('eN, window id, or x,y'),
      find: flag('Describe the target instead; Jev picks it from the accessibility tree or the screenshot of --in (or the last used window)'),
      in: flag('Treat x,y as relative to this window'),
      button: flag('left, right, middle'),
      double: flag('Double click', 'boolean'),
      physical: flag('Skip the accessibility action and use real pointer input', 'boolean'),
      action: flag('Accessibility action name to invoke'),
      stay: flag('Leave focus and pointer at the target (needed for menus that close on focus loss)', 'boolean'),
      label: flag('Short intent text shown next to this agent\'s cursor'),
    },
    async run(o) {
      const target = o.find ? await findTarget(o.find, o.in) : resolveTarget(o.target, o.in)
      await showCursor.click(target.point, { bounds: target.bounds, label: o.label ?? target.label })
      rememberWindow(target.window)
      const semantic = target.kind === 'element' && !o.physical && !o.double && (o.button ?? 'left') === 'left'
      if (semantic) {
        const result = a11y('act', elementRequest(target.element, { action: o.action }))
        if (result.ok) return { delivered: 'accessibility', action: result.action, target: target.element.id, ...(target.found ? { found: target.found } : {}) }
        if (!result.fallback) throw new Error(result.error)
      }
      await physically(target.window, () => pointerClick(target.point, { button: o.button, count: o.double ? 2 : 1 }), { stay: o.stay })
      return { delivered: 'pointer', at: target.point, ...(target.found ? { found: target.found } : {}) }
    },
  },
  move: {
    summary: 'Move this agent\'s cursor to a target (add --physical to also move the real pointer)',
    positional: ['target'],
    options: { target: flag('eN, window id, or x,y'), find: flag('Describe the target instead; Jev locates it'), in: flag('Relative window'), physical: flag('Move the real pointer too', 'boolean'), label: flag('Short intent text shown next to this agent\'s cursor') },
    async run(o) {
      const target = o.find ? await findTarget(o.find, o.in) : resolveTarget(o.target, o.in)
      await showCursor.moveTo(target.point, { bounds: target.bounds, label: o.label })
      if (o.physical) await withInputLock(async () => dispatch('movecursor', ...target.point))
      return { at: target.point }
    },
  },
  drag: {
    summary: 'Drag with the real pointer from one target to another',
    options: { from: flag('Source eN, window, or x,y'), to: flag('Destination eN, window, or x,y'), in: flag('Relative window'), duration: flag('Milliseconds', 'number'), button: flag('Mouse button'), stay: flag('Keep focus at the target', 'boolean') },
    async run(o) {
      const from = resolveTarget(o.from, o.in)
      const to = resolveTarget(o.to, o.in)
      const durationMs = Number(o.duration ?? 700)
      await showCursor.moveTo(from.point, { bounds: from.bounds, label: 'drag' })
      rememberWindow(from.window)
      let travel
      const followDrag = () => {
        travel = showCursor.moveTo(to.point, { bounds: to.bounds, travel_ms: durationMs, straight: true, label: 'drag' })
      }
      await physically(from.window, () => pointerDrag(from.point, to.point, { button: o.button, durationMs, onPressed: followDrag }), { stay: o.stay })
      await travel
      return { from: from.point, to: to.point }
    },
  },
  type: {
    summary: 'Type text: sets accessible text fields directly, otherwise types into the target or last used window',
    positional: ['text'],
    options: {
      text: flag('Text to type'),
      into: flag('eN text field or window to type into'),
      find: flag('Describe the text field instead of --into; Jev locates it in --in or the last used window'),
      in: flag('Window that --find searches'),
      append: flag('Append to an accessible text field instead of replacing it', 'boolean'),
      submit: flag('Press Enter afterwards', 'boolean'),
      keyboard: flag('Force real keystrokes even for accessible text fields', 'boolean'),
      stay: flag('Keep focus on the target window', 'boolean'),
    },
    async run(o) {
      const text = String(o.text ?? '')
      const target = o.find ? await findTarget(o.find, o.in) : o.into ? resolveTarget(o.into) : null
      const window = target?.window ?? keyboardWindow()
      const point = target?.point ?? (window ? [window.bounds[0] + window.bounds[2] / 2, window.bounds[1] + window.bounds[3] / 2] : null)
      if (point) await showCursor.typing(point, Math.min(4, 0.4 + text.length * 0.02), { bounds: target?.bounds })
      rememberWindow(window)
      if (target?.kind === 'element' && !o.keyboard) {
        const result = a11y('set-text', elementRequest(target.element, { text, append: o.append }))
        if (result.ok && !o.submit) return { delivered: 'accessibility', text: result.text }
        if (result.ok) {
          await withKeyboardFocus(window, async () => pressKeys(['Return'], { window: window?.address }), { stay: o.stay })
          return { delivered: 'accessibility+keyboard', text: result.text }
        }
        if (!result.fallback) throw new Error(result.error)
      }
      await withKeyboardFocus(window, async () => {
        if (target?.kind === 'element') {
          const focused = a11y('focus', elementRequest(target.element))
          if (!focused.ok) await pointerClick(target.point)
          await sleep(40)
        }
        await typeText(text, { window: window?.address })
        if (o.submit) pressKeys(['Return'], { window: window?.address })
      }, { stay: o.stay })
      return { delivered: 'keyboard', window: window?.id ?? 'focused' }
    },
  },
  key: {
    summary: 'Press key combos such as ctrl+l, Return, alt+F4 in the target or last used window',
    positional: ['keys'],
    variadic: true,
    options: { keys: flag('Key combos', 'array'), to: flag('Window or element receiving the keys'), stay: flag('Keep focus on the target window', 'boolean') },
    async run(o) {
      const combos = [].concat(o.keys ?? []).flatMap((k) => String(k).split(/\s+/)).filter(Boolean)
      if (!combos.length) throw new Error('Pass at least one key combo')
      const window = keyboardWindow(o.to)
      rememberWindow(window)
      if (window) await showCursor.typing(center(window.bounds), 0.6, { label: combos.join(' ') })
      await withKeyboardFocus(window, async () => pressKeys(combos, { window: window?.address }), { stay: o.stay })
      return { pressed: combos, window: window?.id ?? 'focused' }
    },
  },
  scroll: {
    summary: 'Scroll the wheel over a target',
    positional: ['direction'],
    options: { direction: flag('up, down, left, right'), amount: flag('Wheel notches', 'number'), at: flag('eN, window, or x,y'), find: flag('Describe the area to scroll; Jev locates it'), in: flag('Relative window') },
    async run(o) {
      const target = o.find ? await findTarget(o.find, o.in) : o.at ? resolveTarget(o.at, o.in) : (() => {
        const window = keyboardWindow()
        if (!window) throw new Error('Pass --at or act on a window first')
        return { point: center(window.bounds), window }
      })()
      await showCursor.moveTo(target.point, { bounds: target.bounds })
      rememberWindow(target.window)
      await physically(target.window, () => pointerScroll(target.point, o.direction ?? 'down', Number(o.amount ?? 3)))
      return { scrolled: o.direction ?? 'down', at: target.point }
    },
  },
  'set-value': {
    summary: 'Set a slider or spin button value through accessibility',
    positional: ['target', 'value'],
    options: { target: flag('eN'), value: flag('Number', 'number') },
    async run(o) {
      const target = resolveTarget(o.target)
      await showCursor.click(target.point, { bounds: target.bounds })
      const result = a11y('set-value', elementRequest(target.element, { value: Number(o.value) }))
      if (!result.ok) throw new Error(result.error)
      return result
    },
  },
  read: {
    summary: 'Read the live text, states, and value of an element',
    positional: ['target'],
    options: { target: flag('eN') },
    async run(o) {
      const result = a11y('read', elementRequest(resolveTarget(o.target).element))
      if (!result.ok) throw new Error(result.error)
      return result
    },
  },
  'open-app': {
    summary: 'Launch an app (desktop id, binary, or command line) and wait for its window',
    positional: ['app'],
    options: { app: flag('Desktop file id or command'), wait: flag('Window class or title regex to wait for'), timeout: flag('Seconds', 'number') },
    async run(o) {
      const before = new Set(listWindows({ all: true }).map((w) => w.address))
      const app = String(o.app)
      if (hasCommand('gtk-launch') && !app.includes(' ') && desktopEntryExists(app)) spawnDetached('gtk-launch', [app])
      else dispatch('exec', app)
      const deadline = Date.now() + Number(o.timeout ?? 15) * 1000
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
    options: { target: flag('Window id, class, or title regex') },
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
    options: { target: flag('Window id, class, or title regex') },
    run(o) {
      const window = resolveWindow(o.target)
      dispatch('closewindow', `address:${window.address}`)
      return { closed: window.id }
    },
  },
  workspace: {
    summary: 'Switch to a workspace',
    positional: ['workspace'],
    options: { workspace: flag('Workspace id or name') },
    run: (o) => (dispatch('workspace', o.workspace), { workspace: o.workspace }),
  },
  'move-window-workspace': {
    summary: 'Move a window to a workspace',
    positional: ['workspace'],
    options: { workspace: flag('Workspace id or name'), target: flag('Window'), silent: flag('Do not follow the window', 'boolean') },
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
    options: { dispatcher: flag('Dispatcher name'), args: flag('Arguments', 'array') },
    run: (o) => (dispatch(o.dispatcher, ...[].concat(o.args ?? [])), { ok: true }),
  },
  'active-window': { summary: 'Show the focused window', run: () => listWindows({ all: true }).find((w) => w.focused) ?? null },
  monitors: { summary: 'List monitors', run: () => monitors() },
  workspaces: { summary: 'List workspaces', run: () => workspaces() },
  cursor: { summary: 'Show the real pointer position', run: () => cursorPosition() },
  keybindings: { summary: 'List Hyprland keybindings', run: () => hyprctlJson('binds') },
  cursors: {
    summary: 'Manage agent cursors: list (default), start, stop, forget',
    positional: ['action'],
    options: { action: flag('list, start, stop, forget') },
    async run(o) {
      const action = o.action ?? 'list'
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
      action: flag('start, stop, status'),
      monitor: flag('Monitor name to record, such as DP-3'),
      window: flag('Record the area of this window'),
      region: flag('Global area x,y,w,h to record'),
      out: flag('Output file (default ~/Videos/hyprhand/<time>-<agent>.mp4)'),
      fps: flag('Frames per second (default 30)', 'number'),
    },
    async run(o) {
      const action = o.action ?? 'status'
      if (action === 'start') return startRecording({ monitor: o.monitor, window: o.window, region: o.region, out: o.out, fps: o.fps ?? 30 })
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
