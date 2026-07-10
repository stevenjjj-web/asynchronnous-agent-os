import { randomUUID } from 'node:crypto';
import { AsyncSignal } from './async-signal.js';

const CONTROL_KEY = 'cognition.control';
const CYCLE_KEY = 'cognition.lastCycle';

export class CognitionService {
  constructor({ store, sessions, eventBus, config, modelAvailable }) {
    this.store = store;
    this.sessions = sessions;
    this.eventBus = eventBus;
    this.config = config;
    this.modelAvailable = modelAvailable;
    this.signal = new AsyncSignal();
    this.lastActivityAt = Date.now();
    this.onChange = (update) => {
      if (['SYSTEM_PULSE', 'COGNITION_STATUS', 'EVENT_PUBLISHED'].includes(update?.type)) return;
      this.lastActivityAt = Date.now();
    };
  }

  getControl() {
    return {
      enabled: this.config.cognition.enabled,
      autoReflect: this.config.cognition.autoReflect,
      ...this.store.getSystemState(CONTROL_KEY)?.value,
    };
  }

  configure(patch) {
    const control = { ...this.getControl(), ...patch, updatedAt: Date.now() };
    this.store.setSystemState(CONTROL_KEY, control);
    this.signal.notify('configuration');
    return control;
  }

  requestReflection() {
    const control = this.configure({ enabled: true, forceRequestedAt: Date.now() });
    this.signal.notify('forced-reflection');
    return control;
  }

  status() {
    return {
      control: this.getControl(),
      lastCycle: this.store.getSystemState(CYCLE_KEY)?.value ?? null,
      lastActivityAt: this.lastActivityAt,
    };
  }

  async run({ signal, heartbeat }) {
    this.eventBus.on('change', this.onChange);
    try {
      while (!signal.aborted) {
        const control = this.getControl();
        const forced = Boolean(control.forceRequestedAt);
        const result = await this.tick({ control, forced });
        if (forced) this.configure({ forceRequestedAt: null });
        heartbeat({ ...this.status(), lastDecision: result });
        const interval = Math.min(
          this.config.kernel.heartbeatMs,
          60_000,
          Math.max(250, Math.floor(this.config.cognition.idleAfterMs / 4)),
        );
        await this.signal.wait({ signal, timeoutMs: interval });
      }
    } finally {
      this.eventBus.off('change', this.onChange);
    }
  }

  async tick({ control, forced = false }) {
    const timestamp = Date.now();
    if (!control.enabled && !forced) return { action: 'dormant', at: timestamp };
    const stats = this.store.getStats();
    const runnable = (stats.tasks.READY ?? 0) + (stats.tasks.RUNNING ?? 0);
    if (runnable > 0) return { action: 'defer-active-work', runnable, at: timestamp };
    if (!forced && timestamp - this.lastActivityAt < this.config.cognition.idleAfterMs) {
      return { action: 'defer-not-idle', at: timestamp };
    }
    const lastCycle = this.store.getSystemState(CYCLE_KEY)?.value;
    if (!forced && lastCycle?.at && timestamp - lastCycle.at < this.config.cognition.intervalMs) {
      return { action: 'defer-cooldown', at: timestamp };
    }

    const cycleId = randomUUID();
    const base = { id: cycleId, at: timestamp, forced, autoReflect: Boolean(control.autoReflect) };
    this.eventBus.publish({
      topic: 'cognition.idle',
      correlationKey: 'kernel',
      payload: base,
      source: 'cognition-loop',
      idempotencyKey: `cognition-cycle:${cycleId}`,
    });

    if (!control.autoReflect) {
      const result = { ...base, action: 'observed-idle' };
      this.store.setSystemState(CYCLE_KEY, result);
      return result;
    }
    if (this.config.cognition.requireModel && !this.modelAvailable()) {
      const result = { ...base, action: 'skipped-model-unavailable' };
      this.store.setSystemState(CYCLE_KEY, result);
      return result;
    }

    const date = new Date(timestamp).toISOString().slice(0, 10);
    const budgetKey = `cognition.budget:${date}`;
    const budget = this.store.getSystemState(budgetKey)?.value ?? { used: 0 };
    if (budget.used >= this.config.cognition.dailyGoalBudget) {
      const result = { ...base, action: 'skipped-daily-budget', used: budget.used };
      this.store.setSystemState(CYCLE_KEY, result);
      return result;
    }

    const session = this.sessions.getOrCreate({
      agentId: 'main',
      channel: 'internal',
      peerKey: 'cognition-loop',
      metadata: { system: true, cognition: true },
    });
    const accepted = await this.sessions.submit({
      sessionKey: session.session_key,
      text: [
        'Run a bounded idle cognition cycle.',
        'Review open goals, recent durable events, waiting work, and relevant long-term memory.',
        'Identify at most one useful low-risk follow-up. Do not perform irreversible actions.',
        'If nothing merits action, state that clearly and finish without creating more work.',
      ].join(' '),
      messageId: `cognition:${cycleId}`,
      provenance: 'cognition-loop',
      priority: 30,
    });
    this.store.setSystemState(budgetKey, { used: budget.used + 1, updatedAt: timestamp });
    const result = { ...base, action: 'reflection-goal-created', goalId: accepted.goal.id };
    this.store.setSystemState(CYCLE_KEY, result);
    return result;
  }
}
