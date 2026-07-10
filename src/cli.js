#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, validateConfig, writeDefaultConfig } from './platform/config.js';
import { parseArgs, numberFlag } from './cli/args.js';
import { GatewayClient } from './cli/client.js';
import { createFormatter, printJson, relativeTime, table } from './cli/format.js';
import { interactiveChat, renderHealth, taskColumns } from './cli/interactive.js';
import { waitForGoal } from './cli/wait.js';

const VERSION = '0.4.0';
const { flags, positionals } = parseArgs(process.argv.slice(2));
const command = positionals[0] ?? 'help';
const subcommand = positionals[1];
const config = loadConfig({ projectRoot: process.cwd() });
const format = createFormatter({ color: flags['no-color'] !== true });
const monitorUrlFlag = command === 'monitors' && subcommand === 'add' && positionals[2] === 'https';
const client = new GatewayClient({
  config,
  url: flags.gateway ?? flags['gateway-url'] ?? (monitorUrlFlag ? undefined : flags.url),
  token: flags.token,
});
const json = flags.json === true;
const pidPath = join(config.home, 'gateway.pid');
const gatewayLogPath = join(config.home, 'logs', 'gateway.log');
const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));

try {
  await dispatch();
} catch (error) {
  if (json) printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
  else process.stderr.write(`${format.red('error:')} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function dispatch() {
  if (flags.version || command === 'version') return stdout.write(`${VERSION}\n`);
  if (command === 'help' || flags.help) return help();
  if (command === 'start' || (command === 'gateway' && (!subcommand || subcommand === 'run'))) return import('./server.js');
  if (command === 'gateway' && subcommand === 'start') return startGatewayDaemon();
  if (command === 'gateway' && subcommand === 'stop') return stopGatewayDaemon();
  if (command === 'gateway' && subcommand === 'restart') {
    await stopGatewayDaemon({ allowStopped: true });
    return startGatewayDaemon();
  }
  if (command === 'init') return init();
  if (command === 'doctor') return doctor();
  if (command === 'status' || command === 'health' || (command === 'gateway' && subcommand === 'status')) return status();
  if (command === 'chat' || command === 'terminal') return interactiveChat({ client, format, sessionKey: flags.session });
  if (command === 'run' || command === 'agent') return runAgent();
  if (command === 'goals') return goals();
  if (command === 'tasks') return tasks();
  if (command === 'sessions') return sessions();
  if (command === 'memory') return memory();
  if (command === 'approvals' || command === 'approve' || command === 'deny') return approvals();
  if (command === 'schedules') return schedules();
  if (command === 'monitors') return monitors();
  if (command === 'kernel') return kernel();
  if (command === 'interrupts') return interrupts();
  if (command === 'cognition') return cognition();
  if (command === 'events') return events();
  if (command === 'logs') return logs();
  if (command === 'tools') return tools();
  throw new Error(`Unknown command: ${command}`);
}

function help() {
  stdout.write(`Agent OS ${VERSION} — persistent, asynchronous personal agent runtime\n\n`);
  stdout.write(`Usage: agent-os <command> [options]\n\n`);
  stdout.write(`Core\n  gateway run              Run the daemon in the foreground\n  gateway start|stop|restart|status\n                           Control a detached daemon process\n  kernel status|processes  Inspect resident kernel services\n  status                   Show pulse, threads, memory, and sensing\n  run <prompt>             Submit work and follow it to a wait or terminal state\n  chat                     Open an interactive terminal session\n\n`);
  stdout.write(`Runtime\n  goals list|show          Inspect persistent goals\n  tasks list|show|watch    Inspect thought threads\n  tasks pause|resume|cancel <id>\n  interrupts list|raise    Inspect or raise durable preemption signals\n  cognition status|enable|disable|reflect\n  logs [--follow]          Stream the append-only execution ledger\n  events list|emit         Inspect or publish durable events\n\n`);
  stdout.write(`Agent services\n  sessions list|show       Inspect conversation contexts\n  memory list|search|add   Manage long-term memory\n  approvals list|approve|deny\n  schedules list|add|enable|disable\n  monitors list|show|add|run|enable|disable\n  tools                    List tools, sensors, and listeners\n\n`);
  stdout.write(`Setup\n  init                     Create config and workspace baseline\n  doctor                   Validate local config and gateway readiness\n\n`);
  stdout.write(`Global flags: --json --no-color --gateway <url> --token <token> --help --version\n`);
}

function init() {
  if (existsSync(config.configPath)) throw new Error(`Config already exists: ${config.configPath}`);
  writeDefaultConfig(config.configPath, { projectRoot: process.cwd(), home: config.home });
  stdout.write(`Created ${config.configPath}\nNext: agent-os gateway run\n`);
}

async function doctor() {
  const errors = validateConfig(config);
  let gateway = null;
  try { gateway = await client.get('/api/health'); } catch (error) { gateway = { ok: false, error: error.message }; }
  const result = {
    ok: errors.length === 0,
    config: { path: config.configPath, home: config.home, database: config.database, errors },
    gateway,
  };
  if (json) printJson(result);
  else {
    stdout.write(`${format.bold('Configuration')} ${errors.length ? format.red('invalid') : format.green('valid')}\n`);
    stdout.write(`  path      ${config.configPath}\n  home      ${config.home}\n  database  ${config.database}\n`);
    stdout.write(`${format.bold('Gateway')} ${gateway.ok ? format.green('reachable') : format.yellow('not reachable')}\n`);
    if (gateway.error) stdout.write(`  ${gateway.error}\n`);
  }
  if (!result.ok || flags['require-gateway'] && !gateway.ok) process.exitCode = 1;
}

async function status() {
  const health = await client.get('/api/health');
  if (json) printJson(health);
  else stdout.write(renderHealth(health, format));
}

async function startGatewayDaemon() {
  try {
    const health = await client.get('/api/health');
    if (health.ok) {
      const result = { started: false, alreadyRunning: true, pid: health.kernel?.hostPid };
      return json ? printJson(result) : stdout.write(`Gateway is already running with pid ${result.pid}\n`);
    }
  } catch {
    // A failed health check is expected when starting a stopped daemon.
  }
  mkdirSync(join(config.home, 'logs'), { recursive: true });
  const logFd = openSync(gatewayLogPath, 'a');
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  closeSync(logFd);
  if (!child.pid) throw new Error('Failed to create the gateway daemon process');
  writeFileSync(pidPath, `${JSON.stringify({ pid: child.pid, startedAt: Date.now(), cwd: process.cwd() })}\n`, 'utf8');
  child.unref();
  const health = await waitForGateway(true, 7_500);
  const result = { started: true, pid: health.kernel?.hostPid ?? child.pid, log: gatewayLogPath };
  if (json) printJson(result);
  else stdout.write(`Gateway started with pid ${result.pid}\nLog: ${gatewayLogPath}\n`);
}

async function stopGatewayDaemon({ allowStopped = false } = {}) {
  let health;
  try { health = await client.get('/api/health'); } catch { health = null; }
  if (!health?.ok) {
    if (allowStopped) return;
    throw new Error('Gateway is not reachable; refusing to signal an unverified pid');
  }
  const pid = Number(health.kernel?.hostPid);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('Gateway reported an invalid host pid');
  if (existsSync(pidPath)) {
    const record = JSON.parse(readFileSync(pidPath, 'utf8'));
    if (Number(record.pid) !== pid) throw new Error('Gateway pid does not match the local pid file');
  }
  process.kill(pid, 'SIGTERM');
  await waitForGateway(false, 7_500);
  if (existsSync(pidPath)) unlinkSync(pidPath);
  const result = { stopped: true, pid };
  if (json) printJson(result);
  else stdout.write(`Gateway stopped (pid ${pid})\n`);
}

async function waitForGateway(expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let running = false;
    let health;
    try {
      health = await client.get('/api/health');
      running = health.ok === true;
    } catch {
      running = false;
    }
    if (running === expected) return health;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(expected ? 'Gateway did not become ready before timeout' : 'Gateway did not stop before timeout');
}

async function runAgent() {
  const prompt = positionals.slice(1).join(' ').trim();
  if (!prompt) throw new Error('A prompt is required');
  const accepted = await client.post('/api/v1/messages', {
    text: prompt,
    sessionKey: flags.session,
    agentId: flags.agent ?? 'main',
    channel: 'terminal',
    peerKey: 'owner',
    messageId: flags['message-id'] ?? `cli:${Date.now()}`,
    priority: numberFlag(flags, 'priority', 80),
    interrupt: flags.interrupt === true,
    interruptReason: flags.reason,
    targetTaskId: flags.target,
  });
  if (flags.detach || flags.wait === 'false') {
    if (json) printJson(accepted);
    else stdout.write(`Accepted goal ${accepted.goal.id}\n`);
    return;
  }
  let rl;
  const ask = stdin.isTTY ? async (promptText) => {
    rl ??= createInterface({ input: stdin, output: stdout });
    return rl.question(format.yellow(promptText));
  } : null;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  try {
    const result = await waitForGoal({
      client,
      goalId: accepted.goal.id,
      sessionId: accepted.session.id,
      format,
      json,
      ask,
      pollMs: numberFlag(flags, 'poll-ms', 250),
      signal: controller.signal,
    });
    if (json) printJson(result);
    else if (result.assistant?.content?.text) stdout.write(`${result.assistant.content.text}\n`);
    else if (result.status === 'waiting') {
      stdout.write(`Goal is waiting. Resume from an interactive terminal or publish the required event.\n`);
      process.exitCode = 2;
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    rl?.close();
  }
}

async function goals() {
  const action = subcommand ?? 'list';
  if (action === 'show') {
    const id = positionals[2];
    if (!id) throw new Error('Goal id is required');
    const result = await client.get(`/api/goals/${encodeURIComponent(id)}`);
    if (json) printJson(result);
    else {
      stdout.write(`${format.bold(result.goal.title)} ${result.goal.status}\n${result.goal.objective}\n\n`);
      stdout.write(`${table(result.tasks, taskColumns())}\n`);
    }
    return;
  }
  const result = await client.get('/api/goals');
  if (json) printJson(result);
  else stdout.write(`${table(result.goals, [
    { label: 'STATUS', value: (goal) => goal.status, max: 10 },
    { label: 'GOAL', value: (goal) => goal.title, max: 54 },
    { label: 'TASKS', value: (goal) => goal.taskCount, max: 6 },
    { label: 'UPDATED', value: (goal) => relativeTime(goal.updated_at), max: 12 },
    { label: 'ID', value: (goal) => goal.id, max: 36 },
  ])}\n`);
}

async function tasks() {
  const action = subcommand ?? 'list';
  const id = positionals[2];
  if (['pause', 'resume', 'cancel'].includes(action)) {
    if (!id) throw new Error('Task id is required');
    const result = await client.post(`/api/tasks/${encodeURIComponent(id)}/${action}`);
    return json ? printJson(result) : stdout.write(`${result.task.id} → ${result.task.status}\n`);
  }
  if (action === 'show' || action === 'watch') {
    if (!id) throw new Error('Task id is required');
    if (action === 'show') {
      const result = await client.get(`/api/tasks/${encodeURIComponent(id)}`);
      return json ? printJson(result) : stdout.write(`${JSON.stringify(result.task, null, 2)}\n`);
    }
    return watchTask(id);
  }
  const query = new URLSearchParams();
  if (flags.status) query.set('status', flags.status);
  query.set('limit', String(numberFlag(flags, 'limit', 100)));
  const result = await client.get(`/api/tasks?${query}`);
  if (json) printJson(result);
  else stdout.write(`${table(result.tasks, taskColumns())}\n`);
}

async function watchTask(id) {
  let previous;
  while (true) {
    const { task } = await client.get(`/api/tasks/${encodeURIComponent(id)}`);
    if (task.status !== previous) stdout.write(`${new Date().toISOString()} ${task.status} pc=${task.snapshot.pc}/${task.workflow.length}\n`);
    previous = task.status;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function sessions() {
  const action = subcommand ?? 'list';
  if (action === 'show') {
    const id = positionals[2];
    if (!id) throw new Error('Session id or key is required');
    const result = await client.get(`/api/sessions/${encodeURIComponent(id)}?limit=${numberFlag(flags, 'limit', 100)}`);
    if (json) printJson(result);
    else result.messages.forEach((message) => stdout.write(`${message.role}> ${message.content.text ?? JSON.stringify(message.content)}\n`));
    return;
  }
  const result = await client.get('/api/sessions');
  if (json) printJson(result);
  else stdout.write(`${table(result.sessions, [
    { label: 'AGENT', value: (session) => session.agent_id, max: 12 },
    { label: 'CHANNEL', value: (session) => session.channel, max: 14 },
    { label: 'SESSION', value: (session) => session.session_key, max: 60 },
    { label: 'UPDATED', value: (session) => relativeTime(session.updated_at), max: 12 },
  ])}\n`);
}

async function memory() {
  const action = subcommand ?? 'list';
  if (action === 'add') {
    const content = positionals.slice(2).join(' ').trim();
    if (!content) throw new Error('Memory content is required');
    const result = await client.post('/api/memories', { content, kind: flags.kind ?? 'note', importance: numberFlag(flags, 'importance', 0.7) });
    return json ? printJson(result) : stdout.write(`Remembered ${result.memory.id}\n`);
  }
  const query = action === 'search' ? positionals.slice(2).join(' ') : '';
  const result = await client.get(`/api/memories${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  if (json) printJson(result);
  else stdout.write(`${table(result.memories, [
    { label: 'KIND', value: (item) => item.kind, max: 12 },
    { label: 'MEMORY', value: (item) => item.content, max: 72 },
    { label: 'IMPORTANCE', value: (item) => item.importance, max: 10 },
    { label: 'ID', value: (item) => item.id, max: 36 },
  ])}\n`);
}

async function approvals() {
  let action = subcommand ?? 'list';
  let id = positionals[2];
  if (command === 'approve' || command === 'deny') {
    action = command;
    id = positionals[1];
  }
  if (action === 'approve' || action === 'deny') {
    if (!id) throw new Error('Approval id is required');
    const result = await client.post(`/api/approvals/${encodeURIComponent(id)}/resolve`, {
      decision: action === 'approve' ? 'approve' : 'deny', resolvedBy: 'cli',
    });
    return json ? printJson(result) : stdout.write(`${result.approval.id} → ${result.approval.status}\n`);
  }
  const result = await client.get(`/api/approvals${flags.all ? '' : '?status=PENDING'}`);
  if (json) printJson(result);
  else stdout.write(`${table(result.approvals, [
    { label: 'STATUS', value: (item) => item.status, max: 10 },
    { label: 'RISK', value: (item) => item.risk, max: 10 },
    { label: 'ACTION', value: (item) => item.action, max: 30 },
    { label: 'ID', value: (item) => item.id, max: 52 },
  ])}\n`);
}

async function schedules() {
  const action = subcommand ?? 'list';
  if (action === 'add') {
    const name = flags.name ?? positionals[2];
    const objective = flags.objective ?? positionals.slice(3).join(' ');
    if (!name || !objective || !flags.at) throw new Error('Schedule add requires --name, --objective, and --at');
    const result = await client.post('/api/schedules', {
      name, objective, runAt: flags.at, intervalMinutes: flags['every-minutes'] ? Number(flags['every-minutes']) : undefined,
    });
    return json ? printJson(result) : stdout.write(`Created schedule ${result.schedule.id}\n`);
  }
  if (action === 'enable' || action === 'disable') {
    const id = positionals[2];
    if (!id) throw new Error('Schedule id is required');
    const result = await client.post(`/api/schedules/${encodeURIComponent(id)}/${action}`);
    return json ? printJson(result) : stdout.write(`${result.schedule.id} → ${action}d\n`);
  }
  const result = await client.get('/api/schedules');
  if (json) printJson(result);
  else stdout.write(`${table(result.schedules, [
    { label: 'ENABLED', value: (item) => item.enabled ? 'yes' : 'no', max: 7 },
    { label: 'NAME', value: (item) => item.name, max: 40 },
    { label: 'NEXT', value: (item) => new Date(item.next_run_at).toISOString(), max: 24 },
    { label: 'ID', value: (item) => item.id, max: 36 },
  ])}\n`);
}

async function monitors() {
  const action = subcommand ?? 'list';
  const id = positionals[2];
  if (action === 'show') {
    if (!id) throw new Error('Monitor id is required');
    const result = await client.get(`/api/monitors/${encodeURIComponent(id)}`);
    return json ? printJson(result) : stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  if (['run', 'enable', 'disable'].includes(action)) {
    if (!id) throw new Error('Monitor id is required');
    const result = await client.post(`/api/monitors/${encodeURIComponent(id)}/${action}`);
    return json ? printJson(result) : stdout.write(`${result.monitor.id} → ${action}\n`);
  }
  if (action === 'add') {
    const type = positionals[2];
    if (!['inbox', 'https'].includes(type)) throw new Error('Monitor type must be inbox or https');
    const sensorType = type === 'inbox' ? 'workspace_inbox' : 'https';
    const monitorConfig = type === 'inbox'
      ? { path: flags.path ?? 'inbox', autoGoal: flags['auto-goal'] === true, triggerOnInitial: flags['trigger-initial'] === true }
      : { url: flags.url, autoGoal: flags['auto-goal'] === true, triggerOnInitial: flags['trigger-initial'] === true };
    if (type === 'https' && !flags.url) throw new Error('HTTPS monitor requires --url');
    const result = await client.post('/api/monitors', {
      name: flags.name ?? `${type} monitor`, sensorType,
      intervalSeconds: numberFlag(flags, 'interval', 60), config: monitorConfig,
    });
    return json ? printJson(result) : stdout.write(`Created monitor ${result.monitor.id}\n`);
  }
  const result = await client.get('/api/monitors');
  if (json) printJson(result);
  else stdout.write(`${table(result.monitors, [
    { label: 'ON', value: (item) => item.enabled ? 'yes' : 'no', max: 3 },
    { label: 'STATUS', value: (item) => item.status, max: 9 },
    { label: 'SENSOR', value: (item) => item.sensor_type, max: 20 },
    { label: 'NAME', value: (item) => item.name, max: 36 },
    { label: 'LAST', value: (item) => relativeTime(item.last_observation_at), max: 12 },
    { label: 'NEXT', value: (item) => relativeTime(item.next_poll_at), max: 12 },
    { label: 'ID', value: (item) => item.id, max: 36 },
  ])}\n`);
}

async function events() {
  const action = subcommand ?? 'list';
  if (action === 'emit') {
    const topic = positionals[2];
    const correlationKey = positionals[3];
    if (!topic || !correlationKey) throw new Error('Event emit requires <topic> <correlation-key>');
    let payload = {};
    if (flags.data) payload = JSON.parse(flags.data);
    const result = await client.post('/api/events', { topic, correlationKey, payload, idempotencyKey: flags.key });
    return json ? printJson(result) : stdout.write(`Published ${result.event.id}; awakened ${result.awakened.length} task(s)\n`);
  }
  const query = new URLSearchParams();
  if (flags.topic) query.set('topic', flags.topic);
  const result = await client.get(`/api/events?${query}`);
  if (json) printJson(result);
  else stdout.write(`${table(result.events, [
    { label: 'TOPIC', value: (item) => item.topic, max: 28 },
    { label: 'CORRELATION', value: (item) => item.correlation_key, max: 44 },
    { label: 'SOURCE', value: (item) => item.source, max: 20 },
    { label: 'AT', value: (item) => relativeTime(item.created_at), max: 12 },
  ])}\n`);
}

async function kernel() {
  const action = subcommand ?? 'status';
  const result = await client.get(action === 'processes' ? '/api/kernel/processes' : '/api/kernel');
  if (json) return printJson(result);
  if (action === 'processes') {
    return stdout.write(`${table(result.processes, [
      { label: 'STATUS', value: (item) => item.status, max: 10 },
      { label: 'KIND', value: (item) => item.kind, max: 18 },
      { label: 'PROCESS', value: (item) => item.name, max: 28 },
      { label: 'PID', value: (item) => item.host_pid, max: 8 },
      { label: 'GEN', value: (item) => item.generation, max: 4 },
      { label: 'HEARTBEAT', value: (item) => relativeTime(item.heartbeat_at), max: 12 },
      { label: 'ID', value: (item) => item.id, max: 48 },
    ])}\n`);
  }
  stdout.write(`${format.bold('Kernel daemon')} ${format.green(result.daemon.status.toUpperCase())}\n`);
  stdout.write(`Process     ${result.daemon.processId}\nHost PID    ${result.daemon.hostPid}\nUptime      ${Math.floor(result.daemon.uptimeMs / 1000)}s\n\n`);
  stdout.write(`${table(result.daemon.services, [
    { label: 'STATUS', value: (item) => item.status, max: 10 },
    { label: 'SERVICE', value: (item) => item.name, max: 28 },
    { label: 'GEN', value: (item) => item.generation, max: 4 },
    { label: 'RESTARTS', value: (item) => item.restartCount, max: 8 },
    { label: 'HEARTBEAT', value: (item) => relativeTime(item.lastHeartbeatAt), max: 12 },
  ])}\n`);
}

async function interrupts() {
  const action = subcommand ?? 'list';
  if (action === 'raise') {
    const reason = flags.reason ?? positionals.slice(2).join(' ').trim();
    if (!reason) throw new Error('Interrupt raise requires a reason');
    const result = await client.post('/api/interrupts', {
      reason,
      priority: numberFlag(flags, 'priority', 100),
      targetTaskId: flags.target,
      goalId: flags.goal,
      force: flags.force !== 'false',
      kind: flags.kind ?? 'operator',
    });
    return json ? printJson(result) : stdout.write(`Raised interrupt ${result.interrupt.id}\n`);
  }
  const query = flags.status ? `?status=${encodeURIComponent(flags.status)}` : '';
  const result = await client.get(`/api/interrupts${query}`);
  if (json) return printJson(result);
  stdout.write(`${table(result.interrupts, [
    { label: 'STATUS', value: (item) => item.status, max: 10 },
    { label: 'PRIORITY', value: (item) => item.priority, max: 8 },
    { label: 'KIND', value: (item) => item.kind, max: 12 },
    { label: 'REASON', value: (item) => item.reason, max: 52 },
    { label: 'TARGET', value: (item) => item.dispatched_task_id ?? item.target_task_id ?? '-', max: 36 },
    { label: 'ID', value: (item) => item.id, max: 36 },
  ])}\n`);
}

async function cognition() {
  const action = subcommand ?? 'status';
  const result = action === 'status'
    ? await client.get('/api/cognition')
    : await client.post(`/api/cognition/${action}`, {
        autoReflect: flags.auto === true || flags['auto-reflect'] === true,
      });
  if (json) return printJson(result);
  const status = result.status ?? result;
  stdout.write(`${format.bold('Cognition loop')} ${status.control.enabled ? format.green('ENABLED') : format.yellow('DORMANT')}\n`);
  stdout.write(`Auto reflect  ${status.control.autoReflect ? 'yes' : 'no'}\n`);
  stdout.write(`Last activity ${relativeTime(status.lastActivityAt)}\n`);
  stdout.write(`Last cycle    ${status.lastCycle ? `${status.lastCycle.action} · ${relativeTime(status.lastCycle.at)}` : 'never'}\n`);
}

async function logs() {
  let afterId;
  let first = true;
  do {
    const query = new URLSearchParams();
    if (flags.goal) query.set('goalId', flags.goal);
    if (flags.task) query.set('taskId', flags.task);
    if (afterId !== undefined) query.set('afterId', String(afterId));
    query.set('limit', String(numberFlag(flags, 'limit', 100)));
    const result = await client.get(`/api/audit?${query}`);
    const entries = [...result.audit].sort((left, right) => left.id - right.id);
    for (const entry of entries) {
      stdout.write(`${new Date(entry.created_at).toISOString()} ${entry.type.padEnd(24)} ${entry.message}\n`);
      afterId = Math.max(afterId ?? 0, entry.id);
    }
    if (!flags.follow) return;
    if (first && !entries.length) stdout.write('Waiting for runtime events...\n');
    first = false;
    await new Promise((resolve) => setTimeout(resolve, 750));
  } while (true);
}

async function tools() {
  const result = await client.get('/api/tools');
  if (json) printJson(result);
  else {
    stdout.write(`${format.bold('Tools')}\n${table(result.tools, [
      { label: 'RISK', value: (item) => item.risk, max: 9 },
      { label: 'NAME', value: (item) => item.name, max: 28 },
      { label: 'DESCRIPTION', value: (item) => item.description, max: 76 },
    ])}\n\n`);
    stdout.write(`${format.bold('Sensors')}\n${table(result.sensors, [
      { label: 'TYPE', value: (item) => item.type, max: 24 },
      { label: 'DESCRIPTION', value: (item) => item.description, max: 76 },
    ])}\n\n`);
    stdout.write(`${format.bold('Resident listeners')}\n${table(result.listeners, [
      { label: 'NAME', value: (item) => item.name, max: 28 },
      { label: 'DESCRIPTION', value: (item) => item.description, max: 76 },
    ])}\n`);
  }
}
