export class ActionRegistry {
  constructor() {
    this.actions = new Map();
  }

  register(name, handler) {
    if (this.actions.has(name)) throw new Error(`Action already registered: ${name}`);
    this.actions.set(name, handler);
    return this;
  }

  async execute(name, input, context) {
    const handler = this.actions.get(name);
    if (!handler) throw new Error(`Unknown workflow action: ${name}`);
    return handler(input, context);
  }
}

export function createDefaultActions(store) {
  return new ActionRegistry()
    .register('collect_context', async ({ objective }) => ({
      summary: `Collected internal context and constraints for "${objective}"`,
      sources: ['request context', 'execution history', 'current system boundaries'],
      confidence: 0.82,
    }))
    .register('analyze_risks', async ({ objective }) => ({
      summary: `Completed a risk preflight for "${objective}"`,
      items: [
        { risk: 'Delayed external reply', mitigation: 'Suspend and wake by event without occupying an execution slot' },
        { risk: 'Process restart', mitigation: 'Recover READY and WAITING tasks from SQLite snapshots' },
        { risk: 'Duplicate messages', mitigation: 'Deduplicate with idempotency keys' },
      ],
    }))
    .register('compose_plan', async ({ objective }, { task }) => {
      const dependencies = task.dependsOn.map((id) => store.getTask(id));
      return {
        objective,
        generatedFrom: dependencies.map((dependency) => ({
          task: dependency.title,
          result: dependency.result,
        })),
        nextActions: [
          'Confirm inputs and success criteria',
          'Run eligible work concurrently according to the dependency graph',
          'Convert external waits into durable event subscriptions',
          'Synthesize results and perform a quality review',
        ],
      };
    })
    .register('quality_review', async ({ objective }, { task }) => {
      const source = store.getTask(task.dependsOn[0]);
      return {
        objective,
        sourceTask: source?.title,
        checks: [
          { name: 'No execution slot is held while waiting', passed: true },
          { name: 'An external event resumes the original task', passed: true },
          { name: 'Tasks are scheduled after their dependencies complete', passed: true },
        ],
        verdict: 'ready',
      };
    });
}
