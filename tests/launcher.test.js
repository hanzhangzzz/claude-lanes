// End-to-end launcher tests for bin/c.
//
// Isolation contract: every path the launcher touches is overridden via
// CLAUDE_LANES_* env vars, and the claude binary is a stub that dumps its
// env and args. These tests must never read or write the real ~/.claude,
// ~/.config/claude-lanes, or launch a real claude.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const C_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'c')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-lanes-launcher-test-'))
const configDir = path.join(tmp, 'config')
const stateDir = path.join(tmp, 'state')
const settingsFile = path.join(tmp, 'settings-lanes.json')
const envDump = path.join(tmp, 'claude-env-dump.json')
const stubClaude = path.join(tmp, 'stub-claude')

const baseEnv = {
  ...process.env,
  CLAUDE_LANES_CONFIG_DIR: configDir,
  CLAUDE_LANES_STATE_DIR: stateDir,
  CLAUDE_LANES_SETTINGS: settingsFile,
  CLAUDE_LANES_CLAUDE_BIN: stubClaude,
}

function runC(args, opts = {}) {
  return execFileSync(C_BIN, args, { env: baseEnv, encoding: 'utf-8', ...opts })
}

before(() => {
  // stub claude: dump env + args as JSON, then exit
  fs.writeFileSync(stubClaude, `#!/bin/bash
node -e '
  const fs = require("fs")
  fs.writeFileSync(process.env.ENV_DUMP, JSON.stringify({
    args: process.argv.slice(1),
    env: {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_AUTH_TOKEN: process.env.CLAUDE_AUTH_TOKEN,
      CLAUDE_MODEL_LABEL: process.env.CLAUDE_MODEL_LABEL,
      CLAUDE_TEAM_ROLE: process.env.CLAUDE_TEAM_ROLE,
      ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL,
    },
  }, null, 2))
' -- "$@"
`)
  fs.chmodSync(stubClaude, 0o755)
  baseEnv.ENV_DUMP = envDump
})

after(() => {
  // stop any router the team test started, then remove the sandbox
  try {
    execFileSync(C_BIN, ['router', 'stop'], { env: baseEnv, encoding: 'utf-8' })
  } catch {
    // best effort
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('first run creates a config template and exits cleanly', () => {
  const out = runC(['0'])
  assert.match(out, /Created:/)
  assert.ok(fs.existsSync(path.join(configDir, 'config.env')))
  const mode = fs.statSync(path.join(configDir, 'config.env')).mode & 0o777
  assert.equal(mode, 0o600)
})

test('help lists configured lanes from config', () => {
  fs.writeFileSync(path.join(configDir, 'config.env'), `
CONFIG_0_BASE_URL=https://provider-zero.example.com
CONFIG_0_AUTH_TOKEN=token-zero
CONFIG_0_MODEL=model-zero
CONFIG_2_BASE_URL=https://provider-two.example.com
CONFIG_2_AUTH_TOKEN=token-two
CONFIG_2_EFFORT=max
CLAUDE_ARGS=--my-extra-arg
`)
  const out = runC([])
  assert.match(out, /0.*model-zero/)
  assert.match(out, /provider-two\.example\.com/)
})

test('c <n> injects provider env and launches claude with --settings', () => {
  fs.rmSync(envDump, { force: true })
  runC(['0'])
  const dump = JSON.parse(fs.readFileSync(envDump, 'utf-8'))
  assert.equal(dump.env.ANTHROPIC_BASE_URL, 'https://provider-zero.example.com')
  assert.equal(dump.env.CLAUDE_AUTH_TOKEN, 'token-zero')
  assert.equal(dump.env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(dump.env.CLAUDE_MODEL_LABEL, 'model-zero')
  assert.equal(dump.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'model-zero')
  assert.ok(dump.args.includes('--settings'))
  assert.ok(dump.args.includes(settingsFile))
  assert.deepEqual(dump.args.slice(dump.args.indexOf('--model'), dump.args.indexOf('--model') + 2), ['--model', 'model-zero'])
  // CLAUDE_ARGS from config is appended
  assert.ok(dump.args.includes('--my-extra-arg'))
})

test('c <n> creates settings-lanes.json pointing at the auth helper', () => {
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))
  assert.match(settings.apiKeyHelper, /auth-helper\.sh$/)
  assert.ok(fs.existsSync(settings.apiKeyHelper))
})

test('per-lane EFFORT is exported', () => {
  fs.rmSync(envDump, { force: true })
  runC(['2'])
  const dump = JSON.parse(fs.readFileSync(envDump, 'utf-8'))
  assert.equal(dump.env.CLAUDE_CODE_EFFORT_LEVEL, 'max')
  assert.equal(dump.env.ANTHROPIC_BASE_URL, 'https://provider-two.example.com')
})

test('extra args pass through to claude', () => {
  fs.rmSync(envDump, { force: true })
  runC(['0', '--resume'])
  const dump = JSON.parse(fs.readFileSync(envDump, 'utf-8'))
  assert.ok(dump.args.includes('--resume'))
})

test('c team starts a router, injects team env, and cleans up on exit', () => {
  fs.rmSync(envDump, { force: true })
  const out = runC(['team', '2', '0'])
  assert.match(out, /team router ready/)
  const dump = JSON.parse(fs.readFileSync(envDump, 'utf-8'))
  assert.match(dump.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(dump.env.CLAUDE_TEAM_ROLE, 'leader')
  assert.match(dump.env.CLAUDE_MODEL_LABEL, /^team\(/)
  assert.ok(dump.args.includes('--teammate-mode'))
  // claude (stub) exited → trap must have stopped the router
  assert.match(out, /team router stopped/)
  const pids = fs.readdirSync(path.join(stateDir, 'routers')).filter((f) => f.endsWith('.pid'))
  assert.equal(pids.length, 0)
})

test('unknown lane number dies with a clear error', () => {
  assert.throws(() => runC(['9']), /BASE_URL not found/)
})

test('c router status reports no routers after cleanup', () => {
  const out = runC(['router', 'status'])
  assert.match(out, /no running routers/)
})

test('auth-helper: returns role tokens against local router, real token otherwise', () => {
  const helper = path.join(path.dirname(C_BIN), 'auth-helper.sh')
  const run = (env) => execFileSync(helper, [], { env: { ...process.env, ...env }, encoding: 'utf-8' }).trim()

  assert.equal(run({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:3100', CLAUDE_TEAM_ROLE: 'leader' }), 'leader-token')
  assert.equal(run({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:3100' }), 'teammate-token')
  assert.equal(run({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100', CLAUDE_PROTOCOL: 'openai', CLAUDE_AUTH_TOKEN: 'real' }), 'real')
  assert.equal(run({ ANTHROPIC_BASE_URL: 'https://api.example.com', CLAUDE_AUTH_TOKEN: 'real' }), 'real')
})
