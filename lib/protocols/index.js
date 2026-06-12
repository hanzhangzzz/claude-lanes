// Protocol adapter registry.
//
// To add a protocol (gemini, cohere, ...):
// 1. Create lib/protocols/<name>.js implementing the adapter interface (see base.js)
// 2. Import it below and add it to REGISTRY
// 3. Set CONFIG_X_PROTOCOL=<name> in config.env — done

import { openaiAdapter } from './openai.js'

export { AnthropicEvent } from './base.js'

export const REGISTRY = {
  [openaiAdapter.name]: openaiAdapter,
}

export function getAdapter(name) {
  const adapter = REGISTRY[name]
  if (!adapter) {
    throw new Error(`unknown protocol: ${name} (available: ${Object.keys(REGISTRY).join(', ')})`)
  }
  return adapter
}
