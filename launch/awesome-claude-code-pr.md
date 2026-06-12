# awesome-claude-code 收录提交（Web 表单版）

⚠️ 该仓库规则（2026-06 现行）：**禁止 PR、禁止 gh CLI 提交、必须由人类通过
Web 表单提交**，绕过会被临时或永久封禁。流程：表单 → bot 自动校验 →
维护者审核 → bot 自动建 PR 合入。

## 提交入口（人工打开，2 分钟填完）

https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml

## 各字段内容（直接粘贴）

**Display Name**
```
claude-lanes
```

**Category**：`Tooling`
**Sub-Category**：`Tooling: Config Managers`

**Primary Link**
```
https://github.com/hanzhangzzz/claude-lanes
```

**Author Name**
```
hanzhangzzz
```

**Author Link**
```
https://github.com/hanzhangzzz
```

**License**：`MIT`

**Description**（1–3 句、无 emoji、描述性非推销性）
```
Per-window provider router that pins each terminal's Claude Code process to one provider at launch (`c 0`, `c 1`), instead of routing dynamically. Supports running an agent team's leader and teammates on different providers (`c team 1 0`), and translating to OpenAI-protocol upstreams with streaming tool-call support. No persistent daemon; per-session routers exit with the session.
```

**Validate Claims**（低摩擦验证路径）
```
npm i -g claude-lanes (zero runtime dependencies, Node >= 18). Run `c 0` once to generate ~/.config/claude-lanes/config.env, fill in any Anthropic-compatible provider (base URL + token), then run `c 0` again. The launch banner prints the pinned API/model, and `claude` starts against that provider. Networking: requests go only to the providers you configure; team/protocol modes start a localhost-only proxy (127.0.0.1) that exits with the session. No telemetry, no bypass-permissions (the tool passes no permission flags unless the user opts in via CLAUDE_ARGS in their own config).
```

**Specific Task(s)**
```
1. Pin two terminal windows to two different providers and confirm each window stays on its provider for the whole session.
2. Run an agent team where the leader and the teammates use different providers, and verify the split in the router log.
```

**Specific Prompt(s)**
```
Window A: run `c 0`, then ask Claude Code: "which model are you? answer in one line" — the status banner above and the reply reflect provider 0.
Window B: run `c 1` with a different provider and repeat — the two windows answer from different models simultaneously.
Team split: configure two lanes, run `c team 1 0 -p "say hi"`, then check the router log at ~/.local/state/claude-lanes/routers/<port>.log — it shows LEADER requests routed to lane 1's host and TEAMMATE requests to lane 0's host.
```

**Additional Comments**（可选）
```
Demo GIF recorded against live providers: https://raw.githubusercontent.com/hanzhangzzz/claude-lanes/main/assets/demo.gif — shows the lanes list, a pinned real session, the OpenAI-protocol translation lane, and team mode with router lifecycle (ready -> stopped).
```

## 注意

- 表单要求提交者是人类；用你自己的 GitHub 账号提交。
- bot 校验失败会在 issue 下评论让你改格式，正常修改即可，不算违规。
