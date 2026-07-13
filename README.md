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
- Goal 创建时原子冻结 `Goal Contract`：deadline、token/费用/工具/时间/context/fan-out 预算和能力集合
- 系统全局与 Agent 每日配额、deadline-aware 调度，以及 default/memory/filesystem/network/browser/code/side-effect 资源池
- Capability-based security：父子 Goal 能力单调收窄、文件/域名/账号/数据/凭证范围、到期、撤销和审计
- Secret 只以 credential reference 进入 Goal；受信工具在最终执行边界短暂解析环境凭证，snapshot 和 API 不返回 locator 或 secret
- 浏览器和代码类 Tool 必须绑定已注册 Sandbox adapter；非幂等 Tool 自动进入单槽隔离池和审批门
- 统一外部副作用 operation record：`PREPARED / EXECUTING / UNCERTAIN / RECONCILING / CONFIRMED / COMPENSATED`
- 可查询外部状态的 Tool 支持自动 reconciliation 与 compensation；执行中崩溃的非幂等操作不会盲目重放
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
- Attention Allocator 按 deadline risk、计划漂移、新观察、Goal 冲突、长期阻塞和预期收益/成本决定是否唤醒认知循环
- 每个 Goal 具有持久化 Plan Version 与显式可证伪 Assumption；匹配观察会让旧计划失效并创建受限的认知修复线程
- 修复结果会注入原思考线程的已保存 action state，等待结束后从修订后的认知现场继续，而不是重放已完成工作
- Goal 可声明 shared/exclusive 语义资源；Scheduler 会持久化持有记录并串行化账号、文档或业务对象上的冲突操作
- 长期记忆具有 source、confidence、temporal validity、provenance、supersession 与 contradiction 状态，不再被当成永久真理
- Provider、Tool、Action、Channel、Hook、Sensor 和常驻 Listener 插件边界
- 终端交互、JSON 输出、状态表、任务 watch、日志 follow、事件注入和人工控制
- REST/SSE headless Gateway、认证、限流、health、metrics 和 diagnostics
- 首次启动分步完成模型、密钥、工作区、访问边界、预算、认知与审批配置
- 独立的 Kernel Owl 卡通形象，以及持续刷新的终端 OS 面板
- 对话历史与长期记忆分层管理，支持干净上下文、整段清理与单条遗忘

与 OpenClaw 的能力对照见 [OpenClaw architecture comparison](docs/openclaw-comparison.md)，内核状态机和一致性语义见 [Agent OS architecture](docs/architecture.md)。

## 快速开始

需要 Node.js 22.5 或更新版本。核心运行时没有第三方依赖。

直接进入 Agent OS：

```bash
node src/cli.js
```

第一次运行会进入分步引导，依次设置 Agent 与 workspace、Gateway 访问范围、模型与凭证、资源预算、后台认知和副作用审批策略。确认后会启动脱离终端的长期 Gateway，再进入实时终端桌面。后续可随时重新配置：

```bash
node src/cli.js setup
node src/cli.js model
```

观察和单独提交工作：

```bash
node src/cli.js status
node src/cli.js run "Plan my next product release and ask only for missing constraints"
node src/cli.js chat
```

如果将本项目安装或 link 为 npm package，命令名是 `agent-os`：

```bash
agent-os gateway start
agent-os status
agent-os                                               # 首次引导，之后进入实时终端桌面
agent-os chat                                          # 等价的显式命令
```

未配置模型时系统使用英文 offline provider，但 Goal、Task、会话、记忆、调度、感知和可靠交付链路仍会完整运行。

## 模型与状态目录

[.env.example](.env.example) 是环境变量参考。推荐先运行 `agent-os setup`。如果选择私密文件，模型 key 与 Gateway token 会写入 `security.secretFile`，主配置只保留引用；两个文件都以 `0600` 权限原子写入。也可以选择由 shell、进程管理器或容器注入环境变量：

```bash
AGENT_OS_HOME="$HOME/.agent-os" \
AGENT_MODEL_API_KEY=your-key \
AGENT_MODEL_ID=your-model \
npm start
```

默认状态目录是项目内的 `data/`。`init` 只创建配置基线，不执行产品引导；通常应使用 `setup`：

```bash
AGENT_OS_HOME="$HOME/.agent-os" node src/cli.js setup
```

完整示例见 [config.example.json](config.example.json)。关键配置包括：

