import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAgentState, updateAgentState } from './agent-state.js'
import { agentColor, agentName, forgetCursor, listCursors, showCursor, startOverlay, stopOverlay } from './cursor.js'
import { cursorPosition, dispatch, focusAddress, hyprctlJson, listWindows, monitors, resolveWindow, workspaces } from './hypr.js'
import { pointerClick, pointerDrag, pointerScroll, pressKeys, typeText, withInputLock, withUserPointerRestored } from './input.js'
import { a11y, captureRegion, findElement, formatObservation, observe, regionFor } from './observe.js'
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
    return stay ? perform() : withUserPointerRestored(perform)
  })
}

function rememberWindow(window) {
  if (window) updateAgentState({ window: window.address })
}

function keyboardWindow(target) {
  if (target) return resolveTarget(target).window
  const remembered = readAgentState().window
  return remembered ? tryWindow(remembered) : null
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
  observe: {
    summary: 'List windows and accessible UI elements with ids, optionally with a screenshot',
    options: {
      window: flag('Limit to one window (id, class, or title regex)'),
      all: flag('Include windows on hidden workspaces', 'boolean'),
      screenshot: flag('Capture a screenshot too', 'boolean'),
      annotated: flag('Capture a screenshot with element ids drawn on it', 'boolean'),
      interactive: flag('Only list interactive elements', 'boolean'),
      out: flag('Screenshot path'),
      format: flag('text or json'),
    },
    async run(o) {
      const observation = await observe({ window: o.window, all: o.all, screenshot: o.screenshot, annotated: o.annotated, out: o.out, interactiveOnly: o.interactive })
      return o.format === 'json' ? observation : formatObservation(observation)
    },
  },
  screenshot: {
    summary: 'Capture the desktop, one window, one monitor, or a region (cursor overlay is hidden)',
    options: { window: flag('Window target'), monitor: flag('Monitor name, id, or "focused"'), region: flag('x,y,w,h in global coordinates'), out: flag('Output PNG path') },
    async run(o) {
      const region = o.region ? String(o.region).split(',').map(Number) : regionFor(o)
      const out = o.out || path.join(os.tmpdir(), `hyprhand-${agentName()}-${Date.now()}.png`)
      await captureRegion(region, out)
      return { path: out, origin: region ? region.slice(0, 2) : [0, 0], size: region ? region.slice(2) : null }
    },
  },
  click: {
    summary: 'Click an element (accessibility action first), a window, or x,y',
    positional: ['target'],
    options: {
      target: flag('eN, window id, or x,y'),
      in: flag('Treat x,y as relative to this window'),
      button: flag('left, right, middle'),
      double: flag('Double click', 'boolean'),
      physical: flag('Skip the accessibility action and use real pointer input', 'boolean'),
      action: flag('Accessibility action name to invoke'),
      stay: flag('Leave focus and pointer at the target (needed for menus that close on focus loss)', 'boolean'),
      label: flag('Short intent text shown next to this agent\'s cursor'),
    },
    async run(o) {
      const target = resolveTarget(o.target, o.in)
      await showCursor.click(target.point, { bounds: target.bounds, label: o.label ?? target.label })
      rememberWindow(target.window)
      const semantic = target.kind === 'element' && !o.physical && !o.double && (o.button ?? 'left') === 'left'
      if (semantic) {
        const result = a11y('act', elementRequest(target.element, { action: o.action }))
        if (result.ok) return { delivered: 'accessibility', action: result.action, target: target.element.id }
        if (!result.fallback) throw new Error(result.error)
      }
      await physically(target.window, () => pointerClick(target.point, { button: o.button, count: o.double ? 2 : 1 }), { stay: o.stay })
      return { delivered: 'pointer', at: target.point }
    },
  },
  move: {
    summary: 'Move this agent\'s cursor to a target (add --physical to also move the real pointer)',
    positional: ['target'],
    options: { target: flag('eN, window id, or x,y'), in: flag('Relative window'), physical: flag('Move the real pointer too', 'boolean'), label: flag('Short intent text shown next to this agent\'s cursor') },
    async run(o) {
      const target = resolveTarget(o.target, o.in)
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
      await showCursor.moveTo(from.point, { bounds: from.bounds })
      rememberWindow(from.window)
      const travel = showCursor.moveTo(to.point, { bounds: to.bounds, travel_ms: Number(o.duration ?? 700) })
      await physically(from.window, () => pointerDrag(from.point, to.point, { button: o.button, durationMs: Number(o.duration ?? 700) }), { stay: o.stay })
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
      append: flag('Append to an accessible text field instead of replacing it', 'boolean'),
      submit: flag('Press Enter afterwards', 'boolean'),
      keyboard: flag('Force real keystrokes even for accessible text fields', 'boolean'),
      stay: flag('Keep focus on the target window', 'boolean'),
    },
    async run(o) {
      const text = String(o.text ?? '')
      const target = o.into ? resolveTarget(o.into) : null
      const window = target?.window ?? keyboardWindow()
      const point = target?.point ?? (window ? [window.bounds[0] + window.bounds[2] / 2, window.bounds[1] + window.bounds[3] / 2] : null)
      if (point) await showCursor.typing(point, Math.min(4, 0.4 + text.length * 0.02), { bounds: target?.bounds })
      rememberWindow(window)
      if (target?.kind === 'element' && !o.keyboard) {
        const result = a11y('set-text', elementRequest(target.element, { text, append: o.append }))
        if (result.ok && !o.submit) return { delivered: 'accessibility', text: result.text }
        if (result.ok) {
          await withKeyboardFocus(window, async () => pressKeys(['Return']), { stay: o.stay })
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
        typeText(text)
        if (o.submit) pressKeys(['Return'])
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
      await withKeyboardFocus(window, async () => pressKeys(combos), { stay: o.stay })
      return { pressed: combos, window: window?.id ?? 'focused' }
    },
  },
  scroll: {
    summary: 'Scroll the wheel over a target',
    positional: ['direction'],
    options: { direction: flag('up, down, left, right'), amount: flag('Wheel notches', 'number'), at: flag('eN, window, or x,y'), in: flag('Relative window') },
    async run(o) {
      const target = o.at ? resolveTarget(o.at, o.in) : (() => {
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
