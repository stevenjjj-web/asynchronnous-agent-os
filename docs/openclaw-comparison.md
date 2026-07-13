# OpenClaw Architecture Comparison

This project is not a reduced OpenClaw clone. OpenClaw provides a mature personal-agent gateway with a broad CLI, sessions, channels, tools, memory, approvals, automation, plugins, and background task management. Agent OS adopts the operational lessons from that architecture while making durable asynchronous goals and resumable thought threads its primary kernel abstraction.

## Mature system capabilities adopted

The implementation follows several OpenClaw patterns:

- a long-lived, supervised, loopback-first gateway
- a terminal-first command tree with human-readable and JSON output
- session routing and durable message history
- provider, channel, tool, hook, and plugin registries
- explicit security policy and approval gates
- schedules, background tasks, reliable delivery, and diagnostics
- status, task inspection, logs, and maintenance-oriented CLI operations

Primary references are OpenClaw's [CLI reference](https://docs.openclaw.ai/cli), [task commands](https://docs.openclaw.ai/cli/tasks), and [gateway operations guide](https://docs.openclaw.ai/gateway).

OpenClaw also has durable managed task flows with waiting state and persisted JSON state. The distinction here is therefore not "OpenClaw is synchronous." The distinction is which abstraction owns the entire system.

## Core distinction

| Dimension | OpenClaw primary path | Agent OS primary path |
| --- | --- | --- |
| First execution unit | Agent run inside a session | Persistent goal and task DAG across sessions |
| Concurrency boundary | Per-session and global lanes | Global ready queue, dependencies, priority, and leases |
| Background flow | An orchestration layer for managed background work | The default kernel model for every request |
| Waiting | Run, tool, or managed-flow lifecycle | Any workflow action or tool call can durably suspend |
| Resume state | Transcript, flow JSON state, and background task | Program counter, variables, action state, pending event, tool messages, and checkpoints |
| Session role | Primary context and routing unit for agent runs | Input/output route and context view; never the task owner |
| External input | Injected into a session or background flow | Persisted in an event inbox and matched to an exact wait subscription |
| Idle behavior | Gateway services and configured automation remain active | A real resident daemon supervises listeners, I/O, interrupts, cognition, and scheduling |
| Priority changes | Session/global lane scheduling | Durable interrupts abort cooperative calls, run urgent work, then resume the preempted thread |

The defining invariant is:

> Closing a terminal, disconnecting a channel, finishing a model request, or restarting the gateway does not end a goal.

## Current capability map

| Capability | Current implementation |
| --- | --- |
| Long-lived gateway | Foreground or detached host process, authenticated REST and SSE, health and metrics |
| Resident kernel | Singleton lease, PID/generation process table, heartbeats, supervision, and restart records |
| Terminal control plane | Cursor-anchored slash dropdown, filtering, keyboard selection and paging, focus routing, attention inbox, tables, JSON, follow and watch modes |
| Guided onboarding | Model/provider, masked or referenced credentials, workspace, gateway exposure, budgets, cognition, and approvals |
| Live operator surface | Animated product mascot plus a fixed terminal dashboard for threads, goals, attention, memory, and resource pools |
| Agents and workspaces | Multiple agents, isolated workspaces, bootstrap identity and memory files |
| Sessions and messages | SQLite routing, provenance, idempotent inbound message ids |
| Persistent kernel | Goal and task DAGs, lifecycle state machine, dependency unlocking |
| Scheduling | Global ready queue, bounded concurrency, leases, renewal, recovery, fairness quantum |
| Resource governance | Atomic goal contracts, token/cost/time/tool/context/fan-out budgets, daily quotas, deadline urgency, and isolated capacity pools |
| Capability security | Frozen per-goal authority, child subset inheritance, scoped files/domains/accounts/data/credentials, expiry, revocation, and audit |
| Tool loop | JSON Schema validation, allow/deny policy, risk levels, hooks, bounded rounds |
| Sandboxed execution boundary | Browser/code tools cannot register without a named sandbox adapter; adapters are plugin-provided trusted worker boundaries |
| Suspend and resume | Workflow snapshots and model tool-call state persist across waits and restarts |
| Dynamic fan-out | Child session goals and `goal.completed` event convergence |
| Memory | Explicit capture policy, SQLite FTS5, id-addressable Markdown mirror, selective recall, and deletion |
| Data lifecycle | Clean context switching, terminal-session purge, separate long-term-memory deletion, and schedule detachment |
| Approvals | Durable records and approval events for high-risk tools |
| Automation | One-time and interval schedules that create persistent goals |
| Continuous sensing | Resident push listeners plus persistent monitors, observations, polling fallback, and auto-goals |
| Attention and preemption | Durable interrupts, cooperative abort signals, priority scheduling, and checkpoint resume |
| Idle cognition | Always-resident attention allocator with value/cost scoring, opt-in bounded model reflection, and critical interrupts |
| Side-effect safety | Durable prepare/execute/confirm/reconcile records, uncertain outcomes, compensation, non-idempotent isolation, and atomic message/outbox commit |
| Reliable delivery | SQLite outbox, idempotency, retry backoff, channel registry |
| Inbound channel waiting | Supervised push adapters, durable message ingress, replay-safe event conversion, exact correlation resume |
| Plugins | Explicit allowlisted paths for tools, actions, channels, hooks, sensors, and resident listeners |
| Auditability | Append-only task ledger, durable events, observations, and CLI log streaming |

## Deliberate gaps

The project does not yet claim parity with OpenClaw in these areas:

- production adapters for messaging, email, calendars, and collaboration platforms
- built-in production container/VM implementations for browser, shell, code, and device sandbox adapters
- vector embeddings, reranking, memory consolidation, and reflection policies
- voice, rich media, mobile applications, and device pairing
- signed plugin packaging, dependency resolution, updates, rollback, and marketplace distribution
- shared multi-node storage, broker-backed outbox, and fencing-token fault testing
- hostile multi-tenant hosting inside one kernel process; the supported strong tenant boundary is a separate kernel/database/workspace deployment

These features should enter through adapters and plugins without weakening the asynchronous kernel state machine.