- `gateway.bind`：默认 `127.0.0.1`
- `gateway.auth.tokenEnv/tokenRef`：非 loopback 部署必须通过引用解析出 token
- `runtime.maxConcurrency`：可同时运行的思考线程数量
- `runtime.tickMs`：就绪任务、计时器、计划和感知检查周期
- `runtime.leaseMs`：Task 与 Monitor 执行租约
- `kernel.*`：常驻服务 heartbeat、watchdog、I/O 周期和抢占优先级
- `sensing.*`：pulse、Monitor 并发和默认工作区 inbox sensor
- `cognition.*`：空闲认知、自动反思、冷却时间和每日 Goal 预算
- `resources.goalDefaults/globalDaily/agentDaily`：Goal 预算与系统/Agent 配额
- `resources.pools`：不同执行资源的独立并发容量
- `operations.*`：不确定副作用的 reconciliation 周期和次数上限
- `security.tenantId`：当前 Gateway 所有者 tenant；跨 tenant 请求会被拒绝
- `security.capabilities`：根 Goal 可冻结能力的最大上界
- `security.events`：外部事件 HMAC 密钥引用、时间窗和 replay protection
- `security.approvalRisk`：达到该风险级别的工具需要批准
- `security.tools.allow/deny`：全局工具能力策略
- `security.pluginPaths`：唯一允许加载的本地插件路径
- `agents[]`：Agent 身份、workspace 和模型绑定
- `models.*`：OpenAI-compatible endpoint 或插件 Provider
- `memory.captureMode`：当前为 `explicit`，普通对话不会自动升级为长期记忆
- `onboarding.*`：记录是否已经完成首次产品引导

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
agent-os setup                                      # 首次引导或重新配置
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
agent-os attention
agent-os resources
agent-os goals contract <goal-id>
agent-os goals plan <goal-id>
agent-os capabilities show <goal-id>
agent-os capabilities revoke <goal-id> --reason "Scope is no longer needed"
agent-os operations list --state UNCERTAIN
agent-os operations reconcile <operation-id>
agent-os operations compensate <operation-id> --reason "Undo requested"
agent-os logs --follow
agent-os logs --follow --goal <goal-id>
```

长期服务：

```bash
agent-os sessions list
agent-os sessions show <session-id-or-key>
agent-os sessions purge <session-id-or-key> --yes
agent-os memory list
agent-os memory search "release preference"
agent-os memory add "The user prefers Thursday releases" --kind preference --confidence 0.9
agent-os memory add "The release moved to Friday" --supersedes <old-memory-id>
agent-os memory confirm <memory-id> --confidence 0.98
agent-os memory retract <memory-id> --reason "Corrected by the owner"
agent-os memory forget <memory-id> --yes
agent-os memory explain
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
agent-os credentials add mail-primary --env MAIL_PRIMARY_TOKEN
agent-os credentials revoke mail-primary
agent-os events emit ci.completed repo:main:run:42 --source cli \
  --data '{"status":"passed"}' --secret-env AGENT_EVENT_CLI_SECRET
