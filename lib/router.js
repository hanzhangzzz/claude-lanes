#!/usr/bin/env node
// claude-lanes router — local proxy with two exclusive modes.
//
// Team mode (default): routes by auth token so a single Claude Code team
// session can run the leader and teammates on different providers.
//   - the leader's apiKeyHelper returns "leader-token"
//   - teammates' apiKeyHelper returns "teammate-token" (CLAUDE_TEAM_ROLE is
//     filtered from teammate processes by Claude Code)
//   - the router inspects the Authorization header to pick the route
//
//   env: ROUTER_LEADER_URL    ROUTER_LEADER_TOKEN
//        ROUTER_TEAMMATE_URL  ROUTER_TEAMMATE_TOKEN
//        ROUTER_TEAMMATE_MODEL  (optional model override for teammates)
//
// Protocol mode (ROUTER_PROTOCOL=openai): translates Anthropic /v1/messages
// requests into the target protocol, forwards upstream, and translates the
// response (including SSE streams) back into Anthropic format. Multiple `c`
// processes share one router instance.
//
//   env: ROUTER_PROTOCOL        adapter name from lib/protocols/
//        ROUTER_UPSTREAM_URL    provider base URL (trailing /v1 is stripped)
//        ROUTER_UPSTREAM_TOKEN  provider token
//        ROUTER_TEAMMATE_MODEL  forced model name (optional)
//
// Common env: ROUTER_PORT (default 3100), ROUTER_STATE_DIR (failure dumps)

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { getAdapter, AnthropicEvent } from './protocols/index.js'

const log = (level, msg) => {
  process.stderr.write(`${new Date().toISOString()} ${level} ${msg}\n`)
}

// Beta headers some providers (e.g. MiniMax) reject for teammate routes.
const UNSUPPORTED_BETA_PREFIXES = ['interleaved-thinking', 'output-128k']

const PORT = Number(process.env.ROUTER_PORT || 3100)
const STATE_DIR = process.env.ROUTER_STATE_DIR || path.join(process.cwd(), '.routers')

const stripV1 = (url) => {
  let u = (url || '').replace(/\/+$/, '')
  if (u.endsWith('/v1')) u = u.slice(0, -3)
  return u
}

// ── mode selection (decided once at startup, modes are exclusive) ──

const PROTOCOL = (process.env.ROUTER_PROTOCOL || '').toLowerCase()
let MODE, ADAPTER, UPSTREAM_URL, UPSTREAM_TOKEN, MODEL_OVERRIDE
let LEADER_URL, LEADER_TOKEN, TEAMMATE_URL, TEAMMATE_TOKEN, TEAMMATE_MODEL

if (PROTOCOL) {
  MODE = 'protocol'
  ADAPTER = getAdapter(PROTOCOL)
  UPSTREAM_URL = stripV1(process.env.ROUTER_UPSTREAM_URL)
  UPSTREAM_TOKEN = process.env.ROUTER_UPSTREAM_TOKEN || ''
  MODEL_OVERRIDE = process.env.ROUTER_TEAMMATE_MODEL || ''
  if (!UPSTREAM_URL || !UPSTREAM_TOKEN) {
    log('ERROR', 'protocol mode requires ROUTER_UPSTREAM_URL and ROUTER_UPSTREAM_TOKEN')
    process.exit(1)
  }
  log('INFO', `starting protocol mode: protocol=${PROTOCOL} upstream=${UPSTREAM_URL}`)
} else {
  MODE = 'team'
  LEADER_URL = stripV1(process.env.ROUTER_LEADER_URL)
  LEADER_TOKEN = process.env.ROUTER_LEADER_TOKEN || ''
  TEAMMATE_URL = stripV1(process.env.ROUTER_TEAMMATE_URL)
  TEAMMATE_TOKEN = process.env.ROUTER_TEAMMATE_TOKEN || ''
  TEAMMATE_MODEL = process.env.ROUTER_TEAMMATE_MODEL || ''
  log('INFO', `starting team mode: leader=${LEADER_URL} teammate=${TEAMMATE_URL}`)
}

// ── helpers ──

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

function anthropicError(message) {
  return { type: 'error', error: { type: 'api_error', message } }
}

