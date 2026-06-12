// OpenAI Chat Completions protocol adapter.
//
// Translates Anthropic /v1/messages requests into OpenAI /v1/chat/completions
// requests, and OpenAI responses (including SSE streams) back into Anthropic
// /v1/messages responses.
//
// Supported:
// - text / image_url / tool_use / tool_result blocks, both directions
// - streaming text + tool calls (with tool_calls fragment accumulation)
// - OpenAI usage mapped to Anthropic usage
//
// Not yet supported (TODO):
// - prompt caching field mapping
// - extended thinking / reasoning_effort
// - image transports other than base64 / url

import crypto from 'node:crypto'
import { AnthropicEvent } from './base.js'

const STOP_REASON_MAP = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
  function_call: 'tool_use', // legacy OpenAI protocol
}

const genId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`

const log = (level, msg) => {
  process.stderr.write(`${new Date().toISOString()} ${level} ${msg}\n`)
}

// ──────────────────────────────────────────
// Request conversion: Anthropic → OpenAI
// ──────────────────────────────────────────

// Anthropic top-level `system` (string or block list) → OpenAI system messages.
function convertSystem(system) {
  if (!system) return null
  if (typeof system === 'string') return [{ role: 'system', content: system }]
  const parts = []
  for (const block of system) {
    if (block && typeof block === 'object' && block.type === 'text') {
      parts.push({ role: 'system', content: block.text ?? '' })
    } else if (typeof block === 'string') {
      parts.push({ role: 'system', content: block })
    }
  }
  return parts.length ? parts : null
}

function convertContentBlock(block) {
  const btype = block.type
  if (btype === 'text') return { type: 'text', text: block.text ?? '' }
  if (btype === 'image') {
    const source = block.source ?? {}
    if (source.type === 'base64') {
      const mediaType = source.media_type ?? 'image/png'
      return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data ?? ''}` } }
    }
    if (source.type === 'url') {
      return { type: 'image_url', image_url: { url: source.url ?? '' } }
    }
    log('WARN', `unsupported image source type: ${source.type}, skipping`)
    return null
  }
  if (btype === 'tool_use' || btype === 'tool_result') return null
  log('WARN', `unknown Anthropic content block type: ${btype}, skipping`)
  return null
}

// user message content → [userParts, toolMessages]
// Anthropic tool_result blocks become OpenAI role=tool messages, not user content.
function convertUserContent(content) {
  const userParts = []
  const toolMessages = []
  if (typeof content === 'string') return [[content], []]
  for (const block of content ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'tool_result') {
      let trContent = block.content ?? ''
      if (Array.isArray(trContent)) {
        let text = ''
        for (const tb of trContent) {
          if (tb && typeof tb === 'object' && tb.type === 'text') text += tb.text ?? ''
        }
        trContent = text
      }
      toolMessages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id ?? '',
        content: typeof trContent === 'string' ? trContent : JSON.stringify(trContent),
      })
    } else {
      const converted = convertContentBlock(block)
      if (converted === null) continue
      userParts.push(converted)
    }
  }
  return [userParts, toolMessages]
}

// assistant message content → [textOrNull, toolCallsOrNull]
function convertAssistantContent(content) {
  if (typeof content === 'string') return [content, null]
  const textParts = []
  const toolCalls = []
  for (const block of content ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      textParts.push(block.text ?? '')
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? genId('toolu'),
        type: 'function',
        function: {
          name: block.name ?? '',
          arguments: JSON.stringify(block.input ?? {}),
        },
      })
    }
  }
  const text = textParts.join('') || null
  return [text, toolCalls.length ? toolCalls : null]
}

function convertToolChoice(tc) {
  if (!tc) return null
  if (typeof tc === 'string') return tc
  if (typeof tc === 'object') {
    const t = tc.type
    if (t === 'auto') return 'auto'
    if (t === 'any') return 'required'
    if (t === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } }
    if (t === 'none') return 'none'
  }
  return null
}

function convertTools(tools) {
  if (!tools || !tools.length) return null
  const out = []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    out.push({
      type: 'function',
      function: {
        name: t.name ?? '',
        description: t.description ?? '',
        parameters: t.input_schema ?? {},
      },
    })
  }
  return out.length ? out : null
}