agent-os tools
```

所有读取类命令支持 `--json`，Gateway 远程地址使用 `--gateway <url>`，认证使用 `--token <token>`。

交互终端使用独立设计的 **Kernel Owl** 卡通形象：它会眨眼、观察，并在启动后进入常驻的终端 OS 面板。面板每 750ms 刷新 Kernel 存活状态、RUNNING/READY/WAITING/BLOCKED 思考线程、当前 Goal、长期记忆、Session、注意力判断和隔离资源池；下方保留可滚动交互区。

终端内常用控制：

```text
/                     在光标下方打开命令下拉框并实时过滤
/task <instruction>  并行提交后台 Goal，立即返回输入提示；/bg 是别名
/focus <goal-id>     把后续工作绑定为这个 Goal 的子思考线程
/unfocus             返回全局注意力视角
/inbox               查看等待用户、审批和近期完成项
/channels            查看常驻入站监听器与出站 Channel
/reply [id] <text>   精确恢复一个等待用户输入的线程
/interrupt <text>    创建紧急 Goal 并安全抢占低优先级工作
/model [key]         查看或切换当前 Session 后续 Goal 使用的模型；default 恢复默认
/manager             查看可解释思考线程、运行原因、资源、checkpoint 与 capability
/inspect <task-id>   展开一个线程的等待条件、抢占原因和证据
/trace <goal-id>     回放 Goal DAG、审计因果链和证据集合
/plan <goal-id>      查看 Plan Version、Assumption、失效事件与修复线程
/pause <task-id>     在安全 checkpoint 暂停线程
/resume <task-id>    恢复已暂停线程
/cancel <task-id>    取消线程
/priority <id> <n>   调整调度优先级并写入审计
/budget <id> <k> <v> 在冻结上限内调整 Goal 预算
/revoke <goal-id>    撤销 Goal 的全部 capability
/tasks              查看思考线程
/goals              查看持久目标
/history            查看当前 Session 对话历史
/new                切换到干净上下文，不删除旧数据
/purge              删除当前 Session 历史与已完成 Goal
/memory [query]     查看或搜索显式长期记忆
/forget <memory-id> 永久删除一条长期记忆
/quit               退出终端；后台 Gateway 和任务继续运行
```

输入 `/` 时，输入光标下方会打开独立命令下拉框，实时显示命令语法与用途。继续输入 `/fo`、`/mem` 等前缀会立即过滤；使用 ↑/↓ 移动选择，PageUp/PageDown 翻页，Tab 或 Enter 选择，Esc 关闭。这个下拉框属于输入编辑器，不占用上方 Kernel Owl 状态面板。`/commands` 显示完整目录。

`/model` 会向已配置 Provider 的 `/models` 接口实时发现模型，并打开可搜索的键盘选择器；直接输入字符即可过滤，↑/↓ 移动，PageUp/PageDown 翻页，Enter 选择。菜单前部同时提供 OpenAI、OpenRouter、DeepSeek、Custom 和 Offline 配置入口，选择后只新增一个命名模型配置，保存后自动重启 Gateway 并立即切换，不会重新询问或覆盖其他 OS 设置。`/model status` 查看状态，`/model default` 恢复 Agent 默认模型。模型选择会写入 Session，但每个 Goal 在创建时会冻结 Provider 配置键和实际模型 ID，因此已经 RUNNING 或 WAITING 的思考线程不会在恢复时意外切换模型。

窄终端自动退化为普通交互输出；非 TTY、CI 和 `TERM=dumb` 不播放动画。`--no-animation` 或 `AGENT_OS_NO_ANIMATION=1` 仅关闭开场动画，`--simple-ui` 或 `AGENT_OS_SIMPLE_UI=1` 关闭常驻面板，`--no-color`/`NO_COLOR` 关闭颜色。

## 对话历史与长期记忆

每一句输入都会先写入当前 Session，这是为了让中断、等待和重启后的 Goal 能恢复上下文；它不等于长期记忆。只有 `memory add`、`memory_remember` 或用户明确要求记住时，系统才创建可跨 Session 召回的长期记忆。

- 只是想停止把前面的闲聊带入新任务：使用 `/new`。
- 想删除一整个旧对话：先用 `agent-os sessions list` 找到它，再执行 `sessions purge`；有 ACTIVE Goal 的 Session 会拒绝删除。
- 想删除一条长期偏好或事实：用 `memory list` 找到 ID，再执行 `memory forget`。
- 事实发生变化但要保留历史：新增记忆时用 `--supersedes <id>`；仅需停止召回时用 `memory retract`。
- 删除 Session 不会删除长期记忆；删除长期记忆也不会篡改历史对话，两种数据必须分别处理。

## 一个驾驶舱，多个思考线程

终端只有一个输入区，不代表系统只有一个任务。它更接近人的统一意识与注意力入口：人只有一个当前表达出口，但大脑里可以同时保留多个正在执行、等待、休眠和被打断的工作线程。

```text
Terminal / channels / monitors
              │
              ▼
       Attention Inbox
       ├── needs user input
       ├── needs approval
       ├── external event arrived
       └── work completed
              │
              ▼
      Focus & Input Router
       ├── resume exact wait
       ├── create child goal
       ├── create parallel goal
       └── raise urgent interrupt
              │
              ▼
       Persistent Goal/Task DAGs
