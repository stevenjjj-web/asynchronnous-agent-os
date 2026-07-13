# Agent OS Gap Analysis

This document distinguishes implemented runtime properties from the work still required for a production-grade, human-like asynchronous agent operating system.

## Current baseline

The runtime already has a resident Gateway and supervised kernel services, durable goal/task lifecycles, READY/RUNNING/WAITING/PAUSED states, event and timer wakeups, lease recovery, bounded parallel goals, interrupts, resource contracts, capability contracts, side-effect operation records, temporal explicit memory, channel listener APIs, an attention allocator, plan versions, falsifiable assumptions, bounded plan-repair threads, and semantic resource claims. The operator terminal derives explanations from persisted state, exposes thread resource use and authority, and replays DAG, plan, evidence, and audit causality.

This is a durable event-driven agent runtime. It is not yet a complete cognitive operating system.

## Priority gaps

### 1. Production perception channels

The listener API is real, but the repository lacks production adapters for email, calendars, Slack/Teams, GitHub, mobile notifications, browser sessions, and desktop events. Each adapter still needs OAuth lifecycle management, push/webhook verification, reconnect and cursor recovery, provider rate limits, and reconciliation after missed delivery.

### 2. Strong execution isolation

Capabilities are enforced logically, while `SandboxRegistry` only defines an adapter boundary. There is no built-in container, microVM, seccomp, filesystem namespace, browser-profile isolation, or per-tenant process boundary. Code and browser execution must not be considered strongly isolated until concrete sandbox backends and adversarial tests exist.

### 3. Distributed residency and availability

SQLite and the single resident Gateway are appropriate for a personal local system, but a sleeping laptop cannot perceive external events. Production residency requires systemd/launchd integration, backups, remote push relays, optional cloud workers, replicated durable storage, fencing across nodes, and task migration with ownership transfer.

### 4. Adaptive planning beyond bounded repair

The runtime now stores plan versions and falsifiable assumptions. A matching durable event marks the current plan stale, launches a read-only child repair goal under inherited budgets, and injects the successful revision into resumable parent thought state. The remaining gap is executable DAG surgery: hierarchical success criteria, dependency impact analysis, alternative-path search, cancellation or replacement of invalid downstream tasks, and formal preservation rules for completed side effects.

### 5. Memory consolidation and belief evaluation

Explicit memory now records kind, source, confidence, temporal validity, provenance, confirmation, supersession, and contradiction state. Retrieval excludes inactive and temporally invalid beliefs, while conversation history remains a separate retention domain. The remaining gap is automatic but reviewable consolidation across episodic, semantic, procedural, and working memory; salience decay; semantic contradiction discovery; source trust calibration; and retrieval-quality evaluation.

### 6. Claim-level provenance

The runtime now records an execution-context evidence set with hashes and source identifiers. That proves which observations were available to a model call, but it does not prove that each sentence follows from a particular source. Claim-level provenance requires structured assertions, citations emitted by the model, source-span identity, entailment checks, contradiction tracking, and an evidence graph that survives summarization.

### 7. Cognitive attention quality

The attention allocator uses auditable heuristic signals. It still needs calibrated expected-value estimates, uncertainty, opportunity cost across dozens of goals, starvation protection, user preference learning, conflict resolution, exploration budgets, and evaluation against human scheduling decisions. The scheduler must coordinate both compute resources and cognitive attention without allowing background reflection to crowd out explicit work.

### 8. Rich semantic concurrency control

Goals can now declare durable shared or exclusive semantic resource claims. The scheduler acquires them before a task lease, defers conflicting ready work, releases them at the execution-quantum boundary, and recovers stale claims after a crash. Remaining work includes hierarchical scope matching, read/write upgrades, optimistic version validation, long-lived reservations across waits, deadlock detection, merge protocols, and compensation when individually valid plans create an invalid combined outcome.

### 9. Resource accounting accuracy

Token usage is provider-reported when available and otherwise estimated. Model prices are manually configured and often zero. Production control requires provider price catalogs, tokenizer-accurate reservations, streaming usage, tool and infrastructure cost accounting, forecast error tracking, budget reservations for child goals, and fair scheduling under global pressure.

### 10. Side-effect completeness

The operation protocol supports prepare, execute, confirm, reconciliation, and compensation, but guarantees are only as strong as each tool adapter. Every production side-effect tool needs an explicit idempotency classification, external status query, uncertainty policy, compensation semantics, approval policy, and crash-injection tests.

### 11. Multi-agent organization

The runtime can create child goals, but it lacks a mature actor protocol for specialized agents: identity, scoped delegation, capability attenuation proofs, shared-artifact locking, negotiation, result acceptance, trust scoring, and cross-agent causal tracing.

### 12. Reasoning-state boundary

The system correctly persists external reasoning state, not hidden model activations. Resume therefore reconstructs a new model request from checkpoints, messages, variables, tool state, and evidence. Remaining work includes deterministic prompt-version capture, model-version pinning, resumability tests across provider changes, compact state summaries with loss measurements, and replay tooling for nondeterministic decisions.

### 13. Reliability and operability

The project needs schema migration discipline, online backup and restore, corruption recovery, chaos tests, clock-skew tests, long-duration soak tests, event-storm backpressure, OpenTelemetry export, SLOs, privacy retention controls, and upgrade/rollback procedures.

### 14. Human control ergonomics

The terminal task manager is a foundation, not the finished product. A mature terminal TUI should provide stable split panes, live selection, keyboard actions, diffed checkpoints, budget sliders expressed as terminal forms, capability attenuation rather than only full revocation, and safe previews of pending side effects. A web console is optional; explainable control is not.

## Recommended sequence

1. Ship real email, calendar, GitHub, and chat listeners with credential references and replay-safe ingestion.
2. Add concrete code/browser sandbox backends and tenant isolation tests.
3. Extend bounded plan repair into validated executable DAG surgery and blocked-path search.
4. Extend semantic claims with hierarchical scopes, optimistic validation, and parent/child budget reservations.
5. Build claim-level evidence graphs and reviewable source-aware memory consolidation.
6. Add launchd/systemd packaging, remote push relay, backup, chaos, and soak testing.
7. Evaluate and learn attention policy only after the event, evidence, and control data are trustworthy.