// Drop Anthropic-only fields that OpenAI-protocol providers (e.g. vLLM) reject.
const ANTHROPIC_ONLY_FIELDS = new Set([
  'metadata', 'stop_sequences', 'betas', 'context_management',
  'mcp_servers', 'container', 'inference_geo', 'output_config',
  'speed', 'tool_reference_blocks', 'extra', 'anthropic_internal',
])

function stripAnthropicOnlyFields(body) {
  const out = {}
  for (const [k, v] of Object.entries(body)) {
    if (!ANTHROPIC_ONLY_FIELDS.has(k)) out[k] = v
  }
  return out
}

// ──────────────────────────────────────────
// Response conversion: OpenAI → Anthropic
// ──────────────────────────────────────────

function convertOpenAIMessageToAnthropicContent(msg) {
  const blocks = []
  if (msg.content) blocks.push({ type: 'text', text: msg.content })
  for (const tc of msg.tool_calls ?? []) {
    const fn = tc.function ?? {}
    let input = {}
    if (fn.arguments) {
      try {
        input = JSON.parse(fn.arguments)
      } catch {
        log('WARN', `tool arguments are not valid JSON: ${String(fn.arguments).slice(0, 100)}, using empty object`)
      }
    }
    blocks.push({
      type: 'tool_use',
      id: tc.id ?? genId('toolu'),
      name: fn.name ?? '',
      input,
    })
  }
  if (!blocks.length) blocks.push({ type: 'text', text: '' })
  return blocks
}

const emptyUsage = () => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
})

// ──────────────────────────────────────────
// StreamState: OpenAI SSE → Anthropic SSE
// ──────────────────────────────────────────

export class OpenAIToAnthropicStreamState {
  constructor(model) {
    this.model = model
    this.messageStarted = false
    this.blockIndex = 0
    this.blockOpen = null // null | 'text' | 'tool'
    this.toolBlocks = new Map() // OpenAI tc index → { id, name, inputAcc }
    this.finishReason = null
    this.usage = null
    this.closed = false
    this.lineBuf = '' // SSE lines can split across chunks
  }

  feed(chunk) {
    if (this.closed) return []
    const out = []
    this.lineBuf += chunk.toString('utf-8')
    const lines = this.lineBuf.split('\n')
    this.lineBuf = lines.pop() ?? '' // keep the trailing partial line
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payloadStr = line.slice(6).trim()
      if (!payloadStr) continue
      if (payloadStr === '[DONE]') {
        out.push(...this.finalize())
        return out
      }
      let payload
      try {
        payload = JSON.parse(payloadStr)
      } catch {
        log('WARN', `skipping malformed JSON chunk: ${payloadStr.slice(0, 200)}`)
        continue
      }
      // usage may arrive in the final chunk (stream_options.include_usage)
      if (payload.usage) this.usage = payload.usage
      for (const choice of payload.choices ?? []) {
        out.push(...this.handleChoice(choice))
      }
    }
    return out
  }

  flush() {
    if (this.closed) return []
    return this.finalize()
  }

  handleChoice(choice) {
    const out = []
    const delta = choice.delta ?? {}
    const finish = choice.finish_reason

    if (!this.messageStarted) {
      this.messageStarted = true
      out.push(new AnthropicEvent('message_start', {
        type: 'message_start',
        message: {
          id: genId('msg'),
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...emptyUsage(), input_tokens: this.usage?.prompt_tokens ?? 0 },
        },
      }))
    }

    if (delta.content) {
      if (this.blockOpen !== 'text') {
        out.push(...this.closeBlock())
        out.push(new AnthropicEvent('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: { type: 'text', text: '' },
        }))
        this.blockOpen = 'text'
      }
      out.push(new AnthropicEvent('content_block_delta', {
        type: 'content_block_delta',
        index: this.blockIndex,
        delta: { type: 'text_delta', text: delta.content },
      }))
    }

    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      const fn = tc.function ?? {}
      if (!this.toolBlocks.has(idx)) {
        out.push(...this.closeBlock())
        const toolId = tc.id || genId('toolu')
        const toolName = fn.name ?? ''
        this.toolBlocks.set(idx, { id: toolId, name: toolName, inputAcc: '', anthropicIndex: this.blockIndex })
        this.blockOpen = 'tool'
        out.push(new AnthropicEvent('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
        }))
      }
      if (fn.arguments) {
        const tb = this.toolBlocks.get(idx)
        tb.inputAcc += fn.arguments
        out.push(new AnthropicEvent('content_block_delta', {
          type: 'content_block_delta',
          index: tb.anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: fn.arguments },
        }))
      }
    }

    if (finish) {
      out.push(...this.closeBlock())
      this.finishReason = STOP_REASON_MAP[finish] ?? 'end_turn'
    }
    return out
  }

  // Emit content_block_stop for the open block and advance the index so the
  // next block opens at the following position.
  closeBlock() {
    if (this.blockOpen === null) return []
    this.blockOpen = null
    const ev = new AnthropicEvent('content_block_stop', {
      type: 'content_block_stop',
      index: this.blockIndex,
    })
    this.blockIndex += 1
    return [ev]
  }

  finalize() {
    if (this.closed) return []
    this.closed = true
    const out = []
    if (this.blockOpen !== null) out.push(...this.closeBlock())
    out.push(new AnthropicEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.finishReason ?? 'end_turn', stop_sequence: null },
      usage: {
        output_tokens: this.usage?.completion_tokens ?? 0,
        input_tokens: this.usage?.prompt_tokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }))
    out.push(new AnthropicEvent('message_stop', { type: 'message_stop' }))
    return out
  }
}

