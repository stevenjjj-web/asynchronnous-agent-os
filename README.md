# Agent OS

一个以异步内核为第一原则、通过终端使用的个人 Agent 系统。它吸收成熟 Agent Gateway 的 CLI、会话、模型、工具、记忆、审批、自动化、插件和渠道边界，但把跨时间存在的 Goal/Task DAG、可挂起的思考线程和持续感知作为系统内核。

在 Agent OS 中，会话不是进程：终端退出、模型请求结束、用户暂时不回复、外部系统等待数天或 Gateway 重启，都不会让目标消失。

当前版本是纯 headless 架构，没有前端控制台。Kernel Daemon 是一个真正持续存活的 Node.js 宿主进程：它在没有任务时仍监督 Scheduler、I/O Reactor、Interrupt Reactor、Cognition Loop 和外部 Listener。SQLite 持久化用于崩溃恢复，不再被当作常驻进程的替代品。

## 核心能力

- 每条 Agent 消息立即持久化为 Goal 和 Task DAG
- `CREATED / READY / RUNNING / WAITING / BLOCKED / PAUSED / SUCCEEDED / FAILED / CANCELLED`
- 每个 Task 都是独立思考线程，拥有 workflow、`pc`、variables、tool state、event subscription 和 checkpoints
- 常驻 Kernel Daemon、宿主 PID、generation、子服务 heartbeat、故障记录和 singleton lease
- `gateway start` 可脱离终端后台运行；`gateway run` 用于前台调试
- 模型 tool call 可返回 suspend signal，保存可公开的外部推理状态并释放 Worker
- 全局 Ready Queue、任务依赖、优先级、有界并发、公平时间片、Worker lease 和过期恢复
- Durable Interrupt、长模型调用 AbortSignal、安全抢占和紧急任务完成后的原线程恢复
- 每个 Goal 冻结自己的 transcript 边界，避免同 Session 后续指令污染旧思考线程
- 事件先进入持久 inbox；早到、晚到和重复事件都有确定语义
- SQLite WAL、revision、幂等键、重试、可靠 Outbox 和 append-only audit ledger
- Session、Message provenance、多 Agent workspace 和跨会话长期记忆
- SQLite FTS5 记忆检索，并同步写入 `workspace/memory/YYYY-MM-DD.md`
- 高风险工具自动进入 durable approval gate
- 一次性/固定间隔计划任务，到期创建新的持久目标
- 系统空闲时仍写入 pulse，并持续运行持久 Monitor
- 工作区 inbox 同时使用操作系统实时文件事件和持久轮询兜底
- 可配置的空闲认知循环；默认只观察，显式开启后按 cooldown 和 daily budget 创建反思 Goal
- Provider、Tool、Action、Channel、Hook、Sensor 和常驻 Listener 插件边界
- 终端交互、JSON 输出、状态表、任务 watch、日志 follow、事件注入和人工控制
- REST/SSE headless Gateway、认证、限流、health、metrics 和 diagnostics

与 OpenClaw 的能力对照见 [OpenClaw architecture comparison](docs/openclaw-comparison.md)，内核状态机和一致性语义见 [Agent OS architecture](docs/architecture.md)。

## 快速开始

需要 Node.js 22.5 或更新版本。核心运行时没有第三方依赖。

启动脱离终端的长期 Gateway：

```bash
node src/cli.js gateway start
```

观察和使用：

```bash
node src/cli.js status
node src/cli.js run "Plan my next product release and ask only for missing constraints"
node src/cli.js chat
```

如果将本项目安装或 link 为 npm package，命令名是 `agent-os`：

```bash
agent-os gateway start
agent-os status
agent-os chat
```

未配置模型时系统使用英文 offline provider，但 Goal、Task、会话、记忆、调度、感知和可靠交付链路仍会完整运行。

## 模型与状态目录

[.env.example](.env.example) 是环境变量参考。变量需要由 shell、进程管理器或容器注入：

```bash
AGENT_OS_HOME="$HOME/.agent-os" \
AGENT_MODEL_API_KEY=your-key \
AGENT_MODEL_ID=your-model \
npm start
```

