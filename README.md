# Agent OS

An asynchronous-kernel-first, terminal-native personal agent system. It adopts mature Agent Gateway concepts for CLI, sessions, models, tools, memory, approvals, automation, plugins, and channel boundaries, while placing cross-time Goal/Task DAGs, suspendable thinking threads, and persistent perception at the core of the runtime.

In Agent OS, a session is not a process. Terminal exits, model requests ending, temporary user silence, external systems waiting days, or Gateway restarts do not erase the goal.

The current version is fully headless with no web console. The Kernel Daemon is a continuously alive Node.js host process: even when idle it keeps supervising Scheduler, I/O Reactor, Interrupt Reactor, Cognition Loop, and external Listeners. SQLite persistence provides crash recovery and is not used as a replacement for long-running processes.

## Core capabilities

- Every Agent message is immediately persisted as a Goal and Task DAG
- `CREATED / READY / RUNNING / WAITING / BLOCKED / PAUSED / SUCCEEDED / FAILED / CANCELLED`
- Each Task is an independent thinking thread, owning workflow, `pc`, variables, tool state, event subscriptions, and checkpoints
- Persistent kernel daemon, host PID, generation, sub-service heartbeat, failure record, and singleton lease
- `gateway start` runs in background detached from terminal; `gateway run` is for foreground debugging
- Model tool calls can emit suspend signals, persist public external-reasoning state, and release workers
- Global Ready Queue, task dependencies, priority, bounded concurrency, fair time slicing, Worker lease, and recovery on expiry
- Atomic freeze of `Goal Contract` at creation: deadline, token/cost/tool/time/context/fan-out budgets, and capability sets
- Global and per-Agent daily quotas, deadline-aware scheduling, and default/memory/filesystem/network/browser/code/side-effect resource pools
- Capability-based security: parent/child Goal capabilities shrink monotonically, scoped file/domain/account/data/credential permissions, expiry, revocation, and audit trail
- Secrets enter Goals only as credential references; trusted tools briefly resolve environment credentials at execution boundary, and snapshots/APIs never return locator or secret values
- Browser and code tools must be bound to a trusted Sandbox adapter with declared process/container/microVM isolation; the kernel does not treat normal in-process wrappers as a sandbox
- Unified external-side-effect operation records: `PREPARED / EXECUTING / UNCERTAIN / RECONCILING / CONFIRMED / COMPENSATED`
- Tools that can query external state support automatic reconciliation and compensation; non-idempotent work in failure does not get blind replays
- Durable Interrupt, long-running-model call AbortSignal, safe preemption, and restoration of interrupted thread after urgent completion
- Each Goal freezes its own transcript boundary to prevent later session instructions from contaminating existing thought threads
- Events land in a durable inbox first; early, late, and duplicate events have deterministic semantics
- SQLite WAL, private file permissions, schema migration ledger, startup integrity checks, revision, idempotency keys, retries, reliable outbox, and append-only audit ledger
- Session, message provenance, multi-agent workspace, and cross-session long-term memory
- SQLite FTS5 memory retrieval, and synchronized writes to `workspace/memory/YYYY-MM-DD.md`
- High-risk tools automatically enter durable approval gates
- One-off and periodic schedules create new persistent goals on expiry
- The system continues writing pulse during idle periods and keeps persistent Monitor running
- Workspace inbox uses OS real-time file events with persistent polling as backup
- Attention Allocator decides wake-ups using deadline risk, schedule drift, new observations, Goal conflicts, long-term blocking, and expected utility/cost
- Each Goal has persisted Plan Version and explicit falsifiable assumptions; matching observations invalidate stale plans and create constrained cognition-repair threads
- Repair outcomes are injected into the saved action state of the original thinking thread and resumed after completion from the revised cognitive context rather than replaying completed work
- Goals can declare shared/exclusive semantic resources; Scheduler persists holds and serializes conflicting operations over accounts, documents, or business objects
- Long-term memory stores source, confidence, temporal validity, provenance, supersession, and contradiction states; it is no longer treated as permanent truth
- Versioned, content-addressed, Ed25519-verifiable, and AES-256-GCM-encryptable Memory Bundle, importable/exportable/sync-ready through local snapshots, CAS, or HTTPS providers
- Boundaries for Provider, Tool, Action, Channel, Hook, Sensor, and persistent Listener plugins
- Terminal interaction, JSON output, status tables, task watch, log follow, event injection, and human control
- Headless REST/SSE Gateway, auth, rate limiting, health, metrics, and diagnostics
- First-run onboarding configures model, secrets, workspace, boundaries, budgets, cognition, and approval policies
- Separate Kernel Owl terminal mascot, plus continuously refreshed terminal OS panel
- Layered dialog history and long-term memory management, supporting clean context, full history purge, and single-memory forget

