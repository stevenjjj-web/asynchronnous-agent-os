const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

function latestCheckpoint(task) {
  const checkpoint = task.snapshot?.checkpoints?.at(-1);
  return {
    pc: Number(task.snapshot?.pc ?? 0),
    totalSteps: task.workflow.length,
    revision: task.revision,
    at: checkpoint?.at ?? task.updated_at,
    step: checkpoint?.step ?? task.workflow[task.snapshot?.pc]?.type ?? null,
    detail: checkpoint ?? null,
  };
}

function waitDescription(task) {
  if (task.wait_kind === 'EVENT') {
    return {
      kind: 'event',
      topic: task.wait_topic,
      correlationKey: task.wait_key,
      deadlineAt: task.wake_at,
    };
  }
  if (task.wait_kind === 'TIMER') return { kind: 'timer', wakeAt: task.wake_at };
  return null;
}

function capabilitySummary(contract) {
  const capabilities = contract?.capabilities ?? {};
  return {
    status: contract?.capability_status ?? 'MISSING',
    expiresAt: contract?.capability_expires_at ?? null,
    tools: capabilities.tools ?? [],
    resourcePools: capabilities.resourcePools ?? [],
    filesystemRoots: capabilities.filesystem?.roots ?? [],
    networkDomains: capabilities.network?.domains ?? [],
    accounts: capabilities.accounts ?? {},
    credentialRefs: capabilities.credentialRefs ?? [],
  };
}

function evidenceFromTask(task) {
  const response = task.result?.response ?? task.result ?? task.snapshot?.variables?.response;
  const evidence = response?.evidence ?? [];
  return evidence.map((item, index) => ({
    id: item.id ?? `${task.id}:evidence:${index + 1}`,
    taskId: task.id,
    sourceType: item.sourceType ?? 'tool',
    source: item.source ?? item.tool ?? 'unknown',
    observedAt: item.observedAt ?? task.updated_at,
    digest: item.digest ?? null,
    excerpt: item.excerpt ?? null,
  }));
}

