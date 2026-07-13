import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createFormatter } from '../src/cli/format.js';
import { canUseLiveDashboard, dashboardLines } from '../src/cli/live-dashboard.js';
import { suggestCommands } from '../src/cli/command-palette.js';
import { commandDropdownLines, TerminalInput } from '../src/cli/terminal-input.js';
import { buildSetupConfiguration } from '../src/cli/setup-wizard.js';
import { defaultConfig, loadConfig, writeConfigFile, writeSecretFile } from '../src/platform/config.js';
import { PersonalAgentSystem } from '../src/system.js';

function createConfig(home) {
  const config = defaultConfig({ projectRoot: home, home });
  config.runtime.tickMs = 10;
  config.kernel.heartbeatMs = 25;
  config.kernel.serviceTimeoutMs = 1_000;
  config.kernel.housekeepingMs = 10;
  config.kernel.interruptPollMs = 5;
  config.models.default = { provider: 'offline', model: 'offline' };
  config.agents[0].workspace = join(home, 'workspace');
  return config;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition was not met before timeout');
}

test('setup configuration separates model secrets and applies product policy profiles', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-setup-'));
  try {
    const current = defaultConfig({ projectRoot: home, home });
    current.configPath = join(home, 'config.json');
    const configured = buildSetupConfiguration(current, {
      agentName: 'Aster',
      workspace: join(home, 'aster-workspace'),
      accessProfile: 'network',
      modelPreset: 'custom',
      baseUrl: 'https://models.example.test/v1',
      modelId: 'example-model',
      secretMode: 'file',
      apiKeyEnv: null,
      budgetProfile: 'safe',
      autonomy: 'observe',
      approvalRisk: 'medium',
    }, 1234);
    assert.equal(configured.models.default.apiKeyRef, 'model.default.apiKey');
    assert.equal(configured.models.default.apiKeyEnv, null);
    assert.equal(configured.gateway.bind, '0.0.0.0');
    assert.equal(configured.gateway.auth.tokenRef, 'gateway.auth.token');
    assert.equal(configured.resources.goalDefaults.maxFanOut, 3);
    assert.equal(configured.cognition.autoReflect, false);
    assert.equal(configured.security.approvalRisk, 'medium');
    assert.equal(configured.memory.captureMode, 'explicit');
    assert.equal(configured.onboarding.completedAt, 1234);

    writeSecretFile(configured.security.secretFile, {
      model: { default: { apiKey: 'private-test-key' } },
      gateway: { auth: { token: 'private-gateway-token' } },
    });
    writeConfigFile(current.configPath, configured);
    assert.doesNotMatch(readFileSync(current.configPath, 'utf8'), /private-test-key/);
    assert.doesNotMatch(readFileSync(current.configPath, 'utf8'), /private-gateway-token/);
    const loaded = loadConfig({ projectRoot: home, home, configPath: current.configPath });
    assert.equal(loaded.models.default.apiKey, 'private-test-key');
    assert.equal(loaded.gateway.auth.token, 'private-gateway-token');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('live dashboard presents operating-system state and respects terminal fallbacks', () => {
  const format = createFormatter({ color: false, stdout: { isTTY: false } });
  const snapshot = {
    kernel: { status: 'alive', hostPid: 42, services: [{}, {}, {}, {}, {}] },
    stats: { tasks: { RUNNING: 1, READY: 2, WAITING: 3 }, goals: { ACTIVE: 1 }, memories: 7, sessions: 2 },
    cognition: { lastAssessment: { score: 44, decision: { reason: 'deadline' } } },
    tasks: [{ status: 'RUNNING', title: 'Research release risks' }],
    goals: [{ status: 'ACTIVE', title: 'Prepare release plan' }],
    memories: [{ content: 'Thursday releases' }],
    pools: [{ name: 'network', active: 1, capacity: 3, queued: 0 }],
    inbox: { waiting: [{ prompt: 'Choose a release date' }], counts: { actionable: 1 } },
  };
  const rendered = dashboardLines(snapshot, { format, columns: 100, sessionKey: 'main' }).join('\n');
  assert.match(rendered, /KERNEL OWL/);
  assert.match(rendered, /1 run\s+◆ 2 ready\s+◐ 3 wait/);
  assert.match(rendered, /7 memories · 2 sessions · INBOX 1/);
  assert.match(rendered, /Thursday releases/);
  assert.equal(canUseLiveDashboard({ output: { isTTY: true, columns: 100, rows: 30 }, env: {} }), true);
  assert.equal(canUseLiveDashboard({ output: { isTTY: true, columns: 60, rows: 30 }, env: {} }), false);
  const dropdown = commandDropdownLines(suggestCommands('/fo', 20), {
    format, columns: 100, selectedIndex: 0, pageSize: 6,
  }).join('\n');
  assert.match(dropdown, /Commands 1-2\/2/);
  assert.match(dropdown, /\/focus <goal-id>/);
});

test('slash command discovery previews and completes operating-system controls', () => {
  const all = suggestCommands('/');
  assert.ok(all.length >= 6);
  assert.equal(suggestCommands('/fo')[0].name, '/focus');
  assert.equal(suggestCommands('/reply some text')[0].name, '/reply');
  assert.equal(suggestCommands('/thr')[0].name, '/tasks');
  assert.equal(suggestCommands('/mod')[0].name, '/model');
  const secondPage = commandDropdownLines(suggestCommands('/', Number.POSITIVE_INFINITY), {
    format: createFormatter({ color: false, stdout: { isTTY: false } }),
    columns: 100,
    selectedIndex: 7,
    pageSize: 6,
  }).join('\n');
  assert.match(secondPage, /Commands 7-12\/\d+/);
  assert.match(secondPage, /›/);
});

test('the model picker filters choices and accepts keyboard selection', async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  input.resume = () => {};
  const output = new EventEmitter();
  output.columns = 100;
  output.rows = 30;
  output.write = () => true;
  const terminal = new TerminalInput({
    input,
    output,
    format: createFormatter({ color: false, stdout: { isTTY: false } }),
  });
  terminal.start();
  try {
    const selected = terminal.select('model ❯ ', [
      { value: 'openai', label: 'OpenAI', description: 'gpt family' },
      { value: 'deepseek', label: 'DeepSeek', description: 'deepseek family' },
    ]);
    for (const character of 'deep') terminal.handleKeypress(character, { name: character });
    terminal.handleKeypress('\r', { name: 'return' });
    assert.equal(await selected, 'deepseek');
  } finally {
    terminal.stop();
  }
});

test('session model selection is persistent while each goal freezes its execution model', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-model-'));
  const config = createConfig(home);
  config.models.default = { provider: 'model-default', model: 'default-brain' };
  config.models.fast = { provider: 'model-fast', model: 'fast-brain' };
  const system = new PersonalAgentSystem(config);
  system.providers.register('model-default', () => ({
    async complete() {
      return { content: 'Answered by the default model', toolCalls: [], usage: null };
    },
  }));
  const selectedModelIds = [];
  system.providers.register('model-fast', (modelConfig) => ({
    async complete() {
      selectedModelIds.push(modelConfig.model);
      return { content: 'Answered by the fast model', toolCalls: [], usage: null };
    },
  }));
  await system.start();
  try {
    const sessionKey = 'tenant:default:agent:main:terminal:model-test';
    const fastGoal = await system.sessions.submit({
      text: 'Use the fast model',
      sessionKey,
      modelKey: 'fast',
      modelId: 'fast-brain-v2',
    });
    await waitFor(() => system.store.getGoal(fastGoal.goal.id)?.status === 'SUCCEEDED');
    assert.equal(system.store.getSession(fastGoal.session.id).metadata.modelKey, 'fast');
    assert.equal(system.store.getGoal(fastGoal.goal.id).metadata.modelKey, 'fast');
    assert.equal(system.store.getGoal(fastGoal.goal.id).metadata.modelId, 'fast-brain-v2');
    assert.deepEqual(selectedModelIds, ['fast-brain-v2']);
    assert.equal(system.store.listMessages(fastGoal.session.id).at(-1).content.text, 'Answered by the fast model');

    const defaultGoal = await system.sessions.submit({
      text: 'Return to the agent default',
      sessionKey,
      modelKey: null,
    });
    await waitFor(() => system.store.getGoal(defaultGoal.goal.id)?.status === 'SUCCEEDED');
    assert.equal(system.store.getSession(defaultGoal.session.id).metadata.modelKey, null);
    assert.equal(system.store.getGoal(defaultGoal.goal.id).metadata.modelKey, 'default');
    assert.equal(system.store.getGoal(defaultGoal.goal.id).metadata.modelId, 'default-brain');
    assert.equal(system.store.listMessages(defaultGoal.session.id).at(-1).content.text, 'Answered by the default model');
    assert.equal(system.store.getGoal(fastGoal.goal.id).metadata.modelKey, 'fast');

    await assert.rejects(
      system.sessions.submit({ text: 'Use a missing model', sessionKey, modelKey: 'missing' }),
      /Unknown model config: missing/,
    );
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the attention inbox resumes the exact thought thread waiting for a human', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-inbox-'));
  const config = createConfig(home);
  config.models.default = { provider: 'scripted', model: 'scripted' };
  const system = new PersonalAgentSystem(config);
  system.providers.register('scripted', () => ({
    async complete({ messages }) {
      const toolResult = [...messages].reverse().find((message) => message.role === 'tool');
      if (toolResult) {
        const reply = JSON.parse(toolResult.content);
        return { content: `Human selected ${reply.reply.message}`, toolCalls: [], usage: null };
      }
      return {
        content: '',
        toolCalls: [{
          id: 'attention-question',
          name: 'request_user_input',
          arguments: JSON.stringify({ prompt: 'Choose option A or B' }),
        }],
        usage: null,
      };
    },
  }));
  await system.start();
  try {
    const accepted = await system.sessions.submit({ text: 'Prepare a decision', channel: 'terminal', peerKey: 'owner' });
    await waitFor(() => system.inbox.snapshot().waiting.length === 1);
    const inbox = system.inbox.snapshot();
    assert.equal(inbox.waiting[0].goalId, accepted.goal.id);
    assert.equal(inbox.waiting[0].prompt, 'Choose option A or B');
    const resumed = system.inbox.reply({ target: accepted.goal.id.slice(0, 8), message: 'B' });
    assert.deepEqual(resumed.awakened, [inbox.waiting[0].taskId]);
    await waitFor(() => system.store.getGoal(accepted.goal.id)?.status === 'SUCCEEDED');
    assert.match(system.store.listMessages(accepted.session.id).at(-1).content.text, /selected B/);
    const trace = system.observability.traceGoal(accepted.goal.id);
    assert.ok(trace.evidence.some((item) => item.source === 'request_user_input'));
    assert.equal(trace.conclusion.provenanceLevel, 'execution-context');
    assert.deepEqual(trace.conclusion.evidenceIds, trace.evidence.map((item) => item.id));
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the task manager explains execution and audits operator controls', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-observability-'));
  const config = createConfig(home);
  const system = new PersonalAgentSystem(config);
  await system.start();
  try {
    const accepted = await system.sessions.submit({
      text: 'Create an observable goal',
      budget: { maxCostUsd: 0.5, maxInputTokens: 5_000 },
    });
    await waitFor(() => system.store.getGoal(accepted.goal.id)?.status === 'SUCCEEDED');
    const agentTask = system.store.listTasks(accepted.goal.id).find((task) => task.kind === 'agent-turn');
    const explanation = system.observability.explainTask(agentTask.id);
    assert.equal(explanation.goalId, accepted.goal.id);
    assert.equal(explanation.checkpoint.pc, explanation.checkpoint.totalSteps);
    assert.equal(explanation.capabilities.status, 'ACTIVE');

    const prioritized = system.store.updateTaskPriority(agentTask.id, 17, 'test', 'Reduce attention');
    assert.equal(prioritized.priority, 17);
    const revised = system.resources.reviseBudget(accepted.goal.id, { maxCostUsd: 1 }, {
      actor: 'test', reason: 'Allow one more pass',
    });
    assert.equal(revised.budget.maxCostUsd, 1);
    const auditTypes = system.store.listAudit({ goalId: accepted.goal.id, limit: 100 }).map((entry) => entry.type);
    assert.ok(auditTypes.includes('TASK_PRIORITY_REVISED'));
    assert.ok(auditTypes.includes('GOAL_BUDGET_REVISED'));

    const manager = system.observability.taskManager({ includeTerminal: true });
    assert.ok(manager.threads.some((thread) => thread.id === agentTask.id));
    const trace = system.observability.traceGoal(accepted.goal.id);
    assert.equal(trace.dag.nodes.length, 3);
    assert.equal(trace.dag.edges.length, 2);
    assert.ok(trace.causalChain.length > 3);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a resident inbound channel releases the worker, runs other work, and resumes on the exact message', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-channel-'));
  const config = createConfig(home);
  config.runtime.maxConcurrency = 1;
  config.models.default = { provider: 'channel-script', model: 'channel-script' };
  const system = new PersonalAgentSystem(config);
  let releaseMessage;
  const messageReady = new Promise((resolve) => { releaseMessage = resolve; });
  system.plugins.createApi({ id: 'channel-test' }).registerChannel('supplier-stream', {
    name: 'Supplier push stream',
    inbound: true,
    async listen({ signal, heartbeat, ingest }) {
      heartbeat({ connected: true });
      await Promise.race([
        messageReady,
        new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
      ]);
      if (signal.aborted) return;
      ingest({
        messageId: 'supplier-message-1',
        accountId: 'supplier-mail',
        threadKey: 'purchase-42',
        sender: 'supplier@example.test',
        text: 'Confirmed for Friday',
        payload: { confirmationId: 'confirm-42' },
      });
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  system.providers.register('channel-script', () => ({
    async complete({ messages }) {
      const toolResult = [...messages].reverse().find((message) => message.role === 'tool');
      if (toolResult) {
        const result = JSON.parse(toolResult.content);
        return { content: `Supplier replied: ${result.message.text}`, toolCalls: [], usage: null };
      }
      const latestUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      if (latestUser.includes('independent')) return { content: 'Independent work completed', toolCalls: [], usage: null };
      return {
        content: '',
        toolCalls: [{
          id: 'wait-supplier',
          name: 'wait_for_channel',
          arguments: JSON.stringify({
            channel: 'supplier-stream',
            accountId: 'supplier-mail',
            threadKey: 'purchase-42',
            reason: 'Waiting for the supplier confirmation',
          }),
        }],
        usage: null,
      };
    },
  }));
  await system.start();
  try {
    assert.ok(system.kernel.status().services.some((service) => service.name === 'listener:channel-supplier-stream'));
    const waitingGoal = await system.sessions.submit({ text: 'Wait for supplier confirmation', channel: 'terminal', peerKey: 'owner' });
    await waitFor(() => system.inbox.snapshot().listening.length === 1);
    assert.equal(system.scheduler.active.size, 0);

    const independent = await system.sessions.submit({
      text: 'Complete independent work while the supplier is pending',
      channel: 'terminal',
      peerKey: 'owner',
      threadKey: 'independent',
    });
    await waitFor(() => system.store.getGoal(independent.goal.id)?.status === 'SUCCEEDED');
    assert.equal(system.store.getGoal(waitingGoal.goal.id).status, 'ACTIVE');

    releaseMessage();
    await waitFor(() => system.store.getGoal(waitingGoal.goal.id)?.status === 'SUCCEEDED');
    assert.match(system.store.listMessages(waitingGoal.session.id).at(-1).content.text, /Confirmed for Friday/);
    const messages = system.store.listChannelMessages({ channelId: 'supplier-stream', tenantId: 'default' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].status, 'DELIVERED');
    const duplicate = system.channels.ingest('supplier-stream', {
      messageId: 'supplier-message-1',
      accountId: 'supplier-mail',
      threadKey: 'purchase-42',
      sender: 'supplier@example.test',
      text: 'Confirmed for Friday',
      payload: { confirmationId: 'confirm-42' },
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(system.store.listEvents({ topic: 'channel.message' }).length, 1);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('long-term memory deletion and conversation purge are separate operations', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-forget-'));
  const system = new PersonalAgentSystem(createConfig(home));
  await system.start();
  try {
    const memory = system.memory.remember({
      agentId: 'main', tenantId: 'default', content: 'Temporary product chatter', kind: 'note', source: 'test',
    });
    const diary = join(home, 'workspace', 'memory', new Date(memory.created_at).toISOString().slice(0, 10) + '.md');
    assert.match(readFileSync(diary, 'utf8'), new RegExp(memory.id));
    assert.equal(system.memory.forget(memory.id, { agentId: 'main', tenantId: 'default' }).id, memory.id);
    assert.equal(system.store.getMemory(memory.id), null);
    assert.doesNotMatch(readFileSync(diary, 'utf8'), new RegExp(memory.id));

    const accepted = await system.sessions.submit({ text: 'Disposable conversation', threadKey: 'disposable' });
    await waitFor(() => system.store.getGoal(accepted.goal.id)?.status === 'SUCCEEDED');
    const schedule = system.store.createSchedule({
      id: 'detached-schedule',
      agentId: 'main',
      tenantId: 'default',
      name: 'Detached session schedule',
      nextRunAt: Date.now() + 60_000,
      payload: { objective: 'Continue later', sessionId: accepted.session.id, parentGoalId: accepted.goal.id },
    });
    const purged = system.store.purgeSession(accepted.session.id);
    assert.equal(purged.deletedMessages, 2);
    assert.equal(purged.deletedGoals, 1);
    assert.equal(purged.deletedOutbox, 1);
    assert.equal(purged.detachedSchedules, 1);
    assert.equal(system.store.getSession(accepted.session.id), null);
    assert.equal(system.store.getGoal(accepted.goal.id), null);
    assert.deepEqual(system.store.getSchedule(schedule.id).payload, { objective: 'Continue later' });
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
