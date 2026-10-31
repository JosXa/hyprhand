import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boxToCrop, outputScale, parseBox, zoomAround } from '../lib/capture.js'
import { helpText, parseCommandLine } from '../lib/cli.js'
import { commands, normalizeInput } from '../lib/commands.js'
import { resolveWindow } from '../lib/hypr.js'
import { parseKeyCombo } from '../lib/input.js'
import { tools } from '../lib/mcp.js'
import { screenItems, workWindow } from '../lib/screen.js'

const window = (overrides) => ({ id: 'w1', address: '0x1', app: 'org.kde.dolphin', title: 'Home', pid: 10, workspace: 4, focusRank: 1, visible: true, bounds: [0, 0, 900, 600], ...overrides })
const element = (overrides) => ({ id: 'e1', role: 'push button', name: 'OK', bounds: [10, 10, 50, 20], interactive: true, states: [], ...overrides })

test('parseBox accepts x,y,w,h and rejects empty sizes', () => {
  assert.deepEqual(parseBox('1,2,30,40'), [1, 2, 30, 40])
  assert.throws(() => parseBox('1,2,0,40'), /expected x,y,w,h/)
  assert.throws(() => parseBox('1,2,3'), /expected x,y,w,h/)
})

test('outputScale takes the largest scale of the monitors a box touches', () => {
  const outputs = [{ x: 0, y: 0, width: 1920, height: 1200, scale: 1 }, { x: 1920, y: 0, width: 3840, height: 2400, scale: 2 }]
  assert.equal(outputScale([100, 100, 200, 200], outputs), 1)
  assert.equal(outputScale([1800, 100, 400, 200], outputs), 2)
  assert.equal(outputScale([9000, 0, 10, 10], outputs), 1)
})

test('boxToCrop maps answer fractions through the padding frame and crop into window pixels', () => {
  const frame = [0.25, 0, 0.5, 1]
  const crop = [100, 50, 200, 100]
  assert.deepEqual(boxToCrop({ left: 0.25, right: 0.75, top: 0, bottom: 1 }, frame, crop), [100, 50, 200, 100])
  assert.deepEqual(boxToCrop({ left: 0.5, right: 0.5, top: 0.5, bottom: 0.5 }, frame, crop), [200, 100, 0, 0])
})

test('zoomAround grows small boxes and stays inside the window', () => {
  assert.deepEqual(zoomAround([10, 10, 20, 20], [900, 600], { factor: 3, minimum: 420 }), [0, 0, 420, 420])
  assert.deepEqual(zoomAround([880, 580, 20, 20], [900, 600], { factor: 3, minimum: 420 }), [480, 180, 420, 420])
  assert.deepEqual(zoomAround([0, 0, 800, 500], [900, 600], { factor: 3, minimum: 420 }), [0, 0, 900, 600])
})

test('screenItems keeps the first tooltip line, shows field content, and names row mates of duplicate labels', () => {
  const items = screenItems([
    element({ id: 'e1', role: 'toggle button', name: 'Paintbrush\nShortcut key: B', bounds: [0, 0, 40, 40] }),
    element({ id: 'e2', role: 'text', name: 'Display', text: '408', states: ['editable', 'focused'], bounds: [0, 50, 400, 40] }),
    element({ id: 'e3', name: 'Delete', bounds: [500, 300, 60, 20] }),
    element({ id: 'e4', role: 'label', name: 'invoice.pdf', interactive: false, bounds: [100, 300, 200, 20] }),
    element({ id: 'e5', name: 'Delete', bounds: [500, 400, 60, 20] }),
    element({ id: 'e6', role: 'label', name: 'notes.txt', interactive: false, bounds: [100, 400, 200, 20] }),
  ], window())
  assert.deepEqual(items.map((item) => item.key), ['e1', 'e2', 'e4', 'e3', 'e6', 'e5'])
  assert.equal(items[0].criterion, 'toggle button "Paintbrush" (top-left)')
  assert.equal(items[1].criterion, 'text "Display" (top-left; contains "408"; focused)')
  assert.match(items.find((item) => item.key === 'e3').criterion, /in the row of "invoice.pdf"/)
  assert.match(items.find((item) => item.key === 'e5').criterion, /in the row of "notes.txt"/)
})