默认状态目录是项目内的 `data/`。首次初始化显式配置：

```bash
AGENT_OS_HOME="$HOME/.agent-os" node src/cli.js init
AGENT_OS_HOME="$HOME/.agent-os" node src/cli.js gateway start
```

完整示例见 [config.example.json](config.example.json)。关键配置包括：

- `gateway.bind`：默认 `127.0.0.1`
- `gateway.auth.token`：非 loopback 部署必须配置
- `runtime.maxConcurrency`：可同时运行的思考线程数量
- `runtime.tickMs`：就绪任务、计时器、计划和感知检查周期
- `runtime.leaseMs`：Task 与 Monitor 执行租约
- `kernel.*`：常驻服务 heartbeat、watchdog、I/O 周期和抢占优先级
- `sensing.*`：pulse、Monitor 并发和默认工作区 inbox sensor
- `cognition.*`：空闲认知、自动反思、冷却时间和每日 Goal 预算
- `security.approvalRisk`：达到该风险级别的工具需要批准
- `security.tools.allow/deny`：全局工具能力策略
- `security.pluginPaths`：唯一允许加载的本地插件路径
- `agents[]`：Agent 身份、workspace 和模型绑定
- `models.*`：OpenAI-compatible endpoint 或插件 Provider

## CLI

查看完整命令树：

```bash
node src/cli.js --help
```

核心交互：

```bash
agent-os gateway run                              # 前台运行
agent-os gateway start|stop|restart|status        # 后台进程控制
agent-os kernel status
agent-os kernel processes
agent-os gateway status
agent-os doctor
agent-os run "Research this topic"              # 跟随执行，遇到用户输入或审批时在 TTY 中询问
agent-os run "Research this topic" --detach     # 只提交，不等待
agent-os run "Handle this now" --priority 100 --interrupt
agent-os chat                                    # 交互式长期 Session
```

观察思考线程和执行账本：

```bash
agent-os goals list
agent-os goals show <goal-id>
agent-os tasks list --status WAITING
agent-os tasks show <task-id>
agent-os tasks watch <task-id>
agent-os tasks pause|resume|cancel <task-id>
agent-os interrupts list
agent-os interrupts raise "Urgent operator instruction" --priority 100 --target <task-id>
agent-os cognition status
agent-os cognition enable --auto
agent-os cognition reflect
agent-os logs --follow
agent-os logs --follow --goal <goal-id>
```

长期服务：

```bash
agent-os sessions list
agent-os sessions show <session-id-or-key>
agent-os memory list
agent-os memory search "release preference"
agent-os memory add "The user prefers Thursday releases" --kind preference
agent-os approvals list
agent-os approvals approve|deny <approval-id>
agent-os schedules list
agent-os schedules add --name review --objective "Review the weekly plan" --at 2026-07-11T09:00:00Z
agent-os monitors list
agent-os monitors show <monitor-id>
agent-os monitors add inbox --name requests --path inbox --interval 5 --auto-goal
agent-os monitors add https --name status-page --url https://example.com/status.txt --interval 60 --auto-goal
agent-os monitors run|enable|disable <monitor-id>
agent-os events list
agent-os events emit ci.completed repo:main:run:42 --data '{"status":"passed"}' --key github-run-42
agent-os tools
```

所有读取类命令支持 `--json`，Gateway 远程地址使用 `--gateway <url>`，认证使用 `--token <token>`。

## 空闲感知

每个 Agent 默认创建一个 `workspace_inbox` Monitor，并启动一个受监督的文件系统 Listener。Gateway 即使没有 Goal，也会持续：

1. 写入 `runtime.pulse`，记录 liveness、线程、等待和注意力状态。
2. 监听操作系统文件通知并即时唤醒 Monitor，同时按 interval 轮询防止通知丢失。
3. 比较本次 observation 与上一次持久状态。
4. 变化时写入 `monitor.changed` durable event。
5. `autoGoal` 开启时创建一个新的内部 Session Goal，让 Agent 对变化作出判断。

