import { waitForAbort } from './async-signal.js';
import { ServiceSupervisor } from './service-supervisor.js';

export class KernelDaemon {
  constructor({ store, scheduler, housekeeping, interrupts, cognition, planRepair, listeners, config }) {
    this.config = config;
    this.scheduler = scheduler;
    this.supervisor = new ServiceSupervisor({
      store,
      heartbeatMs: config.kernel.heartbeatMs,
      serviceTimeoutMs: config.kernel.serviceTimeoutMs,
    });

    this.supervisor
      .register('scheduler', async ({ signal, heartbeat }) => {
        this.scheduler.start();
        const timer = setInterval(() => heartbeat({
          workerId: this.scheduler.workerId,
          activeExecutions: this.scheduler.active.size,
        }), config.kernel.heartbeatMs);
        try {
          heartbeat({ workerId: this.scheduler.workerId, activeExecutions: 0 });
          await waitForAbort(signal);
        } finally {
          clearInterval(timer);
          await this.scheduler.stop();
        }
      }, { role: 'ready-queue-and-task-execution' })
      .register('io-reactor', async ({ signal, heartbeat }) => {
        while (!signal.aborted) {
          await housekeeping();
          heartbeat({ cycleAt: Date.now() });
          await new Promise((resolve) => {
            const timeout = setTimeout(resolve, config.kernel.housekeepingMs);
            signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              resolve();
            }, { once: true });
          });
        }
      }, { role: 'monitors-schedules-and-outbox' })
      .register('interrupt-reactor', (context) => interrupts.run(context), {
        role: 'durable-interrupt-dispatch-and-preemption',
      })
      .register('cognition-loop', (context) => cognition.run(context), {
        role: 'idle-attention-and-budgeted-reflection',
      })
      .register('plan-repair-reactor', (context) => planRepair.run(context), {
        role: 'assumption-invalidation-and-bounded-cognitive-repair',
      });
    this.listeners = listeners;
    this.listenersRegistered = false;
  }

  start() {
    if (!this.listenersRegistered) {
      for (const listener of this.listeners.definitions()) {
        this.supervisor.register(listener.name, listener.run, listener.metadata);
      }
      this.listenersRegistered = true;
    }
    this.supervisor.start();
    return this;
  }

  status() {
    return this.supervisor.status();
  }

  stop() {
    return this.supervisor.stop();
  }
}
