import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    output[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(base?.[key] ?? {}, value)
      : value;
  }
  return output;
}

function readPath(object, path) {
  return String(path ?? '').split('.').filter(Boolean).reduce((value, key) => value?.[key], object);
}

function loadSecretValues(path) {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Secret file is invalid: ${path}`, { cause: error });
  }
}

function resolveModelSecrets(config) {
  const secretFile = resolve(config.security.secretFile ?? join(config.home, 'secrets.json'));
  const secrets = loadSecretValues(secretFile);
  const models = Object.fromEntries(Object.entries(config.models ?? {}).map(([key, model]) => {
    const environmentValue = model.apiKeyEnv ? process.env[model.apiKeyEnv] : null;
    const referencedValue = model.apiKeyRef ? readPath(secrets, model.apiKeyRef) : null;
    return [key, {
      ...model,
      apiKey: environmentValue ?? referencedValue ?? model.apiKey ?? null,
    }];
  }));
  const gatewayAuth = config.gateway.auth ?? {};
  const gatewayToken = (gatewayAuth.tokenEnv ? process.env[gatewayAuth.tokenEnv] : null)
    ?? (gatewayAuth.tokenRef ? readPath(secrets, gatewayAuth.tokenRef) : null)
    ?? gatewayAuth.token
    ?? null;
  return {
    ...config,
    gateway: { ...config.gateway, auth: { ...gatewayAuth, token: gatewayToken } },
    security: { ...config.security, secretFile },
    models,
  };
}

export function serializableConfig(config) {
  const output = structuredClone(config);
  delete output.configPath;
  if (output.gateway?.auth) delete output.gateway.auth.token;
  for (const model of Object.values(output.models ?? {})) delete model.apiKey;
  return output;
}

export function defaultConfig({ projectRoot = process.cwd(), home } = {}) {
  const stateHome = resolve(home ?? process.env.AGENT_OS_HOME ?? join(projectRoot, 'data'));
  return {
    version: 1,
    home: stateHome,
    database: resolve(process.env.AGENT_DB ?? join(stateHome, 'agent-os.db')),
    gateway: {
      bind: process.env.AGENT_GATEWAY_BIND ?? '127.0.0.1',
      port: Number(process.env.PORT ?? 3030),
      auth: {
        token: process.env.AGENT_GATEWAY_TOKEN ?? null,
        tokenEnv: 'AGENT_GATEWAY_TOKEN',
        tokenRef: null,
      },
      rateLimit: { windowMs: 60_000, maxWrites: 120 },
    },
    runtime: {
      maxConcurrency: Number(process.env.AGENT_CONCURRENCY ?? 4),
      tickMs: Number(process.env.AGENT_TICK_MS ?? 200),
      leaseMs: Number(process.env.AGENT_LEASE_MS ?? 30_000),
      maxStepsPerTurn: 6,
    },
    kernel: {
      heartbeatMs: 1_000,
      serviceTimeoutMs: 15_000,
      housekeepingMs: 200,
      interruptPollMs: 100,
      preemptionPriority: 90,
    },
    sensing: {
      enabled: true,
      pulseMs: 5_000,
      monitorConcurrency: 2,
      defaultInboxMonitor: true,
      inboxPollMs: 3_000,
    },
    cognition: {
      enabled: true,
      autoReflect: false,
      requireModel: true,
      idleAfterMs: 300_000,
      intervalMs: 1_800_000,
      dailyGoalBudget: 4,
      attentionThreshold: 35,
      criticalThreshold: 75,
      deadlineHorizonMs: 3_600_000,
      blockedAfterMs: 900_000,
      estimatedReflectionCostUsd: 0.02,
      valuePerPointUsd: 0.001,
      weights: { deadline: 35, drift: 20, observation: 15, conflict: 20, blocked: 20 },
    },
    resources: {
      goalDefaults: {
        maxInputTokens: 120_000,
        maxOutputTokens: 40_000,
        maxCostUsd: 5,
        maxToolCalls: 100,
        maxWallTimeMs: 3_600_000,
        maxContextChars: 100_000,
        maxFanOut: 8,
        maxDepth: 3,
      },
      globalDaily: { maxTokens: 2_000_000, maxCostUsd: 50, maxToolCalls: 2_000 },
      agentDaily: { maxTokens: 500_000, maxCostUsd: 15, maxToolCalls: 500 },
      pools: {
        default: 4,
        memory: 4,
        filesystem: 4,
        network: 3,
        browser: 1,
        code: 2,
        'isolated-side-effects': 1,
      },
    },
    operations: { reconcileIntervalMs: 30_000, maxReconcileAttempts: 12 },
    session: { dmScope: 'per-channel-peer', maxContextMessages: 40, maxContextChars: 100_000 },
    memory: { maxRecallEntries: 8, maxEntryChars: 12_000, captureMode: 'explicit' },
    security: {
      tenantId: 'default',
      secretFile: join(stateHome, 'secrets.json'),
      approvalRisk: 'high',
      allowRemoteWithoutAuth: false,
      allowLocalBypass: true,
      pluginPaths: [],
      tools: { allow: ['*'], deny: [] },
      capabilities: {
        tools: ['*'],
        resourcePools: ['*'],
        filesystem: { roots: ['.'], operations: ['list', 'read', 'write', 'delete'] },
        network: { domains: ['*'], methods: ['GET'] },
        accounts: { channel: ['*'] },
        dataScopes: ['agent:self'],
        credentialRefs: [],
        constraints: {},
      },
      events: {
        requireSignature: true,
        replayWindowMs: 300_000,
        sourceSecrets: {},
      },
    },
    agents: [{
      id: 'main',
      name: 'Personal Agent',
      workspace: join(stateHome, 'workspace'),
      model: 'default',
    }],
    models: {
      default: {
        provider: 'openai-compatible',
        baseUrl: process.env.AGENT_MODEL_BASE_URL ?? 'https://api.openai.com/v1',
        apiKey: process.env.AGENT_MODEL_API_KEY ?? process.env.OPENAI_API_KEY ?? null,
        apiKeyEnv: 'AGENT_MODEL_API_KEY',
        apiKeyRef: null,
        model: process.env.AGENT_MODEL_ID ?? 'gpt-4.1-mini',
        timeoutMs: Number(process.env.AGENT_MODEL_TIMEOUT_MS ?? 90_000),
        inputCostPerMillion: Number(process.env.AGENT_MODEL_INPUT_COST_PER_MILLION ?? 0),
        outputCostPerMillion: Number(process.env.AGENT_MODEL_OUTPUT_COST_PER_MILLION ?? 0),
      },
    },
    onboarding: { completedAt: null, version: null },
  };
}

export function loadConfig({ projectRoot = process.cwd(), home, configPath } = {}) {
  const defaults = defaultConfig({ projectRoot, home });
  const path = resolve(configPath ?? process.env.AGENT_OS_CONFIG ?? join(defaults.home, 'config.json'));
  if (!existsSync(path)) return resolveModelSecrets({ ...defaults, configPath: path });
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const config = merge(defaults, parsed);
  return resolveModelSecrets({ ...config, configPath: path });
}

export function writeDefaultConfig(path, options = {}) {
  const config = defaultConfig(options);
  writeConfigFile(path, config, { exclusive: true });
  return config;
}

export function writeConfigFile(path, config, { exclusive = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  if (exclusive && existsSync(path)) throw new Error(`Config already exists: ${path}`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(serializableConfig(config), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return path;
}

export function writeSecretFile(path, values) {
  mkdirSync(dirname(path), { recursive: true });
  const existing = loadSecretValues(path);
  const merged = merge(existing, values);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return path;
}

export function validateConfig(config) {
  const errors = [];
  if (!Array.isArray(config.agents) || config.agents.length === 0) errors.push('At least one agent must be configured');
  if (!Number.isInteger(config.gateway.port) || config.gateway.port < 1 || config.gateway.port > 65_535) errors.push('gateway.port is invalid');
  if (!Number.isInteger(config.runtime.maxConcurrency) || config.runtime.maxConcurrency < 1) errors.push('runtime.maxConcurrency must be greater than zero');
  if (!Number.isInteger(config.kernel.heartbeatMs) || config.kernel.heartbeatMs < 50) errors.push('kernel.heartbeatMs must be at least 50');
  if (!Number.isInteger(config.kernel.serviceTimeoutMs) || config.kernel.serviceTimeoutMs <= config.kernel.heartbeatMs) errors.push('kernel.serviceTimeoutMs must exceed kernel.heartbeatMs');
  if (!Number.isInteger(config.resources.goalDefaults.maxToolCalls) || config.resources.goalDefaults.maxToolCalls < 1) errors.push('resources.goalDefaults.maxToolCalls must be positive');
  if (!Number.isFinite(config.resources.goalDefaults.maxCostUsd) || config.resources.goalDefaults.maxCostUsd < 0) errors.push('resources.goalDefaults.maxCostUsd must be non-negative');
  const ids = new Set();
  for (const agent of config.agents ?? []) {
    if (!agent.id || !/^[a-z0-9][a-z0-9_-]*$/i.test(agent.id)) errors.push(`Invalid agent id: ${agent.id}`);
    if (ids.has(agent.id)) errors.push(`Duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
    if (!config.models[agent.model]) errors.push(`Agent ${agent.id} references unknown model ${agent.model}`);
  }
  for (const [name, model] of Object.entries(config.models ?? {})) {
    if (!['offline', 'openai-compatible'].includes(model.provider)) errors.push(`Model ${name} has an unsupported provider: ${model.provider}`);
    if (model.provider === 'openai-compatible' && !model.baseUrl) errors.push(`Model ${name} requires baseUrl`);
    if (!model.model) errors.push(`Model ${name} requires a model id`);
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.gateway.bind)
    && !config.gateway.auth.token
    && !config.security.allowRemoteWithoutAuth) {
    errors.push('A non-loopback gateway must have an authentication token');
  }
  return errors;
}
