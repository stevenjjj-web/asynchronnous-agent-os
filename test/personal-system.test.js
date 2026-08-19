import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig } from '../src/platform/config.js';
import { PersonalAgentSystem } from '../src/system.js';

async function waitFor(predicate, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition was not met before timeout');
}

function createConfig(home) {
  const config = defaultConfig({ projectRoot: home, home });
  config.runtime.tickMs = 10;
  config.runtime.maxConcurrency = 2;
  config.runtime.leaseMs = 500;
  config.kernel.heartbeatMs = 25;
  config.kernel.serviceTimeoutMs = 1_000;
  config.kernel.housekeepingMs = 10;
  config.kernel.interruptPollMs = 5;
  config.sensing.pulseMs = 20;
  config.sensing.inboxPollMs = 20;
  config.models.default = { provider: 'offline', model: 'offline' };
  config.agents[0].workspace = join(home, 'workspace');
  return config;
}

test('a personal-agent message becomes a persistent DAG and is delivered', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-system-'));
  const system = new PersonalAgentSystem(createConfig(home));
  await system.start();
  try {
    const accepted = await system.sessions.submit({ text: 'Organize my release plan', channel: 'terminal', peerKey: 'owner' });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.tasks.length, 3);

    await waitFor(() => system.store.getGoal(accepted.goal.id).status === 'SUCCEEDED');
    const messages = system.store.listMessages(accepted.session.id);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
    assert.match(messages[1].content.text, /offline mode/);
    await waitFor(() => system.store.listOutbox({ status: 'DELIVERED' }).length === 1);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a model tool call can suspend for user input and resume the same turn', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-suspend-'));
  const config = createConfig(home);
  config.models.default = { provider: 'scripted', model: 'scripted' };
  const system = new PersonalAgentSystem(config);
  system.providers.register('scripted', () => ({
    async complete({ messages }) {
      const toolResult = [...messages].reverse().find((message) => message.role === 'tool');
      if (toolResult) {
        const result = JSON.parse(toolResult.content);
        return { role: 'assistant', content: `Resumed with the reply: ${result.reply.message}`, toolCalls: [], usage: null };
      }
      return {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'ask-1',
          name: 'request_user_input',
          arguments: JSON.stringify({ prompt: 'Choose a release date' }),
        }],
        usage: null,
      };
    },
  }));
  await system.start();
  try {
    const accepted = await system.sessions.submit({ text: 'Schedule my release', channel: 'terminal', peerKey: 'owner' });
    const waiting = await waitFor(() => system.store.listTasks(accepted.goal.id).find((task) => task.wait_kind === 'EVENT'));
    assert.equal(waiting.status, 'WAITING');
    assert.equal(system.scheduler.active.size, 0);

    system.publishEvent({
      topic: waiting.wait_topic,
      correlationKey: waiting.wait_key,
      payload: { message: 'Next Thursday' },
      idempotencyKey: 'scripted-user-reply',
    });
    await waitFor(() => system.store.getGoal(accepted.goal.id).status === 'SUCCEEDED');
    const messages = system.store.listMessages(accepted.session.id);
    assert.match(messages.at(-1).content.text, /Next Thursday/);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('memory is durable, searchable, and mirrored to the workspace diary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-memory-'));
  const system = new PersonalAgentSystem(createConfig(home));
  await system.start();
  try {
    const saved = system.memory.remember({
      agentId: 'main',
      content: 'The user prefers to release products every Thursday',
      kind: 'preference',
      importance: 0.9,
      tags: ['release'],
      source: 'test',
    });
    const results = system.memory.recall('main', 'Thursday release');
    assert.equal(results[0].id, saved.id);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('pause, resume and cancel are persisted task controls', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-control-'));
  const system = new PersonalAgentSystem(createConfig(home));
  await system.start();
  t.after(async () => {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const view = await system.createGoal('Control the task lifecycle', {
    contextDelayMs: 1_000,
    riskDelayMs: 1_000,
    replyTimeoutMs: 5_000,
  });
  const waiting = await waitFor(() => system.store.listTasks(view.goal.id).find((task) => task.status === 'WAITING'));
  const paused = system.store.pauseTask(waiting.id);
  assert.equal(paused.status, 'PAUSED');
  const resumed = system.store.resumeTask(waiting.id);
  assert.ok(['READY', 'WAITING'].includes(resumed.status));
  const cancelled = system.store.cancelTask(waiting.id);
  assert.equal(cancelled.status, 'CANCELLED');
});

test('high-risk tools create a durable approval gate before execution', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-approval-'));
  const config = createConfig(home);
  config.models.default = { provider: 'approval-script', model: 'approval-script' };
  config.security.tools.allow.push('memory_forget');
  config.security.capabilities.tools.push('memory_forget');
  config.security.capabilities.resourcePools.push('isolated-side-effects');
  const system = new PersonalAgentSystem(config);
  const memory = system.memory.remember({ agentId: 'main', content: 'Test memory to delete', kind: 'note', source: 'test' });
  system.providers.register('approval-script', () => ({
    async complete({ messages }) {
      if (messages.some((message) => message.role === 'tool')) {
        return { role: 'assistant', content: 'Completed after approval', toolCalls: [], usage: null };
      }
      return {
        role: 'assistant', content: '', usage: null,
        toolCalls: [{ id: 'forget-1', name: 'memory_forget', arguments: JSON.stringify({ memoryId: memory.id, reason: 'Approval test' }) }],
      };
    },
  }));
  await system.start();
  try {
    const accepted = await system.sessions.submit({ text: 'Delete the test memory' });
    const approval = await waitFor(() => system.store.listApprovals('PENDING')[0]);
    const waiting = system.store.listTasks(accepted.goal.id).find((task) => task.wait_topic === 'approval.resolved');
    assert.ok(waiting);
    assert.ok(system.store.getMemory(memory.id));

    const outcome = system.store.resolveApprovalAndPublishEvent(approval.id, 'approve', {
      resolvedBy: 'gateway-operator',
    }, {
      source: 'approval-api',
      tenantId: 'default',
      agentId: 'main',
      authenticated: true,
      authSubject: 'gateway-operator',
    });
    system.eventBus.announce(outcome.delivery);
    system.scheduler.requestDrain();
    await waitFor(() => system.store.getGoal(accepted.goal.id).status === 'SUCCEEDED');
    assert.equal(system.store.getMemory(memory.id), null);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a due schedule creates a new persistent session goal exactly once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-schedule-'));
  const system = new PersonalAgentSystem(createConfig(home));
  await system.start();
  try {
    const session = system.sessions.getOrCreate({ channel: 'web', peerKey: 'owner' });
    const schedule = system.store.createSchedule({
      name: 'One-time check',
      nextRunAt: Date.now() - 1,
      payload: { objective: 'Perform a one-time plan check', sessionId: session.id },
    });
    const completed = await waitFor(() => {
      const current = system.store.getSchedule(schedule.id);
      return current.last_goal_id && system.store.getGoal(current.last_goal_id)?.status === 'SUCCEEDED' ? current : null;
    });
    assert.equal(completed.enabled, 0);
    assert.equal(system.store.listGoals().filter((goal) => goal.session_id === session.id).length, 1);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('an inbound message id is idempotent across retries', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-message-idempotency-'));
  const system = new PersonalAgentSystem(createConfig(home));
  await system.start();
  try {
    const input = { messageId: 'channel-message-42', text: 'The same channel message', channel: 'terminal', peerKey: 'owner' };
    const first = await system.sessions.submit(input);
    const second = await system.sessions.submit(input);
    assert.equal(second.duplicate, true);
    assert.equal(second.goal.id, first.goal.id);
    assert.equal(system.store.listGoals().length, 1);
    assert.equal(system.store.listMessages(first.session.id).filter((message) => message.role === 'user').length, 1);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the model can spawn parallel child goals and suspend until they converge', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-spawn-'));
  const config = createConfig(home);
  config.runtime.maxConcurrency = 4;
  config.models.default = { provider: 'spawn-script', model: 'spawn-script' };
  const system = new PersonalAgentSystem(config);
  system.providers.register('spawn-script', () => ({
    async complete({ messages }) {
      const user = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const toolResult = [...messages].reverse().find((message) => message.role === 'tool');
      if (toolResult) return { role: 'assistant', content: 'Both child goals have converged', toolCalls: [], usage: null };
      if (user.includes('Child task')) {
        return {
          role: 'assistant', content: '', usage: null,
          toolCalls: [{ id: 'sleep-1', name: 'sleep', arguments: JSON.stringify({ seconds: 0.15, reason: 'Simulate asynchronous child-goal work' }) }],
        };
      }
      if (/research.*parallel|parallel.*research/i.test(user)) {
        return {
          role: 'assistant', content: '', usage: null,
          toolCalls: [{
            id: 'spawn-1', name: 'spawn_goals',
            arguments: JSON.stringify({
              goals: [{ objective: 'Child task: research option A' }, { objective: 'Child task: research option B' }],
              waitForCompletion: true,
            }),
          }],
        };
      }
      return { role: 'assistant', content: `Completed ${user}`, toolCalls: [], usage: null };
    },
  }));
  await system.start();
  try {
    const parent = await system.sessions.submit({ text: 'Please research two options in parallel and summarize them' });
    await waitFor(() => system.store.listTasks(parent.goal.id).some((task) => task.wait_topic === 'goal.completed'));
    await waitFor(() => system.store.getGoal(parent.goal.id).status === 'SUCCEEDED', 5_000);
    const children = system.store.listGoals().filter((goal) => goal.metadata.parentGoalId === parent.goal.id);
    assert.equal(children.length, 2);
    assert.ok(children.every((goal) => goal.status === 'SUCCEEDED'));
    assert.match(system.store.listMessages(parent.session.id).at(-1).content.text, /converged/);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the runtime keeps pulsing while idle and a sensor wakes new work', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-sensing-'));
  const system = new PersonalAgentSystem(createConfig(home));
  await system.start();
  try {
    const pulse = await waitFor(() => system.store.getSystemState('runtime.pulse'));
    assert.equal(pulse.value.status, 'alive');
    assert.equal(pulse.value.activeThreads, 0);

    const monitor = system.store.listMonitors({ agentId: 'main' })[0];
    await waitFor(() => system.store.getMonitor(monitor.id).last_observation_at);
    writeFileSync(join(home, 'workspace', 'inbox', 'new-request.txt'), 'Review the attached request.\n');
    system.monitoring.runNow(monitor.id);

    const event = await waitFor(() => system.store.listEvents({
      topic: 'monitor.changed',
      correlationKey: monitor.id,
    })[0]);
    assert.equal(event.payload.monitorId, monitor.id);
    assert.match(event.payload.summary, /new-request\.txt/);

    const goal = await waitFor(() => system.store.listGoals()[0]);
    await waitFor(() => system.store.getGoal(goal.id).status === 'SUCCEEDED');
    assert.equal(system.store.getMonitor(monitor.id).last_error, null);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a resident filesystem listener wakes the inbox monitor without waiting for its poll interval', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-listener-'));
  const config = createConfig(home);
  config.sensing.inboxPollMs = 60_000;
  const system = new PersonalAgentSystem(config);
  await system.start();
  try {
    const monitor = system.store.listMonitors({ agentId: 'main' })[0];
    await waitFor(() => system.store.getMonitor(monitor.id).last_observation_at);
    await waitFor(() => system.store.listKernelProcesses({ status: 'RUNNING' })
      .find((processRecord) => processRecord.name === 'listener:workspace-inbox' && processRecord.metadata.watchers === 1));
    const startedAt = Date.now();
    writeFileSync(join(home, 'workspace', 'inbox', 'realtime.txt'), 'Wake immediately.\n');
    const event = await waitFor(() => system.store.listEvents({
      topic: 'monitor.changed',
      correlationKey: monitor.id,
    })[0], 1_000);
    assert.match(event.payload.summary, /realtime\.txt/);
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('monitor state and identity survive a gateway restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-monitor-restart-'));
  const first = new PersonalAgentSystem(createConfig(home));
  await first.start();
  let monitorId;
  try {
    const monitor = first.store.listMonitors({ agentId: 'main' })[0];
    monitorId = monitor.id;
    await waitFor(() => first.store.getMonitor(monitorId).last_observation_at);
  } finally {
    await first.stop();
  }

  const second = new PersonalAgentSystem(createConfig(home));
  await second.start();
  try {
    const monitors = second.store.listMonitors({ agentId: 'main' });
    assert.equal(monitors.length, 1);
    assert.equal(monitors[0].id, monitorId);
    assert.ok(monitors[0].lastState);
    await waitFor(() => second.store.getMonitor(monitorId).status === 'IDLE');

    writeFileSync(join(home, 'workspace', 'inbox', 'after-restart.txt'), 'Persistent monitor state.\n');
    second.monitoring.runNow(monitorId);
    const event = await waitFor(() => second.store.listEvents({
      topic: 'monitor.changed',
      correlationKey: monitorId,
    })[0]);
    assert.match(event.payload.summary, /after-restart\.txt/);
  } finally {
    await second.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a resident kernel process and supervised services stay alive while idle', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-kernel-'));
  const system = new PersonalAgentSystem(createConfig(home));
  await system.start();
  try {
    const first = await waitFor(() => {
      const processes = system.store.listKernelProcesses({ status: 'RUNNING' });
      return processes.length === 8 ? processes : null;
    });
    const root = first.find((processRecord) => processRecord.kind === 'kernel');
    assert.equal(root.host_pid, process.pid);
    assert.deepEqual(
      first.filter((processRecord) => processRecord.kind === 'resident-service').map((item) => item.name).sort(),
      ['cognition-loop', 'interrupt-reactor', 'io-reactor', 'listener:workspace-inbox', 'memory-sync-reactor', 'plan-repair-reactor', 'scheduler'],
    );
    const heartbeat = root.heartbeat_at;
    await waitFor(() => system.store.getKernelProcess(root.id).heartbeat_at > heartbeat);
    assert.equal(system.store.listGoals().length, 0);
    assert.equal(system.kernel.status().status, 'alive');
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the kernel lease prevents two live daemons from owning the same process table', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-singleton-'));
  const first = new PersonalAgentSystem(createConfig(home));
  const second = new PersonalAgentSystem(createConfig(home));
  await first.start();
  try {
    await assert.rejects(() => second.start(), /Another Agent OS kernel is alive/);
  } finally {
    await first.stop();
    await second.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('an urgent interrupt preempts a model call and the original thought thread resumes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-preemption-'));
  const config = createConfig(home);
  config.runtime.maxConcurrency = 1;
  config.models.default = { provider: 'preemption-script', model: 'preemption-script' };
  const system = new PersonalAgentSystem(config);
  let backgroundAttempts = 0;
  system.providers.register('preemption-script', () => ({
    async complete({ messages, signal }) {
      const user = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      if (user.includes('background analysis')) {
        backgroundAttempts += 1;
        if (backgroundAttempts === 1) await delay(2_000, undefined, { signal });
        return { role: 'assistant', content: 'Background analysis resumed and completed', toolCalls: [], usage: null };
      }
      return { role: 'assistant', content: 'Urgent instruction completed', toolCalls: [], usage: null };
    },
  }));
  await system.start();
  try {
    const background = await system.submit({ text: 'Perform a long background analysis', priority: 20 });
    const backgroundTurn = await waitFor(() => system.store.listTasks(background.goal.id)
      .find((task) => task.kind === 'agent-turn' && task.status === 'RUNNING'));

    const urgent = await system.submit({
      text: 'Handle this urgent instruction',
      priority: 100,
      interrupt: true,
      interruptReason: 'The operator issued an urgent instruction',
    });
    await waitFor(() => system.store.getGoal(urgent.goal.id).status === 'SUCCEEDED');
    await waitFor(() => system.store.getGoal(background.goal.id).status === 'SUCCEEDED');

    const audit = system.store.listAudit({ taskId: backgroundTurn.id, limit: 100 });
    assert.ok(audit.some((entry) => entry.type === 'TASK_PREEMPTED'));
    assert.ok(backgroundAttempts >= 2);
    const interrupt = system.store.getInterrupt(urgent.interrupt.id);
    assert.equal(interrupt.dispatched_task_id, backgroundTurn.id);
    await waitFor(() => system.store.getInterrupt(interrupt.id).status === 'HANDLED');
    assert.ok(system.store.getGoal(urgent.goal.id).completed_at <= system.store.getGoal(background.goal.id).completed_at);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the cognition loop can create one budgeted reflection goal while otherwise idle', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-cognition-'));
  const config = createConfig(home);
  config.cognition.requireModel = false;
  const system = new PersonalAgentSystem(config);
  await system.start();
  try {
    system.cognition.configure({ enabled: true, autoReflect: true });
    system.cognition.requestReflection();
    const cycle = await waitFor(() => {
      const value = system.store.getSystemState('cognition.lastCycle')?.value;
      return value?.action === 'reflection-goal-created' ? value : null;
    });
    await waitFor(() => system.store.getGoal(cycle.goalId).status === 'SUCCEEDED');
    assert.equal(system.store.listGoals().filter((goal) => goal.id === cycle.goalId).length, 1);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(system.store.getSystemState(`cognition.budget:${today}`).value.used, 1);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