export class ObservabilityKernel {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
  }

  explainTask(taskOrId) {
    const task = typeof taskOrId === 'string' ? this.store.getTask(taskOrId) : taskOrId;
    if (!task) return null;
    const goal = this.store.getGoal(task.goal_id);
    const contract = this.store.getGoalContract(task.goal_id);
    const modelConfig = this.config?.models?.[goal?.metadata?.modelKey];
    const pricingKnown = modelConfig?.provider === 'offline'
      || Number(modelConfig?.inputCostPerMillion ?? 0) > 0
      || Number(modelConfig?.outputCostPerMillion ?? 0) > 0;
    const audit = this.store.listAudit({ taskId: task.id, limit: 100 });
    const latest = audit[0] ?? null;
    const preemption = audit.find((entry) => ['TASK_PREEMPTED', 'PREEMPT_REQUESTED'].includes(entry.type)) ?? null;
    const dependencies = task.dependsOn.map((id) => {
      const dependency = this.store.getTask(id);
      return dependency ? { id: dependency.id, title: dependency.title, status: dependency.status } : { id, status: 'MISSING' };
    });
    const declaredClaims = (goal?.metadata?.resourceClaims
      ?? (goal?.metadata?.conflictKeys ?? []).map((scope) => ({ scope, mode: 'exclusive' })))
      .map((claim) => typeof claim === 'string' ? { scope: claim, mode: 'exclusive' } : claim);
    const claimHistory = this.store.listResourceClaims({ taskId: task.id, limit: 20 });
    let reason = latest?.message ?? 'No lifecycle explanation has been recorded yet';
    if (task.status === 'WAITING' && task.wait_kind === 'EVENT') reason = `Waiting for ${task.wait_topic} · ${task.wait_key}`;
    if (task.status === 'WAITING' && task.wait_kind === 'TIMER') reason = `Sleeping until ${new Date(task.wake_at).toISOString()}`;
    if (task.status === 'BLOCKED') {
      const pending = dependencies.filter((item) => item.status !== 'SUCCEEDED');
      reason = pending.length ? `Blocked by ${pending.map((item) => item.title ?? item.id).join(', ')}` : reason;
    }
    if (task.status === 'RUNNING') reason = `${latest?.message ?? 'Execution slot acquired'} · worker ${task.lease_owner ?? 'unknown'}`;
    if (task.status === 'READY' && preemption && preemption.created_at >= (latest?.created_at ?? 0)) reason = preemption.message;
    return {
      id: task.id,
      goalId: task.goal_id,
      goalTitle: goal?.title ?? null,
      title: task.title,
      kind: task.kind,
      status: task.status,
      priority: task.priority,
      reason,
      checkpoint: latestCheckpoint(task),
      wait: waitDescription(task),
      dependencies,
      usage: contract?.usage ?? {},
      pricing: {
        status: pricingKnown ? 'configured' : 'unpriced',
        inputCostPerMillion: modelConfig?.inputCostPerMillion ?? null,
        outputCostPerMillion: modelConfig?.outputCostPerMillion ?? null,
      },
      budget: contract?.budget ?? {},
      resourceClaims: {
        declared: declaredClaims,
        held: claimHistory.filter((claim) => claim.status === 'HELD'),
        recent: claimHistory,
      },
      capabilities: capabilitySummary(contract),
      preemption: preemption ? {
        reason: preemption.message,
        interruptId: preemption.data.interruptId ?? task.preempted_by ?? null,
        at: preemption.created_at,
        count: task.preemption_count,
      } : null,
      latestAudit: latest,
      evidence: evidenceFromTask(task),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    };
  }

  taskManager({ includeTerminal = false, limit = 100, tenantId } = {}) {
    const tasks = this.store.listAllTasks({ limit: Math.max(limit * 3, limit) })
      .filter((task) => !tenantId || this.store.getGoal(task.goal_id)?.tenant_id === tenantId)
      .filter((task) => includeTerminal || !TERMINAL.has(task.status))
      .slice(0, limit)
      .map((task) => this.explainTask(task));
    const totals = tasks.reduce((result, task) => {
      result[task.status] = (result[task.status] ?? 0) + 1;
      return result;
    }, {});
    return { generatedAt: Date.now(), totals, threads: tasks };
  }

  traceGoal(goalId) {
    const goal = this.store.getGoal(goalId);
    if (!goal) return null;
    const contract = this.store.getGoalContract(goalId);
    const tasks = this.store.listTasks(goalId);
    const audit = this.store.listAudit({ goalId, limit: 1_000 }).reverse();
    const evidence = tasks.flatMap(evidenceFromTask);
    const conclusionTask = tasks.find((task) => task.kind === 'agent-turn');
    const conclusionValue = conclusionTask?.result?.response ?? conclusionTask?.result ?? conclusionTask?.snapshot?.variables?.response;
    const planVersions = this.store.listPlanVersions(goalId, 100);
    const assumptions = this.store.listGoalAssumptions(goalId, { limit: 200 });
    const resourceClaims = this.store.listResourceClaims({ goalId, limit: 500 });
    return {
      goal,
      contract,
      cognition: {
        planVersions,
        assumptions,
        resourceClaims,
      },
      dag: {
        nodes: tasks.map((task) => this.explainTask(task)),
        edges: tasks.flatMap((task) => task.dependsOn.map((dependencyId) => ({
          from: dependencyId,
          to: task.id,
          type: 'depends_on',
        }))),
      },
      causalChain: audit.map((entry, index) => ({
        sequence: index + 1,
        auditId: entry.id,
        taskId: entry.task_id,
        type: entry.type,
        message: entry.message,
        data: entry.data,
        at: entry.created_at,
      })),
      conclusion: conclusionValue?.text ? {
        text: conclusionValue.text,
        evidenceIds: evidence.map((item) => item.id),
        provenanceLevel: evidence.length ? 'execution-context' : 'unattributed',
      } : null,
      evidence,
    };
  }
}