```

输入路由遵循确定性优先原则：

1. 已 focus 的 Goal 正在等待用户时，普通输入直接恢复它。
2. 当前 Session 只有一个明确的 `user.reply` 等待项时，普通输入自动成为它的回复。
3. 存在多个候选等待线程时，系统不会用模型冒险猜测，而是要求通过 `/inbox` 和 `/reply <id>` 选择。
4. 没有等待项时，普通输入创建新的前台 Goal；`/task` 强制创建并行后台 Goal。
5. `/focus` 下的新工作会成为原 Goal 的子 Goal，继承并进一步收窄预算、deadline 和 capabilities。
6. `/interrupt` 创建高优先级 Goal，原线程在安全 checkpoint 被抢占并稍后恢复。

CPU 负责状态机、队列、匹配、唤醒和抢占；LLM 只在需要理解目标、选择路径或处理语义歧义的认知步骤中调用。终端可以关闭，也可以同时从多个终端、消息渠道、Monitor 或外部事件入口投递工作；Goal 生命周期始终属于常驻 Kernel。

## 实时通道等待

`WAITING` 不只是数据库状态。支持入站的 Channel 可以提供一个常驻 `listen()` adapter，例如 IMAP IDLE、Slack Socket Mode、WebSocket、Redis Streams、NATS 或设备消息连接。插件加载后，这个监听器会被 Kernel Supervisor 当作独立常驻服务启动、heartbeat、故障重启和关闭。

Agent 调用 `wait_for_channel` 时指定 `channel + accountId + threadKey`：

```text
Task A calls wait_for_channel
  → checkpoint model/tool state
  → subscribe channel.message correlation key
  → enter WAITING and release worker

Scheduler runs Task B / Task C / Task D

Resident channel listener receives a message
  → authenticate and normalize
  → write channel_messages record
  → deduplicate external message id
  → publish durable channel.message event
  → wake the exact Task A
  → resume the original tool call
  → LLM evaluates the received information and decides the next action
```

入站消息和 Event 之间采用可恢复交付：消息先进入 `channel_messages`，状态为 `PENDING`；发布 durable event 后改为 `DELIVERED`。如果进程在两次提交之间崩溃，I/O Reactor 会重放仍为 PENDING 的消息；event idempotency key 防止重复唤醒。事件早于 Task 订阅到达也不会丢失。

内置 `webhook` Channel 可通过 Gateway 接收已认证消息：

```bash
curl -X POST http://127.0.0.1:3030/api/channels/webhook/messages \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_GATEWAY_TOKEN" \
  -d '{
    "messageId":"supplier-message-42",
    "accountId":"supplier-mail",
    "threadKey":"purchase-42",
    "sender":"supplier@example.com",
    "text":"Confirmed for Friday",
    "payload":{"confirmationId":"confirm-42"}
  }'
```

生产 Channel 插件调用 `registerChannel(id, { listen, send })`。`listen({ signal, heartbeat, ingest })` 持续保持外部连接，并在收到消息时调用 `ingest(...)`；Adapter 不直接操作 Task，也不需要持有模型 Context。

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

空闲认知进程一直存在，但默认 `autoReflect=false`，不会静默产生模型费用。它不再仅按定时器反思：Attention Allocator 会先计算 deadline 风险、失败/抢占造成的偏移、新 observation、共享账号或显式 conflict key、长期阻塞，以及预计反思价值与模型成本。只有得分和值得性达到阈值时，才会唤醒一个有独立预算和只读能力的反思 Goal；critical signal 还可以通过 durable interrupt 请求抢占低优先级工作。

## Goal Contract 与安全边界

提交时可以收窄默认预算和能力：

```bash
agent-os run "Prepare the release evidence" \
  --deadline 2026-07-11T09:00:00Z \
  --budget '{"maxInputTokens":12000,"maxOutputTokens":2000,"maxCostUsd":0.25,"maxToolCalls":8,"maxWallTimeMs":300000,"maxContextChars":30000,"maxFanOut":1,"maxDepth":1}' \
  --capabilities '{"tools":["memory_search","workspace_list","workspace_read"],"resourcePools":["default","memory","filesystem"],"filesystem":{"roots":["release"],"operations":["list","read"]},"network":{"domains":[],"methods":[]},"accounts":{},"dataScopes":["agent:self"],"credentialRefs":[]}'
