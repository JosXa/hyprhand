#!/usr/bin/env node
import { commands } from '../lib/commands.js'
import { serveMcp } from '../lib/mcp.js'
import { prepareSession } from '../lib/session.js'

function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s)
      const next = argv[index + 1]
      if (inline !== undefined) options[key] = inline
      else if (next === undefined || next.startsWith('--')) options[key] = true
      else if (['true', 'false'].includes(next)) options[key] = next === 'true', index++
      else options[key] = next, index++
    } else positional.push(arg)
  }
  return { positional, options }
}

function help() {
  const lines = ['hyprhand: computer use for Hyprland, with one visible cursor per agent', '', 'Usage: hyprhand [--agent NAME] <command> [args] [--json]', '']
  for (const [name, command] of Object.entries(commands)) {
    const args = (command.positional ?? []).map((p) => `<${p}>`).join(' ')
    lines.push(`  ${`${name} ${args}`.padEnd(34)} ${command.summary}`)
  }
  lines.push('  mcp'.padEnd(36) + 'Serve all commands over MCP stdio', '', 'Run "hyprhand <command> --help" for its options.')
  return lines.join('\n')
}

function commandHelp(name, command) {
  const lines = [`hyprhand ${name} ${(command.positional ?? []).map((p) => `<${p}>`).join(' ')}`, command.summary, '']
  for (const [option, spec] of Object.entries(command.options ?? {})) lines.push(`  --${option.padEnd(14)} ${spec.description}`)
  return lines.join('\n')
}

function toText(result) {
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2)
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2))
  if (options.agent) process.env.HYPRHAND_AGENT = String(options.agent)
  const name = positional.shift()
  if (!name || name === 'help' || (!name && options.help)) return console.log(help())
  prepareSession()
  if (name === 'mcp') return serveMcp()
  const command = commands[name]
  if (!command) throw new Error(`Unknown command "${name}"\n\n${help()}`)
  if (options.help) return console.log(commandHelp(name, command))
  const input = { ...options }
  const names = command.positional ?? []
  names.forEach((key, index) => {
    if (input[key] !== undefined) return
    const last = index === names.length - 1
    if (last && command.variadic) {
      const rest = positional.slice(index)
      if (rest.length) input[key] = command.options?.[key]?.type === 'array' ? rest : rest.join(' ')
    } else if (positional[index] !== undefined) input[key] = last && !command.variadic ? positional.slice(index).join(' ') : positional[index]
  })
  const result = await command.run(input)
  console.log(options.json && typeof result === 'string' ? JSON.stringify({ text: result }) : toText(result))
}

main().catch((error) => {
  console.error(`hyprhand: ${error.message}`)
  process.exit(1)
})
