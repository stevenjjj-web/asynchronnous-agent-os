import { AgentRuntime } from './runtime/agent-runtime.js';
import { HookBus } from './platform/hooks.js';
import { ensureWorkspace } from './platform/workspace.js';
import { createProviderRegistry } from './agent/providers.js';
import { ActionControl, ToolRegistry } from './agent/tool-registry.js';
import { MemoryService } from './agent/memory-service.js';
import { ContextBuilder } from './agent/context-builder.js';
import { AgentTurnService } from './agent/agent-turn.js';
import { SessionService } from './agent/session-service.js';
import { ChannelRegistry, OutboxDispatcher } from './platform/channels.js';
import { PluginManager } from './platform/plugin-manager.js';
import { createWorkspaceTools } from './agent/workspace-tools.js';
import { createBuiltinSensors, MonitoringService } from './runtime/monitoring.js';
import { InterruptController } from './kernel/interrupt-controller.js';
import { CognitionService } from './kernel/cognition-service.js';
import { KernelDaemon } from './kernel/kernel-daemon.js';
import { ListenerRegistry } from './kernel/listener-registry.js';
import { createWorkspaceInboxListener } from './kernel/workspace-inbox-listener.js';
import { ResourceKernel } from './kernel/resource-kernel.js';
import { ResourcePoolManager } from './kernel/resource-pools.js';
import { CapabilityKernel, CredentialBroker } from './kernel/capability-kernel.js';
import { OperationManager } from './kernel/operation-manager.js';
import { AttentionAllocator } from './kernel/attention-allocator.js';
import { EventAuthenticator } from './kernel/event-authenticator.js';
import { SandboxRegistry } from './kernel/sandbox-registry.js';
import { AttentionInbox } from './kernel/attention-inbox.js';
import { ObservabilityKernel } from './kernel/observability-kernel.js';
import { PlanRepairService } from './kernel/plan-repair-service.js';