See architecture and semantics in [OpenClaw architecture comparison](docs/openclaw-comparison.md) and [Agent OS architecture](docs/architecture.md).

## Quick start

Supported Node.js versions: 22.22.3, 24.15.0, or 25.9.0 release lines and patch releases. Node.js 24 LTS is recommended. The core runtime has no third-party runtime dependencies.

Start Agent OS directly:

```bash
node src/cli.js
```

The first run enters guided onboarding and sequentially configures Agent and workspace, Gateway access scope, model and credential settings, resource budgets, background cognition, and side-effect approval policy. After confirmation it starts a persistent background Gateway and then opens the live terminal shell. You can reconfigure at any time:

```bash
node src/cli.js setup
node src/cli.js model
```

Observe and submit work independently:

```bash
node src/cli.js status
node src/cli.js security audit
node src/cli.js run "Plan my next product release and ask only for missing constraints"
node src/cli.js chat
```

If installed or linked as an npm package, the command is `agent-os`:

```bash
agent-os gateway start
agent-os status
agent-os                                               # First run onboarding, then open the live terminal shell
agent-os chat                                          # Equivalent explicit command
```

When no model is configured, the system uses the built-in English offline provider, while Goal, Task, session, memory, scheduling, perception, and reliable delivery continue to run end-to-end.

## Model and state directory

[.env.example](.env.example) is the environment reference. Running `agent-os setup` first is recommended. If you choose secret files, model keys and Gateway token are stored in `security.secretFile` and the main config keeps only references; both files are written atomically with `0600` permissions. You can also inject secrets via shell, process manager, or container environment variables:

```bash
AGENT_OS_HOME="$HOME/.agent-os" \
AGENT_MODEL_API_KEY=your-key \
AGENT_MODEL_ID=your-model \
npm start
```

Default state directory is project `data/`. `init` only creates configuration baseline and does not run full onboarding; normally use `setup`:

```bash
AGENT_OS_HOME="$HOME/.agent-os" node src/cli.js setup
```

See a full sample in [config.example.json](config.example.json). Key config fields include:

- `gateway.bind`: default `127.0.0.1`
- `gateway.auth.tokenEnv/tokenRef`: all Gateway traffic, including loopback, resolves token via reference; unresolved SecretRef causes startup failure
- `runtime.maxConcurrency`: number of concurrent thinking threads
- `runtime.tickMs`: scan frequency for ready tasks, timers, schedules, and perception checks
- `runtime.leaseMs`: Task and Monitor execution lease duration
- `kernel.*`: daemon heartbeat, watchdog, I/O cycle, and preemption priority
- `sensing.*`: pulse, monitor concurrency, and default workspace inbox sensor
- `cognition.*`: idle cognition, auto reflection, cooldown, and daily Goal budget
- `resources.goalDefaults/globalDaily/agentDaily`: Goal budgets and system/Agent quotas
- `resources.pools`: separate concurrency caps per resource
- `operations.*`: reconciliation interval and retry limits for uncertain side effects
- `security.tenantId`: owning tenant for the current Gateway; cross-tenant requests are rejected
- `security.capabilities`: maximum capability envelope for root Goal
- `security.events`: external event HMAC secret refs, window, and replay protection
- `security.approvalRisk`: minimum tool risk requiring approval
- `security.tools.allow/deny`: global tool capability policy
- `security.pluginPaths`: explicit allowlist of local plugin paths
- `security.plugins`: plugin ID allowlist, private file requirements, fail-closed plugin load policy

