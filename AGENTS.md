# claude-lanes — Agent 工作说明

## 项目背景

claude-lanes 是 Claude Code 的按窗口 provider 路由器，从 burnkit 仓库的
`tools/claude-provider-router` 拆分而来并移植为零依赖 Node 实现。burnkit
原仓不再演进此工具，本仓是唯一事实源。

定位（README 的叙事基线，改文案时不要偏离）：
- 显式、进程级钉死，反"自动路由"——这是与 claude-code-router 的差异化核心。
- 无常驻 daemon：team / protocol 模式的 router 随会话生灭。
- "笨而可预测"是卖点，不是缺陷；文案中主动认领"它就是环境变量注入"。

## 结构

| 路径 | 说明 |
|------|------|
| `bin/c` | 主入口（bash）：单 provider / team / router 管理 |
| `bin/auth-helper.sh` | Claude Code apiKeyHelper，按模式返回 role token 或真实 token |
| `lib/router.js` | 本地路由代理（Node，零依赖）：team 模式 + protocol 模式 |
| `lib/protocols/` | 协议适配器（openai 已实装）；加新协议不改 router.js |
| `extras/statusline.sh` | 可选状态行（依赖 jq） |
| `launch/` | 发布材料草稿（Show HN、awesome PR），不进 npm 包 |

## 关键约定

- **零运行时依赖**：lib/ 只用 Node 内置模块。引入任何 npm 依赖前必须先说明理由。
- **用户路径**：配置在 `~/.config/claude-lanes/`，状态在
  `~/.local/state/claude-lanes/`，settings 在 `~/.claude/settings-lanes.json`。
  绝不把用户数据放进包目录（npm 升级会清掉）。
- **测试隔离铁律**：所有测试必须通过 `CLAUDE_LANES_CONFIG_DIR` /
  `CLAUDE_LANES_STATE_DIR` / `CLAUDE_LANES_SETTINGS` / `CLAUDE_LANES_CLAUDE_BIN`
  指向临时目录和 stub，绝不触碰真实 `~/.claude`、真实配置或真实 claude 二进制。
- 公开默认必须安全：不得把 `--dangerously-skip-permissions` 写回硬编码默认值，
  它只能通过用户配置的 `CLAUDE_ARGS` 开启。

## 验证

```bash
npm test                 # 35+ 用例：适配器单测 + router 集成 + 启动器端到端
npm pack && npm install -g --prefix "$(mktemp -d)" ./claude-lanes-*.tgz
                         # 验证真实安装路径（symlink 解析、首跑建配置）
```

改动 `lib/` 或 `bin/` 后必须跑 `npm test`；改安装相关逻辑后必须做 pack+install 验证。

## 发布

1. `npm version <patch|minor>`
2. `npm publish`
3. 提交并推送版本变更
