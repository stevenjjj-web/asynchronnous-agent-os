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
    const segment = (value, name) => {
      const text = String(value);
      if (!text || text.length > 256) throw new Error(`${name} must contain 1 to 256 characters`);
      return encodeURIComponent(text);
    };
    return `tenant:${segment(tenantId, 'tenantId')}:agent:${segment(agentId, 'agentId')}:${segment(channel, 'channel')}:${segment(peerKey, 'peerKey')}${threadKey ? `:thread:${segment(threadKey, 'threadKey')}` : ''}`;
  }

  getOrCreate(input = {}) {
    const sessionKey = input.sessionKey ?? this.resolveSessionKey(input);
    if (typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 1_024) throw new Error('sessionKey must contain 1 to 1024 characters');
    const tenantId = input.tenantId ?? this.config.security.tenantId;
    if (tenantId !== this.config.security.tenantId) throw new Error('Cross-tenant session access is not allowed');
    const agentId = input.agentId ?? 'main';
    if (!this.store.getAgent(agentId)) throw new Error(`Unknown agent: ${agentId}`);
    const existing = input.sessionKey ? this.store.getSession(sessionKey) : null;
    if (existing) {
      if (existing.tenant_id !== tenantId) throw new Error('Session key belongs to a different tenant');
      const asserted = {
        agent_id: input.agentId,
        channel: input.channel,
        peer_key: input.peerKey,
      };
      for (const [field, value] of Object.entries(asserted)) {
        if (value != null && existing[field] !== value) throw new Error(`Session key belongs to a different ${field}`);
      }
      return existing;
    }
    return this.store.getOrCreateSession({
      sessionKey,
      agentId,
      tenantId,
      channel: input.channel ?? 'terminal',
      peerKey: input.peerKey ?? 'owner',
      title: input.title,
      metadata: input.metadata,
    });
  }

  async submit(input) {
    const text = String(input.text ?? '').trim();
    if (!text) throw new Error('Message text is required');
    const maxMessageChars = this.config.session.maxMessageChars ?? 200_000;
    if (text.length > maxMessageChars) throw new Error(`Message text exceeds ${maxMessageChars} characters`);
    let session = this.getOrCreate(input);
    if (input.messageId) {
      const existing = this.store.getMessage(input.messageId);
      if (existing?.run_id) {
        if (existing.session_id !== session.id) throw new Error('Message id belongs to a different session');
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
    const hasModelOverride = Object.prototype.hasOwnProperty.call(input, 'modelKey')
      || Object.prototype.hasOwnProperty.call(input, 'modelId');
    const agent = this.store.getAgent(session.agent_id);
    if (!agent) throw new Error(`Unknown agent: ${session.agent_id}`);
    const parentGoal = input.parentGoalId ? this.store.getGoal(input.parentGoalId) : null;
    const spawnDepth = Number(input.spawnDepth ?? (parentGoal
      ? Number(parentGoal.metadata.spawnDepth ?? 0) + 1
      : session.metadata.spawnDepth ?? 0));
    if (!Number.isInteger(spawnDepth) || spawnDepth < 0 || spawnDepth > 100) throw new Error('spawnDepth must be an integer between 0 and 100');
    const modelKey = hasModelOverride
      ? (input.modelKey ? String(input.modelKey) : agent.model_key)
      : (parentGoal?.metadata.modelKey ?? session.metadata.modelKey ?? agent.model_key);
    if (!this.config.models[modelKey]) throw new Error(`Unknown model config: ${modelKey}`);
    const modelId = hasModelOverride
      ? (input.modelId ? String(input.modelId) : this.config.models[modelKey].model)
      : (parentGoal?.metadata.modelId ?? session.metadata.modelId ?? this.config.models[modelKey].model);
    if (String(modelKey).length > 128 || String(modelId).length > 256) throw new Error('Model selection exceeds the allowed length');
    if (hasModelOverride) {
      session = this.store.updateSessionMetadata(session.id, {
        modelKey: input.modelKey == null || input.modelKey === '' ? null : String(input.modelKey),
        modelId: input.modelId == null || input.modelId === '' ? null : String(input.modelId),
      });
    }
    const received = await this.hooks.emit('message_received', { session, text, input });
    if (received.cancelled) throw new Error('Message rejected by policy');
    const effectiveText = String(received.text ?? text).trim();
    if (!effectiveText) throw new Error('Message text is empty after policy hooks');
    if (effectiveText.length > maxMessageChars) throw new Error(`Message text exceeds ${maxMessageChars} characters after policy hooks`);

    const recallId = randomUUID();
    const turnId = randomUUID();
    const deliveryId = randomUUID();
    const goalId = randomUUID();
    const messageId = input.messageId ?? randomUUID();
    const requestedPriority = Number(input.priority ?? 80);
    if (!Number.isFinite(requestedPriority)) throw new Error('priority must be a finite number');
    const priority = Math.max(10, Math.min(100, Math.round(requestedPriority)));
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
        title: effectiveText.length > 42 ? `${effectiveText.slice(0, 42)}…` : effectiveText,
        objective: effectiveText,
        agentId: session.agent_id,
        sessionId: session.id,
        tenantId: session.tenant_id,
        deadlineAt: contract?.deadlineAt,
        contract,
        metadata: {
          source: 'session', sessionKey: session.session_key, messageId,
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
            { type: 'call', action: 'personal.recall', input: { sessionId: session.id, query: effectiveText }, saveAs: 'recall' },
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
    const created = this.store.appendMessageAndCreateGoal({
      id: messageId,
      sessionId: session.id,
      role: 'user',
      content: { text: effectiveText },
      provenance: input.provenance ?? 'user',
    }, plan.goal, plan.tasks);
    this.runtime.eventBus.emit('change', {
      type: 'SESSION_GOAL_CREATED',
      data: { sessionId: session.id, goalId, messageId: created.message.id },
      at: Date.now(),
      stats: this.store.getStats(),
    });
    this.runtime.scheduler.requestDrain();
    return { accepted: true, duplicate: created.duplicate, session, message: created.message, goal: created.goal, tasks: created.tasks };
  }
}
