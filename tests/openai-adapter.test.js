import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openaiAdapter, OpenAIToAnthropicStreamState } from '../lib/protocols/openai.js'

// ── encodeRequest ──

test('encodeRequest: string system + simple text message', () => {
  const out = openaiAdapter.encodeRequest({
    model: 'glm-5',
    max_tokens: 100,
    system: 'be terse',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(out.model, 'glm-5')
  assert.equal(out.max_tokens, 100)
  assert.deepEqual(out.messages, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
  ])
})

test('encodeRequest: system block list and anthropic-only fields stripped', () => {
  const out = openaiAdapter.encodeRequest({
    model: 'm',
    system: [{ type: 'text', text: 'sys1', cache_control: { type: 'ephemeral' } }],
    metadata: { user_id: 'x' },
    stop_sequences: ['x'],
    output_config: {},
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })
  assert.deepEqual(out.messages[0], { role: 'system', content: 'sys1' })
  // single text block collapses to a plain string
  assert.deepEqual(out.messages[1], { role: 'user', content: 'hello' })
  assert.ok(!('metadata' in out))
  assert.ok(!('stop_sequences' in out))
  assert.ok(!('output_config' in out))
})

test('encodeRequest: tool_result becomes role=tool message', () => {
  const out = openaiAdapter.encodeRequest({
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'result text' }] },
          { type: 'text', text: 'continue' },
        ],
      },
    ],
  })
  const toolMsg = out.messages.find((m) => m.role === 'tool')
  assert.deepEqual(toolMsg, { role: 'tool', tool_call_id: 'toolu_1', content: 'result text' })
  const userMsg = out.messages.find((m) => m.role === 'user')
  assert.equal(userMsg.content, 'continue')
})

test('encodeRequest: assistant tool_use becomes tool_calls', () => {
  const out = openaiAdapter.encodeRequest({
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: { city: 'sf' } },
        ],
      },
    ],
  })
  const msg = out.messages[0]
  assert.equal(msg.role, 'assistant')
  assert.equal(msg.content, 'let me check')
  assert.equal(msg.tool_calls.length, 1)
  assert.equal(msg.tool_calls[0].id, 'toolu_9')
  assert.equal(msg.tool_calls[0].function.name, 'get_weather')
  assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { city: 'sf' })
})

test('encodeRequest: tools + tool_choice mapping', () => {
  const out = openaiAdapter.encodeRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' },
  })
  assert.deepEqual(out.tools, [
    { type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } },
  ])
  assert.equal(out.tool_choice, 'required')
})

test('encodeRequest: base64 image becomes data-url image_url part', () => {
  const out = openaiAdapter.encodeRequest({
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        ],
      },
    ],
  })
  const content = out.messages[0].content
  assert.equal(content.length, 2)
  assert.equal(content[1].type, 'image_url')
  assert.equal(content[1].image_url.url, 'data:image/jpeg;base64,AAAA')
})

// ── decodeResponse ──

test('decodeResponse: text + tool_calls + usage', () => {
  const out = openaiAdapter.decodeResponse({
    id: 'chatcmpl-1',
    model: 'glm-5',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: 'calling tool',
        tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"a":1}' } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  })
  assert.equal(out.type, 'message')
  assert.equal(out.stop_reason, 'tool_use')
  assert.deepEqual(out.content[0], { type: 'text', text: 'calling tool' })
  assert.deepEqual(out.content[1], { type: 'tool_use', id: 'call_1', name: 'f', input: { a: 1 } })
  assert.equal(out.usage.input_tokens, 10)
  assert.equal(out.usage.output_tokens, 5)
})

test('decodeResponse: malformed tool arguments fall back to empty input', () => {
  const out = openaiAdapter.decodeResponse({
    choices: [{
      finish_reason: 'tool_calls',
      message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{bad' } }] },
    }],
  })
  assert.deepEqual(out.content[0].input, {})
})

test('decodeResponse: empty choices yields empty message', () => {
  const out = openaiAdapter.decodeResponse({})
  assert.deepEqual(out.content, [])
  assert.equal(out.stop_reason, 'end_turn')
})

// ── stream state machine ──

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`

function collectEvents(chunks) {
  const state = new OpenAIToAnthropicStreamState('test-model')
  const events = []
  for (const chunk of chunks) events.push(...state.feed(Buffer.from(chunk)))
  events.push(...state.flush())
  return events
}

test('stream: text-only stream produces correct Anthropic event sequence', () => {
  const events = collectEvents([
    sse({ choices: [{ delta: { content: 'hel' } }] }),
    sse({ choices: [{ delta: { content: 'lo' } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    'data: [DONE]\n\n',
  ])
  const types = events.map((e) => e.event)
  assert.deepEqual(types, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  assert.equal(events[2].data.delta.text, 'hel')
  const messageDelta = events.find((e) => e.event === 'message_delta')
  assert.equal(messageDelta.data.delta.stop_reason, 'end_turn')
  assert.equal(messageDelta.data.usage.output_tokens, 2)
})

test('stream: text then tool call advances block index', () => {
  const events = collectEvents([
    sse({ choices: [{ delta: { content: 'thinking' } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ])
  const starts = events.filter((e) => e.event === 'content_block_start')
  assert.equal(starts.length, 2)
  assert.equal(starts[0].data.content_block.type, 'text')
  assert.equal(starts[0].data.index, 0)
  assert.equal(starts[1].data.content_block.type, 'tool_use')
  assert.equal(starts[1].data.index, 1)
  assert.equal(starts[1].data.content_block.name, 'f')

  const jsonDeltas = events.filter((e) => e.data.delta?.type === 'input_json_delta')
  assert.equal(jsonDeltas.map((e) => e.data.delta.partial_json).join(''), '{"a":1}')
  assert.ok(jsonDeltas.every((e) => e.data.index === 1))

  const messageDelta = events.find((e) => e.event === 'message_delta')
  assert.equal(messageDelta.data.delta.stop_reason, 'tool_use')
})

test('stream: tool-call-first stream opens block at index 0', () => {
  const events = collectEvents([
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ])
  const start = events.find((e) => e.event === 'content_block_start')
  assert.equal(start.data.index, 0)
  assert.equal(start.data.content_block.type, 'tool_use')
})

test('stream: SSE lines split across chunk boundaries are reassembled', () => {
  const full = sse({ choices: [{ delta: { content: 'hello world' } }] })
  const mid = Math.floor(full.length / 2)
  const events = collectEvents([full.slice(0, mid), full.slice(mid), 'data: [DONE]\n\n'])
  const delta = events.find((e) => e.event === 'content_block_delta')
  assert.equal(delta.data.delta.text, 'hello world')
})

test('stream: missing [DONE] still finalizes via flush', () => {
  const events = collectEvents([
    sse({ choices: [{ delta: { content: 'x' } }] }),
  ])
  const types = events.map((e) => e.event)
  assert.ok(types.includes('message_delta'))
  assert.ok(types.includes('message_stop'))
})

test('stream: toSSE serialization shape', () => {
  const state = new OpenAIToAnthropicStreamState('m')
  const [ev] = state.feed(Buffer.from(sse({ choices: [{ delta: { content: 'a' } }] })))
  const text = ev.toSSE()
  assert.match(text, /^event: message_start\ndata: \{.*\}\n\n$/s)
})