Run `agent-os security audit` before production deployment. `--fix` only patches supported POSIX permission issues and does not auto-expand or shrink goal capabilities. A single Gateway is a trusted operator security domain, and Session key is for routing, not identity authentication. Untrusted users or tenants must isolate OS users, Gateway, database, workspace, credentials, and sandbox. Full boundaries, deployment requirements, and known constraints are in [SECURITY.md](SECURITY.md).
- `agents[]`: Agent identity, workspace, and model binding
- `models.*`: OpenAI-compatible endpoint or plugin Provider
- `memory.captureMode`: currently `explicit`, ordinary dialog does not auto-promote to long-term memory
- `memory.portability`: Memory Bundle size/count, remote signature and encryption requirements, trusted signer, key rotation, provider settings, and automatic pull/push cycle
- `onboarding.*`: tracks whether first-run setup has been completed

## CLI

Show full command tree:

```bash
node src/cli.js --help
```

Core interactions:

```bash
agent-os gateway run                                 # Foreground execution
agent-os gateway start|stop|restart|status             # Background daemon control
agent-os kernel status
agent-os kernel processes
agent-os gateway status
agent-os doctor
agent-os setup                                      # Initial onboarding or reconfiguration
agent-os run "Research this topic"                 # Executes and prompts on user input or approval in TTY
agent-os run "Research this topic" --detach         # Submit only, do not wait
agent-os run "Handle this now" --priority 100 --interrupt
agent-os chat                                       # Interactive long-lived Session
```

Observe thinking threads and execution ledger:

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

Long-running services:

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
agent-os memory export ./memory-backup.json
agent-os memory import ./memory-backup.json
agent-os memory import ./memory-backup.json --activate
agent-os memory providers
agent-os memory push personal-cloud
agent-os memory pull personal-cloud
agent-os memory pull decentralized-cas --digest sha256:<digest>
agent-os memory syncs
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

All read commands support `--json`. Gateway remote address is passed by `--gateway <url>`, and auth uses `--token <token>`.

Interactive terminal uses a dedicated **Kernel Owl** mascot that blinks, watches, and enters a persistent terminal OS panel after startup. The panel refreshes every 750ms and displays kernel liveness, RUNNING/READY/WAITING/BLOCKED threads, current Goal, long-term memory, Session, attention judgments, and isolated resource pools; a scrollable interaction area remains below.

Common terminal controls:

```text
/                     Open the command palette below cursor and filter in real time
/task <instruction>  Submit a background Goal in parallel and return to prompt immediately; /bg is an alias
/focus <goal-id>     Bind following work as a child thread of this Goal
/unfocus             Return to global attention context
/inbox               View pending user input, approvals, and recently completed items
/channels            View persistent inbound listeners and outbound channels
/reply [id] <text>   Restore a specific waiting user-input thread
/interrupt <text>    Create an urgent Goal and safely preempt lower-priority work
/model [key]         View or switch the model used by the current Session; default restores default model
/manager             View explainable thread reasoning, run cause, resources, checkpoints, and capabilities
/inspect <task-id>   Expand a thread wait condition, preemption reason, and evidence
/trace <goal-id>     Replay Goal DAG, audit causality chain, and evidence set
/plan <goal-id>      View Plan Version, Assumptions, invalidation events, and repair threads
/pause <task-id>     Pause a thread at a safe checkpoint
/resume <task-id>    Resume a paused thread
/cancel <task-id>    Cancel a thread
/priority <id> <n>   Adjust scheduling priority and write an audit record
/budget <id> <k> <v> Adjust Goal budget within frozen constraints
/revoke <goal-id>    Revoke all capabilities of a Goal
/tasks               List thinking threads
/goals               View persistent goals
/history             View current Session conversation history
/new                 Switch to clean context without deleting historical data
/purge               Delete current Session history and completed Goals
/memory [query]      View or search explicit long-term memory
/forget <memory-id>  Permanently delete one long-term memory
/quit                Exit terminal; background Gateway and goals keep running
```

Pressing `/` opens an independent command palette under the input cursor, showing command syntax and usage. Typing `/fo`, `/mem`, and similar prefixes filters instantly; use ↑/↓, PageUp/PageDown, Tab/Enter to select, and Esc to close. The palette belongs to the input editor and does not consume the top Kernel Owl panel. `/commands` shows the full catalog.

