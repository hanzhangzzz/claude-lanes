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

## 发布门禁（铁律：TDD 式发布验证）

任何 `npm publish` 之前，必须按顺序通过以下门禁，**任何一关失败都不得发布**；
先写好验证步骤再动手发布，验证不是发布后的补救：

1. **测试全绿**：`npm test` 全部通过。
2. **安装验证**：`npm pack` → 装入隔离 prefix（`npm install -g --prefix "$(mktemp -d)"`）
   → 运行装出来的 `c`，确认 symlink 解析、首跑建配置模板、帮助输出正常。
3. **真实使用验证**：用真实 provider 配置跑通至少：
   - `c <n> -p "..."` 单 provider 非交互问答（Anthropic 直传协议）；
   - 配置中存在 `PROTOCOL=openai` 的 lane 时，同样跑通该 lane（协议翻译链路）；
   - `c team <a> <b> -p "..."`（team router 起、leader 路由、退出后 router 自动清理）。
4. **发布后回验**：`npm publish` 后从 registry 真实安装一次
   （`npm install -g claude-lanes@<version>` 到隔离 prefix）并重复第 3 关的最小用例。

验证结果（命令 + 输出摘要）必须出现在发布说明或交付汇报里；无法完成第 3 关时
标记为未验证，不得对外宣布可用。

## 发布

1. 通过上面的发布门禁
2. `npm version <patch|minor>`
3. `npm publish`
4. 提交并推送版本变更，创建 GitHub Release
