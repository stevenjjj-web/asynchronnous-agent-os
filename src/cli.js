#!/usr/bin/env node
import { chmodSync, closeSync, constants, existsSync, openSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, validateConfig, writeDefaultConfig } from './platform/config.js';
import { parseArgs, numberFlag } from './cli/args.js';
import { GatewayClient } from './cli/client.js';
import { createFormatter, printJson, relativeTime, table } from './cli/format.js';
import { interactiveChat, renderHealth, taskColumns } from './cli/interactive.js';
import { waitForGoal } from './cli/wait.js';
import { runModelWizard, runSetupWizard } from './cli/setup-wizard.js';
import { atomicWritePrivateFile, ensurePrivateDirectory, readPrivateTextFile } from './platform/fs-safety.js';
import { fixSecurityPermissions, runSecurityAudit } from './security/audit.js';
import { canonicalEventEnvelope } from './kernel/event-authenticator.js';

const VERSION = '0.12.0';
const { flags, positionals } = parseArgs(process.argv.slice(2));
const command = positionals[0] ?? (stdin.isTTY && flags.json !== true ? 'chat' : 'help');
const subcommand = positionals[1];
const format = createFormatter({ color: flags['no-color'] !== true });
const monitorUrlFlag = command === 'monitors' && subcommand === 'add' && positionals[2] === 'https';
const json = flags.json === true;
const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
let config;
let client;
let pidPath;
let gatewayLogPath;

function refreshConfiguration() {
  config = loadConfig({ projectRoot: process.cwd() });
  client = new GatewayClient({
    config,
    url: flags.gateway ?? flags['gateway-url'] ?? (monitorUrlFlag ? undefined : flags.url),
    token: flags.token,
  });
  pidPath = join(config.home, 'gateway.pid');
  gatewayLogPath = join(config.home, 'logs', 'gateway.log');
}

refreshConfiguration();

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
  if (['setup', 'onboard', 'configure'].includes(command)) return setup();
  if (command === 'model') return configureAdditionalModel();
  if (command === 'start' || (command === 'gateway' && (!subcommand || subcommand === 'run'))) return import('./server.js');
  if (command === 'gateway' && subcommand === 'start') return startGatewayDaemon();
  if (command === 'gateway' && subcommand === 'stop') return stopGatewayDaemon();
  if (command === 'gateway' && subcommand === 'restart') {
    await stopGatewayDaemon({ allowStopped: true });
    return startGatewayDaemon();
  }
  if (command === 'init') return init();
  if (command === 'doctor') return doctor();
  if (command === 'security') return security();
  if (command === 'status' || command === 'health' || (command === 'gateway' && subcommand === 'status')) return status();
  if (command === 'chat' || command === 'terminal') return openInteractiveTerminal();
  if (command === 'run' || command === 'agent') return runAgent();
  if (command === 'goals') return goals();
  if (command === 'tasks') return tasks();
  if (command === 'manager' || command === 'ps') return taskManager();
  if (command === 'trace') return traceGoal();
  if (command === 'sessions') return sessions();
  if (command === 'memory') return memory();
  if (command === 'approvals' || command === 'approve' || command === 'deny') return approvals();
  if (command === 'schedules') return schedules();
  if (command === 'monitors') return monitors();
  if (command === 'kernel') return kernel();
  if (command === 'interrupts') return interrupts();
  if (command === 'cognition') return cognition();
  if (command === 'resources') return resources();
  if (command === 'operations') return operations();
  if (command === 'attention') return attention();
  if (command === 'capabilities') return capabilities();
  if (command === 'credentials') return credentials();
  if (command === 'events') return events();
  if (command === 'logs') return logs();
  if (command === 'tools') return tools();
  throw new Error(`Unknown command: ${command}`);
}