```

Contract 与 Goal/Task 在同一个 SQLite transaction 中创建。子 Goal 只能继承父 Contract 的子集，并且 deadline、能力到期时间、预算、fan-out 和深度都不能扩张。Gateway 固定绑定一个 `security.tenantId`；不同 tenant 的强隔离部署方式是分别运行 Kernel、数据库、配置和 workspace。单个 Kernel 内的多个 Agent 通过不同 workspace、Goal ownership、Session/Memory/Event tenant scope 和 capability contract 做逻辑隔离。

工具还可以把业务参数映射到通用 `constraints`。例如邮件能力可以同时冻结 `accounts.email=["primary"]`、`credentialRefs=["mail-primary"]`、`constraints.email.recipients=["*@example.com"]`、`messageTypes=["transactional"]`、`maxRecipientsPerCall=2` 和 `maxBodyChars=10000`。子 Goal 只能进一步缩小名单或数值上限；deadline 与费用/工具调用预算仍由同一 Contract 约束。因此授权表达的是“哪个 Goal 在什么期限和预算内，用哪个账号给哪些对象执行哪类动作”，而不只是“是否能调用邮件工具”。

外部事件入口默认要求 HMAC。`security.events.sourceSecrets` 保存的是 `env:VARIABLE` 引用，例如 `{"cli":"env:AGENT_EVENT_CLI_SECRET"}`。签名覆盖 timestamp、nonce、topic、correlation key、tenant、agent 和 canonical payload；nonce 在数据库中唯一，过期 timestamp 或 replay 会被拒绝。

Resource Pool 在当前单机版本中是进程内的可中断 semaphore，不是容器。`browser` 和 `code` Tool 若没有已注册 sandbox adapter 会在注册阶段被拒绝；adapter 本身是受信插件边界，生产部署应让它调用容器、VM、受限 Worker 或远程执行服务。

## 副作用协议

有外部副作用的 Tool 声明 `sideEffect.mode`，Runtime 为每个 idempotency key 创建 operation record。可恢复流程为 `prepare → execute → confirm`；请求超时或进程在 `EXECUTING` 中退出时进入 `UNCERTAIN`，后台 I/O Reactor 调用 Tool 的 `reconcile` 查询外部事实。确认成功后保存外部结果；确认不存在时才允许再次执行；支持撤销的 Tool 可由 CLI/API 执行 compensation。

`messages + outbox` 已在一个本地 transaction 中提交。本地写入类 Tool 使用稳定对象 ID 实现 crash-safe replay。对于既不幂等、又无法查询、也无法撤销的旧系统，Runtime 强制审批和单槽隔离，并在结果不确定时停止自动化，等待人工 reconcile；系统不会虚构 exactly-once。

## 异步恢复状态

普通工具返回 JSON。需要等待的工具返回 `ActionControl.wait(...)`。Runtime 会持久化：

- workflow `pc`、step graph 和 variables
- 模型 messages、未完成 tool call 与 tool-local state
- event topic、correlation key、deadline 和 pending event
- checkpoints、必要证据、结果、错误和审计轨迹
- task lease、revision、pause/cancel intent 和重试状态

收到匹配事件后，原 tool call 从保存的 step 继续，而不是重新执行完整对话。系统不声称冻结模型不可见的内部思维链；恢复所依赖的是可序列化、可审计的外部推理状态。

## 内置工具

- `memory_search`、`memory_remember`、`memory_confirm`、`memory_forget`
- `plan_assume`
- `workspace_list`、`workspace_read`、`workspace_write`、`workspace_delete`
- `http_fetch`
- `request_user_input`
- `wait_for_event`
- `wait_for_channel`
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

- `GET /api/health`、`GET /api/diagnostics`、`GET /api/metrics`、`GET /api/dashboard`
- `GET /api/inbox`、`POST /api/inbox/reply`
- `GET /api/channels/messages`、`POST /api/channels/:id/messages`
- `GET /api/kernel`、`GET /api/kernel/processes`
- `GET /api/resources`、`GET /api/attention`
- `GET /api/operations`、`GET /api/operations/:id`
- `POST /api/operations/:id/reconcile|compensate`
- `GET /api/goals/:id/contract|plan|trace`、`POST /api/goals/:id/capabilities/revoke`
- `GET/POST /api/credentials`、`POST /api/credentials/:id/revoke`
- `GET/POST /api/interrupts`
- `GET /api/cognition`、`POST /api/cognition/enable|disable|reflect`
- `GET/POST /api/goals`、`GET /api/goals/:id`
- `GET /api/tasks`、`GET /api/tasks/:id`、`POST /api/tasks/:id/pause|resume|cancel`
- `GET /api/sessions`、`GET /api/sessions/:id`、`POST /api/sessions/:id/purge`
- `GET/POST /api/memories`、`POST /api/memories/:id/forget|confirm|status`
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

测试覆盖：跨目标并发、外部等待/恢复、早到事件、重启恢复、事件幂等、Session DAG、可挂起模型工具、高风险审批、时态与矛盾记忆、计划版本与观察驱动修复、语义资源互斥、计划任务、任务控制、子目标并行汇合，以及系统空闲时 pulse 与 sensor 唤起新目标。
