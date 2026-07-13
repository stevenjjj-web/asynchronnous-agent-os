import { randomUUID } from 'node:crypto';

export class SessionService {
  constructor({ store, runtime, hooks, contractFactory, config }) {
    this.store = store;
    this.runtime = runtime;
    this.hooks = hooks;
    this.contractFactory = contractFactory;
    this.config = config;
  }

  resolveSessionKey({ tenantId = 'default', agentId = 'main', channel = 'terminal', peerKey = 'owner', threadKey }) {
    return `tenant:${tenantId}:agent:${agentId}:${channel}:${peerKey}${threadKey ? `:thread:${threadKey}` : ''}`;
  }

  getOrCreate(input = {}) {
    const sessionKey = input.sessionKey ?? this.resolveSessionKey(input);
    return this.store.getOrCreateSession({
      sessionKey,
      agentId: input.agentId ?? 'main',
      tenantId: input.tenantId ?? 'default',
      channel: input.channel ?? 'terminal',
      peerKey: input.peerKey ?? 'owner',
      title: input.title,
      metadata: input.metadata,
    });
  }

  async submit(input) {
    const text = String(input.text ?? '').trim();
    if (!text) throw new Error('Message text is required');
    if (input.messageId) {
      const existing = this.store.getMessage(input.messageId);
      if (existing?.run_id) {
        const goal = this.store.getGoal(existing.run_id);
        if (goal) {
          return {
            accepted: true,
            duplicate: true,
            session: this.store.getSession(existing.session_id),
            message: existing,
            goal,
            tasks: this.store.listTasks(goal.id),
          };
        }
      }
    }
    let session = this.getOrCreate(input);
    const hasModelOverride = Object.prototype.hasOwnProperty.call(input, 'modelKey')
      || Object.prototype.hasOwnProperty.call(input, 'modelId');
    const agent = this.store.getAgent(session.agent_id);
    if (!agent) throw new Error(`Unknown agent: ${session.agent_id}`);
    const parentGoal = input.parentGoalId ? this.store.getGoal(input.parentGoalId) : null;
    const spawnDepth = Number(input.spawnDepth ?? (parentGoal
      ? Number(parentGoal.metadata.spawnDepth ?? 0) + 1
      : session.metadata.spawnDepth ?? 0));
    const modelKey = hasModelOverride
      ? (input.modelKey ? String(input.modelKey) : agent.model_key)
      : (parentGoal?.metadata.modelKey ?? session.metadata.modelKey ?? agent.model_key);
    if (!this.config.models[modelKey]) throw new Error(`Unknown model config: ${modelKey}`);
    const modelId = hasModelOverride
      ? (input.modelId ? String(input.modelId) : this.config.models[modelKey].model)
      : (parentGoal?.metadata.modelId ?? session.metadata.modelId ?? this.config.models[modelKey].model);
    if (hasModelOverride) {
      session = this.store.updateSessionMetadata(session.id, {
        modelKey: input.modelKey == null || input.modelKey === '' ? null : String(input.modelKey),
        modelId: input.modelId == null || input.modelId === '' ? null : String(input.modelId),
      });
    }
    const received = await this.hooks.emit('message_received', { session, text, input });
    if (received.cancelled) throw new Error('Message rejected by policy');
    const message = this.store.appendMessage({
      id: input.messageId,
      sessionId: session.id,
      role: 'user',
      content: { text: received.text ?? text },
      provenance: input.provenance ?? 'user',
    });

    const recallId = randomUUID();
    const turnId = randomUUID();
    const deliveryId = randomUUID();
    const goalId = randomUUID();
    const priority = Math.max(10, Math.min(100, Number(input.priority ?? 80)));
    const contract = this.contractFactory?.({
      agentId: session.agent_id,
      tenantId: session.tenant_id,
      parentGoalId: input.parentGoalId,
      deadlineAt: input.deadlineAt,
      budget: input.budget,
      capabilities: input.capabilities,
      capabilityExpiresAt: input.capabilityExpiresAt,
      spawnDepth,
      createdBy: input.provenance ?? 'user',
    });
    const plan = {
      goal: {
        id: goalId,
        title: text.length > 42 ? `${text.slice(0, 42)}…` : text,
        objective: text,
        agentId: session.agent_id,
        sessionId: session.id,
        tenantId: session.tenant_id,
        deadlineAt: contract?.deadlineAt,
        contract,
        metadata: {
          source: 'session', sessionKey: session.session_key, messageId: message.id,
          createdBy: input.provenance ?? 'user',
          cognitiveRepair: input.cognitiveRepair ?? null,
          parentGoalId: input.parentGoalId ?? null,
          spawnDepth,
          priority,
          modelKey,
          modelId,
          conflictKeys: input.conflictKeys ?? [],
          resourceClaims: input.resourceClaims ?? (input.conflictKeys ?? []).map((scope) => ({ scope, mode: 'exclusive' })),
          assumptions: input.assumptions ?? [],
        },
      },
      tasks: [
        {
          id: recallId,
          title: 'Recall relevant long-term memory',
          kind: 'memory-recall',
          priority: Math.min(100, priority + 5),
          workflow: [
            { type: 'call', action: 'personal.recall', input: { sessionId: session.id, query: text }, saveAs: 'recall' },
            { type: 'complete', result: '{{recall}}' },
          ],
        },
        {
          id: turnId,
          title: 'Reason and use tools',
          kind: 'agent-turn',
          priority,
          dependsOn: [recallId],
          workflow: [
            { type: 'call', action: 'personal.agent_turn', input: { sessionId: session.id }, saveAs: 'response' },
            { type: 'complete', result: '{{response}}' },
          ],
        },
        {
          id: deliveryId,
          title: 'Deliver the response reliably',
          kind: 'delivery',
          priority: Math.max(0, priority - 10),
          dependsOn: [turnId],
          workflow: [
            { type: 'call', action: 'personal.deliver', input: { sessionId: session.id }, saveAs: 'delivery' },
            { type: 'complete', result: '{{delivery}}' },
          ],
        },
      ],
    };
    const created = this.store.createGoalWithTasks(plan.goal, plan.tasks);
    this.store.setMessageRunId(message.id, goalId);
    this.runtime.eventBus.emit('change', {
      type: 'SESSION_GOAL_CREATED',
      data: { sessionId: session.id, goalId, messageId: message.id },
      at: Date.now(),
      stats: this.store.getStats(),
    });
    this.runtime.scheduler.requestDrain();
    return { accepted: true, session, message, goal: created.goal, tasks: created.tasks };
  }
}
