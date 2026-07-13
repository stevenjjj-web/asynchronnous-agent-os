import { waitForAbort } from './async-signal.js';

const REPAIR_PREFIX = 'plan-repair:';

function repairProvenance(assumptionId, eventId) {
  return `${REPAIR_PREFIX}${assumptionId}:${eventId}`;
}

function isRepairGoal(goal) {
  return String(goal?.metadata?.createdBy ?? '').startsWith(REPAIR_PREFIX);
}

function narrowRepairCapabilities(parent = {}) {
  const allowed = (values, candidate) => values?.includes('*') || values?.includes(candidate);
  const tools = ['memory_search', 'goal_status', 'kernel_status', 'monitor_status', 'workspace_list', 'workspace_read', 'plan_assume']
    .filter((name) => allowed(parent.tools, name));
  const resourcePools = ['default', 'memory', 'filesystem']
    .filter((name) => allowed(parent.resourcePools, name));
  const operations = ['list', 'read'].filter((name) => allowed(parent.filesystem?.operations, name));
  return {
    tools,
    resourcePools,
    filesystem: { roots: parent.filesystem?.roots ?? [], operations },
    network: { domains: [], methods: [] },
    accounts: {},
    dataScopes: parent.dataScopes ?? [],
    credentialRefs: [],
  };
}

