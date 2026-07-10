import { isActionControl } from '../agent/tool-registry.js';

function resolveValue(value, variables) {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, variables)]));
  }
  if (typeof value !== 'string') return value;

  const exact = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (exact) return readPath(variables, exact[1]);
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const resolved = readPath(variables, path);
    return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved ?? '');
  });
}

function readPath(object, path) {
  return path.split('.').reduce((current, key) => current?.[key], object);
}

function checkpoint(snapshot, step, detail = {}) {
  const checkpoints = [
    ...(snapshot.checkpoints ?? []),
    { pc: snapshot.pc, step: step.type, at: Date.now(), ...detail },
  ].slice(-24);
  return { ...snapshot, checkpoints };
}

export class WorkflowEngine {
  constructor({ store, eventBus, actions, maxStepsPerTurn = 4 }) {
    this.store = store;
    this.eventBus = eventBus;
    this.actions = actions;
    this.maxStepsPerTurn = maxStepsPerTurn;
  }

  async executeTurn(task, { signal } = {}) {
    let snapshot = {
      pc: 0,
      variables: {},
      checkpoints: [],
      ...task.snapshot,
      variables: { objective: this.store.getGoal(task.goal_id)?.objective, ...(task.snapshot?.variables ?? {}) },
    };

    for (let quantum = 0; quantum < this.maxStepsPerTurn; quantum += 1) {
      const control = this.store.getTaskControl(task.id);
      if (!control || control.lease_token !== task.lease_token) return this.store.getTask(task.id);
      if (control.cancel_requested) {
        return this.store.cancelRunningTask(task.id, snapshot, task.lease_token);
      }
      if (control.pause_requested) {
        return this.store.pauseRunningTask(task.id, snapshot, task.lease_token);
      }
      if (control.preempt_requested) {
        return this.store.preemptRunningTask(task.id, snapshot, task.lease_token);
      }
      if (signal?.aborted) throw signal.reason ?? new Error('Task execution was interrupted');
      const step = task.workflow[snapshot.pc];
      if (!step) {
        return this.store.completeTask(task.id, snapshot, snapshot.variables.output ?? { ok: true }, task.lease_token);
      }

      switch (step.type) {
        case 'record': {
          const message = resolveValue(step.message, snapshot.variables);
          this.store.appendAudit(task.goal_id, task.id, 'STEP_RECORDED', message, { pc: snapshot.pc });
          snapshot = checkpoint({ ...snapshot, pc: snapshot.pc + 1 }, step, { message });
          this.store.checkpointTask(task.id, snapshot, null, task.lease_token);
          break;
        }

        case 'set': {
          const value = resolveValue(step.value, snapshot.variables);
          snapshot = checkpoint({
            ...snapshot,
            pc: snapshot.pc + 1,
            variables: { ...snapshot.variables, [step.name]: value },
          }, step, { variable: step.name });
          this.store.checkpointTask(task.id, snapshot, null, task.lease_token);
          break;
        }

        case 'call': {
          const input = resolveValue(step.input ?? {}, snapshot.variables);
          const actionPc = snapshot.pc;
          const result = await this.actions.execute(step.action, input, {
            task,
            snapshot,
            idempotencyKey: `task:${task.id}:step:${snapshot.pc}`,
            actionState: snapshot.actionStates?.[snapshot.pc],
            resumeEvent: snapshot.pendingEvent,
            signal,
          });

          if (isActionControl(result) && result.__agentControl === 'wait') {
            snapshot = checkpoint({
              ...snapshot,
              pendingEvent: undefined,
              actionStates: { ...(snapshot.actionStates ?? {}), [actionPc]: result.state ?? {} },
            }, step, { action: step.action, suspended: true });

            if (result.wait.kind === 'timer') {
              return this.store.waitForTimer(
                task.id,
                snapshot,
                result.wait.wakeAt ?? Date.now() + Number(result.wait.durationMs ?? 0),
                result.wait.reason ?? `Action ${step.action} is waiting for a timer`,
                task.lease_token,
              );
            }

            const queued = this.store.consumeQueuedEvent(task.id, result.wait.topic, result.wait.correlationKey);
            if (queued) {
              snapshot = {
                ...snapshot,
                pendingEvent: {
                  id: queued.id,
                  topic: queued.topic,
                  correlationKey: queued.correlation_key,
                  payload: queued.payload,
                  createdAt: queued.created_at,
                },
              };
              this.store.consumeEventAndCheckpoint(task.id, queued.id, snapshot, task.lease_token);
              continue;
            }
            return this.store.waitForEvent(
              task.id,
              snapshot,
              {
                topic: result.wait.topic,
                correlationKey: result.wait.correlationKey,
                deadline: result.wait.deadline ?? null,
              },
              result.wait.reason ?? `Action ${step.action} is waiting for an external event`,
              task.lease_token,
            );
          }

          const value = isActionControl(result) ? result.value : result;
          const actionStates = { ...(snapshot.actionStates ?? {}) };
          delete actionStates[actionPc];
          snapshot = checkpoint({
            ...snapshot,
            pc: snapshot.pc + 1,
            pendingEvent: undefined,
            actionStates,
            variables: { ...snapshot.variables, [step.saveAs ?? step.action]: value },
          }, step, { action: step.action });
          if (task.snapshot?.pendingEvent?.id) {
            this.store.consumeEventAndCheckpoint(task.id, task.snapshot.pendingEvent.id, snapshot, task.lease_token);
          } else {
            this.store.checkpointTask(task.id, snapshot, null, task.lease_token);
          }
          this.store.appendAudit(task.goal_id, task.id, 'ACTION_COMPLETED', `Action ${step.action} completed`, { pc: snapshot.pc - 1 });
          break;
        }

        case 'delay': {
          const durationMs = Number(resolveValue(step.durationMs, snapshot.variables));
          snapshot = checkpoint({ ...snapshot, pc: snapshot.pc + 1 }, step, { durationMs });
          return this.store.waitForTimer(
            task.id,
            snapshot,
            Date.now() + durationMs,
            resolveValue(step.reason ?? `Asynchronous wait for ${durationMs}ms`, snapshot.variables),
            task.lease_token,
          );
        }

        case 'await_event': {
          const topic = resolveValue(step.topic, snapshot.variables);
          const correlationKey = resolveValue(step.correlationKey, snapshot.variables);
          let incoming = snapshot.pendingEvent;
          if (!incoming || incoming.topic !== topic || incoming.correlationKey !== correlationKey) {
            incoming = this.store.consumeQueuedEvent(task.id, topic, correlationKey);
          }

          if (incoming) {
            const payload = incoming.payload ?? {};
            snapshot = checkpoint({
              ...snapshot,
              pc: snapshot.pc + 1,
              pendingEvent: undefined,
              variables: { ...snapshot.variables, [step.saveAs ?? 'event']: payload },
            }, step, { eventId: incoming.id });
            this.store.consumeEventAndCheckpoint(task.id, incoming.id, snapshot, task.lease_token);
            this.store.appendAudit(task.goal_id, task.id, 'EVENT_CONSUMED', `Event ${topic} was written to the resume context`, { eventId: incoming.id });
            break;
          }

          const deadline = step.timeoutMs ? Date.now() + Number(step.timeoutMs) : null;
          snapshot = checkpoint(snapshot, step, { topic, correlationKey });
          return this.store.waitForEvent(
            task.id,
            snapshot,
            { topic, correlationKey, deadline },
            resolveValue(step.reason ?? `Waiting for event ${topic}`, snapshot.variables),
            task.lease_token,
          );
        }

        case 'emit': {
          const topic = resolveValue(step.topic, snapshot.variables);
          const correlationKey = resolveValue(step.correlationKey, snapshot.variables);
          const payload = resolveValue(step.payload ?? {}, snapshot.variables);
          this.eventBus.publish({
            topic,
            correlationKey,
            payload,
            source: `task:${task.id}`,
            idempotencyKey: `task:${task.id}:step:${snapshot.pc}`,
          });
          snapshot = checkpoint({ ...snapshot, pc: snapshot.pc + 1 }, step, { topic, correlationKey });
          this.store.checkpointTask(task.id, snapshot, null, task.lease_token);
          break;
        }

        case 'complete': {
          const result = resolveValue(step.result ?? { ok: true }, snapshot.variables);
          snapshot = checkpoint({
            ...snapshot,
            pc: snapshot.pc + 1,
            variables: { ...snapshot.variables, output: result },
          }, step);
          return this.store.completeTask(task.id, snapshot, result, task.lease_token);
        }

        default:
          throw new Error(`Unsupported workflow step: ${step.type}`);
      }
    }

    return this.store.yieldTask(task.id, snapshot, 'The reasoning quantum ended; yield for fair scheduling', task.lease_token);
  }
}
