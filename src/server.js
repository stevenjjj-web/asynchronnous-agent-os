import { createServer } from 'node:http';
import { loadConfig, validateConfig } from './platform/config.js';
import { PersonalAgentSystem } from './system.js';

const config = loadConfig({ projectRoot: process.cwd() });
const configErrors = validateConfig(config);
if (configErrors.length) throw new Error(`Invalid configuration:\n- ${configErrors.join('\n- ')}`);
const port = config.gateway.port;
const runtime = await new PersonalAgentSystem(config).start();
const rateWindows = new Map();

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isAuthorized(req, url) {
  if (config.security.allowLocalBypass && isLoopback(req.socket.remoteAddress)) return true;
  const expected = config.gateway.auth.token;
  if (!expected) return config.security.allowRemoteWithoutAuth;
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer === expected || url.searchParams.get('token') === expected;
}

function isRateLimited(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || isLoopback(req.socket.remoteAddress)) return false;
  const key = req.socket.remoteAddress ?? 'unknown';
  const timestamp = Date.now();
  const windowMs = config.gateway.rateLimit?.windowMs ?? 60_000;
  const maxWrites = config.gateway.rateLimit?.maxWrites ?? 120;
  const current = rateWindows.get(key);
  if (!current || timestamp - current.startedAt >= windowMs) {
    rateWindows.set(key, { startedAt: timestamp, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > maxWrites;
}

function listGoalSummaries() {
  return runtime.store.listGoals().map((goal) => {
    const tasks = runtime.store.listTasks(goal.id);
    const counts = tasks.reduce((result, task) => {
      result[task.status] = (result[task.status] ?? 0) + 1;
      return result;
    }, {});
    return { ...goal, taskCount: tasks.length, counts };
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/metrics') {
    const stats = runtime.store.getStats();
    const lines = [
      '# TYPE agent_os_events_total gauge',
      `agent_os_events_total ${stats.events}`,
      '# TYPE agent_os_sessions_total gauge',
      `agent_os_sessions_total ${stats.sessions}`,
      '# TYPE agent_os_memories_total gauge',
      `agent_os_memories_total ${stats.memories}`,
      '# TYPE agent_os_pending_approvals gauge',
      `agent_os_pending_approvals ${stats.pendingApprovals}`,
      '# TYPE agent_os_pending_outbox gauge',
      `agent_os_pending_outbox ${stats.pendingOutbox}`,
      ...Object.entries(stats.tasks).map(([status, count]) => `agent_os_tasks{status="${status.toLowerCase()}"} ${count}`),
      ...Object.entries(stats.goals).map(([status, count]) => `agent_os_goals{status="${status.toLowerCase()}"} ${count}`),
    ];
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`${lines.join('\n')}\n`);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      workerId: runtime.scheduler.workerId,
      activeExecutions: runtime.scheduler.active.size,
      stats: runtime.store.getStats(),
      agents: runtime.store.listAgents().length,
      plugins: runtime.plugins.loaded,
      modelConfigured: Boolean(config.models.default?.apiKey),
      pulse: runtime.store.getSystemState('runtime.pulse'),
      kernel: runtime.kernel.status(),
      cognition: runtime.cognition.status(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
    return json(res, 200, {
      config: {
        home: config.home,
        database: config.database,
        gateway: { bind: config.gateway.bind, port: config.gateway.port, authEnabled: Boolean(config.gateway.auth.token) },
        runtime: config.runtime,
      },
      stats: runtime.store.getStats(),
      scheduler: { workerId: runtime.scheduler.workerId, active: [...runtime.scheduler.active] },
      kernel: runtime.kernel.status(),
      plugins: { loaded: runtime.plugins.loaded, diagnostics: runtime.plugins.diagnostics },
      tools: runtime.tools.list(),
      channels: runtime.channels.list(),
      listeners: runtime.listeners.list(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/tools') {
    return json(res, 200, {
      tools: runtime.tools.list(),
      channels: runtime.channels.list(),
      sensors: runtime.sensors.list(),
      listeners: runtime.listeners.list(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/kernel') {
    return json(res, 200, {
      daemon: runtime.kernel.status(),
      processes: runtime.store.listKernelProcesses({ limit: 100 }),
      stats: runtime.store.getStats(),
      cognition: runtime.cognition.status(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/kernel/processes') {
    return json(res, 200, { processes: runtime.store.listKernelProcesses({
      status: url.searchParams.get('status') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 100),
    }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/interrupts') {
    return json(res, 200, { interrupts: runtime.store.listInterrupts({
      status: url.searchParams.get('status') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 100),
    }) });
  }

  if (req.method === 'POST' && url.pathname === '/api/interrupts') {
    const body = await readJson(req);
    return json(res, 202, { interrupt: runtime.interrupts.raise({
      agentId: body.agentId ?? 'main',
      goalId: body.goalId,
      targetTaskId: body.targetTaskId,
      kind: body.kind ?? 'external',
      priority: body.priority ?? 100,
      force: body.force !== false,
      reason: body.reason,
      payload: body.payload,
    }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/cognition') {
    return json(res, 200, runtime.cognition.status());
  }

  const cognitionMatch = url.pathname.match(/^\/api\/cognition\/(enable|disable|reflect)$/);
  if (req.method === 'POST' && cognitionMatch) {
    const action = cognitionMatch[1];
    const body = await readJson(req);
    const control = action === 'reflect'
      ? runtime.cognition.requestReflection()
      : runtime.cognition.configure({
          enabled: action === 'enable',
          ...(action === 'enable' && body.autoReflect !== undefined ? { autoReflect: Boolean(body.autoReflect) } : {}),
        });
    return json(res, 202, { control, status: runtime.cognition.status() });
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    return json(res, 200, { tasks: runtime.store.listAllTasks({
      status: url.searchParams.get('status') ?? undefined,
      sessionId: url.searchParams.get('sessionId') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 100),
    }) });
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'GET' && taskMatch) {
    const task = runtime.store.getTask(decodeURIComponent(taskMatch[1]));
    return task ? json(res, 200, { task }) : json(res, 404, { error: 'task not found' });
  }

  if (req.method === 'GET' && url.pathname === '/api/audit') {
    return json(res, 200, { audit: runtime.store.listAudit({
      goalId: url.searchParams.get('goalId') ?? undefined,
      taskId: url.searchParams.get('taskId') ?? undefined,
      afterId: url.searchParams.has('afterId') ? Number(url.searchParams.get('afterId')) : undefined,
      limit: Number(url.searchParams.get('limit') ?? 100),
    }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    return json(res, 200, { events: runtime.store.listEvents({
      topic: url.searchParams.get('topic') ?? undefined,
      correlationKey: url.searchParams.get('correlationKey') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 100),
    }) });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/messages') {
    const body = await readJson(req);
    const accepted = await runtime.submit({
      sessionKey: body.sessionKey,
      agentId: body.agentId ?? 'main',
      channel: body.channel ?? 'terminal',
      peerKey: body.peerKey ?? 'owner',
      threadKey: body.threadKey,
      title: body.title,
      text: body.text,
      messageId: body.messageId,
      provenance: body.provenance ?? 'user',
      priority: body.priority,
      interrupt: body.interrupt,
      interruptKind: body.interruptKind,
      interruptReason: body.interruptReason,
      targetTaskId: body.targetTaskId,
    });
    return json(res, 202, accepted);
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return json(res, 200, { sessions: runtime.store.listSessions({ agentId: url.searchParams.get('agentId') ?? undefined }) });
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && sessionMatch) {
    const session = runtime.store.getSession(decodeURIComponent(sessionMatch[1]));
    return session
      ? json(res, 200, { session, messages: runtime.store.listMessages(session.id, { limit: Number(url.searchParams.get('limit') ?? 100) }) })
      : json(res, 404, { error: 'session not found' });
  }

  if (req.method === 'GET' && url.pathname === '/api/memories') {
    return json(res, 200, {
      memories: url.searchParams.get('q')
        ? runtime.memory.recall(url.searchParams.get('agentId') ?? 'main', url.searchParams.get('q'), { limit: Number(url.searchParams.get('limit') ?? 20) })
        : runtime.store.listMemories(url.searchParams.get('agentId') ?? 'main', Number(url.searchParams.get('limit') ?? 50)),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/memories') {
    const body = await readJson(req);
    return json(res, 201, { memory: runtime.memory.remember({
      agentId: body.agentId ?? 'main', content: body.content, kind: body.kind,
      importance: body.importance, tags: body.tags, source: 'api', expiresAt: body.expiresAt,
    }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/approvals') {
    return json(res, 200, { approvals: runtime.store.listApprovals(url.searchParams.get('status') ?? undefined) });
  }

  const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
  if (req.method === 'POST' && approvalMatch) {
    const body = await readJson(req);
    const approval = runtime.store.resolveApproval(decodeURIComponent(approvalMatch[1]), body.decision, {
      resolvedBy: body.resolvedBy ?? 'owner', note: body.note,
    });
    if (!approval) return json(res, 404, { error: 'approval not found' });
    const delivery = runtime.publishEvent({
      topic: 'approval.resolved',
      correlationKey: approval.id,
      payload: { decision: body.decision, status: approval.status, note: body.note },
      source: 'approval-api',
      idempotencyKey: `approval-resolution:${approval.id}`,
    });
    return json(res, 200, { approval, delivery });
  }

  if (req.method === 'GET' && url.pathname === '/api/schedules') {
    return json(res, 200, { schedules: runtime.store.listSchedules() });
  }

  if (req.method === 'GET' && url.pathname === '/api/monitors') {
    return json(res, 200, {
      monitors: runtime.store.listMonitors({
        agentId: url.searchParams.get('agentId') ?? undefined,
        enabled: url.searchParams.has('enabled') ? url.searchParams.get('enabled') === 'true' : undefined,
      }),
      sensors: runtime.sensors.list(),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/monitors') {
    const body = await readJson(req);
    if (!runtime.sensors.get(body.sensorType)) return json(res, 400, { error: 'unknown sensor type' });
    const intervalMs = Number(body.intervalMs ?? Number(body.intervalSeconds) * 1000);
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000) return json(res, 400, { error: 'monitor interval must be at least one second' });
    return json(res, 201, { monitor: runtime.store.createMonitor({
      agentId: body.agentId ?? 'main',
      name: body.name,
      sensorType: body.sensorType,
      intervalMs,
      config: body.config ?? {},
      enabled: body.enabled !== false,
    }) });
  }

  const monitorMatch = url.pathname.match(/^\/api\/monitors\/([^/]+)$/);
  if (req.method === 'GET' && monitorMatch) {
    const monitor = runtime.store.getMonitor(decodeURIComponent(monitorMatch[1]));
    return monitor ? json(res, 200, {
      monitor,
      observations: runtime.store.listMonitorObservations(monitor.id),
    }) : json(res, 404, { error: 'monitor not found' });
  }

  const monitorActionMatch = url.pathname.match(/^\/api\/monitors\/([^/]+)\/(enable|disable|run)$/);
  if (req.method === 'POST' && monitorActionMatch) {
    const id = decodeURIComponent(monitorActionMatch[1]);
    const action = monitorActionMatch[2];
    const monitor = action === 'run'
      ? runtime.store.triggerMonitor(id)
      : runtime.store.setMonitorEnabled(id, action === 'enable');
    if (!monitor) return json(res, 404, { error: 'monitor not found' });
    if (action === 'run') runtime.monitoring.tick();
    return json(res, 200, { monitor });
  }

  if (req.method === 'POST' && url.pathname === '/api/schedules') {
    const body = await readJson(req);
    const nextRunAt = new Date(body.runAt).getTime();
    if (!Number.isFinite(nextRunAt)) return json(res, 400, { error: 'runAt is invalid' });
    return json(res, 201, { schedule: runtime.store.createSchedule({
      agentId: body.agentId ?? 'main', name: body.name, nextRunAt,
      intervalMs: body.intervalMinutes ? Number(body.intervalMinutes) * 60_000 : null,
      payload: { objective: body.objective, sessionId: body.sessionId },
    }) });
  }

  const scheduleToggleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/(enable|disable)$/);
  if (req.method === 'POST' && scheduleToggleMatch) {
    const schedule = runtime.store.setScheduleEnabled(decodeURIComponent(scheduleToggleMatch[1]), scheduleToggleMatch[2] === 'enable');
    return schedule ? json(res, 200, { schedule }) : json(res, 404, { error: 'schedule not found' });
  }

  const taskControlMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(pause|resume|cancel)$/);
  if (req.method === 'POST' && taskControlMatch) {
    const [, taskId, action] = taskControlMatch;
    const task = action === 'pause'
      ? runtime.store.pauseTask(decodeURIComponent(taskId))
      : action === 'resume'
        ? runtime.store.resumeTask(decodeURIComponent(taskId))
        : runtime.store.cancelTask(decodeURIComponent(taskId));
    if (action !== 'resume') runtime.scheduler.signalTask(decodeURIComponent(taskId), `Task ${action} requested by control API`);
    runtime.scheduler.requestDrain();
    return task ? json(res, 200, { task }) : json(res, 404, { error: 'task not found' });
  }

  if (req.method === 'GET' && url.pathname === '/api/outbox') {
    return json(res, 200, { outbox: runtime.store.listOutbox({ status: url.searchParams.get('status') ?? undefined }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/goals') {
    return json(res, 200, { goals: listGoalSummaries(), stats: runtime.store.getStats() });
  }

  if (req.method === 'POST' && url.pathname === '/api/goals') {
    const body = await readJson(req);
    const objective = String(body.objective ?? '').trim();
    if (!objective) return json(res, 400, { error: 'objective is required' });
    const view = await runtime.createGoal(objective, {
      requireReply: body.requireReply !== false,
      replyTimeoutMs: body.replyTimeoutMs,
      priority: body.priority,
      interrupt: body.interrupt,
      interruptReason: body.interruptReason,
    });
    return json(res, 201, view);
  }

  const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
  if (req.method === 'GET' && goalMatch) {
    const view = runtime.store.getGoalView(decodeURIComponent(goalMatch[1]));
    return view ? json(res, 200, view) : json(res, 404, { error: 'goal not found' });
  }

  const replyMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/reply$/);
  if (req.method === 'POST' && replyMatch) {
    const goal = runtime.store.getGoal(decodeURIComponent(replyMatch[1]));
    if (!goal) return json(res, 404, { error: 'goal not found' });
    const body = await readJson(req);
    const message = String(body.message ?? '').trim();
    if (!message) return json(res, 400, { error: 'message is required' });
    const waiting = runtime.store.listTasks(goal.id).find((task) => task.status === 'WAITING' && task.wait_kind === 'EVENT');
    const topic = waiting?.wait_topic ?? goal.metadata.replyTopic;
    const correlationKey = waiting?.wait_key ?? goal.metadata.replyKey;
    if (!topic || !correlationKey) return json(res, 409, { error: 'goal is not waiting for an external reply' });
    const result = runtime.publishEvent({
      topic,
      correlationKey,
      payload: { message, receivedAt: Date.now() },
      source: 'control-api',
      idempotencyKey: body.idempotencyKey,
    });
    return json(res, 202, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/events') {
    const body = await readJson(req);
    if (!body.topic || !body.correlationKey) {
      return json(res, 400, { error: 'topic and correlationKey are required' });
    }
    return json(res, 202, runtime.publishEvent({
      topic: String(body.topic),
      correlationKey: String(body.correlationKey),
      payload: body.payload ?? {},
      source: body.source ?? 'api',
      idempotencyKey: body.idempotencyKey,
    }));
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ workerId: runtime.scheduler.workerId })}\n\n`);
    const onChange = (update) => res.write(`event: runtime\ndata: ${JSON.stringify(update)}\n\n`);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    runtime.eventBus.on('change', onChange);
    req.on('close', () => {
      clearInterval(heartbeat);
      runtime.eventBus.off('change', onChange);
    });
    return;
  }

  return json(res, 404, { error: 'not found' });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (!isAuthorized(req, url)) return json(res, 401, { error: 'unauthorized' });
      if (isRateLimited(req)) return json(res, 429, { error: 'rate limit exceeded' });
      return await handleApi(req, res, url);
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return json(res, 200, {
        name: 'Agent OS Gateway',
        mode: 'headless',
        cli: 'agent-os --help',
        health: '/api/health',
      });
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    return json(res, error instanceof SyntaxError ? 400 : 500, { error: error.message });
  }
});

server.listen(port, config.gateway.bind, () => {
  console.log(`Agent OS headless gateway is running at http://${config.gateway.bind}:${port}`);
});

function shutdown() {
  server.close(async () => {
    await runtime.stop();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