const hostOf = (url) => url.replace(/^https?:\/\//, '').split('/')[0]

// Dump failed upstream exchanges to the state dir and reply in Anthropic
// error format.
function dumpAndRespondError(res, status, content, requestBody) {
  const text = content.toString('utf-8')
  log('ERROR', `upstream error ${status}: ${text.slice(0, 300)}`)
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const dumpPath = path.join(STATE_DIR, `failed_${Date.now()}.json`)
    fs.writeFileSync(dumpPath, JSON.stringify({ status, response: text, request: requestBody }, null, 2))
    log('ERROR', `full request body written to: ${dumpPath}`)
  } catch {
    // dump failures must never mask the original error
  }
  try {
    const upstream = JSON.parse(text)
    if (upstream && typeof upstream === 'object' && upstream.error) {
      const err = upstream.error
      const msg = typeof err === 'object' ? (err.message ?? text) : String(err)
      return sendJson(res, status, anthropicError(msg))
    }
  } catch {
    // not JSON — fall through to raw text
  }
  sendJson(res, status, anthropicError(text))
}

// ── team mode ──

function extractRoleToken(req) {
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return (req.headers['x-api-key'] || '').trim()
}

function resolveRoute(req, model) {
  const roleToken = extractRoleToken(req)
  if (roleToken === 'leader-token') {
    return { url: LEADER_URL, token: LEADER_TOKEN, role: 'leader', modelOverride: null }
  }
  if (roleToken === 'teammate-token') {
    return { url: TEAMMATE_URL, token: TEAMMATE_TOKEN, role: 'teammate', modelOverride: TEAMMATE_MODEL || null }
  }
  log('WARN', `unknown token: ${JSON.stringify(roleToken)}, falling back to model-based routing`)
  if (model && model.toLowerCase().includes('opus')) {
    return { url: LEADER_URL, token: LEADER_TOKEN, role: 'leader', modelOverride: null }
  }
  return { url: TEAMMATE_URL, token: TEAMMATE_TOKEN, role: 'teammate', modelOverride: TEAMMATE_MODEL || null }
}

function buildHeaders(route, req) {
  const headers = {
    authorization: `Bearer ${route.token}`,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
    'content-type': 'application/json',
  }
  for (const [key, val] of Object.entries(req.headers)) {
    if (!key.toLowerCase().startsWith('anthropic-beta')) continue
    const value = Array.isArray(val) ? val.join(',') : val
    if (route.role === 'teammate'
        && UNSUPPORTED_BETA_PREFIXES.some((p) => value.toLowerCase().includes(p))) {
      log('INFO', `filtering beta header: ${key}=${value}`)
      continue
    }
    headers[key] = value
  }
  return headers
}

function prepareBody(body, route) {
  const result = { ...body }
  if (route.modelOverride) result.model = route.modelOverride
  if (route.role === 'teammate') {
    for (const field of ['output_config']) {
      if (field in result) {
        log('INFO', `filtering unsupported field: ${field}`)
        delete result[field]
      }
    }
  }
  return result
}

async function teamForward(req, res, endpointPath) {
  let body
  try {
    body = JSON.parse((await readBody(req)).toString('utf-8'))
  } catch {
    return sendJson(res, 400, anthropicError('invalid json body'))
  }

  const model = body.model || ''
  const route = resolveRoute(req, model)
  const outBody = prepareBody(body, route)
  const headers = buildHeaders(route, req)

  const tag = route.role === 'leader' ? '🔵 LEADER' : '🟢 TEAMMATE'
  let msg = `${tag} model=${JSON.stringify(model)}`
  if (route.modelOverride) msg += ` → ${JSON.stringify(outBody.model)}`
  log('INFO', `${msg} → ${hostOf(route.url)}`)

  const upstreamUrl = `${route.url}${endpointPath}`
  let resp
  try {
    resp = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(outBody),
      signal: AbortSignal.timeout(300_000),
    })
  } catch (e) {
    log('ERROR', `request error: ${e.message}`)
    return sendJson(res, 502, anthropicError(`router request error: ${e.message}`))
  }

  if (resp.status !== 200) {
    const content = Buffer.from(await resp.arrayBuffer())
    return dumpAndRespondError(res, resp.status, content, outBody)
  }

  const contentType = resp.headers.get('content-type') || 'application/json'
  res.writeHead(200, { 'content-type': contentType })
  // pass the upstream body through unchanged — SSE streams stay incremental
  try {
    for await (const chunk of resp.body) {
      res.write(chunk)
    }
  } catch (e) {
    log('ERROR', `stream relay error: ${e.message}`)
  }
  res.end()
}

// ── protocol mode ──

