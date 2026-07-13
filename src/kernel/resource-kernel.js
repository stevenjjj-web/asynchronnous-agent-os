const DAY_MS = 86_400_000;

export class ResourceLimitError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ResourceLimitError';
    this.code = 'RESOURCE_LIMIT';
    this.detail = detail;
  }
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function startOfUtcDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export class ResourceKernel {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
  }

  buildBudget({ parentGoalId, requested = {} } = {}) {
    const ceiling = parentGoalId
      ? this.store.getGoalContract(parentGoalId)?.budget
      : this.config.resources.goalDefaults;
    if (!ceiling) throw new Error(`Missing parent goal contract: ${parentGoalId}`);
    return Object.fromEntries(Object.entries(ceiling).map(([key, maximum]) => [
      key,
      Math.min(finite(requested[key], maximum), maximum),
    ]));
  }

  reviseBudget(goalId, patch, { actor = 'operator', reason = 'Budget revised' } = {}) {
    const contract = this.store.getGoalContract(goalId);
    if (!contract) throw new ResourceLimitError('Goal contract is missing');
    const ceiling = contract.parent_goal_id
      ? this.store.getGoalContract(contract.parent_goal_id)?.budget
      : this.config.resources.goalDefaults;
    if (!ceiling) throw new ResourceLimitError('Budget ceiling is unavailable');
    const next = { ...contract.budget };
    for (const [key, rawValue] of Object.entries(patch ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(next, key)) throw new ResourceLimitError(`Unknown budget field: ${key}`);
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value < 0) throw new ResourceLimitError(`Budget field ${key} must be a non-negative number`);
      const maximum = finite(ceiling[key], Infinity);
      if (value > maximum) throw new ResourceLimitError(`Budget field ${key} exceeds its capability ceiling`, { value, maximum });
      next[key] = value;
    }
    return this.store.updateGoalBudget(goalId, next, actor, reason);
  }

  admitTask(task) {
    const contract = this.store.getGoalContract(task.goal_id);
    if (!contract) return { ok: false, reason: 'Goal contract is missing' };
    const timestamp = Date.now();
    if (contract.capability_status !== 'ACTIVE') {
      return { ok: false, reason: `Goal capability contract is ${contract.capability_status.toLowerCase()}`, resource: 'capability' };
    }
    if (contract.capability_expires_at && timestamp >= contract.capability_expires_at) {
      this.store.setCapabilityStatus(task.goal_id, 'EXPIRED', 'scheduler', { expiredAt: timestamp });
      return { ok: false, reason: 'Goal capability contract has expired', resource: 'capability' };
    }
    if (contract.deadline_at && timestamp > contract.deadline_at) {
      return { ok: false, reason: 'Goal deadline has expired', resource: 'deadline' };
    }
    const goal = this.store.getGoal(task.goal_id);
    if (timestamp - goal.created_at > finite(contract.budget.maxWallTimeMs, Infinity)) {
      return { ok: false, reason: 'Goal wall-time budget is exhausted', resource: 'wallTimeMs' };
    }
    const checks = [
      ['inputTokens', 'maxInputTokens'],
      ['outputTokens', 'maxOutputTokens'],
      ['costUsd', 'maxCostUsd'],
      ['toolCalls', 'maxToolCalls'],
    ];
    for (const [usageKey, budgetKey] of checks) {
      if (Number(contract.usage[usageKey] ?? 0) >= finite(contract.budget[budgetKey], Infinity)) {
        return { ok: false, reason: `Goal budget exhausted: ${budgetKey}`, resource: usageKey };
      }
    }
    const quota = this.checkDailyQuotas(contract);
    return quota ?? { ok: true, contract };
  }

  checkDailyQuotas(contract) {
    const since = startOfUtcDay();
    const scopes = [
      { name: 'global', limits: this.config.resources.globalDaily },
      { name: 'agent', limits: this.config.resources.agentDaily, tenantId: contract.tenant_id, agentId: contract.agent_id },
    ];
    for (const scope of scopes) {
      const checks = [
        ['tokens', 'maxTokens'],
        ['costUsd', 'maxCostUsd'],
        ['toolCalls', 'maxToolCalls'],
      ];
      for (const [type, limitKey] of checks) {
        const limit = finite(scope.limits?.[limitKey], Infinity);
        const used = this.store.aggregateResourceUsage({
          tenantId: scope.tenantId,
          agentId: scope.agentId,
          resourceType: type,
          since,
        });
        if (used >= limit) return {
          ok: false,
          reason: `${scope.name} daily quota exhausted: ${limitKey}`,
          resource: type,
          retryAt: startOfUtcDay() + DAY_MS,
        };
      }
    }
    return null;
  }

  assertModelCall(goalId, messages, modelConfig = {}) {
    const contract = this.store.getGoalContract(goalId);
    if (!contract) throw new ResourceLimitError('Goal contract is missing');
    this.assertExecutionTime(goalId);
    const estimatedInputTokens = Math.ceil(messages.reduce((sum, message) => sum + String(message.content ?? '').length, 0) / 4);
    const remaining = finite(contract.budget.maxInputTokens, Infinity) - Number(contract.usage.inputTokens ?? 0);
    if (estimatedInputTokens > remaining) {
      throw new ResourceLimitError('Estimated model input exceeds the remaining token budget', { estimatedInputTokens, remaining });
    }
    const remainingOutputTokens = finite(contract.budget.maxOutputTokens, Infinity)
      - Number(contract.usage.outputTokens ?? 0);
    const remainingDailyTokens = this.dailyRemaining(contract, 'tokens', 'maxTokens');
    if (estimatedInputTokens >= remainingDailyTokens) {
      throw new ResourceLimitError('Estimated model input exceeds a daily token quota', {
        estimatedInputTokens, remainingDailyTokens,
      });
    }
    const remainingCost = Math.min(
      finite(contract.budget.maxCostUsd, Infinity) - Number(contract.usage.costUsd ?? 0),
      this.dailyRemaining(contract, 'costUsd', 'maxCostUsd'),
    );
    const inputCost = estimatedInputTokens * Number(modelConfig.inputCostPerMillion ?? 0) / 1_000_000;
    if (inputCost > remainingCost) throw new ResourceLimitError('Estimated model input exceeds the remaining cost budget', { inputCost, remainingCost });
    const outputPrice = Number(modelConfig.outputCostPerMillion ?? 0) / 1_000_000;
    const costBoundOutput = outputPrice > 0 ? Math.floor(Math.max(0, remainingCost - inputCost) / outputPrice) : Infinity;
    const maxOutputTokens = Math.floor(Math.min(
      remainingOutputTokens,
      costBoundOutput,
      remainingDailyTokens - estimatedInputTokens,
    ));
    if (maxOutputTokens < 1) throw new ResourceLimitError('No model output budget remains');
    return { estimatedInputTokens, remaining, maxOutputTokens };
  }

  recordModelUsage({ goalId, usage, estimatedInputTokens = 0, estimatedOutputTokens = 0, modelConfig = {}, idempotencyKey }) {
    const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? estimatedInputTokens);
    const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? estimatedOutputTokens);
    const inputCost = inputTokens * Number(modelConfig.inputCostPerMillion ?? 0) / 1_000_000;
    const outputCost = outputTokens * Number(modelConfig.outputCostPerMillion ?? 0) / 1_000_000;
    const records = [
      ['inputTokens', inputTokens],
      ['outputTokens', outputTokens],
      ['tokens', inputTokens + outputTokens],
      ['costUsd', inputCost + outputCost],
      ['modelCalls', 1],
    ];
    return this.store.recordResourceUsageBatch(records.map(([resourceType, amount]) => ({
        goalId,
        resourceType,
        amount,
        idempotencyKey: `${idempotencyKey}:${resourceType}`,
        metadata: { model: modelConfig.model },
      })));
  }

  recordToolCall({ goalId, toolName, resourcePool, idempotencyKey }) {
    const contract = this.store.getGoalContract(goalId);
    this.assertExecutionTime(goalId);
    if (Number(contract?.usage.toolCalls ?? 0) >= finite(contract?.budget.maxToolCalls, Infinity)) {
      throw new ResourceLimitError('Goal tool-call budget is exhausted', { toolName });
    }
    if (this.dailyRemaining(contract, 'toolCalls', 'maxToolCalls') < 1) {
      throw new ResourceLimitError('A daily tool-call quota is exhausted', { toolName });
    }
    return this.store.recordResourceUsage({
      goalId,
      resourceType: 'toolCalls',
      amount: 1,
      idempotencyKey,
      metadata: { toolName, resourcePool },
    });
  }

  authorizeFanOut(parentGoalId, requestedCount, nextDepth) {
    const contract = this.store.getGoalContract(parentGoalId);
    if (!contract) throw new ResourceLimitError('Parent goal contract is missing');
    const existing = this.store.listGoals(10_000)
      .filter((goal) => goal.metadata.parentGoalId === parentGoalId).length;
    if (existing + requestedCount > finite(contract.budget.maxFanOut, 0)) {
      throw new ResourceLimitError('Child-goal fan-out budget would be exceeded', {
        existing,
        requestedCount,
        maximum: contract.budget.maxFanOut,
      });
    }
    if (nextDepth > finite(contract.budget.maxDepth, 0)) {
      throw new ResourceLimitError('Child-goal depth budget would be exceeded', {
        nextDepth,
        maximum: contract.budget.maxDepth,
      });
    }
    return true;
  }

  contextLimit(goalId) {
    const contract = this.store.getGoalContract(goalId);
    return Math.min(
      finite(contract?.budget.maxContextChars, this.config.session.maxContextChars),
      this.config.session.maxContextChars,
    );
  }

  dailyRemaining(contract, resourceType, limitKey) {
    const since = startOfUtcDay();
    const scopes = [
      { limits: this.config.resources.globalDaily },
      { limits: this.config.resources.agentDaily, tenantId: contract.tenant_id, agentId: contract.agent_id },
    ];
    return scopes.reduce((remaining, scope) => {
      const limit = finite(scope.limits?.[limitKey], Infinity);
      const used = this.store.aggregateResourceUsage({
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        resourceType,
        since,
      });
      return Math.min(remaining, Math.max(0, limit - used));
    }, Infinity);
  }

  executionTimeRemaining(taskOrGoalId) {
    const goalId = typeof taskOrGoalId === 'string' ? taskOrGoalId : taskOrGoalId.goal_id;
    const contract = this.store.getGoalContract(goalId);
    const goal = this.store.getGoal(goalId);
    if (!contract || !goal) return 0;
    const wallDeadline = goal.created_at + finite(contract.budget.maxWallTimeMs, Infinity);
    const executionDeadline = Math.min(contract.deadline_at ?? Infinity, wallDeadline);
    return executionDeadline - Date.now();
  }

  assertExecutionTime(goalId) {
    const remainingMs = this.executionTimeRemaining(goalId);
    if (remainingMs <= 0) throw new ResourceLimitError('Goal deadline or wall-time budget has expired', { remainingMs });
    return remainingMs;
  }
}
