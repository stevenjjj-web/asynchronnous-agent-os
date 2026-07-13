import { Store } from '../infra/store.js';
import { createDefaultActions } from './action-registry.js';
import { PersistentEventBus } from './event-bus.js';
import { IntentPlanner } from './planner.js';
import { Scheduler } from './scheduler.js';
import { WorkflowEngine } from './workflow-engine.js';

export class AgentRuntime {
  constructor({ database = ':memory:', maxConcurrency = 3, tickMs = 200, leaseMs = 30_000, planner, onTick } = {}) {
    this.store = new Store(database);
    this.eventBus = new PersistentEventBus(this.store);
    this.planner = planner ?? new IntentPlanner();
    this.actions = createDefaultActions(this.store);
    this.engine = new WorkflowEngine({ store: this.store, eventBus: this.eventBus, actions: this.actions });
    this.scheduler = new Scheduler({
      store: this.store,
      engine: this.engine,
      eventBus: this.eventBus,
      maxConcurrency,
      tickMs,
      leaseMs,
      onTick,
    });
  }

  start() {
    this.scheduler.start();
    return this;
  }

  async createGoal(objective, options = {}) {
    const plan = await this.planner.compile(objective, options);
    if (options.contract) {
      plan.goal.contract = options.contract;
      plan.goal.tenantId = options.contract.tenantId;
      plan.goal.deadlineAt = options.contract.deadlineAt;
      plan.goal.agentId = options.contract.agentId;
    }
    const created = this.store.createGoalWithTasks(plan.goal, plan.tasks);
    this.eventBus.emit('change', {
      type: 'GOAL_CREATED',
      data: { goalId: created.goal.id },
      at: Date.now(),
      stats: this.store.getStats(),
    });
    this.scheduler.requestDrain();
    return this.store.getGoalView(created.goal.id);
  }

  publishEvent(event) {
    const result = this.eventBus.publish(event);
    this.scheduler.requestDrain();
    return result;
  }

  async stop() {
    await this.scheduler.stop();
    this.store.close();
  }
}
