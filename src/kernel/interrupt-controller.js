import { AsyncSignal } from './async-signal.js';

export class InterruptController {
  constructor({ store, scheduler, eventBus, config }) {
    this.store = store;
    this.scheduler = scheduler;
    this.eventBus = eventBus;
    this.config = config;
    this.signal = new AsyncSignal();
  }

  raise(input) {
    const interrupt = this.store.createInterrupt(input);
    this.eventBus.emit('change', {
      type: 'INTERRUPT_RAISED',
      data: { interruptId: interrupt.id, priority: interrupt.priority, goalId: interrupt.goal_id },
      at: Date.now(),
    });
    this.signal.notify(interrupt.id);
    return interrupt;
  }

  async run({ signal, heartbeat }) {
    while (!signal.aborted) {
      const dispatched = this.dispatchPending();
      const handled = this.store.reconcileInterrupts();
      heartbeat({ dispatched, handled, pending: this.store.listInterrupts({ status: 'PENDING' }).length });
      await this.signal.wait({ signal, timeoutMs: this.config.kernel.interruptPollMs });
    }
  }

  dispatchPending() {
    let dispatched = 0;
    for (const interrupt of this.store.listInterrupts({ status: 'PENDING', limit: 100 })) {
      const running = this.store.listAllTasks({ status: 'RUNNING', limit: 100 })
        .filter((task) => task.goal_id !== interrupt.goal_id)
        .filter((task) => !interrupt.target_task_id || task.id === interrupt.target_task_id)
        .filter((task) => interrupt.force || task.priority < interrupt.priority)
        .sort((left, right) => left.priority - right.priority || left.updated_at - right.updated_at);
      const target = running[0] ?? null;
      if (target) {
        this.store.requestTaskPreemption(target.id, interrupt.id, interrupt.reason);
        this.scheduler.signalTask(target.id, `Interrupt ${interrupt.id}`);
      }
      this.store.markInterruptDispatched(interrupt.id, target?.id ?? null);
      this.eventBus.emit('change', {
        type: 'INTERRUPT_DISPATCHED',
        data: { interruptId: interrupt.id, preemptedTaskId: target?.id ?? null, goalId: interrupt.goal_id },
        at: Date.now(),
      });
      dispatched += 1;
    }
    return dispatched;
  }
}
