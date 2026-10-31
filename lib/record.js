import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentName } from './cursor.js'
import { monitors, resolveWindow } from './hypr.js'
import { sleep, spawnDetached, stateDir } from './session.js'

const recordingFile = () => path.join(stateDir(), `recording-${agentName()}.json`)
const even = (value) => Math.max(2, Math.floor(value / 2) * 2)

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readRecording() {
  if (!existsSync(recordingFile())) return null
  const recording = JSON.parse(readFileSync(recordingFile(), 'utf8'))
  return alive(recording.pid) ? recording : (rmSync(recordingFile(), { force: true }), null)
}

function sourceArgs({ monitor, window, region }) {
  if (monitor) {
    const output = monitors().find((candidate) => candidate.name === monitor || String(candidate.id) === String(monitor))
    if (!output) throw new Error(`No monitor "${monitor}"; see hyprhand monitors`)
    return { args: ['-o', output.name], source: `monitor ${output.name}` }
  }
  const bounds = region ? region.split(',').map(Number) : window ? resolveWindow(window).bounds : null
  if (!bounds || bounds.length !== 4 || bounds.some(Number.isNaN)) throw new Error('Pick what to record: --monitor NAME, --window W, or --region x,y,w,h (global)')
  const [x, y, width, height] = bounds
  return { args: ['-g', `${x},${y} ${even(width)}x${even(height)}`], source: `${x},${y} ${even(width)}x${even(height)}` }
}

export async function startRecording({ monitor, window, region, out, fps = 30 }) {
  const running = readRecording()
  if (running) throw new Error(`Already recording to ${running.path}; run hyprhand record stop first`)
  const file = path.resolve(out ?? path.join(os.homedir(), 'Videos', 'hyprhand', `${new Date().toISOString().replace(/[:.]/g, '-')}-${agentName()}.mp4`))
  mkdirSync(path.dirname(file), { recursive: true })
  const { args, source } = sourceArgs({ monitor, window, region })
  const pid = spawnDetached('wf-recorder', ['-y', ...args, '-f', file, '-c', 'libx264', '-x', 'yuv420p', '-r', String(fps), '-p', 'preset=veryfast', '-p', 'crf=28'])
  await sleep(600)
  if (!alive(pid)) throw new Error('wf-recorder exited right away; run it by hand to see why')
  const recording = { pid, path: file, source, startedAt: Date.now() }
  writeFileSync(recordingFile(), JSON.stringify(recording))
  return recording
}

export async function stopRecording() {
  const recording = readRecording()
  if (!recording) throw new Error('No recording is running for this agent')
  process.kill(recording.pid, 'SIGINT')
  for (let waited = 0; alive(recording.pid) && waited < 15000; waited += 100) await sleep(100)
  rmSync(recordingFile(), { force: true })
  return { path: recording.path, source: recording.source, seconds: Math.round((Date.now() - recording.startedAt) / 1000), megabytes: Math.round(statSync(recording.path).size / 1e5) / 10 }
}

export const recordingStatus = () => readRecording() ?? { recording: false }