async function protocolMessages(req, res) {
  let body
  try {
    body = JSON.parse((await readBody(req)).toString('utf-8'))
  } catch {
    return sendJson(res, 400, anthropicError('invalid json body'))
  }

  let outBody
  try {
    outBody = ADAPTER.encodeRequest(body)
  } catch (e) {
    log('ERROR', `encodeRequest failed: ${e.message}`)
    return sendJson(res, 400, anthropicError(`encode error: ${e.message}`))
  }
  if (MODEL_OVERRIDE) outBody.model = MODEL_OVERRIDE

  const headers = ADAPTER.upstreamHeaders(UPSTREAM_TOKEN)
  if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version']

  const modelIn = body.model || ''
  let msg = `🟣 PROTOCOL model=${JSON.stringify(modelIn)}`
  if (outBody.model && outBody.model !== modelIn) msg += ` → ${JSON.stringify(outBody.model)}`
  log('INFO', `${msg} → ${hostOf(UPSTREAM_URL)}`)

  const upstreamUrl = `${UPSTREAM_URL}${ADAPTER.upstreamPath()}`
  const isStream = Boolean(body.stream)

  if (!isStream) {
    let resp
    try {
      resp = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(outBody),
        signal: AbortSignal.timeout(300_000),
      })
    } catch (e) {
      log('ERROR', `protocol request error: ${e.message}`)
      return sendJson(res, 502, anthropicError(`router request error: ${e.message}`))
    }
    const content = Buffer.from(await resp.arrayBuffer())
    if (resp.status !== 200) {
      return dumpAndRespondError(res, resp.status, content, outBody)
    }
    try {
      const anthropicBody = ADAPTER.decodeResponse(JSON.parse(content.toString('utf-8')))
      return sendJson(res, 200, anthropicBody)
    } catch (e) {
      log('ERROR', `decodeResponse failed: ${e.message}`)
      return sendJson(res, 502, anthropicError(`decode error: ${e.message}`))
    }
  }

  // streaming: translate the upstream SSE through the adapter's stream state
  const state = ADAPTER.newStreamState(modelIn)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (events) => {
    for (const ev of events) res.write(ev.toSSE())
  }
  try {
    const resp = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(outBody),
      signal: AbortSignal.timeout(300_000),
    })
    if (resp.status !== 200) {
      const errContent = Buffer.from(await resp.arrayBuffer()).toString('utf-8')
      log('ERROR', `upstream stream error ${resp.status}: ${errContent.slice(0, 300)}`)
      emit([new AnthropicEvent('error', anthropicError(`upstream ${resp.status}: ${errContent.slice(0, 500)}`))])
      return res.end()
    }
    for await (const chunk of resp.body) {
      emit(state.feed(Buffer.from(chunk)))
    }
    emit(state.flush())
  } catch (e) {
    log('ERROR', `protocol stream error: ${e.message}`)
    emit([new AnthropicEvent('error', anthropicError(`router stream error: ${e.message}`))])
  }
  res.end()
}

// ── server ──

const server = http.createServer(async (req, res) => {
  // match on the pathname only — claude appends query strings (?beta=true)
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  log('INFO', `→ ${req.method} ${req.url}`)
  try {
    if (req.method === 'GET' && pathname === '/') {
      if (MODE === 'protocol') {
        return sendJson(res, 200, { status: 'ok', mode: 'protocol', protocol: PROTOCOL, upstream: UPSTREAM_URL })
      }
      return sendJson(res, 200, {
        status: 'ok',
        mode: 'team',
        leader: LEADER_URL,
        teammate: TEAMMATE_URL,
        teammate_model: TEAMMATE_MODEL || '(passthrough)',
      })
    }

    if (req.method === 'POST' && pathname === '/v1/messages') {
      if (MODE === 'protocol') return await protocolMessages(req, res)
      return await teamForward(req, res, req.url)
    }

    if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') {
      if (MODE === 'team') return await teamForward(req, res, req.url)
      // protocol mode has no upstream count_tokens — return a rough stub
      await readBody(req)
      return sendJson(res, 200, { input_tokens: 0 })
    }

    sendJson(res, 404, anthropicError(`no route: ${req.method} ${req.url}`))
  } catch (e) {
    log('ERROR', `unhandled handler error: ${e.stack || e.message}`)
    if (!res.headersSent) sendJson(res, 500, anthropicError(`router internal error: ${e.message}`))
    else res.end()
  }
})

server.listen(PORT, '127.0.0.1', () => {
  log('INFO', `claude-lanes router listening on 127.0.0.1:${PORT} (mode=${MODE})`)
})