例如把文件放入：

```bash
cp request.txt data/workspace/inbox/
agent-os events list --topic monitor.changed
agent-os goals list
```

Monitor 有独立 revision、lease、failure backoff、last state 和 observation ledger；Gateway 重启不会丢失其感知进度。插件可增加邮件轮询 Sensor，也可增加 IMAP IDLE、WebSocket、GitHub stream、消息队列或设备连接等真正常驻的 Listener。

空闲认知进程一直存在，但默认 `autoReflect=false`，不会静默产生模型费用。显式执行 `agent-os cognition enable --auto` 后，它只会在没有 READY/RUNNING 工作、达到 idle delay、超过 cooldown、模型可用且未用完 daily budget 时创建一个有边界的反思 Goal。

## 异步恢复状态

普通工具返回 JSON。需要等待的工具返回 `ActionControl.wait(...)`。Runtime 会持久化：

- workflow `pc`、step graph 和 variables
- 模型 messages、未完成 tool call 与 tool-local state
- event topic、correlation key、deadline 和 pending event
- checkpoints、必要证据、结果、错误和审计轨迹
- task lease、revision、pause/cancel intent 和重试状态

收到匹配事件后，原 tool call 从保存的 step 继续，而不是重新执行完整对话。系统不声称冻结模型不可见的内部思维链；恢复所依赖的是可序列化、可审计的外部推理状态。

## 内置工具

- `memory_search`、`memory_remember`、`memory_forget`
- `workspace_list`、`workspace_read`、`workspace_write`、`workspace_delete`
- `http_fetch`
- `request_user_input`
- `wait_for_event`
- `sleep`
- `spawn_goals`
- `schedule_goal`
- `goal_status`
- `create_monitor`
- `monitor_status`
- `kernel_status`

## Headless API

CLI 通过本地 Gateway API 工作。提交消息立即返回 accepted，不等待模型或工具结束：

```bash
curl -X POST http://127.0.0.1:3030/api/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "messageId":"terminal-001",
    "agentId":"main",
    "channel":"terminal",
    "peerKey":"owner",
    "text":"Prepare a release plan and ask for missing constraints"
  }'
```

主要端点：

- `GET /api/health`、`GET /api/diagnostics`、`GET /api/metrics`
- `GET /api/kernel`、`GET /api/kernel/processes`
- `GET/POST /api/interrupts`
- `GET /api/cognition`、`POST /api/cognition/enable|disable|reflect`
- `GET/POST /api/goals`、`GET /api/goals/:id`
- `GET /api/tasks`、`GET /api/tasks/:id`、`POST /api/tasks/:id/pause|resume|cancel`
- `GET /api/sessions`、`GET /api/sessions/:id`
- `GET/POST /api/memories`
- `GET /api/approvals`、`POST /api/approvals/:id/resolve`
- `GET/POST /api/schedules`
- `GET/POST /api/monitors`、`GET /api/monitors/:id`
- `POST /api/monitors/:id/run|enable|disable`
- `GET/POST /api/events`
- `GET /api/audit`、`GET /api/outbox`、`GET /api/stream`

## 插件

插件只能从 `security.pluginPaths` 显式加载，可注册 Tool、Action、Channel、Hook、Sensor 和受监督的常驻 Listener。示例见 [time-plugin.js](examples/plugins/time-plugin.js)。

```js
export default {
  id: 'my-plugin',
  register(api) {
    api.registerTool({ /* schema + risk + execute */ });
    api.registerSensor('mailbox', { async poll(context) { /* observation */ } });
    api.registerListener('mail-idle', { async run({ signal, publish, heartbeat }) { /* push loop */ } });
    api.on('before_tool_call', async (event) => event);
  },
};
```

## 验证

```bash
npm run check
npm run doctor
```

测试覆盖：跨目标并发、外部等待/恢复、早到事件、重启恢复、事件幂等、Session DAG、可挂起模型工具、高风险审批、长期记忆、计划任务、任务控制、子目标并行汇合，以及系统空闲时 pulse 与 sensor 唤起新目标。
