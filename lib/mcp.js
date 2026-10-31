import { createInterface } from 'node:readline'
import { commands } from './commands.js'

const hiddenFromMcp = new Set(['skill-path'])

function toolName(name) {
  return name.replaceAll('-', '_')
}

function inputSchema(command) {
  const properties = { agent: { type: 'string', description: 'Agent name; each agent gets its own cursor and element ids' } }
  for (const [option, spec] of Object.entries(command.options ?? {})) {
    properties[option] = spec.type === 'array' ? { type: 'array', items: { type: 'string' }, description: spec.description } : { type: spec.type, description: spec.description }
  }
  const required = (command.positional ?? []).filter((key) => ['target', 'text', 'app', 'workspace', 'dispatcher', 'keys', 'direction'].includes(key))
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

const tools = Object.entries(commands)
  .filter(([name]) => !hiddenFromMcp.has(name))
  .map(([name, command]) => ({ name: toolName(name), description: command.summary, inputSchema: inputSchema(command), command }))

async function callTool(name, args = {}) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Unknown tool ${name}`)
  const previousAgent = process.env.HYPRHAND_AGENT
  if (args.agent) process.env.HYPRHAND_AGENT = String(args.agent)
  try {
    const result = await tool.command.run(args)
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  } finally {
    if (args.agent) process.env.HYPRHAND_AGENT = previousAgent ?? ''
    if (!previousAgent) delete process.env.HYPRHAND_AGENT
  }
}

export function serveMcp() {
  const reply = (id, payload) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`)
  let queue = Promise.resolve()
  createInterface({ input: process.stdin }).on('line', (line) => {
    queue = queue.then(async () => {
      if (!line.trim()) return
      const message = JSON.parse(line)
      if (message.id === undefined) return
      try {
        if (message.method === 'initialize') {
          reply(message.id, { result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hyprhand', version: '0.1.0' } } })
        } else if (message.method === 'tools/list') {
          reply(message.id, { result: { tools: tools.map(({ command, ...tool }) => tool) } })
        } else if (message.method === 'tools/call') {
          try {
            reply(message.id, { result: { content: [{ type: 'text', text: await callTool(message.params.name, message.params.arguments) }] } })
          } catch (error) {
            reply(message.id, { result: { isError: true, content: [{ type: 'text', text: error.message }] } })
          }
        } else if (message.method === 'ping') {
          reply(message.id, { result: {} })
        } else {
          reply(message.id, { error: { code: -32601, message: `Method not found: ${message.method}` } })
        }
      } catch (error) {
        reply(message.id, { error: { code: -32603, message: error.message } })
      }
    })
  })
}