export class PlanRepairService {
  constructor({ store, eventBus, sessions, config }) {
    this.store = store;
    this.eventBus = eventBus;
    this.sessions = sessions;
    this.config = config;
    this.started = false;
    this.pending = new Set();
    this.onEvent = (result) => {
      if (result?.duplicate || !result?.event) return;
      const job = this.process(result.event)
        .catch((error) => this.recordFailure(result.event, error))
        .finally(() => this.pending.delete(job));
      this.pending.add(job);
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.eventBus.on('event', this.onEvent);
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    this.eventBus.off('event', this.onEvent);
    await Promise.allSettled([...this.pending]);
  }

  async run({ signal, heartbeat }) {
    this.start();
    const report = () => heartbeat({ pendingRepairs: this.pending.size });
    const timer = setInterval(report, this.config.kernel.heartbeatMs);
    report();
    try {
      await waitForAbort(signal);
    } finally {
      clearInterval(timer);
      await this.stop();
    }
  }

  async process(event) {
    if (event.topic === 'goal.completed') this.completeRepair(event);
    const invalidations = this.store.invalidateAssumptionsForEvent(event);
    for (const invalidation of invalidations) await this.startRepair(invalidation);
  }

  async startRepair({ goal, assumption, event }) {
    if (!goal || goal.status !== 'ACTIVE') return null;
    const provenance = repairProvenance(assumption.id, event.id);
    const existing = this.store.listGoals(10_000).find((candidate) => (
      candidate.metadata.createdBy === provenance
      && candidate.metadata.parentGoalId === goal.id
    ));
    if (existing) return existing;
    const session = goal.session_id ? this.store.getSession(goal.session_id) : null;
    if (!session) {
      this.store.appendAudit(goal.id, null, 'PLAN_REPAIR_BLOCKED', 'Plan repair requires an owning session', {
        assumptionId: assumption.id,
        eventId: event.id,
      });
      return null;
    }
    const parentContract = this.store.getGoalContract(goal.id);
    const previous = this.store.listPlanVersions(goal.id, 1)[0] ?? null;
    try {
      const accepted = await this.sessions.submit({
        sessionKey: session.session_key,
        parentGoalId: goal.id,
        text: [
          'Repair the parent goal plan after a falsifiable assumption was invalidated.',
          `Parent goal: ${goal.objective}`,
          `Invalidated assumption: ${assumption.statement}`,
          `Observation topic: ${event.topic}`,
          `Observation payload: ${JSON.stringify(event.payload ?? {})}`,
          'Determine which conclusions and pending steps are affected, preserve unaffected work, and propose the smallest safe plan revision.',
          'Record any new long-lived assumptions with plan_assume. Do not repeat completed side effects.',
        ].join(' '),
        messageId: provenance,
        provenance,
        cognitiveRepair: { assumptionId: assumption.id, eventId: event.id, parentGoalId: goal.id },
        priority: 95,
        deadlineAt: parentContract?.deadline_at ?? undefined,
        budget: {
          maxInputTokens: Math.min(12_000, Number(parentContract?.budget?.maxInputTokens ?? 12_000)),
          maxOutputTokens: Math.min(2_500, Number(parentContract?.budget?.maxOutputTokens ?? 2_500)),
          maxCostUsd: Math.min(0.25, Number(parentContract?.budget?.maxCostUsd ?? 0.25)),
          maxToolCalls: Math.min(8, Number(parentContract?.budget?.maxToolCalls ?? 8)),
          maxWallTimeMs: Math.min(300_000, Number(parentContract?.budget?.maxWallTimeMs ?? 300_000)),
          maxContextChars: Math.min(30_000, Number(parentContract?.budget?.maxContextChars ?? 30_000)),
          maxFanOut: 0,
          maxDepth: Math.min(1, Number(parentContract?.budget?.maxDepth ?? 1)),
        },
        capabilities: narrowRepairCapabilities(parentContract?.capabilities),
        resourceClaims: goal.metadata.resourceClaims ?? [],
      });
      this.store.addPlanVersion(goal.id, {
        objective: goal.objective,
        state: 'repairing',
        previousPlanVersionId: previous?.id ?? null,
        repairGoalId: accepted.goal.id,
        invalidatedAssumptionId: assumption.id,
        triggeringEventId: event.id,
      }, {
        type: 'assumption-invalidated',
        assumptionId: assumption.id,
        eventId: event.id,
        repairGoalId: accepted.goal.id,
      }, 'REPAIRING');
      this.store.appendAudit(goal.id, null, 'PLAN_REPAIR_STARTED', 'A bounded cognitive repair thread was created', {
        repairGoalId: accepted.goal.id,
        assumptionId: assumption.id,
        eventId: event.id,
      });
      return accepted.goal;
    } catch (error) {
      this.store.appendAudit(goal.id, null, 'PLAN_REPAIR_BLOCKED', error.message, {
        assumptionId: assumption.id,
        eventId: event.id,
        code: error.code ?? null,
      });
      return null;
    }
  }

  completeRepair(event) {
    const repairGoal = this.store.getGoal(event.correlation_key ?? event.payload?.goalId);
    if (!isRepairGoal(repairGoal)) return null;
    const parentGoal = this.store.getGoal(repairGoal.metadata.parentGoalId);
    if (!parentGoal) return null;
    const existing = this.store.listPlanVersions(parentGoal.id, 100).find((version) => (
      version.trigger?.type === 'repair-completed'
      && version.trigger?.repairGoalId === repairGoal.id
    ));
    if (existing) return existing;
    const assumptionId = repairGoal.metadata.cognitiveRepair?.assumptionId;
    const triggeringEventId = repairGoal.metadata.cognitiveRepair?.eventId;
    if (!assumptionId || !triggeringEventId) return null;
    const repairingVersion = this.store.listPlanVersions(parentGoal.id, 100).find((version) => (
      version.status === 'REPAIRING' && version.trigger?.repairGoalId === repairGoal.id
    ));
    const turn = this.store.listTasks(repairGoal.id).find((task) => task.kind === 'agent-turn');
    const response = turn?.result?.response ?? turn?.result ?? turn?.snapshot?.variables?.response ?? null;
    if (repairGoal.status !== 'SUCCEEDED') {
      if (repairingVersion) this.store.setPlanVersionStatus(repairingVersion.id, 'REPAIR_FAILED');
      this.store.appendAudit(parentGoal.id, null, 'PLAN_REPAIR_FAILED', 'The cognitive repair thread did not complete successfully', {
        repairGoalId: repairGoal.id,
        status: repairGoal.status,
      });
      return null;
    }
    if (repairingVersion) this.store.setPlanVersionStatus(repairingVersion.id, 'REPAIRED');
    const version = this.store.addPlanVersion(parentGoal.id, {
      objective: parentGoal.objective,
      state: 'repaired',
      repairGoalId: repairGoal.id,
      invalidatedAssumptionId: assumptionId,
      triggeringEventId,
      revision: response,
      preservedExecution: this.store.listTasks(parentGoal.id).map((task) => ({
        taskId: task.id,
        status: task.status,
        checkpointPc: Number(task.snapshot?.pc ?? 0),
      })),
    }, {
      type: 'repair-completed',
      repairGoalId: repairGoal.id,
      assumptionId,
      eventId: triggeringEventId,
    }, 'CURRENT');
    this.store.injectCognitiveNotice(parentGoal.id, {
      id: `plan-revision:${repairGoal.id}`,
      type: 'plan-revision',
      content: [
        `Plan version ${version.version} supersedes the stale plan after assumption ${assumptionId} was invalidated.`,
        `Repair result: ${response?.text ?? JSON.stringify(response)}`,
        'Preserve completed work and side effects. Re-evaluate only pending decisions affected by this update.',
      ].join('\n'),
      data: { planVersionId: version.id, repairGoalId: repairGoal.id, assumptionId, triggeringEventId },
    });
    this.store.appendAudit(parentGoal.id, null, 'PLAN_REPAIR_COMPLETED', 'The revised plan preserved completed work and current checkpoints', {
      repairGoalId: repairGoal.id,
      version: version.version,
    });
    return version;
  }

  recordFailure(event, error) {
    const goalId = event?.payload?.goalId;
    if (goalId && this.store.getGoal(goalId)) {
      this.store.appendAudit(goalId, null, 'PLAN_REPAIR_SERVICE_ERROR', error.message, { eventId: event.id });
    }
  }
}