`/model` discovers models in real time from the configured Provider `/models` endpoint and opens a searchable keyboard picker. Type to filter and use ↑/↓, PageUp/PageDown, Enter to choose. The top area also exposes OpenAI, OpenRouter, DeepSeek, Custom, and Offline config entries; choosing one adds a single named model profile, and after save it automatically restarts Gateway and switches immediately without revisiting or overriding other OS settings. `/model status` checks status, and `/model default` restores the Agent default model. Model selection is written to the Session, but each Goal freezes provider key and actual model ID at creation so running or waiting Goals do not accidentally switch model upon resumption.

Narrow terminals degrade to plain interactive output. Non-TTY, CI, and `TERM=dumb` disable animations. `--no-animation` or `AGENT_OS_NO_ANIMATION=1` only disables startup animation. `--simple-ui` or `AGENT_OS_SIMPLE_UI=1` disables the persistent panel. `--no-color` or `NO_COLOR` disables colors.

## Conversation history and long-term memory

Every input is first written to the current Session so interrupted, waiting, and restarted Goals can restore context. It is not equivalent to long-term memory. Long-term memory is only created when `memory add`, `memory_remember`, or explicit user instruction requests recall memory.

- If you only want to avoid carrying smalltalk into a new task, use `/new`.
- To delete an old conversation, locate it with `agent-os sessions list` and run `sessions purge`; active Goal sessions are protected from deletion.
- To delete one long-term preference or fact, locate the ID with `memory list` and run `memory forget`.
- If facts changed but history should be preserved, use `--supersedes <id>` when adding new memory; use `memory retract` when only recall should stop.
- Deleting a Session does not delete long-term memory; deleting long-term memory does not alter historical dialog. They must be managed separately.

### Portable memory and cloud/CAS synchronization

A Memory Bundle is a versioned JSON package whose canonical JSON payload produces a `sha256:` content address. A configurable Ed25519 signer can sign payloads, and another Agent OS only needs the matching public key to verify publisher identity. When `activeKeyId` is enabled, signed payloads are wrapped in an AES-256-GCM envelope; remote pull/push default to requiring encryption, and CAS object names use the encrypted envelope digest while inner `payloadDigest` remains for auditing identical cognitive content. Encryption nonce is deterministically derived from `key + signed inner payload`, so unchanged signed snapshots keep stable addresses while changing signer, signature, or content changes the nonce.

Signatures prove source, not correctness. Imported memories default to `CANDIDATE` and do not enter FTS recall or model context until `memory confirm`, local `--activate`, or trusted remote signature with explicit `autoActivate` moves them to `ACTIVE`. Remote payloads must pass envelope verification, decryption, payload digest, and signature checks before database insert.

Import IDs derive from source `portableId + recordDigest` and are transport-independent. Re-exported imported memory restores original portable fields and does not nest `CANDIDATE` payloads repeatedly; returning to a source device matches the original record. Bidirectional cloud sync or multi-node relay therefore avoids duplicate copies on each hop. Changed content creates a distinct reviewable revision, rather than silently replacing prior cognition.

Built-in provider types:

- `file`: overridable local private snapshot.
- `directory-cas`: immutable object store by bundle digest for sync drives or local decentralized directories.
- `https`: fixed cloud snapshot endpoint, GET pull and POST/PUT push.
- `https-cas`: HTTPS content-addressed store by digest; push uses conditional PUT and pull requires explicit digest.
- Trusted plugins can integrate `registerMemoryProvider(id, adapter)` for IPFS, Arweave, S3, Dropbox, or enterprise object-store protocols.

Remote pull requires trusted signatures by default; remote push requires configured signer. HTTPS requests inherit Runtime DNS pinning, SSRF checks, redirect rules, timeout, and size limits. Provider tokens can only be injected via environment variables or private SecretRef. Sample config:

