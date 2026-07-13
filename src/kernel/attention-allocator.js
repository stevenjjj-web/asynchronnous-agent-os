function intersection(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

export class AttentionAllocator {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
  }

  assess(agentId = 'main', tenantId = this.config.security.tenantId) {
    const timestamp = Date.now();
    const activeGoals = this.store.listGoals(10_000)
      .filter((goal) => goal.agent_id === agentId && goal.tenant_id === tenantId && goal.status === 'ACTIVE');
    const tasks = activeGoals.flatMap((goal) => this.store.listTasks(goal.id));
    const horizon = this.config.cognition.deadlineHorizonMs;
    const deadlineRisks = activeGoals
      .filter((goal) => goal.deadline_at)
      .map((goal) => ({ goalId: goal.id, slackMs: goal.deadline_at - timestamp }))
      .filter((item) => item.slackMs <= horizon);
    const deadlineSeverity = deadlineRisks.reduce((maximum, item) => {
      if (item.slackMs <= 0) return 1;
      return Math.max(maximum, 1 - item.slackMs / horizon);
    }, 0);

    const drifted = tasks.filter((task) => task.failure_count > 0 || task.preemption_count > 1);
    const stalePlans = activeGoals.map((goal) => ({ goal, plan: this.store.listPlanVersions(goal.id, 1)[0] }))
      .filter((item) => ['STALE', 'REPAIRING', 'REPAIR_FAILED'].includes(item.plan?.status));
    const driftSeverity = Math.min(1, drifted.reduce((sum, task) => (
      sum + task.failure_count * 0.25 + task.preemption_count * 0.1
    ), 0) + stalePlans.length * 0.35);

    const lastAssessmentAt = this.store.listAttentionAssessments({ agentId, tenantId, limit: 1 })[0]?.created_at ?? 0;
    const observations = this.store.listEvents({ topic: 'monitor.changed', limit: 200 })
      .filter((event) => event.created_at > lastAssessmentAt)
      .filter((event) => !event.tenant_id || event.tenant_id === tenantId)
      .filter((event) => !event.agent_id || event.agent_id === agentId);
    const invalidatedAssumptions = activeGoals.flatMap((goal) => this.store.listGoalAssumptions(goal.id, {
      status: 'INVALIDATED', limit: 100,
    })).filter((assumption) => assumption.updated_at > lastAssessmentAt);
    const observationSeverity = Math.min(1, (observations.length + invalidatedAssumptions.length) / 3);

    const longBlocked = tasks.filter((task) => (
      ['WAITING', 'BLOCKED'].includes(task.status)
      && timestamp - task.updated_at >= this.config.cognition.blockedAfterMs
    ));
    const blockedSeverity = Math.min(1, longBlocked.length / 2);

    const conflicts = [];
    for (let leftIndex = 0; leftIndex < activeGoals.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < activeGoals.length; rightIndex += 1) {
        const left = activeGoals[leftIndex];
        const right = activeGoals[rightIndex];
        const explicit = intersection(left.metadata.conflictKeys, right.metadata.conflictKeys);
        const leftClaims = (left.metadata.resourceClaims ?? []).map((claim) => (
          typeof claim === 'string' ? { scope: claim, mode: 'exclusive' } : claim
        ));
        const rightClaims = (right.metadata.resourceClaims ?? []).map((claim) => (
          typeof claim === 'string' ? { scope: claim, mode: 'exclusive' } : claim
        ));
        const claimConflicts = leftClaims.flatMap((leftClaim) => rightClaims
          .filter((rightClaim) => rightClaim.scope === leftClaim.scope)
          .filter((rightClaim) => String(leftClaim.mode ?? 'exclusive').toLowerCase() === 'exclusive'
            || String(rightClaim.mode ?? 'exclusive').toLowerCase() === 'exclusive')
          .map((rightClaim) => `${leftClaim.scope}:${leftClaim.mode ?? 'exclusive'}/${rightClaim.mode ?? 'exclusive'}`));
        const leftAccounts = this.store.getGoalContract(left.id)?.capabilities.accounts ?? {};
        const rightAccounts = this.store.getGoalContract(right.id)?.capabilities.accounts ?? {};
        const accountConflicts = Object.keys(leftAccounts).flatMap((type) => (
          intersection(leftAccounts[type], rightAccounts[type]).map((account) => `${type}:${account}`)
        ));
        if (explicit.length || claimConflicts.length || accountConflicts.length) {
          conflicts.push({ leftGoalId: left.id, rightGoalId: right.id, scopes: [...explicit, ...claimConflicts, ...accountConflicts] });
        }
      }
    }
    const conflictSeverity = Math.min(1, conflicts.length / 2);

    const weights = this.config.cognition.weights;
    const components = {
      deadline: deadlineSeverity * weights.deadline,
      drift: driftSeverity * weights.drift,
      observation: observationSeverity * weights.observation,
      conflict: conflictSeverity * weights.conflict,
      blocked: blockedSeverity * weights.blocked,
    };
    const score = Math.min(100, Object.values(components).reduce((sum, value) => sum + value, 0));
    const estimatedCost = this.config.cognition.estimatedReflectionCostUsd;
    const expectedValue = score * this.config.cognition.valuePerPointUsd;
    const decision = {
      shouldWake: score >= this.config.cognition.attentionThreshold && expectedValue > estimatedCost,
      critical: score >= this.config.cognition.criticalThreshold,
      reason: this.primaryReason(components),
    };
    const signals = {
      activeGoalCount: activeGoals.length,
      runnableCount: tasks.filter((task) => ['READY', 'RUNNING'].includes(task.status)).length,
      deadlineRisks,
      driftedTaskIds: drifted.map((task) => task.id),
      stalePlanGoalIds: stalePlans.map((item) => item.goal.id),
      newObservationIds: observations.map((event) => event.id),
      invalidatedAssumptionIds: invalidatedAssumptions.map((assumption) => assumption.id),
      conflicts,
      longBlockedTaskIds: longBlocked.map((task) => task.id),
      components,
    };
    return this.store.addAttentionAssessment({
      agentId,
      tenantId,
      score,
      expectedValue,
      estimatedCost,
      signals,
      decision,
    });
  }

  primaryReason(components) {
    const [reason, value] = Object.entries(components).sort((left, right) => right[1] - left[1])[0] ?? ['idle', 0];
    return value > 0 ? reason : 'no-material-change';
  }
}
