import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime } from '../src/runtime/agent-runtime.js';

async function waitFor(predicate, { timeout = 2_000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('Condition was not met before timeout');
}

function fastOptions() {
  return { contextDelayMs: 35, riskDelayMs: 25, reviewDelayMs: 20, replyTimeoutMs: 5_000 };
}

test('waiting for external input releases the worker and other tasks continue', async (t) => {
  const runtime = new AgentRuntime({ tickMs: 10, maxConcurrency: 2 }).start();
  t.after(() => runtime.stop());
  const view = await runtime.createGoal('Prepare an asynchronous product release', fastOptions());

  await waitFor(() => {
    const tasks = runtime.store.listTasks(view.goal.id);
    return tasks.filter((task) => task.status === 'SUCCEEDED').length === 2 && tasks.find((task) => task.wait_kind === 'EVENT');
  });

  const beforeReply = runtime.store.listTasks(view.goal.id);
  assert.equal(beforeReply.find((task) => task.title === 'Confirm requirements and success criteria').status, 'WAITING');
  assert.equal(beforeReply.find((task) => task.title === 'Collect context in parallel').status, 'SUCCEEDED');
  assert.equal(beforeReply.find((task) => task.title === 'Assess risks in parallel').status, 'SUCCEEDED');
  assert.equal(runtime.scheduler.active.size, 0);

  runtime.publishEvent({
    topic: 'user.reply',
    correlationKey: view.goal.metadata.replyKey,
    payload: { message: 'Critical constraints are confirmed' },
  });

  await waitFor(() => runtime.store.getGoal(view.goal.id).status === 'SUCCEEDED');
  assert.ok(runtime.store.listTasks(view.goal.id).every((task) => task.status === 'SUCCEEDED'));
});

test('an event arriving before the await step is persisted and consumed later', async (t) => {
  const runtime = new AgentRuntime({ tickMs: 10, maxConcurrency: 1 });
  t.after(() => runtime.stop());
  const view = await runtime.createGoal('Verify that an early event is not lost', fastOptions());

  const published = runtime.publishEvent({
    topic: 'user.reply',
    correlationKey: view.goal.metadata.replyKey,
    payload: { message: 'This reply arrived before task execution' },
    idempotencyKey: 'early-reply-1',
  });
  assert.equal(published.awakened.length, 0);

  runtime.start();
  await waitFor(() => runtime.store.getGoal(view.goal.id).status === 'SUCCEEDED');
  const clarification = runtime.store.listTasks(view.goal.id).find((task) => task.title === 'Confirm requirements and success criteria');
  assert.equal(clarification.result.userReply.message, 'This reply arrived before task execution');
});

test('waiting state and snapshot survive a runtime restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-'));
  const database = join(directory, 'runtime.db');
  let first = new AgentRuntime({ database, tickMs: 10 }).start();
  const view = await first.createGoal('Verify restart recovery', fastOptions());

  await waitFor(() => first.store.listTasks(view.goal.id).some((task) => task.status === 'WAITING' && task.wait_kind === 'EVENT'));
  const pcBeforeRestart = first.store.listTasks(view.goal.id).find((task) => task.wait_kind === 'EVENT').snapshot.pc;
  await first.stop();
  first = null;

  const second = new AgentRuntime({ database, tickMs: 10 }).start();
  try {
    const restored = second.store.listTasks(view.goal.id).find((task) => task.wait_kind === 'EVENT');
    assert.equal(restored.status, 'WAITING');
    assert.equal(restored.snapshot.pc, pcBeforeRestart);

    second.publishEvent({
      topic: 'user.reply',
      correlationKey: view.goal.metadata.replyKey,
      payload: { message: 'Reply received after process restart' },
    });
    await waitFor(() => second.store.getGoal(view.goal.id).status === 'SUCCEEDED');
  } finally {
    await second.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('idempotency keys prevent duplicate external event processing', async (t) => {
  const runtime = new AgentRuntime({ tickMs: 10 }).start();
  t.after(() => runtime.stop());
  const view = await runtime.createGoal('Verify event idempotency', fastOptions());

  await waitFor(() => runtime.store.listTasks(view.goal.id).some((task) => task.wait_kind === 'EVENT'));
  const event = {
    topic: 'user.reply',
    correlationKey: view.goal.metadata.replyKey,
    payload: { message: 'Consume this only once' },
    idempotencyKey: 'same-message-42',
  };
  const first = runtime.publishEvent(event);
  const duplicate = runtime.publishEvent(event);

  assert.equal(first.duplicate, false);
  assert.equal(first.awakened.length, 1);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.id, first.event.id);
  assert.equal(runtime.store.getStats().events, 1);
});

test('a second goal completes while the first goal is waiting for a reply', async (t) => {
  const runtime = new AgentRuntime({ tickMs: 10, maxConcurrency: 1 }).start();
  t.after(() => runtime.stop());
  const waitingGoal = await runtime.createGoal('Goal A: wait for external approval', fastOptions());

  await waitFor(() => runtime.store.listTasks(waitingGoal.goal.id).some((task) => task.wait_kind === 'EVENT'));
  const independentGoal = await runtime.createGoal('Goal B: complete an independent analysis immediately', {
    ...fastOptions(),
    requireReply: false,
  });

  await waitFor(() => runtime.store.getGoal(independentGoal.goal.id).status === 'SUCCEEDED');
  assert.equal(runtime.store.getGoal(waitingGoal.goal.id).status, 'ACTIVE');
  assert.equal(
    runtime.store.listTasks(waitingGoal.goal.id).find((task) => task.wait_kind === 'EVENT').status,
    'WAITING',
  );
});