```json
{
  "memory": {
    "portability": {
      "pollMs": 30000,
      "maxConcurrentSyncs": 2,
      "maxBundleBytes": 4000000,
      "maxEntries": 5000,
      "maxImportedConfidence": 0.6,
      "requireSignatureForRemote": true,
      "encryption": {
        "requireForRemote": true,
        "activeKeyId": "personal-v1",
        "keys": {
          "personal-v1": {
            "keyEnv": "AGENT_MEMORY_ENCRYPTION_KEY"
          }
        }
      },
      "signer": {
        "id": "personal-laptop",
        "privateKeyEnv": "AGENT_MEMORY_PRIVATE_KEY"
      },
      "trustedSigners": {
        "personal-laptop": {
          "publicKeyEnv": "AGENT_MEMORY_PUBLIC_KEY"
        }
      },
      "providers": {
        "personal-cloud": {
          "type": "https",
          "url": "https://memory.example.com/v1/snapshot",
          "tokenEnv": "AGENT_MEMORY_PROVIDER_TOKEN",
          "pullIntervalMs": 300000,
          "pushIntervalMs": 300000,
          "autoActivate": false
        },
        "decentralized-cas": {
          "type": "https-cas",
          "url": "https://cas.example.com/agent-memory/",
          "tokenEnv": "AGENT_MEMORY_PROVIDER_TOKEN"
        }
      }
    }
  }
}
```

Environment variables can store PEM or single-line base64 DER. Generate Ed25519 key:

```bash
openssl genpkey -algorithm Ed25519 -out memory-private.pem
export AGENT_MEMORY_PRIVATE_KEY="$(openssl pkey -in memory-private.pem -outform DER | openssl base64 -A)"
export AGENT_MEMORY_PUBLIC_KEY="$(openssl pkey -in memory-private.pem -pubout -outform DER | openssl base64 -A)"
export AGENT_MEMORY_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

`keys` can retain old and new keys to decrypt historical bundles, while only `activeKeyId` applies to new exports, enabling seamless rotation. For multi-device personal Agents, all devices can share one encryption key while each device has an independent Ed25519 signer; this preserves decryption sharing while still attributing each memory to a specific publisher. Production should prefer `keyRef` pointing to private `secrets.json`; do not put keys in `config.json`.

Synchronization runs in a dedicated persistent `memory-sync-reactor`. `maxConcurrentSyncs` controls provider worker pool size; network waits still heartbeat, so a slow provider does not occupy Scheduler, block other memory channels, or falsely indicate daemon failure. Each pull, push, import, and export is persisted in `memory_sync_runs` and can be checked via `memory syncs` or `/memory-sync`.

## One cockpit, multiple thinking threads

One terminal input area does not mean one task. The system behaves more like human unified awareness and attention: one immediate expression channel can host many active, waiting, sleeping, and preempted thinking threads.

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

Input routing follows deterministic priority:

1. If a focused Goal is waiting for user input, normal input resumes it directly.
2. If the current Session has exactly one pending `user.reply`, normal input becomes that reply automatically.
3. If multiple waiting candidates exist, the system requires explicit choice through `/inbox` and `/reply <id>` instead of model guessing.
4. Without waiting items, normal input creates a new foreground Goal; `/task` forces parallel background Goal submission.
5. Work under `/focus` becomes a child Goal and further constrains budget, deadline, and capabilities.
6. `/interrupt` creates a high-priority Goal, preempting the current thread at a safe checkpoint for later resumption.

The CPU handles state machine, queueing, matching, wake-up, and preemption; LLM is invoked only for cognitive steps requiring interpretation, path selection, or semantic disambiguation. The terminal can be closed, and work can arrive from multiple terminals, message channels, monitors, or external event inputs while Goal lifecycle remains in the persistent kernel.

## Real-time channel waiting

`WAITING` is more than a database status. Inbound channels can provide a persistent `listen()` adapter such as IMAP IDLE, Slack Socket Mode, WebSocket, Redis Streams, NATS, or device-message connections. After plugin load, this listener is started by Kernel Supervisor as a persistent independent service with heartbeat, restart on failure, and clean shutdown.

When an Agent calls `wait_for_channel`, it specifies `channel + accountId + threadKey`:

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

Inbound messages and events support resumable delivery: messages enter `channel_messages` with `PENDING`; after durable event publish they become `DELIVERED`. If the process crashes between commits, I/O Reactor replays pending messages; event idempotency keys prevent double wake-up. Messages that arrive before task subscription are not lost.

Built-in `webhook` Channel accepts authenticated messages through Gateway:

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

Production Channel plugins call `registerChannel(id, { listen, send })`. `listen({ signal, heartbeat, ingest })` keeps external connections alive and calls `ingest(...)` on message arrival; adapters do not manipulate Tasks directly and must not hold model context.

## Idle perception

Each Agent creates a default `workspace_inbox` Monitor and starts a supervised filesystem Listener. Even without a Goal, Gateway continuously:

1. Writes `runtime.pulse` recording liveness, threads, waits, and attention state.
2. Watches OS notifications and wakes Monitor immediately, while also polling by interval to avoid missed events.
3. Compares current observation with previous persisted state.
4. Writes `monitor.changed` durable event on change.
5. When `autoGoal` is enabled, creates a new internal Session Goal for Agent judgment.

For example, drop a file:

```bash
cp request.txt data/workspace/inbox/
agent-os events list --topic monitor.changed
agent-os goals list
```

Monitors have independent revision, lease, failure backoff, last state, and observation ledger; Gateway restarts do not lose perception progress. Plugins can add email polling Sensors, IMAP IDLE, WebSocket, GitHub stream, message queue, or device connection listeners.

Idle cognition is always present but default `autoReflect=false`, so no silent model spend occurs. It no longer reflects only on a timer: Attention Allocator computes deadline risk, drift from failure/preemption, new observations, shared account or explicit conflict keys, and expected reflection value versus model cost. Only when score and value pass threshold does it wake a read-only, budgeted reflection Goal; critical signals can still issue durable interrupts to preempt low-priority work.

## Goal Contract and security boundaries

When submitting a job, you can narrow default budgets and capabilities:

```bash
agent-os run "Prepare the release evidence" \
  --deadline 2026-07-11T09:00:00Z \
  --budget '{"maxInputTokens":12000,"maxOutputTokens":2000,"maxCostUsd":0.25,"maxToolCalls":8,"maxWallTimeMs":300000,"maxContextChars":30000,"maxFanOut":1,"maxDepth":1}' \
  --capabilities '{"tools":["memory_search","workspace_list","workspace_read"],"resourcePools":["default","memory","filesystem"],"filesystem":{"roots":["release"],"operations":["list","read"]},"network":{"domains":[],"methods":[]},"accounts":{},"dataScopes":["agent:self"],"credentialRefs":[]}'
