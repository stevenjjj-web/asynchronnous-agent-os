import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadConfig, validateConfig } from './platform/config.js';
import { PersonalAgentSystem } from './system.js';
import { authorizeGatewayRequest, BoundedRateLimiter } from './security/gateway-auth.js';
import { runSecurityAudit } from './security/audit.js';
import { requestBoundedText } from './security/public-fetch.js';

const config = loadConfig({ projectRoot: process.cwd() });
const configErrors = validateConfig(config);
if (configErrors.length) throw new Error(`Invalid configuration:\n- ${configErrors.join('\n- ')}`);
const startupSecurityAudit = runSecurityAudit(config);
const productionMode = process.env.NODE_ENV === 'production';
const blockingFindings = startupSecurityAudit.findings
  .filter((item) => item.severity === 'critical' || productionMode && item.severity === 'high');
if (blockingFindings.length > 0) {
  const details = blockingFindings.map((item) => `${item.id}: ${item.title}`);
  throw new Error(`Gateway startup blocked by security findings:\n- ${details.join('\n- ')}`);
}
if (startupSecurityAudit.summary.high > 0) {
  const ids = startupSecurityAudit.findings.filter((item) => item.severity === 'high').map((item) => item.id);
  process.stderr.write(`Security warning: ${startupSecurityAudit.summary.high} high-severity finding(s): ${ids.join(', ')}. Run "agent-os security audit".\n`);
}
const port = config.gateway.port;
const ownerTenantId = config.security.tenantId ?? 'default';
const runtime = await new PersonalAgentSystem(config).start();
const modelCatalogCache = new Map();
const sseClients = new Set();
const INTERNAL_EVENT_TOPICS = new Set([
  'approval.resolved', 'goal.completed', 'channel.message', 'monitor.changed', 'cognition.attention',
]);
const authLimiter = new BoundedRateLimiter({
  windowMs: config.gateway.rateLimit.windowMs,
  maxAttempts: config.gateway.rateLimit.authMaxAttempts,
  lockoutMs: config.gateway.rateLimit.authLockoutMs,
  maxEntries: config.gateway.rateLimit.maxEntries,
});
const readRequestLimiter = new BoundedRateLimiter({
  windowMs: config.gateway.rateLimit.windowMs,
  maxAttempts: config.gateway.rateLimit.maxRequests,
  lockoutMs: config.gateway.rateLimit.windowMs,
  maxEntries: config.gateway.rateLimit.maxEntries,
});
const writeRequestLimiter = new BoundedRateLimiter({
  windowMs: config.gateway.rateLimit.windowMs,
  maxAttempts: config.gateway.rateLimit.maxWrites,
  lockoutMs: config.gateway.rateLimit.windowMs,
  maxEntries: config.gateway.rateLimit.maxEntries,
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function discoverModels(key, model) {
  const fallback = [{ modelKey: key, modelId: model.model, provider: model.provider, configured: true }];
  if (model.provider !== 'openai-compatible' || !model.baseUrl) return { choices: fallback };
  const cached = modelCatalogCache.get(key);
  if (cached && Date.now() - cached.at < 300_000) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await requestBoundedText(`${model.baseUrl.replace(/\/$/, '')}/models`, {
      headers: model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {},
      signal: controller.signal,
      timeoutMs: 8_000,
      maxBytes: 2_000_000,
      allowPrivateNetwork: model.allowPrivateNetwork === true,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    const body = JSON.parse(response.content);
    if (!Array.isArray(body.data ?? [])) throw new Error('Model catalog has an invalid data field');
    const ids = [...new Set((body.data ?? []).map((item) => item?.id).filter(Boolean).map(String).filter((id) => id.length <= 256))].sort();
    const ordered = [model.model, ...ids.filter((id) => id !== model.model)].slice(0, 2_000);
    const value = {
      choices: ordered.map((modelId) => ({
        modelKey: key,
        modelId,
        provider: model.provider,
        configured: true,
      })),
    };
    modelCatalogCache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    return {
      choices: fallback,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function json(res, status, body) {
  let serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > 5_000_000) {
    status = 413;
    serialized = JSON.stringify({ error: 'response exceeds 5 MB; request a smaller page' });
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-resource-policy': 'same-origin',
  });
  res.end(serialized);
}

async function readJson(req, { maxBytes = 1_000_000 } = {}) {
  const declared = Number(req.headers['content-length']);
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8_000_000) throw new Error('Invalid request body limit');
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'Request body too large');
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType && contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

function isRateLimited(req) {
  const address = req.socket.remoteAddress ?? 'unknown';
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const key = `${address}:${write ? 'write' : 'read'}`;
  const limiter = write ? writeRequestLimiter : readRequestLimiter;
  const gate = limiter.check(key);
  if (!gate.allowed) return gate;
  limiter.record(key);
  return null;
}

function queryInteger(url, name, { fallback, minimum = 0, maximum = 1_000 } = {}) {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function inputText(value, name, { maximum, required = true, trim = true } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
  const candidate = trim ? value.trim() : value;
  if ((required && !candidate) || candidate.length > maximum || candidate.includes('\0')) {
    throw new HttpError(400, `${name} must contain ${required ? '1' : '0'} to ${maximum} characters`);
  }
  return candidate;
}

function inputNumber(value, name, { minimum = -Infinity, maximum = Infinity, integer = false, required = true } = {}) {
  if (value == null && !required) return null;
  const candidate = Number(value);
  if (!Number.isFinite(candidate) || integer && !Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new HttpError(400, `${name} is outside its allowed numeric range`);
  }
  return candidate;
}

function listGoalSummaries() {
  return runtime.store.listGoals().filter((goal) => goal.tenant_id === ownerTenantId).map((goal) => {
    const tasks = runtime.store.listTasks(goal.id);
    const counts = tasks.reduce((result, task) => {
      result[task.status] = (result[task.status] ?? 0) + 1;
      return result;
    }, {});
    return { ...goal, taskCount: tasks.length, counts };
  });
}

function resolveTenant(body = {}) {
  if (body.tenantId && body.tenantId !== ownerTenantId) throw new HttpError(403, 'Cross-tenant access is not allowed by this gateway');
  return ownerTenantId;
}

function resolveAgentId(value = 'main') {
  const agentId = String(value ?? 'main');
  if (!runtime.store.getAgent(agentId)) throw new HttpError(400, `unknown agent: ${agentId}`);
  return agentId;
}

function ownsGoal(goal) {
  return Boolean(goal && goal.tenant_id === ownerTenantId);
}

function ownsTask(task) {
  return Boolean(task && ownsGoal(runtime.store.getGoal(task.goal_id)));
}

function ownsSession(session) {
  return Boolean(session && session.tenant_id === ownerTenantId);
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/security/audit') {
    return json(res, 200, runSecurityAudit(config));
  }
  if (req.method === 'GET' && url.pathname === '/api/metrics') {
    const stats = runtime.store.getStats();
    const lines = [
      '# TYPE agent_os_events_total gauge',
      `agent_os_events_total ${stats.events}`,
      '# TYPE agent_os_sessions_total gauge',
      `agent_os_sessions_total ${stats.sessions}`,
      '# TYPE agent_os_memories_total gauge',
      `agent_os_memories_total ${stats.memories}`,
      '# TYPE agent_os_memory_candidates gauge',
      `agent_os_memory_candidates ${stats.memoryCandidates}`,
      '# TYPE agent_os_failed_memory_syncs gauge',
      `agent_os_failed_memory_syncs ${stats.failedMemorySyncs}`,
      '# TYPE agent_os_pending_approvals gauge',
      `agent_os_pending_approvals ${stats.pendingApprovals}`,
      '# TYPE agent_os_pending_outbox gauge',
      `agent_os_pending_outbox ${stats.pendingOutbox}`,
      ...Object.entries(stats.tasks).map(([status, count]) => `agent_os_tasks{status="${status.toLowerCase()}"} ${count}`),
      ...Object.entries(stats.goals).map(([status, count]) => `agent_os_goals{status="${status.toLowerCase()}"} ${count}`),
    ];
    res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
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

  if (req.method === 'GET' && url.pathname === '/api/models') {
    const defaults = Object.fromEntries(runtime.store.listAgents().map((agent) => [agent.id, agent.model_key]));
    const models = Object.entries(config.models).map(([key, model]) => ({
      key,
      provider: model.provider,
      model: model.model,
      configured: model.provider === 'offline' || Boolean(model.baseUrl && model.model),
      defaultFor: Object.entries(defaults).filter(([, modelKey]) => modelKey === key).map(([agentId]) => agentId),
    }));
    let choices = models.map((model) => ({
      modelKey: model.key,
      modelId: model.model,
      provider: model.provider,
      configured: model.configured,
    }));
    let discoveryErrors = [];
    if (url.searchParams.get('discover') === 'true') {
      const discovered = await Promise.all(Object.entries(config.models).map(([key, model]) => discoverModels(key, model)));
      choices = discovered.flatMap((result) => result.choices);
      discoveryErrors = discovered.map((result, index) => result.error
        ? { modelKey: Object.keys(config.models)[index], error: result.error }
        : null).filter(Boolean);
    }
    return json(res, 200, { models, defaults, choices, discoveryErrors });
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
      sandboxes: runtime.sandboxes.list(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    const tasks = runtime.store.listAllTasks({ limit: 50 }).filter(ownsTask);
    const goals = listGoalSummaries().slice(0, 8);
    return json(res, 200, {
      generatedAt: Date.now(),
      kernel: runtime.kernel.status(),
      stats: runtime.store.getStats(),
      cognition: runtime.cognition.status(),
      tasks: tasks.filter((task) => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)).slice(0, 8),
      goals,
      memories: runtime.store.listMemories('main', 5, ownerTenantId),
      pools: runtime.resourcePools.status(),
      inbox: runtime.inbox.snapshot({ limit: 8 }),
      taskManager: runtime.observability.taskManager({ limit: 8, tenantId: ownerTenantId }),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/task-manager') {
    return json(res, 200, runtime.observability.taskManager({
      includeTerminal: url.searchParams.get('includeTerminal') === 'true',
      limit: queryInteger(url, 'limit', { fallback: 100, minimum: 1, maximum: 500 }),
      tenantId: ownerTenantId,
    }));
  }

  if (req.method === 'GET' && url.pathname === '/api/inbox') {
    return json(res, 200, runtime.inbox.snapshot({
      limit: queryInteger(url, 'limit', { fallback: 20, minimum: 1, maximum: 200 }),
    }));
  }

  if (req.method === 'POST' && url.pathname === '/api/inbox/reply') {
    const body = await readJson(req);
    try {
      return json(res, 202, runtime.inbox.reply({
        target: body.target,
        message: body.message,
        idempotencyKey: body.idempotencyKey,
      }));
    } catch (error) {
      return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/tools') {
    return json(res, 200, {
      tools: runtime.tools.list(),
      channels: runtime.channels.list(),
      sensors: runtime.sensors.list(),
      listeners: runtime.listeners.list(),
      sandboxes: runtime.sandboxes.list(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/channels/messages') {
    return json(res, 200, {
      messages: runtime.store.listChannelMessages({
        channelId: url.searchParams.get('channel') ?? undefined,
        accountId: url.searchParams.get('accountId') ?? undefined,
        threadKey: url.searchParams.get('threadKey') ?? undefined,
        status: url.searchParams.get('status') ?? undefined,
        tenantId: ownerTenantId,
        limit: queryInteger(url, 'limit', { fallback: 100, minimum: 1, maximum: 500 }),
      }),
    });
  }

  const channelMessageMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
  if (req.method === 'POST' && channelMessageMatch) {
    const body = await readJson(req);
    try {
      return json(res, 202, runtime.channels.ingest(decodeURIComponent(channelMessageMatch[1]), {
        messageId: body.messageId,
        accountId: body.accountId,
        threadKey: body.threadKey,
        sender: body.sender,
        text: body.text,
        payload: body.payload,
        receivedAt: body.receivedAt,
        tenantId: resolveTenant(body),
        agentId: resolveAgentId(body.agentId),
      }));
    } catch (error) {
      return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
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
      limit: queryInteger(url, 'limit', { fallback: 100, minimum: 1, maximum: 500 }),
    }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/resources') {
    return json(res, 200, {
      pools: runtime.resourcePools.status(),
      defaults: config.resources.goalDefaults,
      globalDaily: config.resources.globalDaily,
      agentDaily: config.resources.agentDaily,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/operations') {
    const operations = runtime.store.listOperations({
      state: url.searchParams.get('state') ?? undefined,
      goalId: url.searchParams.get('goalId') ?? undefined,
      limit: queryInteger(url, 'limit', { fallback: 100, minimum: 1, maximum: 500 }),
    }).filter((operation) => ownsGoal(runtime.store.getGoal(operation.goal_id)));
    return json(res, 200, { operations });
  }

  const operationMatch = url.pathname.match(/^\/api\/operations\/([^/]+)$/);
  if (req.method === 'GET' && operationMatch) {
    const operation = runtime.store.getOperation(decodeURIComponent(operationMatch[1]));
    return operation && ownsGoal(runtime.store.getGoal(operation.goal_id))
      ? json(res, 200, { operation })
      : json(res, 404, { error: 'operation not found' });
  }

  const operationActionMatch = url.pathname.match(/^\/api\/operations\/([^/]+)\/(reconcile|compensate)$/);
  if (req.method === 'POST' && operationActionMatch) {
    const body = await readJson(req);
    const operation = runtime.store.getOperation(decodeURIComponent(operationActionMatch[1]));
    if (!operation || !ownsGoal(runtime.store.getGoal(operation.goal_id))) return json(res, 404, { error: 'operation not found' });
    const result = operationActionMatch[2] === 'compensate'
      ? await runtime.operations.compensate(operation.id, body.reason)
      : await runtime.operations.reconcile(operation);
    return json(res, 200, { operation: result });
  }

  if (req.method === 'GET' && url.pathname === '/api/attention') {
    return json(res, 200, { assessments: runtime.store.listAttentionAssessments({
      agentId: url.searchParams.get('agentId') ?? 'main',
      tenantId: ownerTenantId,
      limit: queryInteger(url, 'limit', { fallback: 50, minimum: 1, maximum: 500 }),
    }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/credentials') {
    return json(res, 200, { credentials: runtime.store.listCredentialRefs({
      tenantId: ownerTenantId,
      agentId: url.searchParams.get('agentId') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
    }).map(({ locator, ...reference }) => reference) });
  }

  if (req.method === 'POST' && url.pathname === '/api/credentials') {
    const body = await readJson(req);
    if (!/^env:[A-Z_][A-Z0-9_]*$/i.test(String(body.locator ?? ''))) return json(res, 400, { error: 'credential locator must be a valid env: reference' });
    const expiresAt = body.expiresAt == null ? null : new Date(body.expiresAt).getTime();
    if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new HttpError(400, 'expiresAt must be a future date or timestamp');
    const reference = runtime.store.createCredentialRef({
      id: body.id,
      tenantId: resolveTenant(body),
      agentId: resolveAgentId(body.agentId),
      provider: 'environment',
      locator: String(body.locator).slice(4),
      expiresAt,
      metadata: body.metadata,
    });
    const { locator, ...safeReference } = reference;
    return json(res, 201, { credential: safeReference });
  }

  const credentialActionMatch = url.pathname.match(/^\/api\/credentials\/([^/]+)\/revoke$/);
  if (req.method === 'POST' && credentialActionMatch) {
    const current = runtime.store.getCredentialRef(decodeURIComponent(credentialActionMatch[1]));
    if (!current || current.tenant_id !== ownerTenantId) return json(res, 404, { error: 'credential reference not found' });
    const reference = runtime.store.setCredentialRefStatus(current.id, 'REVOKED');
    const { locator, ...safeReference } = reference;
    return json(res, 200, { credential: safeReference });
  }

  if (req.method === 'GET' && url.pathname === '/api/interrupts') {
    const interrupts = runtime.store.listInterrupts({
      status: url.searchParams.get('status') ?? undefined,
      limit: queryInteger(url, 'limit', { fallback: 100, minimum: 1, maximum: 500 }),
    }).filter((interrupt) => (
      runtime.store.getAgent(interrupt.agent_id)
      && (!interrupt.goal_id || ownsGoal(runtime.store.getGoal(interrupt.goal_id)))
    ));
    return json(res, 200, { interrupts });
  }

  if (req.method === 'POST' && url.pathname === '/api/interrupts') {
    const body = await readJson(req);
    inputNumber(body.priority ?? 100, 'priority', { minimum: 0, maximum: 100 });
    if (body.reason != null) inputText(body.reason, 'reason', { maximum: 4_000 });
    if (body.goalId && !ownsGoal(runtime.store.getGoal(body.goalId))) return json(res, 404, { error: 'goal not found' });
    if (body.targetTaskId && !ownsTask(runtime.store.getTask(body.targetTaskId))) return json(res, 404, { error: 'task not found' });
    return json(res, 202, { interrupt: runtime.interrupts.raise({
      agentId: resolveAgentId(body.agentId),
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
    const tasks = runtime.store.listAllTasks({
      status: url.searchParams.get('status') ?? undefined,
      sessionId: url.searchParams.get('sessionId') ?? undefined,
      limit: queryInteger(url, 'limit', { fallback: 100, minimum: 1, maximum: 500 }),
    }).filter(ownsTask);
    return json(res, 200, { tasks });
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'GET' && taskMatch) {
    const task = runtime.store.getTask(decodeURIComponent(taskMatch[1]));
    return ownsTask(task) ? json(res, 200, { task }) : json(res, 404, { error: 'task not found' });
  }

  const taskExplainMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/explain$/);
  if (req.method === 'GET' && taskExplainMatch) {
    const task = runtime.store.getTask(decodeURIComponent(taskExplainMatch[1]));
    if (!ownsTask(task)) return json(res, 404, { error: 'task not found' });
    return json(res, 200, { thread: runtime.observability.explainTask(task) });
  }

  if (req.method === 'GET' && url.pathname === '/api/audit') {
    const audit = runtime.store.listAudit({
      goalId: url.searchParams.get('goalId') ?? undefined,
      taskId: url.searchParams.get('taskId') ?? undefined,
      afterId: url.searchParams.has('afterId') ? queryInteger(url, 'afterId', { fallback: undefined, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) : undefined,
      limit: queryInteger(url, 'limit', { fallback: 100, minimum: 1, maximum: 500 }),
    }).filter((entry) => ownsGoal(runtime.store.getGoal(entry.goal_id)));
    return json(res, 200, { audit });
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const events = runtime.store.listEvents({
      topic: url.searchParams.get('topic') ?? undefined,
      correlationKey: url.searchParams.get('correlationKey') ?? undefined,
      limit: queryInteger(url, 'limit', { fallback: 100, minimum: 1, maximum: 500 }),
    }).filter((event) => !event.tenant_id || event.tenant_id === ownerTenantId);
    return json(res, 200, { events });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/messages') {
    const body = await readJson(req);
    inputText(body.text, 'text', { maximum: config.session.maxMessageChars });
    if (body.messageId != null) inputText(body.messageId, 'messageId', { maximum: 256, trim: false });
    if (body.priority != null) inputNumber(body.priority, 'priority', { minimum: 0, maximum: 100 });
    if (body.parentGoalId && !ownsGoal(runtime.store.getGoal(body.parentGoalId))) throw new HttpError(404, 'parent goal not found');
    const accepted = await runtime.submit({
      sessionKey: body.sessionKey,
      agentId: resolveAgentId(body.agentId),
      tenantId: resolveTenant(body),
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
      deadlineAt: body.deadlineAt,
      budget: body.budget,
      capabilities: body.capabilities,
      capabilityExpiresAt: body.capabilityExpiresAt,
      parentGoalId: body.parentGoalId,
      conflictKeys: body.conflictKeys,
      resourceClaims: body.resourceClaims,
      assumptions: body.assumptions,
      ...(Object.prototype.hasOwnProperty.call(body, 'modelKey') ? { modelKey: body.modelKey } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'modelId') ? { modelId: body.modelId } : {}),
    });
    return json(res, 202, accepted);
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return json(res, 200, { sessions: runtime.store.listSessions({
      agentId: url.searchParams.get('agentId') ?? undefined,
      tenantId: ownerTenantId,
    }) });
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && sessionMatch) {
    const session = runtime.store.getSession(decodeURIComponent(sessionMatch[1]));
    return ownsSession(session)
      ? json(res, 200, { session, messages: runtime.store.listMessages(session.id, { limit: queryInteger(url, 'limit', { fallback: 100, minimum: 1, maximum: 500 }) }) })
      : json(res, 404, { error: 'session not found' });
  }

  const sessionModelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/model$/);
  if (req.method === 'POST' && sessionModelMatch) {
    const body = await readJson(req);
    const session = runtime.store.getSession(decodeURIComponent(sessionModelMatch[1]));
    if (!ownsSession(session)) return json(res, 404, { error: 'session not found' });
    const modelKey = body.modelKey == null || body.modelKey === '' ? null : String(body.modelKey);
    if (modelKey && modelKey.length > 128) throw new HttpError(400, 'modelKey exceeds 128 characters');
    if (modelKey && !config.models[modelKey]) return json(res, 400, { error: `unknown model config: ${modelKey}` });
    const effectiveModelKey = modelKey ?? runtime.store.getAgent(session.agent_id)?.model_key;
    const modelId = body.modelId == null || body.modelId === '' ? null : String(body.modelId);
    if (modelId && modelId.length > 256) throw new HttpError(400, 'modelId exceeds 256 characters');
    const effectiveModelId = modelId ?? config.models[effectiveModelKey]?.model;
    const updated = runtime.store.updateSessionMetadata(session.id, { modelKey, modelId });
    return json(res, 200, { session: updated, modelKey, modelId, effectiveModelKey, effectiveModelId });
  }

  const sessionPurgeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/purge$/);
  if (req.method === 'POST' && sessionPurgeMatch) {
    const session = runtime.store.getSession(decodeURIComponent(sessionPurgeMatch[1]));
    if (!ownsSession(session)) return json(res, 404, { error: 'session not found' });
    const result = runtime.store.purgeSession(session.id);
    return json(res, 200, { purged: result });
  }

  if (req.method === 'GET' && url.pathname === '/api/memories') {
    return json(res, 200, {
      memories: url.searchParams.get('q')
        ? runtime.memory.recall(url.searchParams.get('agentId') ?? 'main', url.searchParams.get('q'), {
            limit: queryInteger(url, 'limit', { fallback: 20, minimum: 1, maximum: 200 }), tenantId: ownerTenantId,
          })
        : runtime.store.listMemories(url.searchParams.get('agentId') ?? 'main', queryInteger(url, 'limit', { fallback: 50, minimum: 1, maximum: 500 }), ownerTenantId),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/memory-portability/providers') {
    return json(res, 200, { providers: runtime.memoryPortability.listProviders() });
  }

  if (req.method === 'GET' && url.pathname === '/api/memory-portability/runs') {
    return json(res, 200, {
      runs: runtime.store.listMemorySyncRuns({
        agentId: resolveAgentId(url.searchParams.get('agentId') ?? 'main'),
        tenantId: ownerTenantId,
        providerId: url.searchParams.get('providerId') ?? undefined,
        limit: queryInteger(url, 'limit', { fallback: 100, minimum: 1, maximum: 500 }),
      }),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/memory-portability/export') {
    const body = await readJson(req);
    const result = runtime.memoryPortability.exportTracked({
      agentId: resolveAgentId(body.agentId),
      tenantId: resolveTenant(body),
      includeInactive: body.includeInactive === true,
      unsigned: body.unsigned === true,
      limit: body.limit == null ? undefined : inputNumber(body.limit, 'limit', {
        minimum: 1, maximum: config.memory.portability.maxEntries, integer: true,
      }),
      providerId: 'api',
    });
    return json(res, 200, {
      bundle: result.bundle,
      digest: result.digest,
      contentDigest: result.contentDigest,
      payloadDigest: result.payloadDigest,
      encrypted: result.encrypted,
      count: result.count,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/memory-portability/import') {
    const body = await readJson(req, { maxBytes: Math.min(8_000_000, config.memory.portability.maxBundleBytes + 100_000) });
    if (!body.bundle || typeof body.bundle !== 'object' || Array.isArray(body.bundle)) throw new HttpError(400, 'bundle must be an object');
    let result;
    try {
      result = runtime.memoryPortability.importTracked(body.bundle, {
        agentId: resolveAgentId(body.agentId),
        tenantId: resolveTenant(body),
        activate: body.activate === true,
        remote: false,
        providerId: 'api',
      });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    return json(res, 200, result);
  }

  const memoryProviderMatch = url.pathname.match(/^\/api\/memory-portability\/providers\/([^/]+)\/(pull|push)$/);
  if (req.method === 'POST' && memoryProviderMatch) {
    const providerId = decodeURIComponent(memoryProviderMatch[1]);
    if (!runtime.memoryPortability.listProviders().some((provider) => provider.id === providerId)) {
      return json(res, 404, { error: 'memory provider not found' });
    }
    const body = await readJson(req);
    const options = {
      agentId: resolveAgentId(body.agentId),
      tenantId: resolveTenant(body),
      activate: body.activate === true,
      includeInactive: body.includeInactive === true,
      digest: body.digest == null ? undefined : inputText(body.digest, 'digest', { maximum: 128 }),
    };
    let result;
    try {
      result = memoryProviderMatch[2] === 'pull'
        ? await runtime.memoryPortability.pull(providerId, options)
        : await runtime.memoryPortability.push(providerId, options);
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
    return json(res, 200, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/memories') {
    const body = await readJson(req);
    inputText(body.content, 'content', { maximum: config.memory.maxEntryChars });
    if (body.kind != null && !['fact', 'preference', 'decision', 'episode', 'procedure', 'note'].includes(body.kind)) throw new HttpError(400, 'invalid memory kind');
    if (body.importance != null) inputNumber(body.importance, 'importance', { minimum: 0, maximum: 1 });
    if (body.confidence != null) inputNumber(body.confidence, 'confidence', { minimum: 0, maximum: 1 });
    if (body.tags != null && (!Array.isArray(body.tags) || body.tags.length > 50)) throw new HttpError(400, 'tags must be an array with at most 50 entries');
    if (body.source != null) inputText(body.source, 'source', { maximum: 256 });
    return json(res, 201, { memory: runtime.memory.remember({
      agentId: resolveAgentId(body.agentId), tenantId: resolveTenant(body), content: body.content, kind: body.kind,
      importance: body.importance, confidence: body.confidence, tags: body.tags, source: body.source ?? 'api',
      expiresAt: body.expiresAt, validFrom: body.validFrom, validUntil: body.validUntil,
      supersedesId: body.supersedesId, contradictsIds: body.contradictsIds,
      provenance: { actor: 'gateway-operator', evidence: body.evidence ?? null },
    }) });
  }

  const memoryConfirmMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/confirm$/);
  if (req.method === 'POST' && memoryConfirmMatch) {
    const body = await readJson(req);
    const memory = runtime.store.getMemory(decodeURIComponent(memoryConfirmMatch[1]));
    if (!memory || memory.tenant_id !== ownerTenantId) return json(res, 404, { error: 'memory not found' });
    if (body.confidence != null) inputNumber(body.confidence, 'confidence', { minimum: 0, maximum: 1 });
    return json(res, 200, { memory: runtime.memory.confirm(memory.id, {
      confidence: body.confidence,
      source: body.source ?? 'operator',
    }) });
  }

  const memoryStatusMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/status$/);
  if (req.method === 'POST' && memoryStatusMatch) {
    const body = await readJson(req);
    const memory = runtime.store.getMemory(decodeURIComponent(memoryStatusMatch[1]));
    if (!memory || memory.tenant_id !== ownerTenantId) return json(res, 404, { error: 'memory not found' });
    const status = String(body.status ?? '').toUpperCase();
    if (!['ACTIVE', 'RETRACTED', 'CONTRADICTED'].includes(status)) return json(res, 400, { error: 'invalid memory status' });
    return json(res, 200, { memory: runtime.store.setMemoryStatus(memory.id, status, {
      actor: 'gateway-operator', reason: body.reason ?? null,
    }) });
  }

  const memoryForgetMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/forget$/);
  if (req.method === 'POST' && memoryForgetMatch) {
    const memory = runtime.store.getMemory(decodeURIComponent(memoryForgetMatch[1]));
    if (!memory || memory.tenant_id !== ownerTenantId) return json(res, 404, { error: 'memory not found' });
    const forgotten = runtime.memory.forget(memory.id, { agentId: memory.agent_id, tenantId: ownerTenantId });
    return json(res, 200, { forgotten });
  }

  if (req.method === 'GET' && url.pathname === '/api/approvals') {
    const approvals = runtime.store.listApprovals(url.searchParams.get('status') ?? undefined)
      .filter((approval) => ownsGoal(runtime.store.getGoal(approval.goal_id)));
    return json(res, 200, { approvals });
  }

  const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
  if (req.method === 'POST' && approvalMatch) {
    const body = await readJson(req);
    if (!['approve', 'deny'].includes(body.decision)) throw new HttpError(400, 'decision must be approve or deny');
    if (body.note != null) inputText(body.note, 'note', { maximum: 4_000, required: false });
    const approvalId = decodeURIComponent(approvalMatch[1]);
    const current = runtime.store.getApproval(approvalId);
    if (!current || !ownsGoal(runtime.store.getGoal(current.goal_id))) return json(res, 404, { error: 'approval not found' });
    let outcome;
    try {
      outcome = runtime.store.resolveApprovalAndPublishEvent(approvalId, body.decision, {
        resolvedBy: 'gateway-operator', note: body.note,
      }, {
      source: 'approval-api',
      tenantId: runtime.store.getGoal(current.goal_id)?.tenant_id,
      agentId: runtime.store.getGoal(current.goal_id)?.agent_id,
      authenticated: true,
      authSubject: 'gateway-operator',
      });
    } catch (error) {
      throw new HttpError(409, error.message);
    }
    runtime.eventBus.announce(outcome.delivery);
    runtime.scheduler.requestDrain();
    return json(res, 200, outcome);
  }

  if (req.method === 'GET' && url.pathname === '/api/schedules') {
    return json(res, 200, { schedules: runtime.store.listSchedules(100, ownerTenantId) });
  }

  if (req.method === 'GET' && url.pathname === '/api/monitors') {
    return json(res, 200, {
      monitors: runtime.store.listMonitors({
        agentId: url.searchParams.get('agentId') ?? undefined,
        tenantId: ownerTenantId,
        enabled: url.searchParams.has('enabled') ? url.searchParams.get('enabled') === 'true' : undefined,
      }),
      sensors: runtime.sensors.list(),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/monitors') {
    const body = await readJson(req);
    if (!runtime.sensors.get(body.sensorType)) return json(res, 400, { error: 'unknown sensor type' });
    const name = inputText(body.name, 'name', { maximum: 500 });
    const intervalMs = inputNumber(body.intervalMs ?? Number(body.intervalSeconds) * 1000, 'monitor interval', {
      minimum: 1_000, maximum: 31_536_000_000, integer: true,
    });
    if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) throw new HttpError(400, 'monitor config must be an object');
    if (body.sensorType === 'https') {
      const monitorUrl = inputText(body.config.url, 'config.url', { maximum: 8_192 });
      let parsed;
      try { parsed = new URL(monitorUrl); } catch { throw new HttpError(400, 'config.url must be a valid HTTPS URL'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port && parsed.port !== '443') {
        throw new HttpError(400, 'config.url must use HTTPS port 443 without embedded credentials');
      }
      body.config.url = monitorUrl;
    }
    return json(res, 201, { monitor: runtime.store.createMonitor({
      agentId: resolveAgentId(body.agentId),
      tenantId: resolveTenant(body),
      name,
      sensorType: body.sensorType,
      intervalMs,
      config: body.config ?? {},
      enabled: body.enabled !== false,
    }) });
  }

  const monitorMatch = url.pathname.match(/^\/api\/monitors\/([^/]+)$/);
  if (req.method === 'GET' && monitorMatch) {
    const monitor = runtime.store.getMonitor(decodeURIComponent(monitorMatch[1]));
    return monitor?.tenant_id === ownerTenantId ? json(res, 200, {
      monitor,
      observations: runtime.store.listMonitorObservations(monitor.id),
    }) : json(res, 404, { error: 'monitor not found' });
  }

  const monitorActionMatch = url.pathname.match(/^\/api\/monitors\/([^/]+)\/(enable|disable|run)$/);
  if (req.method === 'POST' && monitorActionMatch) {
    const id = decodeURIComponent(monitorActionMatch[1]);
    const action = monitorActionMatch[2];
    const current = runtime.store.getMonitor(id);
    if (!current || current.tenant_id !== ownerTenantId) return json(res, 404, { error: 'monitor not found' });
    const monitor = action === 'run'
      ? runtime.store.triggerMonitor(id)
      : runtime.store.setMonitorEnabled(id, action === 'enable');
    if (!monitor) return json(res, 404, { error: 'monitor not found' });
    if (action === 'run') runtime.monitoring.tick();
    return json(res, 200, { monitor });
  }

  if (req.method === 'POST' && url.pathname === '/api/schedules') {
    const body = await readJson(req);
    if (body.sessionId && !ownsSession(runtime.store.getSession(body.sessionId))) return json(res, 404, { error: 'session not found' });
    const name = inputText(body.name, 'name', { maximum: 500 });
    const objective = inputText(body.objective, 'objective', { maximum: 200_000 });
    const nextRunAt = new Date(body.runAt).getTime();
    if (!Number.isFinite(nextRunAt)) return json(res, 400, { error: 'runAt is invalid' });
    return json(res, 201, { schedule: runtime.store.createSchedule({
      agentId: resolveAgentId(body.agentId), tenantId: resolveTenant(body), name, nextRunAt,
      intervalMs: body.intervalMinutes == null ? null : inputNumber(body.intervalMinutes, 'intervalMinutes', {
        minimum: 1, maximum: 525_600, integer: true,
      }) * 60_000,
      payload: { objective, sessionId: body.sessionId },
    }) });
  }

  const scheduleToggleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/(enable|disable)$/);
  if (req.method === 'POST' && scheduleToggleMatch) {
    const id = decodeURIComponent(scheduleToggleMatch[1]);
    const current = runtime.store.getSchedule(id);
    if (!current || current.tenant_id !== ownerTenantId) return json(res, 404, { error: 'schedule not found' });
    const schedule = runtime.store.setScheduleEnabled(id, scheduleToggleMatch[2] === 'enable');
    return schedule ? json(res, 200, { schedule }) : json(res, 404, { error: 'schedule not found' });
  }

  const taskControlMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(pause|resume|cancel)$/);
  if (req.method === 'POST' && taskControlMatch) {
    const [, taskId, action] = taskControlMatch;
    const current = runtime.store.getTask(decodeURIComponent(taskId));
    if (!ownsTask(current)) return json(res, 404, { error: 'task not found' });
    const task = action === 'pause'
      ? runtime.store.pauseTask(decodeURIComponent(taskId))
      : action === 'resume'
        ? runtime.store.resumeTask(decodeURIComponent(taskId))
        : runtime.store.cancelTask(decodeURIComponent(taskId));
    if (action !== 'resume') runtime.scheduler.signalTask(decodeURIComponent(taskId), `Task ${action} requested by control API`);
    runtime.scheduler.requestDrain();
    return task ? json(res, 200, { task }) : json(res, 404, { error: 'task not found' });
  }

  const taskPriorityMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/priority$/);
  if (req.method === 'POST' && taskPriorityMatch) {
    const body = await readJson(req);
    inputNumber(body.priority, 'priority', { minimum: 0, maximum: 100 });
    const taskId = decodeURIComponent(taskPriorityMatch[1]);
    const current = runtime.store.getTask(taskId);
    if (!ownsTask(current)) return json(res, 404, { error: 'task not found' });
    const task = runtime.store.updateTaskPriority(taskId, body.priority, 'gateway-operator', body.reason);
    runtime.scheduler.requestDrain();
    return json(res, 200, { task, explanation: runtime.observability.explainTask(task) });
  }

  if (req.method === 'GET' && url.pathname === '/api/outbox') {
    const outbox = runtime.store.listOutbox({ status: url.searchParams.get('status') ?? undefined })
      .filter((entry) => ownsSession(runtime.store.getSession(entry.session_id)));
    return json(res, 200, { outbox });
  }

  if (req.method === 'GET' && url.pathname === '/api/goals') {
    return json(res, 200, { goals: listGoalSummaries(), stats: runtime.store.getStats() });
  }

  if (req.method === 'POST' && url.pathname === '/api/goals') {
    const body = await readJson(req);
    const objective = inputText(body.objective, 'objective', { maximum: 200_000 });
    if (body.priority != null) inputNumber(body.priority, 'priority', { minimum: 0, maximum: 100 });
    if (body.parentGoalId && !ownsGoal(runtime.store.getGoal(body.parentGoalId))) throw new HttpError(404, 'parent goal not found');
    const view = await runtime.createGoal(objective, {
      requireReply: body.requireReply !== false,
      replyTimeoutMs: body.replyTimeoutMs,
      priority: body.priority,
      interrupt: body.interrupt,
      interruptReason: body.interruptReason,
      deadlineAt: body.deadlineAt,
      budget: body.budget,
      capabilities: body.capabilities,
      conflictKeys: body.conflictKeys,
      resourceClaims: body.resourceClaims,
      assumptions: body.assumptions,
      capabilityExpiresAt: body.capabilityExpiresAt,
      parentGoalId: body.parentGoalId,
      agentId: resolveAgentId(body.agentId),
      tenantId: resolveTenant(body),
    });
    return json(res, 201, view);
  }

  const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
  if (req.method === 'GET' && goalMatch) {
    const view = runtime.store.getGoalView(decodeURIComponent(goalMatch[1]));
    return view && ownsGoal(view.goal) ? json(res, 200, view) : json(res, 404, { error: 'goal not found' });
  }

  const goalContractMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/contract$/);
  if (req.method === 'GET' && goalContractMatch) {
    const goalId = decodeURIComponent(goalContractMatch[1]);
    const contract = runtime.store.getGoalContract(goalId);
    return contract?.tenant_id === ownerTenantId ? json(res, 200, {
      contract,
      capabilityAudit: runtime.store.listCapabilityAudit(goalId),
    }) : json(res, 404, { error: 'goal contract not found' });
  }

  const goalPlanMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/plan$/);
  if (req.method === 'GET' && goalPlanMatch) {
    const goalId = decodeURIComponent(goalPlanMatch[1]);
    if (!ownsGoal(runtime.store.getGoal(goalId))) return json(res, 404, { error: 'goal not found' });
    return json(res, 200, {
      goal: runtime.store.getGoal(goalId),
      versions: runtime.store.listPlanVersions(goalId, 100),
      assumptions: runtime.store.listGoalAssumptions(goalId, { limit: 200 }),
      resourceClaims: runtime.store.listResourceClaims({ goalId, limit: 500 }),
    });
  }

  const goalTraceMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/trace$/);
  if (req.method === 'GET' && goalTraceMatch) {
    const goalId = decodeURIComponent(goalTraceMatch[1]);
    if (!ownsGoal(runtime.store.getGoal(goalId))) return json(res, 404, { error: 'goal not found' });
    return json(res, 200, runtime.observability.traceGoal(goalId));
  }

  const goalBudgetMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/budget$/);
  if (req.method === 'POST' && goalBudgetMatch) {
    const body = await readJson(req);
    const goalId = decodeURIComponent(goalBudgetMatch[1]);
    if (!ownsGoal(runtime.store.getGoal(goalId))) return json(res, 404, { error: 'goal not found' });
    const contract = runtime.resources.reviseBudget(goalId, body.budget ?? {}, {
      actor: 'gateway-operator',
      reason: body.reason ?? 'Budget revised from control API',
    });
    runtime.scheduler.requestDrain();
    return json(res, 200, { contract });
  }

  const capabilityActionMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/capabilities\/revoke$/);
  if (req.method === 'POST' && capabilityActionMatch) {
    const body = await readJson(req);
    const goalId = decodeURIComponent(capabilityActionMatch[1]);
    if (!ownsGoal(runtime.store.getGoal(goalId))) return json(res, 404, { error: 'goal contract not found' });
    const contract = runtime.capabilities.revoke(
      goalId,
      'gateway-operator',
      body.reason,
    );
    return contract ? json(res, 200, { contract }) : json(res, 404, { error: 'goal contract not found' });
  }

  const replyMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/reply$/);
  if (req.method === 'POST' && replyMatch) {
    const goal = runtime.store.getGoal(decodeURIComponent(replyMatch[1]));
    if (!ownsGoal(goal)) return json(res, 404, { error: 'goal not found' });
    const body = await readJson(req);
    const message = inputText(body.message, 'message', { maximum: config.session.maxMessageChars });
    if (body.idempotencyKey != null) inputText(body.idempotencyKey, 'idempotencyKey', { maximum: 512, trim: false });
    const waiting = runtime.store.listTasks(goal.id).find((task) => (
      task.status === 'WAITING'
      && task.wait_kind === 'EVENT'
      && task.wait_topic === 'user.reply'
    ));
    const topic = waiting?.wait_topic ?? goal.metadata.replyTopic;
    const correlationKey = waiting?.wait_key ?? goal.metadata.replyKey;
    if (!topic || !correlationKey) return json(res, 409, { error: 'goal is not waiting for an external reply' });
    let result;
    try {
      result = runtime.publishEvent({
        topic,
        correlationKey,
        payload: { message },
        source: 'control-api',
        idempotencyKey: body.idempotencyKey,
        tenantId: goal.tenant_id,
        agentId: goal.agent_id,
        authenticated: true,
        authSubject: 'gateway-operator',
      });
    } catch (error) {
      if (String(error.message).includes('replay key was reused')) throw new HttpError(409, error.message);
      throw error;
    }
    return json(res, 202, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/events') {
    const body = await readJson(req);
    if (!body.topic || !body.correlationKey) {
      return json(res, 400, { error: 'topic and correlationKey are required' });
    }
    if (INTERNAL_EVENT_TOPICS.has(String(body.topic))) throw new HttpError(403, 'event topic is reserved for the Agent OS kernel');
    const source = String(body.source ?? 'api');
    const tenantId = resolveTenant(body);
    const agentId = resolveAgentId(body.agentId);
    if (body.idempotencyKey != null) inputText(body.idempotencyKey, 'idempotencyKey', { maximum: 512, trim: false });
    let authentication;
    try {
      authentication = runtime.eventAuthenticator.verify({
        source,
        topic: String(body.topic),
        correlationKey: String(body.correlationKey),
        payload: body.payload ?? {},
        tenantId,
        agentId,
        timestamp: body.timestamp,
        nonce: body.nonce,
        signature: body.signature ?? req.headers['x-agent-event-signature'],
      });
    } catch {
      throw new HttpError(401, 'external event authentication failed');
    }
    try {
      return json(res, 202, runtime.publishEvent({
        topic: String(body.topic),
        correlationKey: String(body.correlationKey),
        payload: body.payload ?? {},
        source,
        idempotencyKey: body.idempotencyKey,
        tenantId,
        agentId,
        nonce: authentication.nonce,
        authenticated: authentication.authenticated,
        authSubject: authentication.authSubject,
      }));
    } catch (error) {
      if (String(error.message).includes('replay key was reused')) throw new HttpError(409, error.message);
      throw error;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    if (sseClients.size >= 32) return json(res, 503, { error: 'stream connection limit reached' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
    });
    sseClients.add(res);
    let closed = false;
    let heartbeat;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      runtime.eventBus.off('change', onChange);
      sseClients.delete(res);
    };
    const write = (chunk) => {
      if (closed || res.destroyed) return false;
      if (Buffer.byteLength(chunk) > 256_000 || !res.write(chunk)) {
        cleanup();
        res.destroy();
        return false;
      }
      return true;
    };
    const onChange = (update) => write(`event: runtime\ndata: ${JSON.stringify(update)}\n\n`);
    write(`event: connected\ndata: ${JSON.stringify({ workerId: runtime.scheduler.workerId })}\n\n`);
    heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000);
    runtime.eventBus.on('change', onChange);
    req.on('close', cleanup);
    return;
  }

  return json(res, 404, { error: 'not found' });
}

const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 35_000, headersTimeout: 10_000 }, async (req, res) => {
  const requestId = randomUUID();
  const requestPath = String(req.url ?? '').split('?', 1)[0];
  res.setHeader('x-request-id', requestId);
  try {
    const url = new URL(req.url, 'http://agent-os.invalid');
    if (url.pathname.startsWith('/api/')) {
      const authorization = authorizeGatewayRequest(req, config, authLimiter);
      if (!authorization.ok) {
        if (authorization.retryAfterMs) res.setHeader('retry-after', String(Math.ceil(authorization.retryAfterMs / 1_000)));
        return json(res, authorization.status, { error: authorization.status === 429 ? 'rate limit exceeded' : 'unauthorized' });
      }
      const rateLimit = isRateLimited(req);
      if (rateLimit) {
        if (rateLimit.retryAfterMs) res.setHeader('retry-after', String(Math.ceil(rateLimit.retryAfterMs / 1_000)));
        return json(res, 429, { error: 'rate limit exceeded' });
      }
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
    const status = error instanceof HttpError || error instanceof URIError
      ? (error.status ?? 400)
      : error?.code === 'CAPABILITY_DENIED'
        ? 403
        : error?.code === 'RESOURCE_LIMIT'
          ? 422
          : 500;
    console.error(JSON.stringify({
      level: 'error', requestId, method: req.method, path: requestPath,
      error: error instanceof Error ? error.stack : String(error),
    }));
    return json(res, status, {
      error: status >= 500 ? 'internal server error' : error.message,
      requestId,
    });
  }
});
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;
server.maxConnections = 128;

await new Promise((resolveListen, rejectListen) => {
  const onError = (error) => rejectListen(error);
  server.once('error', onError);
  server.listen(port, config.gateway.bind, () => {
    server.off('error', onError);
    resolveListen();
  });
}).catch(async (error) => {
  await runtime.stop();
  throw error;
});
console.log(`Agent OS headless gateway is running at http://${config.gateway.bind}:${port}`);

let shuttingDown = false;
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  const force = setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(exitCode || 1);
  }, 10_000);
  force.unref();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolveClose) => server.close(resolveClose));
  await runtime.stop();
  clearTimeout(force);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('uncaughtException', (error) => {
  console.error(error);
  void shutdown(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  void shutdown(1);
});
