const usage = 'Usage: hyprhand [--agent NAME] <command> [args] [--json]'

export function parseCommandLine(argv, commands) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s)
    const next = argv[index + 1]
    let value
    if (inline !== undefined) value = inline
    else if (next === undefined || next.startsWith('--')) value = true
    else if (isBooleanFlag(commands, positional[0], key)) value = /^(true|false|yes|no|on|off|0|1)$/i.test(next) ? (index++, next) : true
    else value = next, index++
    options[key] = key in options ? [].concat(options[key], value) : value
  }
  const { agent, json, help, ...rest } = options
  const name = positional.shift()
  const command = commands[name]
  const input = { ...rest }
  const names = command?.positional ?? []
  names.forEach((key, index) => {
    if (input[key] !== undefined || positional[index] === undefined) return
    const last = index === names.length - 1
    const remaining = positional.slice(index)
    if (!last) input[key] = positional[index]
    else if (command.options?.[key]?.type === 'array') input[key] = remaining
    else input[key] = remaining.join(' ')
  })
  return { name, input, agent: agent === undefined ? undefined : String(agent), json: Boolean(json), help: Boolean(help) || name === 'help' }
}

const globalSwitches = new Set(['json', 'help'])

function isBooleanFlag(commands, name, key) {
  return globalSwitches.has(key) || commands[name]?.options?.[key]?.type === 'boolean'
}

function signature(name, command) {
  return [name, ...(command.positional ?? []).map((key) => (command.options?.[key]?.required ? `<${key}>` : `[${key}]`))].join(' ')
}

export function helpText(commands, name) {
  const command = name && commands[name]
  if (!command) {
    const lines = ['hyprhand: computer use for Hyprland, with one visible cursor per agent', '', usage, '']
    for (const [key, entry] of Object.entries(commands)) lines.push(`  ${signature(key, entry).padEnd(34)} ${entry.summary}`)
    lines.push(`  ${'mcp'.padEnd(34)} Serve all commands over MCP stdio`, '', 'Run "hyprhand <command> --help" for its options.')
    return lines.join('\n')
  }
  const lines = [`hyprhand ${signature(name, command)}`, command.summary, '']
  for (const [option, spec] of Object.entries(command.options ?? {})) {
    const notes = [spec.required && 'required', spec.default !== undefined && `default ${spec.default}`, spec.type !== 'string' && spec.type].filter(Boolean)
    lines.push(`  --${option.padEnd(14)} ${spec.description}${notes.length ? ` (${notes.join(', ')})` : ''}`)
  }
  return lines.join('\n')
}
