import { readFileSync } from 'node:fs'
import { sleep } from './session.js'

const endpoint = () => process.env.TYPESAFE_API_URL ?? 'https://api.typesafe.ai/v1/systemone'
export const jevModel = () => process.env.HYPRHAND_JEV_MODEL ?? 'jev-latest'
export const JEV_IMAGE_SIDE = { min: 280, max: 1568 }

export function jevAvailable() {
  return Boolean(process.env.TYPESAFE_API_KEY)
}

export async function askJev({ state, questions, images = {} }) {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) throw new Error('TYPESAFE_API_KEY is not set. Create a key at https://console.typesafe.ai/keys')
  const assets = Object.fromEntries(Object.entries(images).map(([ref, file]) => [ref, {
    type: 'image',
    format: /\.png$/i.test(file) ? 'png' : 'jpg',
    data_base64: readFileSync(file).toString('base64'),
  }]))
  const hasImages = Object.keys(assets).length > 0
  const body = JSON.stringify({ model: jevModel(), state, questions, ...(hasImages ? { assets } : {}) })
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(hasImages ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {}) }
  const started = Date.now()
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(endpoint(), { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }))
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
