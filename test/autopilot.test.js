import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { createAutopilot } from '../lib/autopilot.js'

const window = { id: 'w1', address: '0x1', app: 'org.kde.dolphin', title: 'Home', pid: 10, workspace: 4, focusRank: 0, bounds: [100, 50, 900, 600] }
const logDir = mkdtempSync(path.join(os.tmpdir(), 'hyprhand-test-'))
let logs = 0
after(() => rmSync(logDir, { recursive: true, force: true }))

const item = (key, label, bounds = [120, 80, 60, 20]) => ({ key, label, where: 'top-left', criterion: `push button "${label}" (top-left)`, element: { id: key, role: 'push button', name: label, bounds, states: [] } })
const screen = (signature, items = [item('e1', 'Documents')], title = window.title) => ({ window: { ...window, title }, items, image: null, signature, dispose() {} })
const choice = (picked, confidence = 0.95) => ({ choice: picked, confidence, probabilities: { [picked]: confidence } })

function harness({ screens, answers }) {
  const acted = []
  const asked = []
  let read = 0
  const pilot = createAutopilot({
    workWindow: () => window,
    readScreen: async () => screens[Math.min(read++, screens.length - 1)],
    snapshotWindow: async () => assert.fail('no screenshot expected'),
    askJev: async (request) => {
      asked.push(request)
      const answer = answers[asked.length - 1]
      return { answers: { satisfied: { noul: 0 }, ...answer }, usage: { input_tokens: 10, output_tokens: 2 }, ms: 1 }
    },
    act: new Proxy({}, { get: (_, name) => async (...args) => acted.push([name, ...args]) }),
    sleep: async () => {},
    runLog: () => path.join(logDir, `${++logs}.json`),
  })
  return { pilot, acted, asked }
}

test('a round trip is reported back to the model and finishes as done', async () => {
  const { pilot, acted, asked } = harness({
    screens: [screen('home'), screen('docs', [item('e1', 'Back')], 'Documents'), screen('home')],
    answers: [{ kind: choice('click_item'), item: choice('e1') }, { kind: choice('go_back') }, { kind: choice('none'), satisfied: { noul: 0.9 } }],
  })
  const report = await pilot.drive({ goal: 'Open Documents, then go back' })
  assert.equal(report.status, 'done')
  assert.deepEqual(acted.map(([name]) => name), ['click', 'keys'])
  assert.deepEqual(acted[1][2], ['alt+Left'])
  assert.deepEqual(asked[2].state.previous_actions, ['click push button "Documents" (top-left) → window title "Documents"', 'go_back → window title "Home", back to the screen from before step 1'])
  assert.equal(report.tokens, 36)
  assert.equal(JSON.parse(readFileSync(report.log, 'utf8')).requests.length, 3)
})

test('low confidence stops the run with alternatives before acting', async () => {
  const { pilot, acted } = harness({ screens: [screen('home')], answers: [{ kind: { choice: 'click_item', confidence: 0.3, probabilities: { click_item: 0.3, scroll_down: 0.28 } }, item: choice('e1') }] })
  const report = await pilot.drive({ goal: 'Open Documents' })
  assert.equal(report.status, 'unsure')
  assert.deepEqual(report.alternatives, ['click_item 0.30', 'scroll_down 0.28'])
  assert.equal(acted.length, 0)
})

test('a dry run decides once and does not act', async () => {
  const { pilot, acted } = harness({ screens: [screen('home')], answers: [{ kind: choice('click_item'), item: choice('e1') }] })
  const report = await pilot.drive({ goal: 'Open Documents', dryRun: true })
  assert.equal(report.status, 'dry_run')
  assert.equal(report.steps.length, 1)
  assert.equal(acted.length, 0)
})

test('a screen that never changes ends as stuck', async () => {
  const { pilot } = harness({ screens: [screen('same')], answers: Array(5).fill({ kind: choice('scroll_down') }) })
  const report = await pilot.drive({ goal: 'Find the end' })
  assert.equal(report.status, 'stuck')
  assert.match(report.reason, /stayed the same/)
})

test('a closed window ends the run', async () => {
  const { pilot } = harness({ screens: [screen('home'), null], answers: [{ kind: choice('press_escape') }] })
  assert.equal((await pilot.drive({ goal: 'Close it' })).status, 'window_closed')
})