```

Contract and Goal/Task are created in the same SQLite transaction. Child Goals inherit only subsets of parent Contract and cannot expand deadline, capability expiry, budgets, fan-out, or depth. Gateway is bound to one `security.tenantId`; strict tenant isolation runs separate Kernel, database, config, and workspace. Multiple Agents inside one Kernel are logically isolated using workspace boundaries, Goal ownership, Session/Memory/Event tenant scope, and capability contract.

Tools can map business parameters to generic `constraints`. For example, mail capability can freeze `accounts.email=["primary"]`, `credentialRefs=["mail-primary"]`, `constraints.email.recipients=["*@example.com"]`, `messageTypes=["transactional"]`, `maxRecipientsPerCall=2`, and `maxBodyChars=10000`. Child Goals may further narrow lists or limits, while deadline and token/tool budgets remain constrained by the same Contract. Authorization therefore means exactly which Goal can perform which action, on which objects, in which time and budget, not merely whether a tool is callable.

External event entry points require HMAC by default. `security.events.sourceSecrets` stores references like `env:VARIABLE`, for example `{"cli":"env:AGENT_EVENT_CLI_SECRET"}`. Signatures use `agent-os-event-v1` domain separation across source, timestamp, nonce, topic, correlation key, tenant, agent, and canonical payload. Nonce is unique in DB and requests with expired timestamp, reused nonce, or content replay are rejected. Internal topics include `approval.resolved`, `goal.completed`, `channel.message`, `monitor.changed`, and `cognition.attention`; external event APIs cannot inject them.

Model requests default to public HTTPS or loopback HTTP endpoints. All addresses are resolved and validated before connect; outgoing traffic is fixed to validated endpoints and does not follow redirects, preventing DNS rebinding, credential redirect, and SSRF patterns. If private HTTPS model access is truly required, set `allowPrivateNetwork: true` on that model; security audit marks it high risk.

Resource pool in current single-machine release is an interruptible in-process semaphore, not containers. `browser` and `code` Tools without a registered sandbox adapter declaring process/container/microvm isolation are rejected at registration. The adapter itself is a trusted plugin boundary; production deployments still must verify it truly invokes containers, VMs, restricted Workers, or remote execution services.

## Side-effect protocol

Tools with external side effects declare `sideEffect.mode`; runtime creates an operation record for each idempotency key. The recoverable path is `prepare → execute → confirm`. If request times out or process exits in `EXECUTING`, it transitions to `UNCERTAIN`, and background I/O Reactor invokes Tool `reconcile` to query external fact. When confirmation succeeds, external result is persisted; re-execution occurs only if confirmation is absent. Tools supporting compensation can be rolled back via CLI/API compensation.

`messages + outbox` are committed in one local transaction. Local write tools use stable object IDs for crash-safe replay. For legacy non-idempotent, non-queryable, and non-compensatable systems, runtime enforces approval and single-slot isolation, and pauses automation until human reconcile when results are uncertain. The system does not invent exactly-once behavior.

## Asynchronous recovery states

Normal tool calls return JSON. Tools that need waiting return `ActionControl.wait(...)`. Runtime persists:

- workflow `pc`, step graph, and variables
- model messages, pending tool calls, and tool-local state
- event topic, correlation key, deadline, and pending event
- checkpoints, required evidence, results, errors, and audit trace
- task lease, revision, pause/cancel intent, and retry state

When a matching event arrives, the original tool call resumes from the saved step instead of replaying the full conversation. The runtime does not claim to preserve invisible in-model internal thought chains; restoration uses serializable, auditable external reasoning state.

## Built-in tools

- `memory_search`, `memory_remember`, `memory_confirm`, `memory_forget`
- `plan_assume`
- `workspace_list`, `workspace_read`, `workspace_write`, `workspace_delete`
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

CLI works through local Gateway API. Submissions return accepted immediately and do not wait for model or tool completion:

```bash
curl -X POST http://127.0.0.1:3030/api/v1/messages \
  -H "authorization: Bearer $AGENT_GATEWAY_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "messageId":"terminal-001",
    "agentId":"main",
    "channel":"terminal",
    "peerKey":"owner",
    "text":"Prepare a release plan and ask for missing constraints"
  }'
