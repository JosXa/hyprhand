#!/usr/bin/env node
import { helpText, parseCommandLine } from '../lib/cli.js'
import { commands, invokeCommand } from '../lib/commands.js'
import { serveMcp } from '../lib/mcp.js'
import { prepareSession } from '../lib/session.js'

const { name, input, agent, json, help } = parseCommandLine(process.argv.slice(2), commands)

async function main() {
  if (!name || (help && !commands[name])) return console.log(helpText(commands))
  if (help) return console.log(helpText(commands, name))
  prepareSession()
  if (name === 'mcp') return serveMcp()
  if (!commands[name]) throw new Error(`Unknown command "${name}"\n\n${helpText(commands)}`)
  const result = await invokeCommand(name, input, { agent })
  if (typeof result === 'string') console.log(json ? JSON.stringify({ text: result }) : result)
  else console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(`hyprhand: ${error.message}`)
  process.exit(1)
})
