# awesome-claude-code 收录 PR 草案

目标仓库：https://github.com/hesreallyhim/awesome-claude-code

## 操作步骤

1. Fork 后查看该仓库 CONTRIBUTING.md —— 它有自己的提交流程（通常要求用
   issue 表单或脚本生成条目，提 PR 前先核对最新要求）。
2. 条目放在 Tooling / 第三方工具类目（以仓库当前分类名为准）。

## 条目文案（按 awesome 列表惯例：一句话，无营销词）

```markdown
[claude-lanes](https://github.com/hanzhangzzz/claude-lanes) - Per-window provider router: pin each terminal's Claude Code to one provider (`c 0`, `c 1`), run agent-team leader and teammates on different providers (`c team 1 0`), translate to OpenAI-protocol upstreams. No daemon.
```

## PR 标题

```
Add claude-lanes (per-window provider router with team-mode split)
```

## PR 描述

```markdown
## What is it

claude-lanes pins each terminal window's Claude Code process to one provider
at launch time (`c 0` / `c 1` / ...), instead of routing dynamically. It also
supports running an agent team's leader and teammates on different providers
(`c team 1 0`), and translating to OpenAI-protocol upstreams (vLLM etc.) with
full streaming tool-call support.

## Why it's a useful addition

Existing routers in the list focus on dynamic/auto routing. claude-lanes
covers the opposite workflow — multiple parallel terminal sessions where each
window must stay deterministically on its chosen model — and is, as far as I
know, the only tool that splits leader/teammate traffic to different
providers.

- License: MIT
- Install: `npm i -g claude-lanes`
- Tests: 35 cases (unit + integration + e2e), zero runtime deps
```