function help() {
  stdout.write(`Agent OS ${VERSION} — persistent, asynchronous personal agent runtime\n\n`);
  stdout.write(`Usage: agent-os <command> [options]\n\n`);
  stdout.write(`Core\n  gateway run              Run the daemon in the foreground\n  gateway start|stop|restart|status\n                           Control a detached daemon process\n  kernel status|processes  Inspect resident kernel services\n  status                   Show pulse, threads, memory, and sensing\n  run <prompt>             Submit work and follow it to a wait or terminal state\n  chat                     Open an interactive terminal session\n\n`);
  stdout.write(`Runtime\n  manager | ps             Explain active thought threads and resource use\n  manager <task-id>        Inspect checkpoint, wait, budget, and capabilities\n  trace <goal-id>          Replay the DAG, causal chain, evidence, and plan changes\n  goals list|show|contract|plan\n                           Inspect goals, authority, assumptions, and plan versions\n  tasks list|show|watch    Inspect thought threads\n  tasks pause|resume|cancel|priority <id>\n  resources                Inspect quotas and isolated pools\n  capabilities show|revoke Inspect frozen authority\n  operations list|show|reconcile|compensate\n  interrupts list|raise    Inspect or raise durable preemption signals\n  cognition status|enable|disable|reflect\n  attention                Inspect attention-value assessments\n  logs [--follow]          Stream the append-only execution ledger\n  events list|emit         Inspect or publish durable events\n\n`);
  stdout.write(`Agent services\n  sessions list|show|purge Inspect or remove conversation history\n  memory list|search|add|confirm|retract|forget\n                           Manage sourced and temporal long-term memory\n  memory export|import|providers|pull|push|syncs\n                           Move signed memory bundles across providers\n  credentials list|add|revoke\n  approvals list|approve|deny\n  schedules list|add|enable|disable\n  monitors list|show|add|run|enable|disable\n  tools                    List tools, sensors, and listeners\n\n`);
  stdout.write(`Setup\n  setup | onboard | configure\n                           Guided full-system setup and policy wizard\n  model                    Add a named model provider configuration\n  init                     Create config and workspace baseline only\n  doctor                   Validate local config and gateway readiness\n\n`);
  stdout.write(`Security\n  security audit [--fix]   Audit authentication, authority, plugins, sandboxes, and file permissions\n\n`);
  stdout.write(`Global flags: --json --no-color --no-animation --simple-ui --gateway <url> --token <token> --help --version\n`);
}

function init() {
  if (existsSync(config.configPath)) throw new Error(`Config already exists: ${config.configPath}`);
  writeDefaultConfig(config.configPath, { projectRoot: process.cwd(), home: config.home });
  stdout.write(`Created ${config.configPath}\nNext: agent-os setup\n`);
}

async function setup() {
  let wasRunning = false;
  try {
    wasRunning = Boolean((await client.get('/api/health')).ok);
  } catch {
    wasRunning = false;
  }
  if (wasRunning) {
    stdout.write(`${format.dim('Stopping the resident Gateway so configuration changes are applied safely…')}\n`);
    await stopGatewayDaemon();
  }
  let result;
  try {
    result = await runSetupWizard({ currentConfig: config, input: stdin, output: stdout, format });
  } catch (error) {
    if (wasRunning) await startGatewayDaemon().catch(() => {});
    throw error;
  }
  refreshConfiguration();
  if (result.startGateway || wasRunning) await startGatewayDaemon();
  return result;
}

async function openInteractiveTerminal() {
  if (!config.onboarding?.completedAt) {
    const result = await setup();
    if (!result.startGateway) {
      stdout.write('Setup completed. Start the resident system with: agent-os gateway start\n');
      return;
    }
  } else {
    try {
      await client.get('/api/health');
    } catch {
      await startGatewayDaemon();
    }
  }
  return interactiveChat({
    client,
    format,
    sessionKey: flags.session ?? `tenant:${config.security.tenantId}:agent:main:terminal:owner`,
    version: VERSION,
    animate: flags['no-animation'] !== true,
    live: flags['simple-ui'] !== true,
    configureModel: (preset) => configureAdditionalModel(preset),
  });
}

async function configureAdditionalModel(initialPreset) {
  let wasRunning = false;
  try { wasRunning = Boolean((await client.get('/api/health')).ok); } catch {}
  const result = await runModelWizard({ currentConfig: config, input: stdin, output: stdout, format, initialPreset });
  if (wasRunning) await stopGatewayDaemon();
  refreshConfiguration();
  if (wasRunning) await startGatewayDaemon();
  return result;
}

