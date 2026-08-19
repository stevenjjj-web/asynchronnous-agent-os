import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { waitForGoal } from './wait.js';
import { table, relativeTime } from './format.js';
import { renderWelcome } from './banner.js';
import { LiveDashboard } from './live-dashboard.js';
import { commandCatalogLines } from './command-palette.js';
import { TerminalInput } from './terminal-input.js';

export async function interactiveChat({ client, format, sessionKey, version = 'dev', animate = true, live = true, configureModel }) {
  if (!stdin.isTTY) throw new Error('Interactive chat requires a TTY');
  await renderWelcome({ client, format, version, sessionKey, animate });
  const dashboard = new LiveDashboard({ client, format, sessionKey, enabled: live });
  await dashboard.start().catch(() => false);
  const terminalInput = new TerminalInput({ input: stdin, output: stdout, format });
  let activeSessionKey = sessionKey ?? 'tenant:default:agent:main:terminal:owner';
  let focusedGoal = null;
  let selectedModel = await readSessionModel(client, activeSessionKey).catch(() => undefined);
  dashboard.setSessionKey(activeSessionKey);
  terminalInput.start();
  try {
    while (true) {
      const input = (await terminalInput.question(`${format.cyan('you')} ${format.bold('❯')} `, { commands: true })).trim();
      if (!input) continue;
      try {
        if (input === '/quit' || input === '/exit') break;
        if (input === '/new') {
          const previousSessionKey = activeSessionKey;
          activeSessionKey = freshSessionKey();
          focusedGoal = null;
          selectedModel = undefined;
          dashboard.setSessionKey(activeSessionKey);
          dashboard.setFocusedGoal(null);
          stdout.write(`${format.green('✓')} New clean conversation context started. Previous session: ${previousSessionKey}\n`);
          stdout.write(`${format.dim('Existing history and long-term memory were not deleted. Use /purge while a session is active to remove its history.')}\n`);
          continue;
        }
        if (input === '/purge') {
          const answer = (await terminalInput.question(format.yellow('Permanently delete this session history and its completed goals? Type "yes": '))).trim().toLowerCase();
          if (answer !== 'yes') {
            stdout.write(`${format.dim('Session purge cancelled.')}\n`);
            continue;
          }
          const result = await client.post(`/api/sessions/${encodeURIComponent(activeSessionKey)}/purge`);
          activeSessionKey = freshSessionKey();
          focusedGoal = null;
          selectedModel = undefined;
          dashboard.setSessionKey(activeSessionKey);
          dashboard.setFocusedGoal(null);
          stdout.write(`${format.green('✓')} Purged ${result.purged.deletedMessages} messages, ${result.purged.deletedGoals} completed goals, and ${result.purged.deletedOutbox} delivery records. Long-term memory was preserved.\n`);
          await dashboard.refresh();
          continue;
        }
        if (input.startsWith('/forget ')) {
          const memoryId = input.slice('/forget '.length).trim();
          const answer = (await terminalInput.question(format.yellow(`Permanently forget long-term memory ${memoryId}? Type "yes": `))).trim().toLowerCase();
          if (answer !== 'yes') {
            stdout.write(`${format.dim('Memory deletion cancelled.')}\n`);
            continue;
          }
          const result = await client.post(`/api/memories/${encodeURIComponent(memoryId)}/forget`);
          stdout.write(`${format.green('✓')} Forgot long-term memory ${result.forgotten.id}\n`);
          await dashboard.refresh();
          continue;
        }
        if (input.startsWith('/task ') || input.startsWith('/bg ')) {
          const text = input.slice(input.indexOf(' ') + 1).trim();
          if (!text) {
            stdout.write(format.yellow('Usage: /task <instruction>\n'));
            continue;
          }
          const accepted = await submitMessage(client, text, activeSessionKey, {
            parentGoalId: focusedGoal?.id,
            ...(selectedModel ?? {}),
          });
          activeSessionKey = accepted.session.session_key;
          dashboard.setSessionKey(activeSessionKey);
          stdout.write(`${format.green('◆')} Background goal accepted: ${accepted.goal.id}\n`);
          await dashboard.refresh();
          continue;
        }
        if (input.startsWith('/interrupt ')) {
          const text = input.slice('/interrupt '.length).trim();
          const accepted = await submitMessage(client, text, activeSessionKey, {
            parentGoalId: focusedGoal?.id,
            priority: 100,
            interrupt: true,
            interruptReason: text,
            ...(selectedModel ?? {}),
          });
          activeSessionKey = accepted.session.session_key;
          dashboard.setSessionKey(activeSessionKey);
          stdout.write(`${format.yellow('▲')} Urgent goal raised: ${accepted.goal.id}\n`);
          await dashboard.refresh();
          continue;
        }
        if (input === '/focus' || input.startsWith('/focus ')) {
          const goalId = input.slice('/focus'.length).trim();
          if (!goalId) {
            stdout.write(focusedGoal
              ? `Focused on ${focusedGoal.title} · ${focusedGoal.id}\n`
              : `${format.dim('No goal is focused.')}\n`);
            continue;
          }
          const resolved = await resolveGoal(client, goalId);
          focusedGoal = { id: resolved.goal.id, title: resolved.goal.title, status: resolved.goal.status };
          if (resolved.goal.session_id) {
            const { session } = await client.get(`/api/sessions/${encodeURIComponent(resolved.goal.session_id)}`);
            activeSessionKey = session.session_key;
            selectedModel = Object.prototype.hasOwnProperty.call(session.metadata, 'modelKey')
              ? { modelKey: session.metadata.modelKey, modelId: session.metadata.modelId ?? null }
              : undefined;
            dashboard.setSessionKey(activeSessionKey);
          }
          dashboard.setFocusedGoal(focusedGoal);
          stdout.write(`${format.green('◎')} Focused on ${focusedGoal.title} · ${focusedGoal.id}\n`);
          continue;
        }
        if (input === '/unfocus') {
          focusedGoal = null;
          dashboard.setFocusedGoal(null);
          stdout.write(`${format.green('○')} Returned to general attention routing.\n`);
          continue;
        }
        if (input === '/reply' || input.startsWith('/reply ')) {
          const reply = await resolveReplyCommand(client, input.slice('/reply'.length).trim());
          stdout.write(`${format.green('↻')} Resumed ${reply.selected.goalTitle} · ${reply.selected.goalId}\n`);
          await dashboard.refresh();
          continue;
        }
        if (input === '/model' || input.startsWith('/model ')) {
          selectedModel = await handleModelCommand(input, {
            client,
            format,
            stdout,
            sessionKey: activeSessionKey,
            selectedModel,
            terminalInput,
            dashboard,
            configureModel,
          });
          continue;
        }
        if (input.startsWith('/')) {
          await handleSlashCommand(input, { client, format, stdout, dashboard, sessionKey: activeSessionKey });
          continue;
        }
        const routed = await routeNaturalReply(client, input, {
          sessionKey: activeSessionKey,
          focusedGoalId: focusedGoal?.id,
        });
        if (routed?.ambiguous) {
          stdout.write(`${format.yellow('!')} ${routed.count} thought threads need input. Use /inbox, then /reply <goal-id> <message>.\n`);
          continue;
        }
        if (routed) {
          stdout.write(`${format.green('↻')} Routed as a reply to ${routed.selected.goalTitle} · ${routed.selected.goalId}\n`);
          await dashboard.refresh();
          continue;
        }
        const accepted = await submitMessage(client, input, activeSessionKey, {
          parentGoalId: focusedGoal?.id,
          ...(selectedModel ?? {}),
        });
        activeSessionKey = accepted.session.session_key;
        dashboard.setSessionKey(activeSessionKey);
        const result = await waitForGoal({
          client,
          goalId: accepted.goal.id,
          sessionId: accepted.session.id,
          format,
          ask: (prompt) => terminalInput.question(format.yellow(prompt)),
        });
        if (result.assistant?.content?.text) stdout.write(`\n${format.green('agent-os')} ${format.bold('❯')} ${result.assistant.content.text}\n\n`);
        else stdout.write(`\n${format.yellow('agent-os')} ${format.bold('❯')} Goal ${result.status}. No terminal message was delivered.\n\n`);
      } catch (error) {
        stdout.write(`${format.red('!')} ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    terminalInput.stop();
    dashboard.stop();
  }
}

function freshSessionKey() {
  return `agent:main:terminal:owner:thread:${randomUUID()}`;
}

async function submitMessage(client, text, sessionKey, options = {}) {
  const body = {
    text,
    sessionKey,
    channel: 'terminal',
    peerKey: 'owner',
    messageId: `terminal:${randomUUID()}`,
    parentGoalId: options.parentGoalId,
    priority: options.priority,
    interrupt: options.interrupt,
    interruptReason: options.interruptReason,
  };
  if (Object.prototype.hasOwnProperty.call(options, 'modelKey') && options.modelKey !== undefined) {
    body.modelKey = options.modelKey;
  }
  if (Object.prototype.hasOwnProperty.call(options, 'modelId') && options.modelId !== undefined) {
    body.modelId = options.modelId;
  }
  return client.post('/api/v1/messages', body);
}

async function readSessionModel(client, sessionKey) {
  const { sessions } = await client.get('/api/sessions');
  const session = sessions.find((item) => item.id === sessionKey || item.session_key === sessionKey);
  if (!session || !Object.prototype.hasOwnProperty.call(session.metadata, 'modelKey')) return undefined;
  return { modelKey: session.metadata.modelKey, modelId: session.metadata.modelId ?? null };
}

async function handleModelCommand(input, {
  client, format, stdout, sessionKey, selectedModel, terminalInput, dashboard, configureModel,
}) {
  const requested = input.slice('/model'.length).trim();
  if (!requested) stdout.write(`${format.dim('Discovering models from configured providers…')}\n`);
  const [{ models, defaults, choices = [], discoveryErrors = [] }, { sessions }] = await Promise.all([
    client.get(`/api/models${requested === 'status' ? '' : '?discover=true'}`),
    client.get('/api/sessions'),
  ]);
  const session = sessions.find((item) => item.id === sessionKey || item.session_key === sessionKey);
  const storedSelection = session && Object.prototype.hasOwnProperty.call(session.metadata, 'modelKey')
    ? { modelKey: session.metadata.modelKey, modelId: session.metadata.modelId ?? null }
    : selectedModel;
  const defaultModelKey = defaults[session?.agent_id ?? 'main'] ?? models[0]?.key;
  const effectiveModelKey = storedSelection?.modelKey ?? defaultModelKey;
  const effectiveBase = models.find((item) => item.key === effectiveModelKey);
  const effectiveModelId = storedSelection?.modelId ?? effectiveBase?.model;

  if (requested === 'status') {
    stdout.write(`${format.bold('Models')} · current ${format.cyan(effectiveModelId)} · ${effectiveModelKey}${storedSelection == null ? format.dim(' (agent default)') : ''}\n`);
    stdout.write(`${table(models, [
      { label: '', value: (item) => item.key === effectiveModelKey ? '●' : ' ', max: 1 },
      { label: 'KEY', value: (item) => item.key, max: 20 },
      { label: 'PROVIDER', value: (item) => item.provider, max: 22 },
      { label: 'MODEL', value: (item) => item.model, max: 36 },
      { label: 'READY', value: (item) => item.configured ? 'yes' : 'no', max: 5 },
    ])}\n`);
    stdout.write(`${format.dim('Use /model to open the searchable picker, or /model default to restore the agent default.')}\n`);
    return storedSelection;
  }

  let nextSelection;
  if (!requested) {
    const uniqueChoices = [...new Map(choices.map((choice) => [`${choice.modelKey}\u0000${choice.modelId}`, choice])).values()];
    const optionMap = new Map();
    const options = [{
      value: '__default__',
      label: `Agent default · ${models.find((item) => item.key === defaultModelKey)?.model ?? defaultModelKey}`,
      description: 'Clear the session override',
    }];
    if (configureModel) {
      options.push(
        { value: '__configure__:openai', label: 'Add OpenAI provider…', description: 'Configure endpoint and credential' },
        { value: '__configure__:openrouter', label: 'Add OpenRouter provider…', description: 'Configure endpoint and credential' },
        { value: '__configure__:deepseek', label: 'Add DeepSeek provider…', description: 'Configure endpoint and credential' },
        { value: '__configure__:custom', label: 'Add custom provider…', description: 'Any OpenAI-compatible endpoint' },
        { value: '__configure__:offline', label: 'Add offline mode…', description: 'Run without model network access' },
      );
    }
    uniqueChoices.forEach((choice, index) => {
      const value = `model:${index}`;
      optionMap.set(value, choice);
      options.push({
        value,
        label: choice.modelId,
        description: `${choice.modelKey} · ${choice.provider}${choice.modelKey === effectiveModelKey && choice.modelId === effectiveModelId ? ' · current' : ''}`,
      });
    });
    const selected = await terminalInput.select(`${format.cyan('model')} ${format.bold('❯')} `, options);
    if (!selected) return storedSelection;
    if (selected === '__default__') nextSelection = { modelKey: null, modelId: null };
    else if (selected.startsWith('__configure__:')) {
      dashboard.stop();
      terminalInput.stop();
      let configured;
      try {
        configured = await configureModel(selected.slice('__configure__:'.length));
      } finally {
        terminalInput.start();
        await dashboard.start().catch(() => false);
      }
      nextSelection = { modelKey: configured.modelKey, modelId: configured.modelId };
    } else {
      const choice = optionMap.get(selected);
      nextSelection = { modelKey: choice.modelKey, modelId: choice.modelId };
    }
    if (discoveryErrors.length) {
      stdout.write(`${format.dim(`Some provider catalogs were unavailable: ${discoveryErrors.map((item) => item.modelKey).join(', ')}`)}\n`);
    }
  } else if (requested === 'default') {
    nextSelection = { modelKey: null, modelId: null };
  } else {
    const configured = models.find((item) => item.key === requested);
    const matchingChoices = choices.filter((item) => item.modelId === requested);
    const choice = matchingChoices.find((item) => item.modelKey === effectiveModelKey) ?? matchingChoices[0];
    if (configured) nextSelection = { modelKey: configured.key, modelId: configured.model };
    else if (choice) nextSelection = { modelKey: choice.modelKey, modelId: choice.modelId };
    else throw new Error(`Unknown model: ${requested}. Use /model to search the provider catalog.`);
  }
  if (session) {
    await client.post(`/api/sessions/${encodeURIComponent(session.id)}/model`, nextSelection);
  }
  const nextEffectiveKey = nextSelection.modelKey ?? defaultModelKey;
  const nextEffectiveId = nextSelection.modelId ?? models.find((item) => item.key === nextEffectiveKey)?.model ?? nextEffectiveKey;
  stdout.write(`${format.green('✓')} Session model set to ${format.cyan(nextEffectiveId)} · ${nextEffectiveKey}${nextSelection.modelKey == null ? format.dim(' (agent default)') : ''}. New goals will use it; active goals keep their frozen model.\n`);
  return nextSelection;
}

async function resolveGoal(client, idOrPrefix) {
  const { goals } = await client.get('/api/goals');
  const matches = goals.filter((goal) => goal.id === idOrPrefix || goal.id.startsWith(idOrPrefix));
  if (!matches.length) throw new Error(`Goal not found: ${idOrPrefix}`);
  if (matches.length > 1) throw new Error(`Goal id prefix is ambiguous: ${idOrPrefix}`);
  return client.get(`/api/goals/${encodeURIComponent(matches[0].id)}`);
}

async function resolveTask(client, idOrPrefix) {
  const { tasks } = await client.get('/api/tasks?limit=1000');
  const matches = tasks.filter((task) => task.id === idOrPrefix || task.id.startsWith(idOrPrefix));
  if (!matches.length) throw new Error(`Task not found: ${idOrPrefix}`);
  if (matches.length > 1) throw new Error(`Task id prefix is ambiguous: ${idOrPrefix}`);
  return matches[0];
}

async function resolveReplyCommand(client, raw) {
  if (!raw) throw new Error('Usage: /reply [goal-id] <message>');
  const inbox = await client.get('/api/inbox');
  if (!inbox.waiting.length) throw new Error('No thought thread is waiting for user input');
  const [first, ...remainder] = raw.split(/\s+/);
  const targetMatch = inbox.waiting.some((item) => item.goalId.startsWith(first) || item.taskId.startsWith(first));
  const target = targetMatch ? first : undefined;
  const message = targetMatch ? remainder.join(' ') : raw;
  if (!message) throw new Error('Reply message is required');
  return client.post('/api/inbox/reply', {
    target,
    message,
    idempotencyKey: `terminal-reply:${randomUUID()}`,
  });
}

async function routeNaturalReply(client, message, { sessionKey, focusedGoalId } = {}) {
  const inbox = await client.get('/api/inbox');
  const candidates = inbox.waiting.filter((item) => focusedGoalId
    ? item.goalId === focusedGoalId
    : item.sessionKey === sessionKey);
  if (candidates.length > 1) return { ambiguous: true, count: candidates.length };
  if (candidates.length !== 1) return null;
  return client.post('/api/inbox/reply', {
    target: candidates[0].taskId,
    message,
    idempotencyKey: `terminal-natural-reply:${randomUUID()}`,
  });
}

async function handleSlashCommand(input, { client, format, stdout, dashboard, sessionKey }) {
  const [command, ...rest] = input.slice(1).split(/\s+/);
  if (command === 'help' || command === 'commands') {
    stdout.write(`${commandCatalogLines(format).join('\n')}\n`);
  } else if (command === 'clear') {
    if (!dashboard.clearLog()) stdout.write('\u001b[2J\u001b[H');
  } else if (command === 'manager' || command === 'ps') {
    const result = await client.get('/api/task-manager?limit=100');
    stdout.write(`${format.bold('Thought thread task manager')} · ${result.threads.length} active threads\n`);
    stdout.write(`${table(result.threads, [
      { label: 'STATE', value: (item) => item.status, max: 9 },
      { label: 'PRI', value: (item) => item.priority, max: 3 },
      { label: 'THREAD', value: (item) => item.title, max: 28 },
      { label: 'WHY', value: (item) => item.reason, max: 42 },
      { label: 'TOKENS', value: (item) => Number(item.usage.tokens ?? 0), max: 8 },
      { label: 'COST', value: (item) => item.pricing.status === 'unpriced' ? 'unpriced' : `$${Number(item.usage.costUsd ?? 0).toFixed(4)}`, max: 9 },
      { label: 'PC', value: (item) => `${item.checkpoint.pc}/${item.checkpoint.totalSteps}`, max: 7 },
      { label: 'CAP', value: (item) => item.capabilities.status, max: 8 },
      { label: 'ID', value: (item) => item.id, max: 36 },
    ])}\n`);
  } else if (command === 'inspect') {
    if (!rest[0]) throw new Error('Usage: /inspect <task-id>');
    const task = await resolveTask(client, rest[0]);
    const { thread } = await client.get(`/api/tasks/${encodeURIComponent(task.id)}/explain`);
    stdout.write(`${format.bold(thread.title)} · ${thread.status} · priority ${thread.priority}\n`);
    stdout.write(`Why         ${thread.reason}\nCheckpoint  pc ${thread.checkpoint.pc}/${thread.checkpoint.totalSteps} · revision ${thread.checkpoint.revision} · ${new Date(thread.checkpoint.at).toISOString()}\n`);
    stdout.write(`Wait        ${thread.wait ? JSON.stringify(thread.wait) : '-'}\nResources   ${Number(thread.usage.tokens ?? 0)} tokens · ${thread.pricing.status === 'unpriced' ? 'cost unpriced' : `$${Number(thread.usage.costUsd ?? 0).toFixed(6)}`} · ${Number(thread.usage.toolCalls ?? 0)} tools\n`);
    stdout.write(`Capability  ${thread.capabilities.status} · tools ${thread.capabilities.tools.join(', ') || '-'} · pools ${thread.capabilities.resourcePools.join(', ') || '-'}\n`);
    stdout.write(`Preemption  ${thread.preemption ? thread.preemption.reason : '-'}\nEvidence    ${thread.evidence.map((item) => item.id).join(', ') || 'none recorded'}\n`);
  } else if (command === 'trace') {
    if (!rest[0]) throw new Error('Usage: /trace <goal-id>');
    const resolved = await resolveGoal(client, rest[0]);
    const trace = await client.get(`/api/goals/${encodeURIComponent(resolved.goal.id)}/trace`);
    stdout.write(`${format.bold(trace.goal.title)} · ${trace.goal.status}\n${format.bold('DAG')}\n`);
    trace.dag.nodes.forEach((node) => stdout.write(`  ${node.id.slice(0, 8)} ${node.status.padEnd(9)} ${node.title} ← ${node.dependencies.map((item) => item.id.slice(0, 8)).join(', ') || 'root'}\n`));
    stdout.write(`${format.bold('Causal replay')}\n`);
    trace.causalChain.forEach((event) => stdout.write(`  ${String(event.sequence).padStart(3)} ${event.type.padEnd(24)} ${event.message}\n`));
    stdout.write(`${format.bold('Evidence')} ${trace.evidence.map((item) => item.id).join(', ') || 'none recorded'}\n`);
  } else if (command === 'plan') {
    if (!rest[0]) throw new Error('Usage: /plan <goal-id>');
    const resolved = await resolveGoal(client, rest[0]);
    const plan = await client.get(`/api/goals/${encodeURIComponent(resolved.goal.id)}/plan`);
    stdout.write(`${format.bold(plan.goal.title)} · cognitive plan\n${table(plan.versions, [
      { label: 'VERSION', value: (item) => item.version, max: 7 },
      { label: 'STATUS', value: (item) => item.status, max: 12 },
      { label: 'TRIGGER', value: (item) => item.trigger.type ?? '-', max: 24 },
      { label: 'WHEN', value: (item) => relativeTime(item.created_at), max: 12 },
    ])}\n${format.bold('Assumptions')}\n${table(plan.assumptions, [
      { label: 'STATUS', value: (item) => item.status, max: 12 },
      { label: 'CONF', value: (item) => Number(item.confidence).toFixed(2), max: 5 },
      { label: 'ASSUMPTION', value: (item) => item.statement, max: 60 },
      { label: 'WATCH', value: (item) => item.watch.topic ?? '-', max: 24 },
    ])}\n`);
  } else if (['pause', 'resume', 'cancel'].includes(command)) {
    if (!rest[0]) throw new Error(`Usage: /${command} <task-id>`);
    const task = await resolveTask(client, rest[0]);
    const result = await client.post(`/api/tasks/${encodeURIComponent(task.id)}/${command}`);
    stdout.write(`${format.green('✓')} ${result.task.title} → ${result.task.status}\n`);
    await dashboard.refresh();
  } else if (command === 'priority') {
    if (!rest[0] || rest[1] === undefined) throw new Error('Usage: /priority <task-id> <0-100>');
    const task = await resolveTask(client, rest[0]);
    const priority = Number(rest[1]);
    if (!Number.isFinite(priority)) throw new Error('Priority must be a number');
    const result = await client.post(`/api/tasks/${encodeURIComponent(task.id)}/priority`, {
      priority, actor: 'terminal', reason: 'Priority revised from the operator terminal',
    });
    stdout.write(`${format.green('✓')} ${result.task.title} priority → ${result.task.priority}\n`);
    await dashboard.refresh();
  } else if (command === 'budget') {
    if (!rest[0] || !rest[1] || rest[2] === undefined) throw new Error('Usage: /budget <goal-id> <field> <value>');
    const resolved = await resolveGoal(client, rest[0]);
    const value = Number(rest[2]);
    if (!Number.isFinite(value)) throw new Error('Budget value must be a number');
    const result = await client.post(`/api/goals/${encodeURIComponent(resolved.goal.id)}/budget`, {
      budget: { [rest[1]]: value }, actor: 'terminal', reason: 'Budget revised from the operator terminal',
    });
    stdout.write(`${format.green('✓')} ${rest[1]} → ${result.contract.budget[rest[1]]}\n`);
  } else if (command === 'revoke') {
    if (!rest[0]) throw new Error('Usage: /revoke <goal-id>');
    const resolved = await resolveGoal(client, rest[0]);
    const result = await client.post(`/api/goals/${encodeURIComponent(resolved.goal.id)}/capabilities/revoke`, {
      actor: 'terminal', reason: 'Capabilities revoked from the operator terminal',
    });
    stdout.write(`${format.yellow('▲')} ${resolved.goal.title} capabilities → ${result.contract.capability_status}\n`);
  } else if (command === 'status') {
    const health = await client.get('/api/health');
    stdout.write(renderHealth(health, format));
  } else if (command === 'kernel') {
    const { daemon } = await client.get('/api/kernel');
    stdout.write(`${format.bold('Kernel')} ${daemon.status} · pid ${daemon.hostPid} · ${daemon.services.length} resident services\n`);
  } else if (command === 'tasks' || command === 'threads') {
    const { tasks } = await client.get('/api/tasks?limit=20');
    stdout.write(`${table(tasks, taskColumns())}\n`);
  } else if (command === 'goals') {
    const { goals } = await client.get('/api/goals');
    stdout.write(`${table(goals, [
      { label: 'STATUS', value: (goal) => goal.status, max: 10 },
      { label: 'GOAL', value: (goal) => goal.title, max: 54 },
      { label: 'UPDATED', value: (goal) => relativeTime(goal.updated_at), max: 12 },
      { label: 'ID', value: (goal) => goal.id, max: 36 },
    ])}\n`);
  } else if (command === 'inbox') {
    const inbox = await client.get('/api/inbox');
    const rows = [
      ...inbox.waiting.map((item) => ({
        type: 'INPUT', need: item.prompt, goal: item.goalTitle, id: item.goalId,
      })),
      ...inbox.approvals.map((item) => ({
        type: `APPROVAL:${item.risk}`, need: item.action, goal: item.goalTitle, id: item.id,
      })),
      ...inbox.listening.map((item) => ({
        type: 'LISTEN', need: `${item.channel}:${item.accountId}:${item.threadKey}`, goal: item.goalTitle, id: item.goalId,
      })),
    ];
    stdout.write(`${format.bold(`Attention inbox · ${inbox.counts.actionable} actionable · ${inbox.counts.listening} channel listeners`)}\n`);
    stdout.write(`${table(rows, [
      { label: 'TYPE', value: (item) => item.type, max: 16 },
      { label: 'NEED', value: (item) => item.need, max: 50 },
      { label: 'GOAL', value: (item) => item.goal, max: 36 },
      { label: 'ID', value: (item) => item.id, max: 36 },
    ])}\n`);
    if (inbox.completions.length) {
      stdout.write(`\n${format.bold('Recent completions')}\n${table(inbox.completions, [
        { label: 'STATUS', value: (item) => item.status, max: 10 },
        { label: 'GOAL', value: (item) => item.goalTitle, max: 60 },
        { label: 'WHEN', value: (item) => relativeTime(item.completedAt), max: 12 },
        { label: 'ID', value: (item) => item.goalId, max: 36 },
      ])}\n`);
    }
  } else if (command === 'history') {
    const { sessions } = await client.get('/api/sessions');
    const current = sessions.find((session) => session.id === sessionKey || session.session_key === sessionKey);
    if (!current) {
      stdout.write(`${format.dim('(empty conversation)')}\n`);
      return;
    }
    const { messages } = await client.get(`/api/sessions/${encodeURIComponent(current.id)}?limit=30`);
    if (!messages.length) stdout.write(`${format.dim('(empty conversation)')}\n`);
    else messages.forEach((message) => stdout.write(`${format.dim(message.role.padEnd(9))} ${message.content.text ?? JSON.stringify(message.content)}\n`));
  } else if (command === 'memory') {
    const query = rest.join(' ');
    const { memories } = await client.get(`/api/memories${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    stdout.write(`${table(memories, [
      { label: 'STATUS', value: (memory) => memory.status, max: 12 },
      { label: 'KIND', value: (memory) => memory.kind, max: 12 },
      { label: 'MEMORY', value: (memory) => memory.content, max: 54 },
      { label: 'CONF', value: (memory) => Number(memory.confidence).toFixed(2), max: 5 },
      { label: 'ID', value: (memory) => memory.id, max: 36 },
    ])}\n`);
  } else if (command === 'memory-sync') {
    const [{ providers }, { runs }] = await Promise.all([
      client.get('/api/memory-portability/providers'),
      client.get('/api/memory-portability/runs?limit=20'),
    ]);
    stdout.write(`${format.bold('Memory providers')}\n${table(providers, [
      { label: 'PROVIDER', value: (item) => item.id, max: 24 },
      { label: 'TYPE', value: (item) => item.type, max: 16 },
      { label: 'REMOTE', value: (item) => item.remote ? 'yes' : 'no', max: 6 },
      { label: 'SIGNED', value: (item) => item.signatureRequired ? 'required' : '-', max: 8 },
      { label: 'CRYPT', value: (item) => item.encryptionRequired ? 'required' : '-', max: 8 },
      { label: 'AUTO PULL', value: (item) => item.pullIntervalMs ?? '-', max: 12 },
      { label: 'AUTO PUSH', value: (item) => item.pushIntervalMs ?? '-', max: 12 },
    ])}\n\n${format.bold('Recent sync runs')}\n${table(runs, [
      { label: 'STATUS', value: (item) => item.status, max: 10 },
      { label: 'DIRECTION', value: (item) => item.direction, max: 9 },
      { label: 'PROVIDER', value: (item) => item.provider_id, max: 20 },
      { label: 'DIGEST', value: (item) => item.bundle_digest ?? '-', max: 24 },
      { label: 'WHEN', value: (item) => relativeTime(item.started_at), max: 12 },
    ])}\n`);
  } else if (command === 'approvals') {
    const { approvals } = await client.get('/api/approvals?status=PENDING');
    stdout.write(`${table(approvals, [
      { label: 'RISK', value: (approval) => approval.risk, max: 10 },
      { label: 'ACTION', value: (approval) => approval.action, max: 28 },
      { label: 'ID', value: (approval) => approval.id, max: 48 },
    ])}\n`);
  } else if (command === 'interrupts') {
    const { interrupts } = await client.get('/api/interrupts?status=PENDING');
    stdout.write(`${table(interrupts, [
      { label: 'PRIORITY', value: (item) => item.priority, max: 8 },
      { label: 'REASON', value: (item) => item.reason, max: 64 },
      { label: 'ID', value: (item) => item.id, max: 36 },
    ])}\n`);
  } else if (command === 'resources') {
    const result = await client.get('/api/resources');
    stdout.write(`${table(result.pools, [
      { label: 'POOL', value: (item) => item.name, max: 28 },
      { label: 'CAPACITY', value: (item) => item.capacity, max: 8 },
      { label: 'ACTIVE', value: (item) => item.active, max: 6 },
      { label: 'QUEUED', value: (item) => item.queued, max: 6 },
    ])}\n`);
  } else if (command === 'channels') {
    const result = await client.get('/api/tools');
    stdout.write(`${table(result.channels, [
      { label: 'CHANNEL', value: (item) => item.id, max: 24 },
      { label: 'SEND', value: (item) => item.canSend ? 'yes' : 'no', max: 5 },
      { label: 'RECEIVE', value: (item) => item.canReceive ? 'yes' : 'no', max: 7 },
      { label: 'LISTENER', value: (item) => item.canListen ? 'resident' : item.inbound ? 'gateway' : '-', max: 10 },
      { label: 'NAME', value: (item) => item.name, max: 46 },
    ])}\n`);
  } else if (command === 'attention') {
    const result = await client.get('/api/attention?agentId=main');
    stdout.write(`${table(result.assessments, [
      { label: 'SCORE', value: (item) => Number(item.score).toFixed(1), max: 6 },
      { label: 'WAKE', value: (item) => item.decision.shouldWake ? 'yes' : 'no', max: 5 },
      { label: 'REASON', value: (item) => item.decision.reason, max: 32 },
      { label: 'WHEN', value: (item) => relativeTime(item.created_at), max: 12 },
    ])}\n`);
  } else if (command === 'security') {
    const result = await client.get('/api/security/audit');
    stdout.write(`${format.bold('Security audit')} · ${result.summary.critical} critical · ${result.summary.high} high · ${result.summary.warning} warning\n`);
    stdout.write(`${table(result.findings, [
      { label: 'LEVEL', value: (item) => item.severity.toUpperCase(), max: 8 },
      { label: 'CHECK', value: (item) => item.id, max: 32 },
      { label: 'FINDING', value: (item) => item.title, max: 68 },
    ])}\n`);
  } else {
    stdout.write(format.yellow(`Unknown command: /${command}\n`));
  }
}

export function taskColumns() {
  return [
    { label: 'STATUS', value: (task) => task.status, max: 10 },
    { label: 'TASK', value: (task) => task.title, max: 48 },
    { label: 'KIND', value: (task) => task.kind, max: 16 },
    { label: 'UPDATED', value: (task) => relativeTime(task.updated_at), max: 12 },
    { label: 'ID', value: (task) => task.id, max: 36 },
  ];
}

export function renderHealth(health, format) {
  const pulse = health.pulse?.value;
  const stats = health.stats;
  return [
    `${format.bold('Agent OS')} ${format.green(health.ok ? 'ALIVE' : 'DEGRADED')}`,
    `Kernel     ${health.kernel?.status ?? 'unknown'} · pid ${health.kernel?.hostPid ?? '-'}`,
    `Gateway    ${health.workerId}`,
    `Pulse      ${pulse ? `#${pulse.sequence} · ${relativeTime(pulse.lastPulseAt)}` : 'not observed yet'}`,
    `Threads    running ${stats.tasks.RUNNING ?? 0} · ready ${stats.tasks.READY ?? 0} · waiting ${stats.tasks.WAITING ?? 0} · blocked ${stats.tasks.BLOCKED ?? 0}`,
    `Memory     ${stats.memories} records · ${stats.sessions} sessions`,
    `Sensing    ${stats.enabledMonitors} monitors · ${stats.enabledSchedules} schedules`,
    `Resident   ${stats.residentProcesses} processes · ${health.kernel?.services?.length ?? 0} supervised services`,
    `Attention  ${stats.pendingInterrupts} interrupts · ${stats.pendingApprovals} approvals · ${stats.uncertainOperations} uncertain operations`,
    `Delivery   ${stats.pendingOutbox} outbound · ${stats.activeCapabilityContracts} active contracts`,
    `Model      ${health.modelConfigured ? 'configured' : 'offline fallback'}`,
    '',
  ].join('\n');
}
