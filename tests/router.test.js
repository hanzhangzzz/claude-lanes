// Integration tests: boot lib/router.js as a child process against a stub
// upstream server, in both team and protocol modes. No real network, no real
// HOME — everything lives in a temp dir.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROUTER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'router.js')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-lanes-router-test-'))

// ── stub upstream: records requests, answers per-path ──

const seen = []
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8')
    seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null })

    if (req.url === '/v1/messages') {
      // Anthropic-shaped upstream (team mode target)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'anthropic-upstream-ok' }] }))
    }
    if (req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body)
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'streamed-text' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'chatcmpl-x',
        model: parsed.model,
        choices: [{ finish_reason: 'stop', message: { content: 'openai-upstream-ok' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }))
    }
    res.writeHead(404)
    res.end('{}')
  })
})

let upstreamPort

function startRouter(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ROUTER], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d.toString()
      if (stderr.includes('listening')) resolve(child)
    })
    child.on('exit', (code) => reject(new Error(`router exited early (${code}): ${stderr}`)))
    setTimeout(() => reject(new Error(`router startup timeout: ${stderr}`)), 5000).unref()
  })
}

let teamRouter, protocolRouter
const TEAM_PORT = 3911
const PROTO_PORT = 3912

before(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = upstream.address().port
  const base = `http://127.0.0.1:${upstreamPort}`

  teamRouter = await startRouter({
    ROUTER_PORT: String(TEAM_PORT),
    ROUTER_STATE_DIR: path.join(tmpRoot, 'team-state'),
    ROUTER_LEADER_URL: `${base}/leader-should-not-be-used`,
    ROUTER_TEAMMATE_URL: base,
    ROUTER_LEADER_TOKEN: 'real-leader-secret',
    ROUTER_TEAMMATE_TOKEN: 'real-teammate-secret',
    ROUTER_TEAMMATE_MODEL: 'forced-teammate-model',
  })
  protocolRouter = await startRouter({
    ROUTER_PORT: String(PROTO_PORT),
    ROUTER_STATE_DIR: path.join(tmpRoot, 'proto-state'),
    ROUTER_PROTOCOL: 'openai',
    ROUTER_UPSTREAM_URL: `${base}/v1`, // trailing /v1 must be stripped
    ROUTER_UPSTREAM_TOKEN: 'upstream-secret',
  })
})

after(() => {
  teamRouter?.kill()
  protocolRouter?.kill()
  upstream.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// ── team mode ──

test('team: health endpoint reports mode and routes', async () => {
  const resp = await fetch(`http://127.0.0.1:${TEAM_PORT}/`)
  const body = await resp.json()
  assert.equal(body.status, 'ok')
  assert.equal(body.mode, 'team')
  assert.equal(body.teammate_model, 'forced-teammate-model')
})

test('team: teammate-token routes to teammate with model override and real token', async () => {
  seen.length = 0
  const resp = await fetch(`http://127.0.0.1:${TEAM_PORT}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer teammate-token',
      'anthropic-beta': 'interleaved-thinking-2025,other-beta',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-sonnet', output_config: { x: 1 }, messages: [] }),
  })
  assert.equal(resp.status, 200)
  const upstreamReq = seen[0]
  assert.equal(upstreamReq.headers.authorization, 'Bearer real-teammate-secret')
  // model override applied, unsupported field and beta header filtered
  assert.equal(upstreamReq.body.model, 'forced-teammate-model')
  assert.ok(!('output_config' in upstreamReq.body))
  assert.equal(upstreamReq.headers['anthropic-beta'], undefined)
  const body = await resp.json()
  assert.equal(body.content[0].text, 'anthropic-upstream-ok')
})

test('team: leader-token routes to leader URL', async () => {
  seen.length = 0
  await fetch(`http://127.0.0.1:${TEAM_PORT}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer leader-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus', messages: [] }),
  })
  assert.equal(seen[0].url, '/leader-should-not-be-used/v1/messages')
  assert.equal(seen[0].headers.authorization, 'Bearer real-leader-secret')
  // leader keeps the original model
  assert.equal(seen[0].body.model, 'claude-opus')
})

test('team: unknown token falls back to model-based routing', async () => {
  seen.length = 0
  await fetch(`http://127.0.0.1:${TEAM_PORT}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer mystery', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [] }),
  })
  assert.equal(seen[0].url, '/leader-should-not-be-used/v1/messages')
})

test('team: count_tokens is forwarded', async () => {
  seen.length = 0
  const resp = await fetch(`http://127.0.0.1:${TEAM_PORT}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { authorization: 'Bearer teammate-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  })
  assert.equal(seen[0].url, '/v1/messages/count_tokens')
  assert.equal(resp.status, 404) // stub upstream has no count_tokens route — passthrough of status is fine
})

// ── protocol mode ──

test('protocol: health endpoint strips /v1 from upstream', async () => {
  const resp = await fetch(`http://127.0.0.1:${PROTO_PORT}/`)
  const body = await resp.json()
  assert.equal(body.mode, 'protocol')
  assert.equal(body.protocol, 'openai')
  assert.ok(!body.upstream.endsWith('/v1'))
})

test('protocol: non-stream request is translated both ways', async () => {
  seen.length = 0
  const resp = await fetch(`http://127.0.0.1:${PROTO_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5', max_tokens: 10, system: 'sys', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(resp.status, 200)
  const upstreamReq = seen[0]
  assert.equal(upstreamReq.url, '/v1/chat/completions')
  assert.equal(upstreamReq.headers.authorization, 'Bearer upstream-secret')
  assert.equal(upstreamReq.body.messages[0].role, 'system')

  const body = await resp.json()
  assert.equal(body.type, 'message')
  assert.equal(body.content[0].text, 'openai-upstream-ok')
  assert.equal(body.usage.input_tokens, 7)
})

test('protocol: streaming request yields Anthropic SSE events', async () => {
  const resp = await fetch(`http://127.0.0.1:${PROTO_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(resp.headers.get('content-type'), 'text/event-stream')
  const text = await resp.text()
  assert.match(text, /event: message_start/)
  assert.match(text, /streamed-text/)
  assert.match(text, /event: message_stop/)
})

test('protocol: count_tokens returns stub', async () => {
  const resp = await fetch(`http://127.0.0.1:${PROTO_PORT}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  })
  assert.deepEqual(await resp.json(), { input_tokens: 0 })
})

test('protocol: upstream error is wrapped in Anthropic error format and dumped', async () => {
  const resp = await fetch(`http://127.0.0.1:${PROTO_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json at all',
  })
  assert.equal(resp.status, 400)
  const body = await resp.json()
  assert.equal(body.type, 'error')
})