async function doctor() {
  const errors = validateConfig(config);
  const securityAudit = runSecurityAudit(config);
  let gateway = null;
  try { gateway = await client.get('/api/health'); } catch (error) { gateway = { ok: false, error: error.message }; }
  const result = {
    ok: errors.length === 0 && securityAudit.ok,
    config: { path: config.configPath, home: config.home, database: config.database, errors },
    gateway,
    security: securityAudit,
  };
  if (json) printJson(result);
  else {
    stdout.write(`${format.bold('Configuration')} ${errors.length ? format.red('invalid') : format.green('valid')}\n`);
    stdout.write(`  path      ${config.configPath}\n  home      ${config.home}\n  database  ${config.database}\n`);
    stdout.write(`${format.bold('Gateway')} ${gateway.ok ? format.green('reachable') : format.yellow('not reachable')}\n`);
    if (gateway.error) stdout.write(`  ${gateway.error}\n`);
    stdout.write(`${format.bold('Security')} ${securityAudit.ok ? format.green('hardened') : format.yellow('review required')} · ${securityAudit.summary.critical} critical · ${securityAudit.summary.high} high\n`);
  }
  if (!result.ok || flags['require-gateway'] && !gateway.ok) process.exitCode = 1;
}

function security() {
  const action = subcommand ?? 'audit';
  if (action !== 'audit') throw new Error(`Unknown security command: ${action}`);
  const fixed = flags.fix === true ? fixSecurityPermissions(config) : null;
  const result = runSecurityAudit(config);
  if (json) printJson({ ...result, fixed });
  else {
    stdout.write(`${format.bold('Agent OS security audit')} · ${result.trustModel}\n`);
    stdout.write(`${result.summary.critical} critical · ${result.summary.high} high · ${result.summary.warning} warning · ${result.summary.info} info\n\n`);
    for (const item of result.findings) {
      const color = item.severity === 'critical' ? format.red
        : item.severity === 'high' ? format.yellow
          : item.severity === 'warning' ? format.cyan : format.dim;
      stdout.write(`${color(item.severity.toUpperCase().padEnd(8))} ${item.id} — ${item.title}\n  ${item.detail}\n`);
      if (item.remediation) stdout.write(`  ${format.dim(`Fix: ${item.remediation}`)}\n`);
    }
    if (fixed) stdout.write(`\n${format.green('Permissions repaired')} · ${fixed.changed.length} paths\n`);
  }
  if (!result.ok) process.exitCode = 1;
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
  ensurePrivateDirectory(join(config.home, 'logs'));
  const logFd = openSync(gatewayLogPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  chmodSync(gatewayLogPath, 0o600);
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  closeSync(logFd);
  if (!child.pid) throw new Error('Failed to create the gateway daemon process');
  atomicWritePrivateFile(pidPath, `${JSON.stringify({ pid: child.pid, startedAt: Date.now(), cwd: process.cwd() })}\n`);
  child.unref();
  let health;
  try {
    health = await waitForGateway(true, 7_500);
  } catch (error) {
    if (existsSync(pidPath)) unlinkSync(pidPath);
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    throw error;
  }
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
    const record = JSON.parse(readPrivateTextFile(pidPath, { maxBytes: 10_000 }));
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
    tenantId: flags.tenant ?? config.security.tenantId,
    deadlineAt: flags.deadline,
    budget: jsonFlag('budget'),
    capabilities: jsonFlag('capabilities'),
    resourceClaims: jsonFlag('resource-claims'),
    assumptions: jsonFlag('assumptions'),
    capabilityExpiresAt: flags['capability-expires'],
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
  if (action === 'plan') {
    const id = positionals[2];
    if (!id) throw new Error('Goal id is required');
    const result = await client.get(`/api/goals/${encodeURIComponent(id)}/plan`);
    if (json) return printJson(result);
    stdout.write(`${format.bold(result.goal.title)} · cognitive plan\n`);
    stdout.write(`${table(result.versions, [
      { label: 'VERSION', value: (item) => item.version, max: 7 },
      { label: 'STATUS', value: (item) => item.status, max: 12 },
      { label: 'TRIGGER', value: (item) => item.trigger.type ?? '-', max: 24 },
      { label: 'WHEN', value: (item) => relativeTime(item.created_at), max: 12 },
      { label: 'ID', value: (item) => item.id, max: 52 },
    ])}\n\n${format.bold('Assumptions')}\n`);
    stdout.write(`${table(result.assumptions, [
      { label: 'STATUS', value: (item) => item.status, max: 12 },
      { label: 'CONF', value: (item) => Number(item.confidence).toFixed(2), max: 5 },
      { label: 'ASSUMPTION', value: (item) => item.statement, max: 60 },
      { label: 'WATCH', value: (item) => item.watch.topic ?? '-', max: 24 },
      { label: 'ID', value: (item) => item.id, max: 44 },
    ])}\n`);
    return;
  }
  if (action === 'budget') {
    const id = positionals[2];
    if (!id) throw new Error('Goal id is required');
    const budget = jsonFlag('budget');
    if (!budget) throw new Error('Budget revision requires --budget JSON');
    const result = await client.post(`/api/goals/${encodeURIComponent(id)}/budget`, {
      budget,
      actor: 'cli',
      reason: flags.reason ?? 'Budget revised from CLI',
    });
    return json ? printJson(result) : stdout.write(`${id} budget revised\n${JSON.stringify(result.contract.budget, null, 2)}\n`);
  }
  if (action === 'contract') {
    const id = positionals[2];
    if (!id) throw new Error('Goal id is required');
    const result = await client.get(`/api/goals/${encodeURIComponent(id)}/contract`);
    return json ? printJson(result) : stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
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
  if (action === 'priority') {
    if (!id) throw new Error('Task id is required');
    const priority = numberFlag(flags, 'value', Number(positionals[3]));
    if (!Number.isFinite(priority)) throw new Error('Priority requires --value <0-100> or a positional value');
    const result = await client.post(`/api/tasks/${encodeURIComponent(id)}/priority`, {
      priority,
      actor: 'cli',
      reason: flags.reason ?? 'Priority revised from CLI',
    });
    return json ? printJson(result) : stdout.write(`${result.task.id} priority → ${result.task.priority}\n`);
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

async function taskManager() {
  const taskId = positionals[1];
  if (taskId) {
    const result = await client.get(`/api/tasks/${encodeURIComponent(taskId)}/explain`);
    return json ? printJson(result) : stdout.write(renderThreadExplanation(result.thread));
  }
  const result = await client.get(`/api/task-manager?includeTerminal=${flags.all === true}&limit=${numberFlag(flags, 'limit', 100)}`);
  if (json) return printJson(result);
  stdout.write(`${format.bold('Thought thread task manager')} · ${result.threads.length} threads\n`);
  stdout.write(`${table(result.threads, [
    { label: 'STATE', value: (item) => item.status, max: 9 },
    { label: 'PRI', value: (item) => item.priority, max: 3 },
    { label: 'THREAD', value: (item) => item.title, max: 30 },
    { label: 'WHY', value: (item) => item.reason, max: 44 },
    { label: 'TOKENS', value: (item) => Number(item.usage.tokens ?? 0), max: 8 },
    { label: 'COST', value: (item) => item.pricing.status === 'unpriced' ? 'unpriced' : `$${Number(item.usage.costUsd ?? 0).toFixed(4)}`, max: 9 },
    { label: 'PC', value: (item) => `${item.checkpoint.pc}/${item.checkpoint.totalSteps}`, max: 7 },
    { label: 'CAP', value: (item) => item.capabilities.status, max: 8 },
    { label: 'ID', value: (item) => item.id, max: 36 },
  ])}\n`);
}

function renderThreadExplanation(thread) {
  return [
    `${format.bold(thread.title)} · ${thread.status} · priority ${thread.priority}`,
    `Why         ${thread.reason}`,
    `Checkpoint  pc ${thread.checkpoint.pc}/${thread.checkpoint.totalSteps} · revision ${thread.checkpoint.revision} · ${new Date(thread.checkpoint.at).toISOString()}`,
    `Wait        ${thread.wait ? JSON.stringify(thread.wait) : '-'}`,
    `Resources   ${Number(thread.usage.tokens ?? 0)} tokens · ${thread.pricing.status === 'unpriced' ? 'cost unpriced' : `$${Number(thread.usage.costUsd ?? 0).toFixed(6)}`} · ${Number(thread.usage.toolCalls ?? 0)} tool calls`,
    `Budget      ${JSON.stringify(thread.budget)}`,
    `Claims      ${thread.resourceClaims.declared.map((claim) => `${claim.mode ?? 'exclusive'}:${claim.scope}`).join(', ') || '-'}`,
    `Capability  ${thread.capabilities.status} · tools ${thread.capabilities.tools.join(', ') || '-'} · pools ${thread.capabilities.resourcePools.join(', ') || '-'}`,
    `Preemption  ${thread.preemption ? `${thread.preemption.reason} · count ${thread.preemption.count}` : '-'}`,
    `Evidence    ${thread.evidence.length ? thread.evidence.map((item) => item.id).join(', ') : 'none recorded'}`,
    `Goal        ${thread.goalTitle} · ${thread.goalId}`,
    '',
  ].join('\n');
}

async function traceGoal() {
  const goalId = positionals[1];
  if (!goalId) throw new Error('Goal id is required');
  const result = await client.get(`/api/goals/${encodeURIComponent(goalId)}/trace`);
  if (json) return printJson(result);
  stdout.write(`${format.bold(result.goal.title)} · ${result.goal.status}\n\n${format.bold('DAG')}\n`);
  for (const node of result.dag.nodes) {
    const parents = node.dependencies.map((item) => item.id.slice(0, 8)).join(', ') || 'root';
    stdout.write(`  ${node.id.slice(0, 8)}  ${node.status.padEnd(9)} ${node.title}  ← ${parents}\n`);
  }
  stdout.write(`\n${format.bold('Causal replay')}\n`);
  for (const event of result.causalChain) {
    stdout.write(`  ${String(event.sequence).padStart(3)}  ${new Date(event.at).toISOString()}  ${event.type.padEnd(24)} ${event.message}\n`);
  }
  stdout.write(`\n${format.bold('Evidence')}\n`);
  if (!result.evidence.length) stdout.write('  No evidence records were captured for this goal.\n');
  for (const evidence of result.evidence) stdout.write(`  ${evidence.id} · ${evidence.sourceType}:${evidence.source} · ${evidence.excerpt ?? evidence.digest}\n`);
  if (result.conclusion) stdout.write(`\n${format.bold('Conclusion')} [${result.conclusion.provenanceLevel}]\n${result.conclusion.text}\n`);
  stdout.write(`\n${format.bold('Plan history')}\n`);
  for (const version of result.cognition.planVersions) stdout.write(`  v${version.version} ${version.status.padEnd(12)} ${version.trigger.type ?? '-'}\n`);
  stdout.write(`${format.bold('Assumptions')}\n`);
  for (const assumption of result.cognition.assumptions) stdout.write(`  ${assumption.status.padEnd(12)} ${Number(assumption.confidence).toFixed(2)} ${assumption.statement}\n`);
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
  if (action === 'purge') {
    const id = positionals[2];
    if (!id) throw new Error('Session id or key is required');
    await confirmDestructive(`Permanently delete completed goals and messages in session ${id}?`);
    const result = await client.post(`/api/sessions/${encodeURIComponent(id)}/purge`);
    return json
      ? printJson(result)
      : stdout.write(`Purged ${result.purged.deletedMessages} messages, ${result.purged.deletedGoals} completed goals, and ${result.purged.deletedOutbox} delivery records. Long-term memories were preserved.\n`);
  }
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
  if (action === 'providers') {
    const result = await client.get('/api/memory-portability/providers');
    if (json) return printJson(result);
    return stdout.write(`${table(result.providers, [
      { label: 'PROVIDER', value: (item) => item.id, max: 24 },
      { label: 'TYPE', value: (item) => item.type, max: 16 },
      { label: 'PULL', value: (item) => item.canPull ? item.pullIntervalMs ?? 'manual' : '-', max: 12 },
      { label: 'PUSH', value: (item) => item.canPush ? item.pushIntervalMs ?? 'manual' : '-', max: 12 },
      { label: 'REMOTE', value: (item) => item.remote ? 'yes' : 'no', max: 6 },
      { label: 'SIGNED', value: (item) => item.signatureRequired ? 'required' : '-', max: 8 },
      { label: 'CRYPT', value: (item) => item.encryptionRequired ? 'required' : '-', max: 8 },
      { label: 'AUTO ACTIVE', value: (item) => item.autoActivate ? 'yes' : 'no', max: 11 },
    ])}\n`);
  }
  if (action === 'syncs') {
    const query = new URLSearchParams({ limit: String(numberFlag(flags, 'limit', 100)) });
    if (flags.provider) query.set('providerId', flags.provider);
    const result = await client.get(`/api/memory-portability/runs?${query}`);
    if (json) return printJson(result);
    return stdout.write(`${table(result.runs, [
      { label: 'STATUS', value: (item) => item.status, max: 10 },
      { label: 'DIRECTION', value: (item) => item.direction, max: 9 },
      { label: 'PROVIDER', value: (item) => item.provider_id, max: 20 },
      { label: 'IMPORTED', value: (item) => item.imported_count, max: 8 },
      { label: 'DUP', value: (item) => item.duplicate_count, max: 5 },
      { label: 'SIGNATURE', value: (item) => item.signature_status ?? '-', max: 14 },
      { label: 'WHEN', value: (item) => relativeTime(item.started_at), max: 12 },
      { label: 'ERROR', value: (item) => item.error ?? '-', max: 40 },
    ])}\n`);
  }
  if (action === 'export') {
    const explicitPath = positionals[2];
    const directory = explicitPath ? null : ensurePrivateDirectory(join(config.home, 'exports'));
    const path = resolve(explicitPath ?? join(directory, `memory-${new Date().toISOString().replaceAll(':', '-')}.json`));
    const result = await client.post('/api/memory-portability/export', {
      agentId: flags.agent ?? 'main',
      includeInactive: flags['include-inactive'] === true,
      unsigned: flags.unsigned === true,
      limit: numberFlag(flags, 'limit', config.memory.portability.maxEntries),
    });
    atomicWritePrivateFile(path, `${JSON.stringify(result.bundle, null, 2)}\n`, { privateDirectory: !explicitPath });
    return json
      ? printJson({ path, digest: result.digest, payloadDigest: result.payloadDigest, contentDigest: result.contentDigest, encrypted: result.encrypted, count: result.count })
      : stdout.write(`Exported ${result.count} memories to ${path}\nDigest: ${result.digest}\nEncrypted: ${result.encrypted ? 'yes' : 'no'}\n`);
  }
  if (action === 'import') {
    const configuredPath = positionals[2];
    if (!configuredPath) throw new Error('Memory import path is required');
    const path = resolve(configuredPath);
    const serialized = readPrivateTextFile(path, { maxBytes: config.memory.portability.maxBundleBytes });
    let bundle;
    try { bundle = JSON.parse(serialized); } catch { throw new Error('Memory import file is not valid JSON'); }
    const result = await client.post('/api/memory-portability/import', {
      bundle,
      agentId: flags.agent ?? 'main',
      activate: flags.activate === true,
    });
    return json
      ? printJson(result)
      : stdout.write(`Imported ${result.imported} memories (${result.duplicates} duplicates) as ${result.status}.\nDigest: ${result.digest}\n`);
  }
  if (action === 'pull' || action === 'push') {
    const providerId = positionals[2];
    if (!providerId) throw new Error(`Memory ${action} requires a provider id`);
    const result = await client.post(`/api/memory-portability/providers/${encodeURIComponent(providerId)}/${action}`, {
      agentId: flags.agent ?? 'main',
      digest: flags.digest,
      activate: flags.activate === true,
      includeInactive: flags['include-inactive'] === true,
    });
    if (json) return printJson(result);
    if (action === 'pull') {
      return stdout.write(`Pulled ${result.digest}: ${result.imported} imported, ${result.duplicates} duplicates, status ${result.status}.\n`);
    }
    return stdout.write(`Pushed ${result.count} memories to ${providerId}.\nDigest: ${result.digest}\n`);
  }
  if (action === 'forget' || action === 'delete') {
    const id = positionals[2];
    if (!id) throw new Error('Memory id is required');
    await confirmDestructive(`Permanently forget long-term memory ${id}?`);
    const result = await client.post(`/api/memories/${encodeURIComponent(id)}/forget`);
    return json ? printJson(result) : stdout.write(`Forgot long-term memory ${result.forgotten.id}\n`);
  }
  if (action === 'explain') {
    return stdout.write([
      'Conversation history and long-term memory are separate.',
      'Messages stay inside their session so work can resume and recent context can be reconstructed.',
      'Only explicit memory actions create long-term memory records.',
      'Use `agent-os memory forget <id> --yes` to delete a long-term memory.',
      'Use `agent-os sessions purge <id> --yes` to delete an ended conversation and its completed goals.',
      'Use `/new` inside the terminal to start clean context without deleting history.',
      '',
    ].join('\n'));
  }
  if (action === 'confirm') {
    const id = positionals[2];
    if (!id) throw new Error('Memory id is required');
    const result = await client.post(`/api/memories/${encodeURIComponent(id)}/confirm`, {
      confidence: numberFlag(flags, 'confidence', undefined), source: 'cli',
    });
    return json ? printJson(result) : stdout.write(`Confirmed ${result.memory.id} at confidence ${result.memory.confidence}\n`);
  }
  if (action === 'retract' || action === 'contradict') {
    const id = positionals[2];
    if (!id) throw new Error('Memory id is required');
    const result = await client.post(`/api/memories/${encodeURIComponent(id)}/status`, {
      status: action === 'retract' ? 'RETRACTED' : 'CONTRADICTED', reason: flags.reason, actor: 'cli',
    });
    return json ? printJson(result) : stdout.write(`${result.memory.id} → ${result.memory.status}\n`);
  }
  if (action === 'add') {
    const content = positionals.slice(2).join(' ').trim();
    if (!content) throw new Error('Memory content is required');
    const validUntil = flags['valid-until'] ? new Date(flags['valid-until']).getTime() : undefined;
    if (flags['valid-until'] && !Number.isFinite(validUntil)) throw new Error('--valid-until must be a valid date or timestamp');
    const result = await client.post('/api/memories', {
      content,
      kind: flags.kind ?? 'note',
      importance: numberFlag(flags, 'importance', 0.7),
      confidence: numberFlag(flags, 'confidence', 0.7),
      validUntil,
      supersedesId: flags.supersedes,
      contradictsIds: flags.contradicts ? String(flags.contradicts).split(',').filter(Boolean) : undefined,
    });
    return json ? printJson(result) : stdout.write(`Remembered ${result.memory.id}\n`);
  }
  const query = action === 'search' ? positionals.slice(2).join(' ') : '';
  const result = await client.get(`/api/memories${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  if (json) printJson(result);
  else stdout.write(`${table(result.memories, [
    { label: 'STATUS', value: (item) => item.status, max: 12 },
    { label: 'KIND', value: (item) => item.kind, max: 12 },
    { label: 'MEMORY', value: (item) => item.content, max: 72 },
    { label: 'CONF', value: (item) => Number(item.confidence).toFixed(2), max: 5 },
    { label: 'SOURCE', value: (item) => item.source, max: 22 },
    { label: 'ID', value: (item) => item.id, max: 36 },
  ])}\n`);
}

async function confirmDestructive(question) {
  if (flags.yes === true) return true;
  if (!stdin.isTTY) throw new Error('This destructive command requires --yes in a non-interactive terminal');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${format.yellow(question)} Type "yes" to continue: `)).trim().toLowerCase();
    if (answer !== 'yes') throw new Error('Operation cancelled');
    return true;
  } finally {
    rl.close();
  }
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
    const source = flags.source ?? 'cli';
    const tenantId = flags.tenant ?? config.security.tenantId;
    const agentId = flags.agent ?? 'main';
    const timestamp = flags.timestamp ? Number(flags.timestamp) : Date.now();
    const nonce = flags.nonce ?? randomUUID();
    let signature = flags.signature;
    if (!signature && flags['secret-env']) {
      const secret = process.env[flags['secret-env']];
      if (!secret) throw new Error(`Event signing secret is unavailable: ${flags['secret-env']}`);
      const canonical = canonicalEventEnvelope({
        source, timestamp, nonce, topic, correlationKey, tenantId, agentId, payload,
      });
      signature = createHmac('sha256', secret).update(canonical).digest('hex');
    }
    const result = await client.post('/api/events', {
      topic,
      correlationKey,
      payload,
      idempotencyKey: flags.key,
      source,
      tenantId,
      agentId,
      timestamp,
      nonce,
      signature,
    });
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

async function resources() {
  const result = await client.get('/api/resources');
  if (json) return printJson(result);
  stdout.write(`${format.bold('Resource pools')}\n${table(result.pools, [
    { label: 'POOL', value: (item) => item.name, max: 28 },
    { label: 'CAPACITY', value: (item) => item.capacity, max: 8 },
    { label: 'ACTIVE', value: (item) => item.active, max: 6 },
    { label: 'QUEUED', value: (item) => item.queued, max: 6 },
  ])}\n\n`);
  stdout.write(`${format.bold('Default goal budget')}\n${JSON.stringify(result.defaults, null, 2)}\n`);
}

async function operations() {
  const action = subcommand ?? 'list';
  const id = positionals[2];
  if (action === 'show') {
    if (!id) throw new Error('Operation id is required');
    const result = await client.get(`/api/operations/${encodeURIComponent(id)}`);
    return json ? printJson(result) : stdout.write(`${JSON.stringify(result.operation, null, 2)}\n`);
  }
  if (action === 'reconcile' || action === 'compensate') {
    if (!id) throw new Error('Operation id is required');
    const result = await client.post(`/api/operations/${encodeURIComponent(id)}/${action}`, { reason: flags.reason });
    return json ? printJson(result) : stdout.write(`${result.operation.id} → ${result.operation.state}\n`);
  }
  const query = new URLSearchParams();
  if (flags.state) query.set('state', flags.state);
  if (flags.goal) query.set('goalId', flags.goal);
  const result = await client.get(`/api/operations?${query}`);
  if (json) return printJson(result);
  stdout.write(`${table(result.operations, [
    { label: 'STATE', value: (item) => item.state, max: 13 },
    { label: 'MODE', value: (item) => item.mode, max: 16 },
    { label: 'TOOL', value: (item) => item.tool_name, max: 28 },
    { label: 'ATTEMPTS', value: (item) => item.attempt, max: 8 },
    { label: 'UPDATED', value: (item) => relativeTime(item.updated_at), max: 12 },
    { label: 'ID', value: (item) => item.id, max: 36 },
  ])}\n`);
}

async function attention() {
  const result = await client.get(`/api/attention?agentId=${encodeURIComponent(flags.agent ?? 'main')}`);
  if (json) return printJson(result);
  stdout.write(`${table(result.assessments, [
    { label: 'SCORE', value: (item) => item.score.toFixed(1), max: 6 },
    { label: 'WAKE', value: (item) => item.decision.shouldWake ? 'yes' : 'no', max: 5 },
    { label: 'CRITICAL', value: (item) => item.decision.critical ? 'yes' : 'no', max: 8 },
    { label: 'REASON', value: (item) => item.decision.reason, max: 20 },
    { label: 'VALUE', value: (item) => item.expected_value.toFixed(3), max: 8 },
    { label: 'COST', value: (item) => item.estimated_cost.toFixed(3), max: 8 },
    { label: 'AT', value: (item) => relativeTime(item.created_at), max: 12 },
  ])}\n`);
}

async function capabilities() {
  const action = subcommand ?? 'show';
  const goalId = positionals[2];
  if (!goalId) throw new Error('Goal id is required');
  if (action === 'revoke') {
    const result = await client.post(`/api/goals/${encodeURIComponent(goalId)}/capabilities/revoke`, {
      reason: flags.reason ?? 'Revoked from CLI',
      actor: 'cli',
    });
    return json ? printJson(result) : stdout.write(`${goalId} capabilities → ${result.contract.capability_status}\n`);
  }
  const result = await client.get(`/api/goals/${encodeURIComponent(goalId)}/contract`);
  return json ? printJson(result) : stdout.write(`${JSON.stringify({
    status: result.contract.capability_status,
    expiresAt: result.contract.capability_expires_at,
    capabilities: result.contract.capabilities,
    audit: result.capabilityAudit,
  }, null, 2)}\n`);
}

async function credentials() {
  const action = subcommand ?? 'list';
  if (action === 'add') {
    const id = flags.id ?? positionals[2];
    if (!id || !flags.env) throw new Error('Credential add requires an id and --env <VARIABLE>');
    const result = await client.post('/api/credentials', {
      id,
      locator: `env:${flags.env}`,
      tenantId: flags.tenant ?? config.security.tenantId,
      agentId: flags.agent ?? 'main',
      expiresAt: flags.expires ? new Date(flags.expires).getTime() : undefined,
    });
    return json ? printJson(result) : stdout.write(`Created credential reference ${result.credential.id}\n`);
  }
  if (action === 'revoke') {
    const id = positionals[2];
    if (!id) throw new Error('Credential id is required');
    const result = await client.post(`/api/credentials/${encodeURIComponent(id)}/revoke`);
    return json ? printJson(result) : stdout.write(`${id} → ${result.credential.status}\n`);
  }
  const result = await client.get(`/api/credentials?tenantId=${encodeURIComponent(flags.tenant ?? config.security.tenantId)}`);
  if (json) return printJson(result);
  stdout.write(`${table(result.credentials, [
    { label: 'STATUS', value: (item) => item.status, max: 10 },
    { label: 'PROVIDER', value: (item) => item.provider, max: 14 },
    { label: 'AGENT', value: (item) => item.agent_id, max: 12 },
    { label: 'EXPIRES', value: (item) => item.expires_at ? relativeTime(item.expires_at) : '-', max: 12 },
    { label: 'ID', value: (item) => item.id, max: 36 },
  ])}\n`);
}

function jsonFlag(name) {
  if (flags[name] === undefined) return undefined;
  try { return JSON.parse(flags[name]); } catch { throw new Error(`--${name} must be valid JSON`); }
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
    ])}\n\n`);
    stdout.write(`${format.bold('Sandbox adapters')}\n${table(result.sandboxes, [
      { label: 'NAME', value: (item) => item.name, max: 28 },
      { label: 'DESCRIPTION', value: (item) => item.description, max: 76 },
    ])}\n`);
  }
}