// ──────────────────────────────────────────
// Adapter
// ──────────────────────────────────────────

export const openaiAdapter = {
  name: 'openai',

  encodeRequest(anthropicBody) {
    const body = stripAnthropicOnlyFields(anthropicBody)
    const out = { model: body.model ?? '' }

    if ('max_tokens' in body) out.max_tokens = body.max_tokens
    for (const k of ['temperature', 'top_p', 'stream', 'stop', 'presence_penalty', 'frequency_penalty', 'user', 'seed']) {
      if (k in body) out[k] = body[k]
    }

    const sysMsgs = convertSystem(body.system)
    const outMessages = []
    if (sysMsgs) outMessages.push(...sysMsgs)

    for (const m of body.messages ?? []) {
      const { role, content } = m
      if (role === 'user') {
        const [userParts, toolMsgs] = convertUserContent(content)
        if (userParts.length) {
          let contentOut
          if (userParts.length === 1 && typeof userParts[0] === 'string') {
            contentOut = userParts[0]
          } else if (userParts.length === 1 && userParts[0]?.type === 'text') {
            contentOut = userParts[0].text ?? ''
          } else {
            contentOut = userParts
          }
          outMessages.push({ role: 'user', content: contentOut })
        }
        outMessages.push(...toolMsgs)
      } else if (role === 'assistant') {
        const [text, toolCalls] = convertAssistantContent(content)
        const msg = { role: 'assistant', content: text }
        if (toolCalls) msg.tool_calls = toolCalls
        outMessages.push(msg)
      } else {
        log('WARN', `unknown message role: ${role}, skipping`)
      }
    }
    out.messages = outMessages

    const tools = convertTools(body.tools)
    if (tools) out.tools = tools
    const tc = convertToolChoice(body.tool_choice)
    if (tc) out.tool_choice = tc

    return out
  },

  decodeResponse(responseBody) {
    const choices = responseBody.choices ?? []
    if (!choices.length) {
      return {
        id: responseBody.id ?? genId('msg'),
        type: 'message',
        role: 'assistant',
        model: responseBody.model ?? '',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: emptyUsage(),
      }
    }
    const choice = choices[0]
    const msg = choice.message ?? {}
    const usage = responseBody.usage ?? {}
    return {
      id: responseBody.id ?? genId('msg'),
      type: 'message',
      role: 'assistant',
      model: responseBody.model ?? '',
      content: convertOpenAIMessageToAnthropicContent(msg),
      stop_reason: STOP_REASON_MAP[choice.finish_reason ?? ''] ?? 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }
  },

  upstreamPath() {
    return '/v1/chat/completions'
  },

  upstreamHeaders(token) {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    }
  },

  newStreamState(model) {
    return new OpenAIToAnthropicStreamState(model)
  },
}