export class PersonalAgentSystem {
  constructor(config) {
    this.config = config;
    this.housekeepingRunning = false;
    this.housekeepingPromise = null;
    this.runtime = new AgentRuntime({
      database: config.database,
      maxConcurrency: config.runtime.maxConcurrency,
      tickMs: config.runtime.tickMs,
      leaseMs: config.runtime.leaseMs,
    });
    this.store = this.runtime.store;
    this.observability = new ObservabilityKernel({ store: this.store, config });
    this.eventBus = this.runtime.eventBus;
    this.scheduler = this.runtime.scheduler;
    this.actions = this.runtime.actions;
    this.hooks = new HookBus();
    this.providers = createProviderRegistry();
    this.eventAuthenticator = new EventAuthenticator({ config });
    this.resources = new ResourceKernel({ store: this.store, config });
    this.capabilities = new CapabilityKernel({ store: this.store, config });
    this.resourcePools = new ResourcePoolManager(config.resources.pools);
    this.credentials = new CredentialBroker({ store: this.store });
    this.sandboxes = new SandboxRegistry();
    this.operations = new OperationManager({
      store: this.store,
      config,
      pools: this.resourcePools,
    });
    this.tools = new ToolRegistry({
      approvalRisk: config.security.approvalRisk,
      hooks: this.hooks,
      policy: config.security.tools,
      capabilities: this.capabilities,
      resources: this.resources,
      pools: this.resourcePools,
      operations: this.operations,
      credentials: this.credentials,
      sandboxes: this.sandboxes,
    });

    for (const agent of config.agents) {
      ensureWorkspace(agent.workspace);
      this.store.upsertAgent(agent);
    }
    this.memory = new MemoryService({ store: this.store, config });
    this.contextBuilder = new ContextBuilder({ store: this.store, memory: this.memory, resources: this.resources, config });
    this.agentTurn = new AgentTurnService({
      store: this.store,
      config,
      providers: this.providers,
      tools: this.tools,
      contextBuilder: this.contextBuilder,
      hooks: this.hooks,
      resources: this.resources,
    });
    this.sessions = new SessionService({
      store: this.store,
      runtime: this.runtime,
      hooks: this.hooks,
      contractFactory: (input) => this.buildGoalContract(input),
      config,
    });
    this.inbox = new AttentionInbox({
      store: this.store,
      tenantId: config.security.tenantId,
      publishEvent: (event) => this.publishEvent(event),
    });
    this.scheduler.resourceKernel = this.resources;
    this.sensors = createBuiltinSensors();
    this.monitoring = new MonitoringService({
      store: this.store,
      eventBus: this.eventBus,
      sessions: this.sessions,
      sensors: this.sensors,
      config,
    });
    this.monitoring.ensureDefaults();
    this.listeners = new ListenerRegistry({
      eventBus: this.eventBus, store: this.store, tenantId: config.security.tenantId,
    });
    this.listeners.register('workspace-inbox', createWorkspaceInboxListener({
      store: this.store,
      monitoring: this.monitoring,
      heartbeatMs: config.kernel.heartbeatMs,
      tenantId: config.security.tenantId,
    }));
    this.channels = new ChannelRegistry({
      hooks: this.hooks,
      eventBus: this.eventBus,
      store: this.store,
      tenantId: config.security.tenantId,
    });
    this.channels.register('web', {
      name: 'HTTP API',
      send: async (record) => ({ ok: true, local: true, outboxId: record.id }),
    });
    this.channels.register('terminal', {
      name: 'Local Terminal',
      send: async (record) => ({ ok: true, local: true, outboxId: record.id }),
    });
    this.channels.register('internal', {
      name: 'Internal Agent-to-Agent',
      send: async (record) => ({ ok: true, internal: true, outboxId: record.id }),
    });
    this.channels.register('webhook', {
      name: 'Authenticated inbound webhook',
      inbound: true,
    });
    this.outbox = new OutboxDispatcher({ store: this.store, channels: this.channels });
    this.registerTools();
    this.registerActions();
    this.plugins = new PluginManager({
      config,
      tools: this.tools,
      actions: this.actions,
      channels: this.channels,
      hooks: this.hooks,
      sensors: this.sensors,
      listeners: this.listeners,
      sandboxes: this.sandboxes,
    });
    this.interrupts = new InterruptController({
      store: this.store,
      scheduler: this.scheduler,
      eventBus: this.eventBus,
      config,
    });
    this.attention = new AttentionAllocator({ store: this.store, config });
    this.cognition = new CognitionService({
      store: this.store,
      sessions: this.sessions,
      eventBus: this.eventBus,
      attention: this.attention,
      interrupts: this.interrupts,
      config,
      modelAvailable: () => config.agents.some((agent) => {
        const model = config.models[agent.model];
        return model && model.provider !== 'offline'
          && (model.provider !== 'openai-compatible' || Boolean(model.apiKey));
      }),
    });
    this.planRepair = new PlanRepairService({
      store: this.store,
      eventBus: this.eventBus,
      sessions: this.sessions,
      config,
    });
    this.kernel = new KernelDaemon({
      store: this.store,
      scheduler: this.scheduler,
      housekeeping: () => this.housekeeping(),
      interrupts: this.interrupts,
      cognition: this.cognition,
      planRepair: this.planRepair,
      listeners: this.listeners,
      config,
    });
  }

  async start() {
    await this.plugins.loadConfigured();
    this.kernel.start();
    return this;
  }

