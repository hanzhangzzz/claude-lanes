# claude-lanes

**Per-window provider router for Claude Code. Pin a model to each terminal lane.**

```bash
npm i -g claude-lanes
```

```
iTerm window 1   $ c 0          → Claude Code on GLM-5, forever
iTerm window 2   $ c 1          → Claude Code on official Anthropic API
iTerm window 3   $ c 2          → Claude Code on a vLLM box (OpenAI protocol)
iTerm window 4   $ c team 1 0   → leader on Opus, every teammate on GLM-5
```

Each terminal window is a **lane**. Each lane is pinned to one provider for the
life of the process. No daemon, no JSON config, no auto-routing that silently
switches your model mid-task.

[中文文档 →](README.zh-CN.md)

![claude-lanes demo](assets/demo.gif)

## Why

If you run several Claude Code sessions in parallel — one window per task —
you want *explicit control*: this window runs this model, period. Session-level
`/model` switching and token-count-based auto-routing are great for casual use,
but for deep work they are exactly what you don't want: you can't trust a task
to a model you didn't choose.

`claude-lanes` is deliberately simple: `c 2` injects the provider's
`ANTHROPIC_BASE_URL` and token into the environment and `exec`s `claude`.
That's the whole trick — and that's the point. The process is pinned at birth
and nothing can re-route it.

## Quick start

```bash
npm i -g claude-lanes
c 0          # first run creates ~/.config/claude-lanes/config.env
vim ~/.config/claude-lanes/config.env   # fill in your providers
c 0          # this window now runs provider 0
```

Config is one numbered block per provider:

```bash
CONFIG_0_BASE_URL=https://open.bigmodel.cn/api/anthropic
CONFIG_0_AUTH_TOKEN=sk-...
CONFIG_0_MODEL=glm-5

CONFIG_1_BASE_URL=https://api.anthropic.com
CONFIG_1_AUTH_TOKEN=sk-ant-...
```

Anything that speaks the Anthropic API works: GLM, Kimi, MiniMax, DeepSeek,
official Anthropic, your own gateway.

## Team mode — one session, two providers

Claude Code agent teams spawn teammate processes. `claude-lanes` can route the
leader and the teammates to **different providers**:

```bash
c team 1 0     # leader → provider 1 (e.g. Opus), teammates → provider 0 (e.g. GLM-5)
```

A throwaway local router starts on a free port, tells leader and teammate
requests apart by auth token, and dies when your session ends. Run five
`c team` windows in parallel — each gets its own router. This is the cheap way
to run an expensive leader with a fleet of inexpensive teammates.

Requires `tmux` (teammates run as separate processes via `--teammate-mode tmux`).

## OpenAI-protocol providers

For upstreams that only speak OpenAI Chat Completions (vLLM, OpenRouter-style
gateways):

```bash
CONFIG_2_BASE_URL=https://your-vllm-box.example.com/v1
CONFIG_2_AUTH_TOKEN=sk-...
CONFIG_2_PROTOCOL=openai
CONFIG_2_MODEL=qwen3-coder
```

`c 2` starts (or reuses) a local translation proxy that converts
Anthropic ⇄ OpenAI **including streaming and tool calls** — a real stream
state machine (text deltas, tool_call fragment accumulation,
`finish_reason` → `stop_reason`), not just field renaming. Known gaps:
prompt caching and extended thinking are not mapped yet.

New protocols are pluggable: drop an adapter file into `lib/protocols/`,
register it in `index.js`, done — the router core never changes.

## How it compares to claude-code-router

[claude-code-router](https://github.com/musistudio/claude-code-router) is
excellent and does much more: scenario-based auto-routing, in-session `/model`,
a web UI, presets. If you want a smart always-on gateway, use it.

`claude-lanes` is the opposite philosophy:

|                       | claude-code-router            | claude-lanes                     |
| --------------------- | ----------------------------- | -------------------------------- |
| Model selection       | auto-routing + `/model`       | explicit, pinned per process     |
| Runtime               | persistent daemon             | no daemon¹                       |
| Config                | JSON                          | env file, one line per provider  |
| Team mode (leader/teammates on different providers) | — | `c team 1 0` |
| Mental model          | smart gateway                 | dumb, predictable launcher       |

¹ team/protocol modes spawn a per-session router that exits with your session.

## Extras

- **Status line** — `extras/statusline.sh` shows the pinned model, context
  usage, duration and git branch in the Claude Code status line (requires
  `jq`). Wire it up in your `settings.json` as `statusLine`.
- **`CLAUDE_ARGS`** — extra flags appended to every launch, e.g.
  `CLAUDE_ARGS=--dangerously-skip-permissions` if you live dangerously.
- **`c router status`** / **`c router stop`** — inspect or kill local routers.
- Per-lane options: `CONFIG_n_MODEL`, `CONFIG_n_EFFORT` (thinking effort),
  `CONFIG_n_COMPACT_WINDOW` (auto-compact threshold).

## Requirements

- macOS or Linux, Node ≥ 18
- [Claude Code](https://www.anthropic.com/claude-code)
- `tmux` for team mode

## License

MIT
