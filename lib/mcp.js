import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { commands, invokeCommand } from './commands.js'

const hiddenFromMcp = new Set(['skill-path'])
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function propertySchema(spec) {
  const schema = spec.type === 'array' ? { type: 'array', items: { type: 'string' } } : { type: spec.type }
  return { ...schema, description: spec.description, ...(spec.default !== undefined ? { default: spec.default } : {}) }
}

function inputSchema(command) {
  const properties = { agent: { type: 'string', description: 'Agent name; each agent gets its own cursor, remembered window, and element ids' } }
  const required = []
  for (const [option, spec] of Object.entries(command.options ?? {})) {
    properties[option] = propertySchema(spec)
    if (spec.required) required.push(option)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

export const tools = Object.entries(commands)
  .filter(([name]) => !hiddenFromMcp.has(name))
  .map(([name, command]) => ({ name: name.replaceAll('-', '_'), command: name, description: command.summary, inputSchema: inputSchema(command) }))

async function callTool(name, { agent, ...input } = {}) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Unknown tool ${name}`)
  const result = await invokeCommand(tool.command, input, { agent })
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
}

async function answer(message) {
  if (message.method === 'initialize') return { result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hyprhand', version } } }
  if (message.method === 'tools/list') return { result: { tools: tools.map(({ command, ...tool }) => tool) } }
  if (message.method === 'ping') return { result: {} }
  if (message.method !== 'tools/call') return { error: { code: -32601, message: `Method not found: ${message.method}` } }
  try {
    return { result: { content: [{ type: 'text', text: await callTool(message.params.name, message.params.arguments) }] } }
  } catch (error) {
    return { result: { isError: true, content: [{ type: 'text', text: error.message }] } }
  }
}

export function serveMcp() {
  const reply = (id, payload) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`)
  createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      return reply(null, { error: { code: -32700, message: error.message } })
    }
    if (message.id === undefined) return
    reply(message.id, await answer(message).catch((error) => ({ error: { code: -32603, message: error.message } })))
  })
}
