export class OperationManager {
  constructor({ store, config, pools }) {
    this.store = store;
    this.config = config;
    this.pools = pools;
    this.handlers = new Map();
  }

  registerTool(tool) {
    if (tool.sideEffect) this.handlers.set(tool.name, tool);
  }

  async execute(tool, args, context, invoke) {
    const descriptor = tool.sideEffect;
    if (!descriptor) return invoke();
    const mode = descriptor.mode ?? 'idempotent';
    if (mode === 'non-idempotent' && !context.approvalGranted) {
      throw new Error(`Non-idempotent tool requires explicit approval: ${tool.name}`);
    }
    let operation = this.store.getOperation(context.idempotencyKey);
    if (operation) {
      this.assertReplayMatches(operation, tool, args, context);
    } else {
      const preparedValue = descriptor.prepare
        ? await descriptor.prepare({ args, context, idempotencyKey: context.idempotencyKey })
        : { requestHash: context.idempotencyKey };
      operation = this.store.prepareOperation({
        idempotencyKey: context.idempotencyKey,
        goalId: context.task.goal_id,
        taskId: context.task.id,
        toolName: tool.name,
        mode,
        resourcePool: tool.resourcePool,
        request: args,
        prepared: preparedValue,
      }).operation;
    }
    if (operation.state === 'CONFIRMED') return this.decorate(operation.result, operation, true);
    if (operation.state === 'COMPENSATED') {
      return { ok: false, operationId: operation.id, operationState: operation.state, error: 'Operation was compensated' };
    }
    if (operation.state === 'EXECUTING' && mode !== 'idempotent' && mode !== 'local-idempotent') {
      operation = this.store.transitionOperation(operation.id, 'UNCERTAIN', {
        error: 'The previous executor stopped before recording the external outcome',
        nextReconcileAt: Date.now(),
      });
    }
    if (operation.state === 'UNCERTAIN' || operation.state === 'RECONCILING') {
      if (descriptor.reconcile) {
        operation = await this.reconcile(operation, tool, { acquirePool: false });
        if (operation.state === 'CONFIRMED') return this.decorate(operation.result, operation, true);
        if (operation.state !== 'ABSENT') return this.uncertain(operation);
      } else if (mode !== 'idempotent') {
        return this.uncertain(operation);
      }
    }

    this.store.transitionOperation(operation.id, 'EXECUTING', { incrementAttempt: true });
    try {
      const result = await invoke();
      if (descriptor.confirm) {
        const confirmation = await descriptor.confirm({ operation: this.store.getOperation(operation.id), result, args, context });
        if (!confirmation?.confirmed) {
          operation = this.store.transitionOperation(operation.id, 'UNCERTAIN', {
            result,
            reconciliation: confirmation,
            nextReconcileAt: Date.now() + this.config.operations.reconcileIntervalMs,
            error: confirmation?.reason ?? 'External confirmation is inconclusive',
          });
          return this.uncertain(operation);
        }
      }
      operation = this.store.transitionOperation(operation.id, 'CONFIRMED', { result });
      return this.decorate(result, operation, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const uncertain = mode !== 'local-idempotent';
      operation = this.store.transitionOperation(operation.id, uncertain ? 'UNCERTAIN' : 'FAILED', {
        error: message,
        nextReconcileAt: uncertain ? Date.now() + this.config.operations.reconcileIntervalMs : null,
      });
      if (context.signal?.aborted) throw context.signal.reason ?? error;
      return uncertain ? this.uncertain(operation) : { ok: false, operationId: operation.id, operationState: operation.state, error: message };
    }
  }

  assertReplayMatches(operation, tool, args, context) {
    const canonical = (value) => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
      }
      return value;
    };
    const expected = JSON.stringify(canonical(operation.request ?? {}));
    const actual = JSON.stringify(canonical(args ?? {}));
    if (
      operation.tool_name !== tool.name
      || operation.mode !== (tool.sideEffect?.mode ?? 'idempotent')
      || operation.goal_id !== context.task.goal_id
      || operation.task_id !== context.task.id
      || expected !== actual
    ) {
      throw new Error(`Idempotency key was reused for a different operation: ${context.idempotencyKey}`);
    }
  }

  async reconcile(operation, tool = this.handlers.get(operation.tool_name), { acquirePool = true } = {}) {
    if (!tool?.sideEffect?.reconcile) return operation;
    this.store.transitionOperation(operation.id, 'RECONCILING', { incrementReconcile: true });
    try {
      const reconcile = () => tool.sideEffect.reconcile({
        operation: this.store.getOperation(operation.id),
        request: operation.request,
      });
      const result = acquirePool
        ? await this.pools.run(tool.resourcePool, reconcile)
        : await reconcile();
      if (result?.confirmed) {
        return this.store.transitionOperation(operation.id, 'CONFIRMED', {
          result: result.result ?? operation.result,
          reconciliation: result,
        });
      }
      if (result?.absent) {
        return this.store.transitionOperation(operation.id, 'ABSENT', { reconciliation: result });
      }
      return this.store.transitionOperation(operation.id, 'UNCERTAIN', {
        reconciliation: result,
        nextReconcileAt: Date.now() + this.config.operations.reconcileIntervalMs,
        error: result?.reason ?? 'Reconciliation remains inconclusive',
      });
    } catch (error) {
      return this.store.transitionOperation(operation.id, 'UNCERTAIN', {
        error: error instanceof Error ? error.message : String(error),
        nextReconcileAt: Date.now() + this.config.operations.reconcileIntervalMs,
      });
    }
  }

  async reconcileDue() {
    const results = [];
    for (const operation of this.store.getOperationsDueForReconciliation()) {
      if (operation.reconcile_attempt >= this.config.operations.maxReconcileAttempts) continue;
      const tool = this.handlers.get(operation.tool_name);
      if (!tool?.sideEffect?.reconcile) continue;
      results.push(await this.reconcile(operation, tool));
    }
    return results;
  }

  async compensate(id, reason = 'Operator requested compensation') {
    const operation = this.store.getOperation(id);
    if (!operation) throw new Error(`Unknown operation: ${id}`);
    if (operation.state === 'COMPENSATED') return operation;
    if (operation.state !== 'CONFIRMED') throw new Error(`Only confirmed operations can be compensated: ${operation.state}`);
    const tool = this.handlers.get(operation.tool_name);
    if (!tool?.sideEffect?.compensate) throw new Error(`Tool does not support compensation: ${operation.tool_name}`);
    const idempotencyKey = `compensate:${operation.id}`;
    this.store.transitionOperation(operation.id, 'COMPENSATING', {
      compensation: { reason, idempotencyKey, startedAt: Date.now() },
    });
    try {
      const result = await this.pools.run(tool.resourcePool, () => tool.sideEffect.compensate({
        operation: this.store.getOperation(operation.id), reason, idempotencyKey,
      }));
      return this.store.transitionOperation(operation.id, 'COMPENSATED', {
        compensation: { reason, idempotencyKey, result },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.store.transitionOperation(operation.id, 'COMPENSATION_UNCERTAIN', {
        compensation: { reason, idempotencyKey, error: message },
        error: message,
      });
    }
  }

  uncertain(operation) {
    return {
      ok: false,
      operationId: operation.id,
      operationState: operation.state,
      uncertain: true,
      error: operation.last_error ?? 'The external side effect may have completed and requires reconciliation',
    };
  }

  decorate(result, operation, replayed) {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return { ...result, _operation: { id: operation.id, state: operation.state, replayed } };
    }
    return { ok: true, value: result, _operation: { id: operation.id, state: operation.state, replayed } };
  }
}
