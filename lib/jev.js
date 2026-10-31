import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sleep } from './session.js'

const endpoint = () => process.env.TYPESAFE_API_URL ?? 'https://api.typesafe.ai/v1/systemone'
export const jevModel = () => process.env.HYPRHAND_JEV_MODEL ?? 'jev-latest'

export function jevAvailable() {
  return Boolean(process.env.TYPESAFE_API_KEY)
}

export async function askJev({ state, questions, images = {} }) {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) throw new Error('TYPESAFE_API_KEY is not set. Create a key at https://console.typesafe.ai/keys')
  const refs = Object.keys(images)
  const hasImages = refs.length > 0
  const json = JSON.stringify({ model: jevModel(), state, questions, ...(hasImages ? { assets: Object.fromEntries(refs.map((ref) => [ref, { type: 'image', part: ref }])) } : {}) })
  const body = () => {
    if (!hasImages) return json
    const form = new FormData()
    form.append('request', new Blob([json], { type: 'application/json' }))
    for (const ref of refs) form.append(ref, new Blob([readFileSync(images[ref])], { type: /\.png$/i.test(images[ref]) ? 'image/png' : 'image/jpeg' }), path.basename(images[ref]))
    return form
  }
  const headers = { authorization: `Bearer ${key}`, ...(hasImages ? { 'TypeSafe-Danger-Zone-Images': 'true' } : { 'content-type': 'application/json' }) }
  const started = Date.now()
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(endpoint(), { method: 'POST', headers, body: body(), signal: AbortSignal.timeout(20000) }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }))
    if (response.ok) {
      const result = await response.json()
      return { answers: result.answers, usage: result.usage, model: result.model, ms: Date.now() - started }
    }
    const retryable = response.status === 0 || response.status === 429 || response.status >= 500
    if (!retryable || attempt >= 2) throw new Error(`Jev request failed (${response.status}): ${(await response.text()).slice(0, 300)}`)
    await sleep(400 * 2 ** attempt)
  }
}

export function choice(instructions, criteria) {
  return { type: 'choice', instructions, criteria }
}

export function noul(instructions) {
  return { type: 'noul', instructions }
}

export function box(instructions) {
  return { type: 'box', instructions }
}