test('workWindow follows a dialog of the same app on the same workspace', () => {
  const main = window()
  const dialog = window({ id: 'w2', address: '0x2', app: 'dotnet', title: 'Save changes?', focusRank: 0 })
  const other = window({ id: 'w3', address: '0x3', app: 'kitty', pid: 99, focusRank: 2 })
  assert.equal(workWindow('w1', [main, dialog, other]).id, 'w2')
  assert.equal(workWindow('kitty', [main, dialog, other]).id, 'w3')
})

test('resolveWindow errors carry the NO_WINDOW code', () => {
  assert.throws(() => resolveWindow('nothing-like-this', [window()]), (error) => error.code === 'NO_WINDOW')
})

test('parseKeyCombo maps modifier aliases', () => {
  assert.deepEqual(parseKeyCombo('ctrl+shift+T'), { modifiers: ['ctrl', 'shift'], keysym: 't' })
  assert.deepEqual(parseKeyCombo('super+1'), { modifiers: ['logo'], keysym: '1' })
  assert.throws(() => parseKeyCombo('hyper+x'), /Unknown modifier/)
})

test('parseCommandLine keeps positionals after boolean flags and joins the last positional', () => {
  assert.deepEqual(parseCommandLine(['--agent', 'calc', 'type', '--stay', 'hello', 'world', '--submit'], commands), {
    name: 'type', input: { stay: true, submit: true, text: 'hello world' }, agent: 'calc', json: false, help: false,
  })
  assert.deepEqual(parseCommandLine(['click', 'e3', '--stay', 'false', '--in', 'kcalc'], commands).input, { target: 'e3', stay: 'false', in: 'kcalc' })
  assert.deepEqual(parseCommandLine(['key', 'ctrl+a', 'BackSpace', '--to', 'w1'], commands).input, { keys: ['ctrl+a', 'BackSpace'], to: 'w1' })
  assert.deepEqual(parseCommandLine(['do', 'go', '--input', 'a', '--input', 'b=c'], commands).input, { goal: 'go', input: ['a', 'b=c'] })
  assert.equal(parseCommandLine(['--json', 'observe'], commands).name, 'observe')
})

test('normalizeInput applies defaults, types values, and names missing arguments', () => {
  assert.deepEqual(normalizeInput(commands.click, { target: 'e3', stay: 'false', 'min-confidence': '0.6' }), { target: 'e3', 'min-confidence': 0.6, button: 'left', stay: false })
  assert.equal(normalizeInput(commands.scroll, {}).direction, 'down')
  assert.throws(() => normalizeInput(commands.type, {}), /Missing <text>/)
  assert.throws(() => normalizeInput(commands.drag, { from: 'e1' }), /Missing --to/)
  assert.throws(() => normalizeInput(commands.scroll, { amount: 'lots' }), /--amount must be a number/)
})

test('MCP schemas come from the command flags', () => {
  const schema = (name) => tools.find((tool) => tool.name === name).inputSchema
  assert.deepEqual(schema('set_value').required, ['target', 'value'])
  assert.equal(schema('scroll').required, undefined)
  assert.equal(schema('scroll').properties.amount.default, 3)
  assert.deepEqual(schema('wait_for').required, ['condition'])
  assert.ok(!tools.some((tool) => tool.name === 'skill_path'))
})

test('helpText lists defaults and required flags', () => {
  const text = helpText(commands, 'scroll')
  assert.match(text, /hyprhand scroll \[direction\]/)
  assert.match(text, /--amount\s+Wheel notches \(default 3, number\)/)
  assert.match(helpText(commands, 'type'), /hyprhand type <text>/)
})
