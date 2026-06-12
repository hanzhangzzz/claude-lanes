# Show HN 草案

## 标题（按推荐顺序，二选一后微调）

1. `Show HN: Claude Lanes – run six Claude Code terminals, each pinned to a different model`
2. `Show HN: I don't trust LLM auto-routing, so each of my terminal windows is pinned to one model`

标题规则：不出现 "revolutionary/best/powerful"，HN 只认具体画面。

## 正文

I run five or six Claude Code sessions in parallel, one terminal window per
task. The existing routers (claude-code-router is the big one, 35k stars,
genuinely good) are built around auto-routing: the proxy picks a model based
on token count or task type, and you can switch mid-session with /model.

That's exactly what I don't want. When I park a long refactor in window 3 on
a specific model, I need it to still be that model two hours later. I don't
trust a router to silently decide my heavy task now runs on a cheaper model.

So claude-lanes does the dumbest thing that works: `c 2` injects that
provider's ANTHROPIC_BASE_URL and token into the environment and execs
claude. The process is pinned at birth. No daemon, no JSON, no magic. Yes,
it's "just env vars" — that's the feature.

Two things turned out to need more than env vars:

- Team mode: Claude Code agent teams spawn teammate processes. `c team 1 0`
  starts a throwaway local router (dies with your session) that tells leader
  and teammate requests apart by auth token — so the leader runs on an
  expensive model while every teammate runs on a cheap one.

- OpenAI-protocol upstreams (vLLM etc.): a local proxy translates
  Anthropic ⇄ OpenAI including streaming tool calls — a real stream state
  machine, not field renaming. Prompt caching / extended thinking aren't
  mapped yet.

Zero runtime dependencies (Node built-ins only), macOS/Linux,
`npm i -g claude-lanes`.

GitHub: https://github.com/hanzhangzzz/claude-lanes

## 发帖注意

- 周二至周四，美西早上 8–10 点（北京时间 23:00–01:00）提交。
- 提交后第一时间在评论区补一条"我为什么做这个"的 founder comment，
  把 demo GIF 链接放进去（HN 正文不渲染图片）。
- 预答热门质疑（提前写好，别临场）：
  - "这不就是个 env var wrapper？" → 是，单 provider 模式就是，这是卖点；
    team 模式和协议翻译不是。
  - "为什么不用 claude-code-router？" → 它更强大，哲学相反；深度并行
    工作流要确定性不要智能。
  - "为什么 bash + node 混合？" → launcher 要 exec 语义（进程替换），
    bash 最自然；router 要并发流转发，Node 内置即够。