  buildGoalContract(input = {}) {
    const parent = input.parentGoalId ? this.store.getGoalContract(input.parentGoalId) : null;
    const agentId = input.agentId ?? parent?.agent_id ?? 'main';
    const tenantId = input.tenantId ?? parent?.tenant_id ?? 'default';
    if (parent && (parent.agent_id !== agentId || parent.tenant_id !== tenantId)) {
      throw new Error('Child goals cannot cross agent or tenant ownership boundaries');
    }
    if (parent) {
      const parentDepth = Number(this.store.getGoal(input.parentGoalId)?.metadata.spawnDepth ?? 0);
      this.resources.authorizeFanOut(input.parentGoalId, 1, Number(input.spawnDepth ?? parentDepth + 1));
    }
    const requestedDeadline = input.deadlineAt == null ? null : new Date(input.deadlineAt).getTime();
    if (input.deadlineAt != null && !Number.isFinite(requestedDeadline)) throw new Error('deadlineAt must be a valid date or timestamp');
    const deadlineAt = parent?.deadline_at && requestedDeadline
      ? Math.min(parent.deadline_at, requestedDeadline)
      : parent?.deadline_at ?? requestedDeadline;
    const rawCapabilityExpiry = input.capabilityExpiresAt ?? input.capabilities?.expiresAt;
    const requestedCapabilityExpiry = rawCapabilityExpiry == null
      ? null
      : new Date(rawCapabilityExpiry).getTime();
    if (rawCapabilityExpiry != null && !Number.isFinite(requestedCapabilityExpiry)) {
      throw new Error('capabilityExpiresAt must be a valid date or timestamp');
    }
    const capabilities = this.capabilities.freeze({
      parentGoalId: input.parentGoalId,
      requested: input.capabilities,
      expiresAt: requestedCapabilityExpiry,
    });
    const capabilityExpiresAt = parent?.capability_expires_at && capabilities.expiresAt
      ? Math.min(parent.capability_expires_at, capabilities.expiresAt)
      : parent?.capability_expires_at ?? capabilities.expiresAt ?? null;
    return {
      agentId,
      tenantId,
      parentGoalId: input.parentGoalId ?? null,
      deadlineAt,
      budget: this.resources.buildBudget({ parentGoalId: input.parentGoalId, requested: input.budget }),
      capabilities,
      capabilityExpiresAt,
      createdBy: input.createdBy ?? 'kernel',
    };
  }

