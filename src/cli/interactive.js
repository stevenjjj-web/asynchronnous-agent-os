import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { waitForGoal } from './wait.js';
import { table, relativeTime } from './format.js';

export async function interactiveChat({ client, format, sessionKey }) {
  if (!stdin.isTTY) throw new Error('Interactive chat requires a TTY');
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  let activeSessionKey = sessionKey ?? `agent:main:terminal:owner`;
  stdout.write(`${format.bold('Agent OS terminal')} ${format.dim(`session ${activeSessionKey}`)}\n`);
  stdout.write(`${format.dim('Commands: /status /kernel /tasks /goals /memory <query> /approvals /interrupts /quit')}\n\n`);
  try {
    while (true) {
      const input = (await rl.question(format.cyan('you> '))).trim();
      if (!input) continue;
      if (input === '/quit' || input === '/exit') break;
      if (input.startsWith('/')) {
        await handleSlashCommand(input, { client, format, stdout });
        continue;
      }
      const accepted = await client.post('/api/v1/messages', {
        text: input,
        sessionKey: activeSessionKey,
        channel: 'terminal',
        peerKey: 'owner',
        messageId: `terminal:${Date.now()}`,
      });
      activeSessionKey = accepted.session.session_key;
      const result = await waitForGoal({
        client,
        goalId: accepted.goal.id,
        sessionId: accepted.session.id,
        format,
        ask: (prompt) => rl.question(format.yellow(prompt)),
      });
      if (result.assistant?.content?.text) stdout.write(`${format.green('agent>')} ${result.assistant.content.text}\n\n`);
      else stdout.write(`${format.yellow('agent>')} Goal ${result.status}. No terminal message was delivered.\n\n`);
    }
  } finally {
    rl.close();
  }
}

async function handleSlashCommand(input, { client, format, stdout }) {
  const [command, ...rest] = input.slice(1).split(/\s+/);
  if (command === 'status') {
    const health = await client.get('/api/health');
    stdout.write(renderHealth(health, format));
  } else if (command === 'kernel') {
    const { daemon } = await client.get('/api/kernel');
    stdout.write(`${format.bold('Kernel')} ${daemon.status} · pid ${daemon.hostPid} · ${daemon.services.length} resident services\n`);
  } else if (command === 'tasks') {
    const { tasks } = await client.get('/api/tasks?limit=20');
    stdout.write(`${table(tasks, taskColumns())}\n`);
  } else if (command === 'goals') {
    const { goals } = await client.get('/api/goals');
    stdout.write(`${table(goals, [
      { label: 'STATUS', value: (goal) => goal.status, max: 10 },
      { label: 'GOAL', value: (goal) => goal.title, max: 54 },
      { label: 'UPDATED', value: (goal) => relativeTime(goal.updated_at), max: 12 },
    ])}\n`);
  } else if (command === 'memory') {
    const query = rest.join(' ');
    const { memories } = await client.get(`/api/memories${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    stdout.write(`${table(memories, [
      { label: 'KIND', value: (memory) => memory.kind, max: 12 },
      { label: 'MEMORY', value: (memory) => memory.content, max: 68 },
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
    `Attention  ${stats.pendingInterrupts} interrupts · ${stats.pendingApprovals} approvals · ${stats.pendingOutbox} outbound`,
    `Model      ${health.modelConfigured ? 'configured' : 'offline fallback'}`,
    '',
  ].join('\n');
}