```

Key endpoints:

- `GET /api/health`, `GET /api/diagnostics`, `GET /api/metrics`, `GET /api/dashboard`
- `GET /api/inbox`, `POST /api/inbox/reply`
- `GET /api/channels/messages`, `POST /api/channels/:id/messages`
- `GET /api/kernel`, `GET /api/kernel/processes`
- `GET /api/resources`, `GET /api/attention`
- `GET /api/operations`, `GET /api/operations/:id`
- `POST /api/operations/:id/reconcile|compensate`
- `GET /api/goals/:id/contract|plan|trace`, `POST /api/goals/:id/capabilities/revoke`
- `GET/POST /api/credentials`, `POST /api/credentials/:id/revoke`
- `GET/POST /api/interrupts`
- `GET /api/cognition`, `POST /api/cognition/enable|disable|reflect`
- `GET /api/goals`, `GET /api/goals/:id`
- `GET /api/tasks`, `GET /api/tasks/:id`, `POST /api/tasks/:id/pause|resume|cancel`
- `GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions/:id/purge`
- `GET/POST /api/memories`, `POST /api/memories/:id/forget|confirm|status`
- `GET /api/approvals`, `POST /api/approvals/:id/resolve`
- `GET/POST /api/schedules`
- `GET/POST /api/monitors`, `GET /api/monitors/:id`
- `POST /api/monitors/:id/run|enable|disable`
- `GET/POST /api/events`
- `GET /api/audit`, `GET /api/outbox`, `GET /api/stream`

## Plugins

Plugins can only be loaded from explicit `security.pluginPaths`, and can register Tool, Action, Channel, Hook, Sensor, and supervised persistent Listener. See example [time-plugin.js](examples/plugins/time-plugin.js).

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

## Validation

```bash
npm run check
npm run doctor
```

Test coverage includes concurrent Goals, external wait/recovery, early events, restart recovery, idempotency, Session DAG, suspend-capable model tools, high-risk approval, temporal and contradictory memory, plan versioning and observation-driven repair, semantic resource mutual exclusion, schedules, task controls, child-goal parallel convergence, and idle pulse plus sensor-triggered new goals.
