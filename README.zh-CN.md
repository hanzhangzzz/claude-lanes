# claude-lanes

**Claude Code 的按窗口 provider 路由器。每个终端窗口钉死一个模型。**

```bash
npm i -g claude-lanes
```

```
iTerm 窗口 1   $ c 0          → 这个窗口的 Claude Code 永远跑 GLM-5
iTerm 窗口 2   $ c 1          → 官方 Anthropic API
iTerm 窗口 3   $ c 2          → vLLM 自部署（OpenAI 协议自动翻译）
iTerm 窗口 4   $ c team 1 0   → leader 用 Opus，所有 teammate 用 GLM-5
```

每个终端窗口是一条**车道（lane）**，每条车道在进程整个生命周期内只跑一个
provider。没有常驻 daemon、没有 JSON 配置、没有会半路偷换模型的自动路由。

## 为什么

如果你习惯并行开多个 Claude Code 窗口、一个窗口干一件事，你要的是**精确控制**：
这个窗口就用这个模型，不许变。会话内 `/model` 切换和按 token 数自动路由对轻度
用户很友好，但对深度用户恰恰是干扰——你没法把任务托付给一个你没选的模型。

`claude-lanes` 故意做得很笨：`c 2` 把 provider 的 `ANTHROPIC_BASE_URL` 和 token
注入环境变量然后 `exec claude`。全部魔法就这一下——这正是它的卖点：进程出生时
就被钉死，之后没有任何东西能改它的路由。

## 快速开始

```bash
npm i -g claude-lanes
c 0          # 首次运行生成 ~/.config/claude-lanes/config.env
vim ~/.config/claude-lanes/config.env   # 填入你的 provider
c 0          # 这个窗口从此跑 provider 0
```

配置一行一个字段，一个编号一个 provider：

```bash
CONFIG_0_BASE_URL=https://open.bigmodel.cn/api/anthropic
CONFIG_0_AUTH_TOKEN=sk-...
CONFIG_0_MODEL=glm-5

CONFIG_1_BASE_URL=https://api.anthropic.com
CONFIG_1_AUTH_TOKEN=sk-ant-...
```

凡是说 Anthropic 协议的都能接：GLM、Kimi、MiniMax、DeepSeek、官方 API、自建网关。

## Team 模式 — 一个会话，两个 provider

Claude Code 的 agent team 会 spawn 独立的 teammate 进程。`claude-lanes` 能把
leader 和 teammate 路由到**不同 provider**：

```bash
c team 1 0     # leader → provider 1（如 Opus），teammates → provider 0（如 GLM-5）
```

一个一次性本地 router 在空闲端口拉起，靠 auth token 区分 leader / teammate
请求，会话结束自动退出。开五个 `c team` 窗口就有五个互不干扰的 router。
这是"贵 leader + 便宜 teammate 编队"的最低成本玩法。

Team 模式需要 `tmux`（teammate 以独立进程跑在 `--teammate-mode tmux` 下）。

## OpenAI 协议的 provider

对只会说 OpenAI Chat Completions 的上游（vLLM、各类 OpenAI 兼容网关）：

```bash
CONFIG_2_BASE_URL=https://your-vllm-box.example.com/v1
CONFIG_2_AUTH_TOKEN=sk-...
CONFIG_2_PROTOCOL=openai
CONFIG_2_MODEL=qwen3-coder
```

`c 2` 会启动（或复用）一个本地协议翻译代理，做 Anthropic ⇄ OpenAI 的**完整双向
转换，含流式和工具调用**——真正的流式状态机（文本增量、tool_call 分片累积、
`finish_reason` → `stop_reason` 映射），不是简单的字段改名。已知空缺：prompt
caching 和 extended thinking 暂未映射。

新协议可插拔：在 `lib/protocols/` 放一个 adapter 文件、在 `index.js` 注册一行，
router 主体零改动。

## 与 claude-code-router 的关系

[claude-code-router](https://github.com/musistudio/claude-code-router) 非常优秀
且功能更多：场景自动路由、会话内 `/model`、Web UI、preset 分享。想要智能常驻
网关，用它。

`claude-lanes` 是相反的哲学：

|                | claude-code-router       | claude-lanes               |
| -------------- | ------------------------ | -------------------------- |
| 模型选择       | 自动路由 + `/model`      | 显式指定，进程级钉死       |
| 运行时         | 常驻 daemon              | 无 daemon¹                 |
| 配置           | JSON                     | env 文件，一行一个 provider |
| Team 模式（leader/teammate 分流） | —     | `c team 1 0`               |
| 心智模型       | 聪明的网关               | 笨而可预测的启动器         |

¹ team / protocol 模式会拉起随会话生灭的一次性 router。

## 附加件

- **状态行** — `extras/statusline.sh` 在 Claude Code 状态行显示钉死的模型、
  上下文用量、耗时和 git 分支（需要 `jq`），在 `settings.json` 的 `statusLine`
  里接上即可。
- **`CLAUDE_ARGS`** — 追加到每次启动的额外参数，例如
  `CLAUDE_ARGS=--dangerously-skip-permissions`（后果自负）。
- **`c router status` / `c router stop`** — 查看或停掉本地 router。
- 每条 lane 可配：`CONFIG_n_MODEL`、`CONFIG_n_EFFORT`（思考深度）、
  `CONFIG_n_COMPACT_WINDOW`（auto-compact 阈值）。

## 环境要求

- macOS 或 Linux，Node ≥ 18
- [Claude Code](https://www.anthropic.com/claude-code)
- Team 模式需要 `tmux`

## License

MIT