test('only quoted or provided text can be typed', async () => {
  const field = { ...item('e2', 'Search'), element: { id: 'e2', role: 'entry', name: 'Search', bounds: [0, 0, 100, 20], states: ['editable'] } }
  const { pilot, acted, asked } = harness({
    screens: [screen('a', [field]), screen('b', [field])],
    answers: [{ kind: choice('type_input'), item: choice('e2'), input: choice('1') }, { kind: choice('none'), satisfied: { noul: 0.95 } }],
  })
  await pilot.drive({ goal: 'Search for "hyprhand"', inputs: ['user=joscha'] })
  assert.deepEqual(asked[0].state.provided_inputs, ['user: "joscha"', '"hyprhand"'])
  assert.equal(acted[0][0], 'type')
  assert.equal(acted[0][2], 'hyprhand')
})

test('errors from acting end the run with status error', async () => {
  const pilot = createAutopilot({
    workWindow: () => window,
    readScreen: async () => screen('home'),
    snapshotWindow: async () => null,
    askJev: async () => ({ answers: { kind: choice('click_item'), item: choice('e1'), satisfied: { noul: 0 } }, ms: 1 }),
    act: { click: async () => { throw new Error('ydotool died') } },
    sleep: async () => {},
    runLog: () => path.join(logDir, `${++logs}.json`),
  })
  const report = await pilot.drive({ goal: 'Open Documents' })
  assert.equal(report.status, 'error')
  assert.equal(report.reason, 'ydotool died')
})

test('check turns scores into verdicts', async () => {
  for (const [score, verdict] of [[0.92, 'yes'], [0.5, 'unsure'], [0.02, 'no']]) {
    const pilot = createAutopilot({
      workWindow: () => window,
      readScreen: async () => ({ ...screen('a'), image: { file: '/tmp/x.jpg' } }),
      askJev: async () => ({ answers: { holds: { noul: score } }, ms: 1 }),
      sleep: async () => {},
    })
    assert.equal((await pilot.check('the display shows 408')).verdict, verdict)
  }
})

test('waitFor keeps polling while the window does not exist yet', async () => {
  let calls = 0
  const pilot = createAutopilot({
    workWindow: () => {
      if (++calls < 3) throw Object.assign(new Error('No window matches "kcalc"'), { code: 'NO_WINDOW' })
      return window
    },
    readScreen: async () => ({ ...screen('a'), image: { file: '/tmp/x.jpg' } }),
    askJev: async () => ({ answers: { holds: { noul: 0.9 } }, ms: 1 }),
    sleep: async () => {},
  })
  const result = await pilot.waitFor('the calculator is open', { window: 'kcalc' })
  assert.equal(result.verdict, 'yes')
  assert.equal(calls, 3)
})

test('locate picks an accessibility item and falls back to vision when none matches', async () => {
  const toScreen = ([x, y]) => ({ left: x, right: x, top: y, bottom: y })
  const snapshot = {
    image: () => ({ file: '/tmp/x.jpg', toWindow: () => [10, 10, 20, 20], toScreen: () => [400, 300, 20, 20] }),
    dispose() {},
  }
  const answers = [{ item: choice('e1') }, { item: choice('none') }, { present: { noul: 0.8 }, spot: { box: toScreen([0.1, 0.1]), confidence: 0.4 } }, { present: { noul: 0.95 }, spot: { box: toScreen([0.5, 0.5]), confidence: 0.6 } }]
  let asked = 0
  const pilot = createAutopilot({
    workWindow: () => window,
    readScreen: async () => screen('a'),
    snapshotWindow: async () => snapshot,
    askJev: async () => ({ answers: answers[asked++], ms: 1 }),
    sleep: async () => {},
  })
  const viaTree = await pilot.locate('the Documents folder')
  assert.equal(viaTree.report.via, 'accessibility')
  assert.equal(viaTree.target.kind, 'element')
  const viaVision = await pilot.locate('the gift icon')
  assert.equal(viaVision.report.via, 'vision')
  assert.equal(viaVision.report.target, '410,310')
  assert.deepEqual(viaVision.target.point, [410, 310])
})
