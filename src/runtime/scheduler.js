import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export class Scheduler extends EventEmitter {
  constructor({ store, engine, eventBus, maxConcurrency = 3, tickMs = 200, leaseMs = 30_000, onTick }) {
    super();
    this.store = store;
    this.engine = engine;
    this.eventBus = eventBus;
    this.maxConcurrency = maxConcurrency;
    this.tickMs = tickMs;
    this.leaseMs = leaseMs;
    this.onTick = onTick;
    this.workerId = `runtime-${randomUUID().slice(0, 8)}`;
    this.active = new Set();
    this.inFlight = new Map();
    this.controllers = new Map();
    this.timer = null;
    this.stopping = false;
    this.draining = false;
    this.drainQueued = false;
    this.eventBus.on('event', () => this.requestDrain());
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    const recovered = this.store.recoverOrphanedTasks();
    const releasedClaims = this.store.releaseStaleResourceClaims();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    this.emitChange('RUNTIME_STARTED', { workerId: this.workerId, recovered, releasedClaims });
    this.tick();
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const taskId of this.active) {
      this.store.requestTaskPreemption(taskId, 'kernel:shutdown', 'Kernel shutdown requested a safe execution checkpoint');
      this.signalTask(taskId, 'Kernel is stopping');
    }
    await Promise.allSettled(this.inFlight.values());
    this.emitChange('RUNTIME_STOPPED', { workerId: this.workerId });
  }

  tick() {
    const expiredLeases = this.store.recoverExpiredLeases();
    const timers = this.store.wakeDueTimers();
    const expired = this.store.expireEventWaits();
    const releasedClaims = this.store.releaseStaleResourceClaims();
    this.onTick?.();
    if (timers.length || expired.length || expiredLeases.length || releasedClaims) {
      this.emitChange('WAIT_STATES_UPDATED', { timers, expired, expiredLeases, releasedClaims });
    }
    this.requestDrain();
  }

  requestDrain() {
    if (!this.timer || this.stopping || this.drainQueued) return;
    this.drainQueued = true;
    queueMicrotask(() => {
      this.drainQueued = false;
      this.drain();
    });
  }

  drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const capacity = this.maxConcurrency - this.active.size;
      if (capacity <= 0) return;
      const candidates = this.store.getReadyTasks(capacity * 2);
      for (const candidate of candidates) {
        if (this.active.size >= this.maxConcurrency) break;
        const admission = this.resourceKernel?.admitTask(candidate) ?? { ok: true };
        if (!admission.ok) {
          if (admission.retryAt) {
            this.store.deferReadyTask(candidate.id, admission.retryAt, admission.reason, { resource: admission.resource });
          } else {
            this.store.failTask(candidate.id, new Error(admission.reason), { retryable: false });
          }
          continue;
        }
        const claims = this.store.acquireResourceClaims(candidate.id, this.workerId);
        if (!claims.acquired) {
          this.store.deferReadyTask(candidate.id, Date.now() + Math.max(500, this.tickMs * 2), claims.reason, {
            conflicts: claims.conflicts?.map((claim) => ({ taskId: claim.task_id, scope: claim.scope, mode: claim.mode })) ?? [],
          });
          continue;
        }
        const task = this.store.claimTask(candidate.id, this.workerId, this.leaseMs);
        if (!task) {
          this.store.releaseResourceClaims(candidate.id, 'Task claim failed after semantic resource admission');
          continue;
        }
        this.active.add(task.id);
        this.emitChange('TASK_CLAIMED', { taskId: task.id, goalId: task.goal_id });
        const execution = this.runTask(task);
        this.inFlight.set(task.id, execution);
        execution.finally(() => this.inFlight.delete(task.id));
      }
    } finally {
      this.draining = false;
    }
  }

  async runTask(task) {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const remainingMs = this.resourceKernel?.executionTimeRemaining(task) ?? Infinity;
    const budgetTimer = Number.isFinite(remainingMs)
      ? setTimeout(() => {
          const error = new Error('Goal deadline or wall-time budget expired during execution');
          error.code = 'RESOURCE_LIMIT';
          controller.abort(error);
        }, Math.max(1, remainingMs))
      : null;
    budgetTimer?.unref?.();
    const renewEvery = Math.max(1_000, Math.floor(this.leaseMs / 3));
    const leaseTimer = setInterval(() => {
      this.store.renewLease(task.id, task.lease_token, this.leaseMs);
    }, renewEvery);
    leaseTimer.unref?.();
    try {
      await this.engine.executeTurn(task, { signal: controller.signal });
    } catch (error) {
      const current = this.store.getTask(task.id);
      const control = this.store.getTaskControl(task.id);
      if (controller.signal.aborted && current?.status === 'RUNNING') {
        if (control?.cancel_requested) {
          this.store.cancelRunningTask(task.id, current.snapshot, task.lease_token);
        } else if (control?.pause_requested) {
          this.store.pauseRunningTask(task.id, current.snapshot, task.lease_token);
        } else if (control?.preempt_requested) {
          this.store.preemptRunningTask(task.id, current.snapshot, task.lease_token);
        } else {
          this.store.failTask(task.id, error, {
            retryable: error?.code !== 'RESOURCE_LIMIT', leaseToken: task.lease_token,
          });
        }
      } else {
        this.store.failTask(task.id, error, {
          retryable: !['RESOURCE_LIMIT', 'CAPABILITY_DENIED'].includes(error?.code),
          leaseToken: task.lease_token,
        });
      }
    } finally {
      clearInterval(leaseTimer);
      if (budgetTimer) clearTimeout(budgetTimer);
      this.controllers.delete(task.id);
      this.active.delete(task.id);
      this.store.releaseResourceClaims(task.id);
      const current = this.store.getTask(task.id);
      const goal = this.store.getGoal(task.goal_id);
      if (goal && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(goal.status)) {
        this.eventBus.publish({
          topic: 'goal.completed',
          correlationKey: goal.id,
          payload: { goalId: goal.id, status: goal.status },
          source: 'scheduler',
          idempotencyKey: `goal-terminal:${goal.id}:${goal.status}`,
          tenantId: goal.tenant_id,
          agentId: goal.agent_id,
          authenticated: true,
          authSubject: 'kernel:scheduler',
        });
      }
      this.emitChange('TASK_STATE_CHANGED', {
        taskId: task.id,
        goalId: task.goal_id,
        status: current?.status,
      });
      this.requestDrain();
    }
  }

  signalTask(taskId, reason = 'Task control signal') {
    const controller = this.controllers.get(taskId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new Error(reason));
    return true;
  }

  emitChange(type, data) {
    const update = { type, data, at: Date.now(), stats: this.store.getStats() };
    this.emit('change', update);
    this.eventBus.emit('change', update);
  }
}