  registerTools() {
    for (const tool of createWorkspaceTools(this.store)) this.tools.register(tool);
    this.tools
      .register({
        name: 'memory_search',
        description: 'Searches the current agent\'s long-term memory.',
        risk: 'low',
        resourcePool: 'memory',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async ({ query, limit }, { session }) => ({
          ok: true,
          memories: this.memory.recall(session.agent_id, query, { limit, tenantId: session.tenant_id }),
        }),
      })
      .register({
        name: 'memory_remember',
        description: 'Stores a fact, preference, or decision across sessions only when the user explicitly asks for it. Never store secrets.',
        risk: 'low',
        resourcePool: 'memory',
        sideEffect: { mode: 'local-idempotent' },
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            kind: { type: 'string', enum: ['fact', 'preference', 'decision', 'episode', 'procedure', 'note'] },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            tags: { type: 'array', items: { type: 'string' } },
            validFrom: { type: 'number' },
            validUntil: { type: 'number' },
            supersedesId: { type: 'string' },
            contradictsIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['content'],
          additionalProperties: false,
        },
        execute: async (args, { session, idempotencyKey }) => ({ ok: true, memory: this.memory.remember({
          ...args,
          id: `memory:${idempotencyKey}`,
          agentId: session.agent_id,
          tenantId: session.tenant_id,
          source: `session:${session.id}`,
          provenance: { sessionId: session.id, channel: session.channel, peerKey: session.peer_key },
        }) }),
      })
      .register({
        name: 'memory_confirm',
        description: 'Confirms an existing long-term memory only after explicit user verification and raises its confidence without changing its content.',
        risk: 'low',
        resourcePool: 'memory',
        sideEffect: { mode: 'local-idempotent' },
        parameters: {
          type: 'object',
          properties: {
            memoryId: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['memoryId'],
          additionalProperties: false,
        },
        execute: async ({ memoryId, confidence }, { session }) => {
          const memory = this.store.getMemory(memoryId);
          if (!memory || memory.agent_id !== session.agent_id || memory.tenant_id !== session.tenant_id) {
            return { ok: false, error: 'Memory is unavailable in this agent scope' };
          }
          return { ok: true, memory: this.memory.confirm(memoryId, { confidence, source: `session:${session.id}` }) };
        },
      })
      .register({
        name: 'plan_assume',
        description: 'Records an explicit, falsifiable planning assumption and the durable event that should invalidate it.',
        risk: 'low',
        resourcePool: 'default',
        sideEffect: { mode: 'local-idempotent' },
        parameters: {
          type: 'object',
          properties: {
            statement: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            watchTopic: { type: 'string' },
            correlationKey: { type: 'string' },
            source: { type: 'string' },
          },
          required: ['statement', 'watchTopic'],
          additionalProperties: false,
        },
        execute: async (args, { task, idempotencyKey }) => ({
          ok: true,
          assumption: this.store.addGoalAssumption(task.goal_id, {
            id: `assumption:${idempotencyKey}`,
            statement: args.statement,
            confidence: args.confidence,
            watch: { topic: args.watchTopic, correlationKey: args.correlationKey, source: args.source },
            evidence: { recordedByTaskId: task.id },
          }),
        }),
      })
      .register({
        name: 'request_user_input',
        description: 'Suspends the current task for a critical choice, approval, or external information from the user.',
        risk: 'low',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            timeoutSeconds: { type: 'integer', minimum: 60, maximum: 604800 },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
        execute: async (args, context) => {
          if (context.resumeEvent) return ActionControl.value({ ok: true, reply: context.resumeEvent.payload });
          const correlationKey = `task:${context.task.id}:user-input`;
          return ActionControl.wait({
            kind: 'event',
            topic: 'user.reply',
            correlationKey,
            deadline: Date.now() + Number(args.timeoutSeconds ?? 86_400) * 1000,
            reason: args.prompt,
          }, { prompt: args.prompt });
        },
      })
      .register({
        name: 'wait_for_event',
        description: 'Waits for a webhook, CI result, email, payment, or another external event without holding an execution slot.',
        risk: 'low',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            correlationKey: { type: 'string' },
            reason: { type: 'string' },
            timeoutSeconds: { type: 'integer', minimum: 1, maximum: 604800 },
          },
          required: ['topic', 'correlationKey'],
          additionalProperties: false,
        },
        execute: async (args, context) => {
          if (context.resumeEvent) return ActionControl.value({ ok: true, event: context.resumeEvent.payload });
          return ActionControl.wait({
            kind: 'event',
            topic: args.topic,
            correlationKey: args.correlationKey,
            deadline: args.timeoutSeconds ? Date.now() + args.timeoutSeconds * 1000 : null,
            reason: args.reason ?? `Waiting for ${args.topic}`,
          }, { waiting: true });
        },
      })
      .register({
        name: 'wait_for_channel',
        description: 'Suspends until a continuously supervised inbound channel receives a matching message.',
        risk: 'low',
        resourcePool: 'default',
        capability: { accountType: 'channel', accountArg: 'accountId' },
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string' },
            accountId: { type: 'string' },
            threadKey: { type: 'string' },
            reason: { type: 'string' },
            timeoutSeconds: { type: 'integer', minimum: 1, maximum: 2_592_000 },
          },
          required: ['channel', 'accountId', 'threadKey'],
          additionalProperties: false,
        },
        execute: async (args, context) => {
          if (context.resumeEvent) return ActionControl.value({
            ok: true,
            message: context.resumeEvent.payload,
          });
          if (!this.channels.has(args.channel)) throw new Error(`Unknown channel: ${args.channel}`);
          return ActionControl.wait({
            kind: 'event',
            topic: 'channel.message',
            correlationKey: this.channels.correlationKey(args.channel, args.accountId, args.threadKey),
            deadline: Date.now() + Number(args.timeoutSeconds ?? 86_400) * 1000,
            reason: args.reason ?? `Waiting for ${args.channel}:${args.accountId}:${args.threadKey}`,
          }, {
            channel: args.channel,
            accountId: args.accountId,
            threadKey: args.threadKey,
          });
        },
      })
      .register({
        name: 'sleep',
        description: 'Suspends the current task for a duration without holding a worker.',
        risk: 'low',
        parameters: {
          type: 'object',
          properties: { seconds: { type: 'number', minimum: 0.05, maximum: 3600 }, reason: { type: 'string' } },
          required: ['seconds'],
          additionalProperties: false,
        },
        execute: async (args, context) => {
          if (context.toolState?.started) return ActionControl.value({ ok: true, sleptSeconds: args.seconds });
          return ActionControl.wait({
            kind: 'timer', durationMs: args.seconds * 1000,
            reason: args.reason ?? `Waiting for ${args.seconds} seconds`,
          }, { started: true });
        },
      })
      .register({
        name: 'schedule_goal',
        description: 'Creates a one-time or fixed-interval personal goal.',
        risk: 'medium',
        sideEffect: { mode: 'local-idempotent' },
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' }, objective: { type: 'string' }, runAt: { type: 'string' },
            intervalMinutes: { type: 'integer', minimum: 1 },
          },
          required: ['name', 'objective', 'runAt'],
          additionalProperties: false,
        },
        execute: async (args, { session, task, idempotencyKey }) => {
          const nextRunAt = new Date(args.runAt).getTime();
          if (!Number.isFinite(nextRunAt)) throw new Error('runAt must be a valid ISO date/time');
          return {
            ok: true,
            schedule: this.store.createSchedule({
              id: `schedule:${idempotencyKey}`,
              agentId: session.agent_id,
              tenantId: session.tenant_id,
              name: args.name,
              nextRunAt,
              intervalMs: args.intervalMinutes ? args.intervalMinutes * 60_000 : null,
              payload: { objective: args.objective, sessionId: session.id, parentGoalId: task.goal_id },
            }),
          };
        },
      })
      .register({
        name: 'goal_status',
        description: 'Shows the status of recent goals and tasks in the runtime.',
        risk: 'low',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ ok: true, goals: this.store.listGoals(10).map((goal) => ({ id: goal.id, title: goal.title, status: goal.status })) }),
      })
      .register({
        name: 'spawn_goals',
        description: 'Splits independent work into 1-5 persistent child goals. It can return immediately or suspend the parent until the children finish.',
        risk: 'medium',
        parameters: {
          type: 'object',
          properties: {
            goals: {
              type: 'array', minItems: 1, maxItems: 5,
              items: {
                type: 'object',
                properties: { objective: { type: 'string' } },
                required: ['objective'],
                additionalProperties: false,
              },
            },
            waitForCompletion: { type: 'boolean' },
          },
          required: ['goals'],
          additionalProperties: false,
        },
        execute: async (args, context) => {
          const depth = Number(context.session.metadata.spawnDepth ?? 0);
          let childGoalIds = context.toolState?.childGoalIds;
          if (!childGoalIds) {
            this.resources.authorizeFanOut(context.task.goal_id, args.goals.length, depth + 1);
            const children = [];
            for (const [index, goal] of args.goals.entries()) {
              const accepted = await this.sessions.submit({
                agentId: context.session.agent_id,
                tenantId: context.session.tenant_id,
                channel: 'internal',
                peerKey: `parent:${context.task.goal_id}`,
                threadKey: `${context.task.id}:${index}`,
                text: goal.objective,
                messageId: `${context.idempotencyKey}:child:${index}`,
                provenance: `child-goal:${context.task.goal_id}`,
                parentGoalId: context.task.goal_id,
                spawnDepth: depth + 1,
                metadata: { spawnDepth: depth + 1 },
              });
              children.push(accepted.goal.id);
            }
            childGoalIds = children;
          }
          const goals = childGoalIds.map((id) => this.store.getGoal(id));
          const pending = goals.find((goal) => goal && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(goal.status));
          if (args.waitForCompletion && pending) {
            return ActionControl.wait({
              kind: 'event', topic: 'goal.completed', correlationKey: pending.id,
              reason: `Waiting for child goal "${pending.title}" to complete`,
            }, { childGoalIds });
          }
          return ActionControl.value({
            ok: true,
            childGoals: goals.map((goal) => ({ id: goal.id, title: goal.title, status: goal.status })),
          });
        },
      })
      .register({
        name: 'memory_forget',
        description: 'Permanently deletes a long-term memory. This action cannot be undone.',
        risk: 'high',
        resourcePool: 'isolated-side-effects',
        sideEffect: { mode: 'non-idempotent' },
        parameters: {
          type: 'object',
          properties: { memoryId: { type: 'string' }, reason: { type: 'string' } },
          required: ['memoryId', 'reason'],
          additionalProperties: false,
        },
        execute: async ({ memoryId }, { session }) => ({
          ok: Boolean(this.memory.forget(memoryId, {
            agentId: session.agent_id, tenantId: session.tenant_id,
          })),
        }),
      })
      .register({
        name: 'create_monitor',
        description: 'Creates a persistent background monitor that keeps sensing while the agent is idle.',
        risk: 'medium',
        sideEffect: { mode: 'local-idempotent' },
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            sensorType: { type: 'string', enum: ['workspace_inbox', 'https'] },
            intervalSeconds: { type: 'number', minimum: 1, maximum: 86400 },
            config: { type: 'object' },
            autoGoal: { type: 'boolean' },
          },
          required: ['name', 'sensorType', 'intervalSeconds', 'config'],
          additionalProperties: false,
        },
        execute: async (args, { session, idempotencyKey }) => ({
          ok: true,
          monitor: this.store.createMonitor({
            id: `monitor:${idempotencyKey}`,
            agentId: session.agent_id,
            tenantId: session.tenant_id,
            name: args.name,
            sensorType: args.sensorType,
            intervalMs: args.intervalSeconds * 1000,
            config: { ...args.config, autoGoal: args.autoGoal === true },
          }),
        }),
      })
      .register({
        name: 'monitor_status',
        description: 'Lists persistent background monitors and their latest state.',
        risk: 'low',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async (_args, { session }) => ({
          ok: true,
          monitors: this.store.listMonitors({ agentId: session.agent_id, tenantId: session.tenant_id }).map((monitor) => ({
            id: monitor.id,
            name: monitor.name,
            sensorType: monitor.sensor_type,
            enabled: Boolean(monitor.enabled),
            status: monitor.status,
            nextPollAt: monitor.next_poll_at,
            lastObservationAt: monitor.last_observation_at,
            lastError: monitor.last_error,
          })),
        }),
      })
      .register({
        name: 'kernel_status',
        description: 'Reports the resident daemon, supervised services, task threads, pending interrupts, and cognition state.',
        risk: 'low',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({
          ok: true,
          daemon: this.kernel.status(),
          stats: this.store.getStats(),
          interrupts: this.store.listInterrupts({ status: 'PENDING', limit: 20 }),
          cognition: this.cognition.status(),
        }),
      })
      .register({
        name: 'goal_contract',
        description: 'Reports the current goal deadline, remaining budget, frozen capabilities, and capability status.',
        risk: 'low',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async (_args, context) => ({
          ok: true,
          contract: this.store.getGoalContract(context.task.goal_id),
          resourcePools: this.resourcePools.status(),
        }),
      });
  }

  registerActions() {
    this.actions
      .register('personal.recall', async ({ sessionId, query }) => {
        const session = this.store.getSession(sessionId);
        return { memories: this.memory.recall(session.agent_id, query, { tenantId: session.tenant_id }) };
      })
      .register('personal.agent_turn', (input, context) => this.agentTurn.run(input, context))
      .register('personal.deliver', async ({ sessionId }, context) => {
        const session = this.store.getSession(sessionId);
        const source = context.task.dependsOn.map((id) => this.store.getTask(id)).find((task) => task?.kind === 'agent-turn');
        const response = source?.result;
        if (!response?.text) throw new Error('Agent turn produced no deliverable text');
        const delivery = this.store.appendMessageAndEnqueueOutbox({
          id: `assistant:${source.id}`,
          sessionId: session.id,
          role: 'assistant',
          content: { text: response.text, usage: response.usage, trace: response.trace },
          runId: source.id,
          provenance: 'agent',
        }, {
          channel: session.channel,
          target: session.peer_key,
          payload: { type: 'assistant.message', messageId: `assistant:${source.id}`, text: response.text },
          idempotencyKey: `delivery:${context.task.id}`,
        });
        const { message, outbox } = delivery;
        return { messageId: message.id, outboxId: outbox.id };
      });
  }

  async housekeeping() {
    if (this.housekeepingRunning) return this.housekeepingPromise;
    this.housekeepingRunning = true;
    this.housekeepingPromise = this.runHousekeeping();
    try {
      await this.housekeepingPromise;
    } finally {
      this.housekeepingRunning = false;
      this.housekeepingPromise = null;
    }
  }

  async runHousekeeping() {
    this.monitoring.tick();
    this.channels.reconcileInbound();
    await this.operations.reconcileDue();
    await this.outbox.drain();
    for (const schedule of this.store.getDueSchedules(20, this.config.security.tenantId)) {
      try {
        const session = (schedule.payload.sessionId ? this.store.getSession(schedule.payload.sessionId) : null)
          ?? this.sessions.getOrCreate({
            agentId: schedule.agent_id, tenantId: schedule.tenant_id, channel: 'terminal', peerKey: 'owner',
          });
        const result = await this.sessions.submit({
          sessionKey: session.session_key,
          text: schedule.payload.objective,
          messageId: `schedule:${schedule.id}:${schedule.next_run_at}`,
          provenance: `schedule:${schedule.id}`,
          parentGoalId: schedule.payload.parentGoalId,
        });
        this.store.markScheduleRun(schedule.id, result.goal.id);
      } catch (error) {
        this.eventBus.emit('change', { type: 'SCHEDULE_FAILED', data: { scheduleId: schedule.id, error: String(error) }, at: Date.now() });
      }
    }
  }

  publishEvent(event) { return this.runtime.publishEvent(event); }

  async submit(input) {
    const accepted = await this.sessions.submit(input);
    const priority = Math.max(10, Math.min(100, Number(input.priority ?? 80)));
    if (input.interrupt === true || priority >= this.config.kernel.preemptionPriority) {
      const interrupt = this.interrupts.raise({
        agentId: accepted.session.agent_id,
        goalId: accepted.goal.id,
        targetTaskId: input.targetTaskId,
        kind: input.interruptKind ?? 'user',
        priority,
        force: input.interrupt === true,
        reason: input.interruptReason ?? `Higher-priority goal requires attention: ${accepted.goal.title}`,
        payload: { sessionId: accepted.session.id, messageId: accepted.message.id },
      });
      return { ...accepted, interrupt };
    }
    return accepted;
  }

  async createGoal(objective, options = {}) {
    const contract = this.buildGoalContract({
      agentId: options.agentId ?? 'main',
      tenantId: options.tenantId ?? this.config.security.tenantId,
      parentGoalId: options.parentGoalId,
      deadlineAt: options.deadlineAt,
      budget: options.budget,
      capabilities: options.capabilities,
      capabilityExpiresAt: options.capabilityExpiresAt,
      createdBy: options.createdBy ?? 'api',
    });
    const view = await this.runtime.createGoal(objective, { ...options, contract });
    const priority = Math.max(10, Math.min(100, Number(options.priority ?? 80)));
    if (options.interrupt === true || priority >= this.config.kernel.preemptionPriority) {
      this.interrupts.raise({
        agentId: view.goal.agent_id,
        goalId: view.goal.id,
        kind: options.interruptKind ?? 'user',
        priority,
        force: options.interrupt === true,
        reason: options.interruptReason ?? `Higher-priority goal requires attention: ${view.goal.title}`,
      });
    }
    return view;
  }

  async stop() {
    await this.kernel.stop();
    if (this.housekeepingPromise) await this.housekeepingPromise;
    await this.monitoring.stop();
    this.store.close();
  }
}
