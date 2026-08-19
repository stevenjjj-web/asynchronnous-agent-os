import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import {
  assertSecureRegularFile,
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  readPrivateTextFile,
} from './fs-safety.js';

export const SAFE_BUILTIN_TOOLS = Object.freeze([
  'memory_search', 'memory_remember', 'memory_confirm', 'plan_assume',
  'workspace_list', 'workspace_read', 'workspace_write',
  'request_user_input', 'wait_for_event', 'wait_for_channel', 'sleep',
  'spawn_goals', 'schedule_goal', 'goal_status', 'create_monitor',
  'monitor_status', 'kernel_status',
]);

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`Unsafe configuration key: ${key}`);
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
    assertSecureRegularFile(path);
    return JSON.parse(readPrivateTextFile(path));
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
    if (model.apiKeyRef && referencedValue == null) {
      throw new Error(`Configured secret reference is unresolved: models.${key}.apiKeyRef -> ${model.apiKeyRef}`);
    }
    return [key, {
      ...model,
      apiKey: environmentValue ?? referencedValue ?? model.apiKey ?? null,
    }];
  }));
  const gatewayAuth = config.gateway.auth ?? {};
  const referencedGatewayToken = gatewayAuth.tokenRef ? readPath(secrets, gatewayAuth.tokenRef) : null;
  if (gatewayAuth.tokenRef && referencedGatewayToken == null) {
    throw new Error(`Configured secret reference is unresolved: gateway.auth.tokenRef -> ${gatewayAuth.tokenRef}`);
  }
  const gatewayToken = (gatewayAuth.tokenEnv ? process.env[gatewayAuth.tokenEnv] : null)
    ?? referencedGatewayToken
    ?? gatewayAuth.token
    ?? null;
  const portability = config.memory?.portability ?? {};
  const signer = portability.signer ? { ...portability.signer } : null;
  if (signer) {
    const referencedValue = signer.privateKeyRef ? readPath(secrets, signer.privateKeyRef) : null;
    if (signer.privateKeyRef && referencedValue == null) {
      throw new Error(`Configured secret reference is unresolved: memory.portability.signer.privateKeyRef -> ${signer.privateKeyRef}`);
    }
    signer.privateKey = (signer.privateKeyEnv ? process.env[signer.privateKeyEnv] : null)
      ?? referencedValue
      ?? signer.privateKey
      ?? null;
    if (!signer.privateKey) throw new Error(`Memory signer ${signer.id ?? 'unknown'} has no resolved private key`);
  }
  const trustedSigners = Object.fromEntries(Object.entries(portability.trustedSigners ?? {}).map(([id, signerConfig]) => {
    const referencedValue = signerConfig.publicKeyRef ? readPath(secrets, signerConfig.publicKeyRef) : null;
    if (signerConfig.publicKeyRef && referencedValue == null) {
      throw new Error(`Configured secret reference is unresolved: memory.portability.trustedSigners.${id}.publicKeyRef -> ${signerConfig.publicKeyRef}`);
    }
    const publicKey = (signerConfig.publicKeyEnv ? process.env[signerConfig.publicKeyEnv] : null)
      ?? referencedValue
      ?? signerConfig.publicKey
      ?? null;
    if (!publicKey) throw new Error(`Trusted memory signer ${id} has no resolved public key`);
    return [id, { ...signerConfig, publicKey }];
  }));
  const memoryProviders = Object.fromEntries(Object.entries(portability.providers ?? {}).map(([id, provider]) => {
    const referencedValue = provider.tokenRef ? readPath(secrets, provider.tokenRef) : null;
    if (provider.tokenRef && referencedValue == null) {
      throw new Error(`Configured secret reference is unresolved: memory.portability.providers.${id}.tokenRef -> ${provider.tokenRef}`);
    }
    return [id, {
      ...provider,
      token: (provider.tokenEnv ? process.env[provider.tokenEnv] : null) ?? referencedValue ?? provider.token ?? null,
    }];
  }));
  const memoryEncryption = portability.encryption ?? {};
  const encryptionKeys = Object.fromEntries(Object.entries(memoryEncryption.keys ?? {}).map(([id, keyConfig]) => {
    const referencedValue = keyConfig.keyRef ? readPath(secrets, keyConfig.keyRef) : null;
    if (keyConfig.keyRef && referencedValue == null) {
      throw new Error(`Configured secret reference is unresolved: memory.portability.encryption.keys.${id}.keyRef -> ${keyConfig.keyRef}`);
    }
    const key = (keyConfig.keyEnv ? process.env[keyConfig.keyEnv] : null)
      ?? referencedValue
      ?? keyConfig.key
      ?? null;
    if (!key) throw new Error(`Memory encryption key ${id} is unresolved`);
    return [id, { ...keyConfig, key }];
  }));
  return {
    ...config,
    gateway: { ...config.gateway, auth: { ...gatewayAuth, token: gatewayToken } },
    security: { ...config.security, secretFile },
    models,
    memory: {
      ...config.memory,
      portability: {
        ...portability,
        signer,
        trustedSigners,
        providers: memoryProviders,
        encryption: { ...memoryEncryption, keys: encryptionKeys },
      },
    },
  };
}

export function serializableConfig(config) {
  const output = structuredClone(config);
  delete output.configPath;
  if (output.gateway?.auth) delete output.gateway.auth.token;
  for (const model of Object.values(output.models ?? {})) delete model.apiKey;
  if (output.memory?.portability?.signer) delete output.memory.portability.signer.privateKey;
  for (const signer of Object.values(output.memory?.portability?.trustedSigners ?? {})) {
    if (signer.publicKeyEnv || signer.publicKeyRef) delete signer.publicKey;
  }
  for (const provider of Object.values(output.memory?.portability?.providers ?? {})) delete provider.token;
  for (const key of Object.values(output.memory?.portability?.encryption?.keys ?? {})) delete key.key;
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
      rateLimit: {
        windowMs: 60_000,
        maxRequests: 600,
        maxWrites: 120,
        maxEntries: 10_000,
        authMaxAttempts: 10,
        authLockoutMs: 300_000,
      },
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
    session: { dmScope: 'per-channel-peer', maxContextMessages: 40, maxContextChars: 100_000, maxMessageChars: 200_000 },
    memory: {
      maxRecallEntries: 8,
      maxEntryChars: 12_000,
      captureMode: 'explicit',
      portability: {
        pollMs: 30_000,
        maxConcurrentSyncs: 2,
        maxSyncHistory: 5_000,
        maxBundleBytes: 4_000_000,
        maxEntries: 5_000,
        maxImportedConfidence: 0.6,
        requireSignatureForRemote: true,
        encryption: {
          requireForRemote: true,
          activeKeyId: null,
          keys: {},
        },
        signer: null,
        trustedSigners: {},
        providers: {},
      },
    },
    security: {
      tenantId: 'default',
      secretFile: join(stateHome, 'secrets.json'),
      approvalRisk: 'medium',
      allowRemoteWithoutAuth: false,
      allowLocalBypass: false,
      pluginPaths: [],
      plugins: { failClosed: true, allowIds: [], requirePrivateFiles: true },
      tools: { allow: [...SAFE_BUILTIN_TOOLS], deny: [] },
      capabilities: {
        tools: [...SAFE_BUILTIN_TOOLS],
        resourcePools: ['default', 'memory', 'filesystem'],
        filesystem: { roots: ['.'], operations: ['list', 'read', 'write'] },
        network: { domains: [], methods: [] },
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
        allowPrivateNetwork: false,
        inputCostPerMillion: Number(process.env.AGENT_MODEL_INPUT_COST_PER_MILLION ?? 0),
        outputCostPerMillion: Number(process.env.AGENT_MODEL_OUTPUT_COST_PER_MILLION ?? 0),
      },
    },
    onboarding: { completedAt: null, version: null },
  };
}

export function loadConfig({ projectRoot = process.cwd(), home, configPath } = {}) {
  const defaults = defaultConfig({ projectRoot, home });
  ensurePrivateDirectory(defaults.home);
  const path = resolve(configPath ?? process.env.AGENT_OS_CONFIG ?? join(defaults.home, 'config.json'));
  if (!existsSync(path)) return resolveModelSecrets({ ...defaults, configPath: path });
  assertSecureRegularFile(path);
  const parsed = JSON.parse(readPrivateTextFile(path));
  const config = merge(defaults, parsed);
  return resolveModelSecrets({ ...config, configPath: path });
}

export function writeDefaultConfig(path, options = {}) {
  const config = defaultConfig(options);
  writeConfigFile(path, config, { exclusive: true });
  return config;
}

export function writeConfigFile(path, config, { exclusive = false } = {}) {
  ensurePrivateDirectory(dirname(path));
  if (exclusive && existsSync(path)) throw new Error(`Config already exists: ${path}`);
  return atomicWritePrivateFile(path, `${JSON.stringify(serializableConfig(config), null, 2)}\n`);
}

export function writeSecretFile(path, values) {
  ensurePrivateDirectory(dirname(path));
  const existing = loadSecretValues(path);
  const merged = merge(existing, values);
  return atomicWritePrivateFile(path, `${JSON.stringify(merged, null, 2)}\n`);
}

export function validateConfig(config) {
  const errors = [];
  const stringList = (value, name, maximum = 1_000) => {
    if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== 'string' || !item || item.length > 512)) {
      errors.push(`${name} must be an array of at most ${maximum} non-empty strings`);
    }
  };
  const positiveInteger = (value, name, minimum = 1) => {
    if (!Number.isInteger(value) || value < minimum) errors.push(`${name} must be an integer of at least ${minimum}`);
  };
  const nonNegativeNumber = (value, name) => {
    if (!Number.isFinite(value) || value < 0) errors.push(`${name} must be a non-negative number`);
  };
  if (!Array.isArray(config.agents) || config.agents.length === 0) errors.push('At least one agent must be configured');
  if (!Number.isInteger(config.gateway.port) || config.gateway.port < 1 || config.gateway.port > 65_535) errors.push('gateway.port is invalid');
  if (config.gateway.bind !== 'localhost' && !isIP(config.gateway.bind)) errors.push('gateway.bind must be localhost or an IP address');
  if (!Number.isInteger(config.runtime.maxConcurrency) || config.runtime.maxConcurrency < 1) errors.push('runtime.maxConcurrency must be greater than zero');
  positiveInteger(config.runtime.tickMs, 'runtime.tickMs', 10);
  positiveInteger(config.runtime.leaseMs, 'runtime.leaseMs', 100);
  positiveInteger(config.runtime.maxStepsPerTurn, 'runtime.maxStepsPerTurn');
  if (!Number.isInteger(config.kernel.heartbeatMs) || config.kernel.heartbeatMs < 50) errors.push('kernel.heartbeatMs must be at least 50');
  if (!Number.isInteger(config.kernel.serviceTimeoutMs) || config.kernel.serviceTimeoutMs <= config.kernel.heartbeatMs) errors.push('kernel.serviceTimeoutMs must exceed kernel.heartbeatMs');
  if (!Number.isInteger(config.resources.goalDefaults.maxToolCalls) || config.resources.goalDefaults.maxToolCalls < 1) errors.push('resources.goalDefaults.maxToolCalls must be positive');
  if (!Number.isFinite(config.resources.goalDefaults.maxCostUsd) || config.resources.goalDefaults.maxCostUsd < 0) errors.push('resources.goalDefaults.maxCostUsd must be non-negative');
  for (const [name, value] of Object.entries(config.resources.goalDefaults ?? {})) nonNegativeNumber(value, `resources.goalDefaults.${name}`);
  for (const [scope, values] of Object.entries({ globalDaily: config.resources.globalDaily, agentDaily: config.resources.agentDaily })) {
    for (const [name, value] of Object.entries(values ?? {})) nonNegativeNumber(value, `resources.${scope}.${name}`);
  }
  for (const [name, value] of Object.entries(config.resources.pools ?? {})) positiveInteger(value, `resources.pools.${name}`);
  const ids = new Set();
  for (const agent of config.agents ?? []) {
    if (!agent.id || String(agent.id).length > 128 || !/^[a-z0-9][a-z0-9_-]*$/i.test(agent.id)) errors.push(`Invalid agent id: ${agent.id}`);
    if (ids.has(agent.id)) errors.push(`Duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
    if (typeof agent.name !== 'string' || !agent.name || agent.name.length > 256) errors.push(`Agent ${agent.id} has an invalid name`);
    if (typeof agent.workspace !== 'string' || !agent.workspace || agent.workspace.length > 4_096) errors.push(`Agent ${agent.id} has an invalid workspace`);
    if (!config.models[agent.model]) errors.push(`Agent ${agent.id} references unknown model ${agent.model}`);
  }
  for (const [name, model] of Object.entries(config.models ?? {})) {
    if (!['offline', 'openai-compatible'].includes(model.provider)) errors.push(`Model ${name} has an unsupported provider: ${model.provider}`);
    if (model.provider === 'openai-compatible' && !model.baseUrl) errors.push(`Model ${name} requires baseUrl`);
    if (model.provider === 'openai-compatible' && model.baseUrl) {
      try {
        const endpoint = new URL(model.baseUrl);
        const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname);
        if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && isLoopback)) {
          errors.push(`Model ${name} must use HTTPS unless it is a loopback endpoint`);
        }
        if (endpoint.username || endpoint.password) errors.push(`Model ${name} baseUrl must not contain credentials`);
        if (endpoint.search || endpoint.hash) errors.push(`Model ${name} baseUrl must not contain a query string or fragment`);
        if (endpoint.protocol === 'https:' && endpoint.port && endpoint.port !== '443' && model.allowPrivateNetwork !== true) {
          errors.push(`Model ${name} requires allowPrivateNetwork for a non-standard HTTPS port`);
        }
      } catch {
        errors.push(`Model ${name} has an invalid baseUrl`);
      }
    }
    if (!model.model) errors.push(`Model ${name} requires a model id`);
    if (String(model.model ?? '').length > 256) errors.push(`Model ${name} id exceeds 256 characters`);
    if (model.apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/i.test(model.apiKeyEnv)) errors.push(`Model ${name} has an invalid apiKeyEnv reference`);
    positiveInteger(model.timeoutMs ?? 90_000, `models.${name}.timeoutMs`, 100);
    if (model.allowPrivateNetwork != null && typeof model.allowPrivateNetwork !== 'boolean') errors.push(`models.${name}.allowPrivateNetwork must be a boolean`);
    nonNegativeNumber(model.inputCostPerMillion ?? 0, `models.${name}.inputCostPerMillion`);
    nonNegativeNumber(model.outputCostPerMillion ?? 0, `models.${name}.outputCostPerMillion`);
  }
  const loopbackGateway = ['127.0.0.1', '::1', 'localhost'].includes(config.gateway.bind);
  if (!loopbackGateway
    && !config.gateway.auth.token
    && !config.security.allowRemoteWithoutAuth) {
    errors.push('A non-loopback gateway must have an authentication token');
  }
  if (config.gateway.auth.token && Buffer.byteLength(config.gateway.auth.token) < 32) {
    errors.push('gateway authentication token must be at least 32 bytes');
  }
  if (config.gateway.auth.token && (Buffer.byteLength(config.gateway.auth.token) > 4_096 || /[\s\0]/u.test(config.gateway.auth.token))) {
    errors.push('gateway authentication token must not contain whitespace and must be at most 4096 bytes');
  }
  if (['change-me-now', 'change-me-to-a-long-random-token'].includes(config.gateway.auth.token)) {
    errors.push('gateway authentication token is a published placeholder and must be replaced');
  }
  if (!config.gateway.auth.token && !config.security.allowLocalBypass && !config.security.allowRemoteWithoutAuth) {
    errors.push('Gateway authentication is required; run agent-os setup to generate a token');
  }
  if (!Number.isInteger(config.gateway.rateLimit?.maxRequests) || config.gateway.rateLimit.maxRequests < 1) {
    errors.push('gateway.rateLimit.maxRequests must be a positive integer');
  }
  positiveInteger(config.gateway.rateLimit?.windowMs, 'gateway.rateLimit.windowMs', 1_000);
  positiveInteger(config.gateway.rateLimit?.maxWrites, 'gateway.rateLimit.maxWrites');
  positiveInteger(config.gateway.rateLimit?.authMaxAttempts, 'gateway.rateLimit.authMaxAttempts');
  positiveInteger(config.gateway.rateLimit?.authLockoutMs, 'gateway.rateLimit.authLockoutMs', 1_000);
  if (config.gateway.rateLimit?.maxWrites > config.gateway.rateLimit?.maxRequests) errors.push('gateway.rateLimit.maxWrites cannot exceed maxRequests');
  if (!Number.isInteger(config.gateway.rateLimit?.maxEntries) || config.gateway.rateLimit.maxEntries < 100) {
    errors.push('gateway.rateLimit.maxEntries must be at least 100');
  }
  if (!['medium', 'high', 'critical'].includes(config.security.approvalRisk)) {
    errors.push('security.approvalRisk must be medium, high, or critical');
  }
  if (!Array.isArray(config.security.pluginPaths)) errors.push('security.pluginPaths must be an array');
  else if (config.security.pluginPaths.some((path) => typeof path !== 'string' || !path || path.length > 4_096)) errors.push('security.pluginPaths contains an invalid path');
  stringList(config.security.plugins?.allowIds ?? [], 'security.plugins.allowIds');
  stringList(config.security.tools?.allow, 'security.tools.allow');
  stringList(config.security.tools?.deny, 'security.tools.deny');
  stringList(config.security.capabilities?.tools, 'security.capabilities.tools');
  stringList(config.security.capabilities?.resourcePools, 'security.capabilities.resourcePools');
  stringList(config.security.capabilities?.filesystem?.roots, 'security.capabilities.filesystem.roots');
  stringList(config.security.capabilities?.filesystem?.operations, 'security.capabilities.filesystem.operations');
  stringList(config.security.capabilities?.network?.domains, 'security.capabilities.network.domains');
  stringList(config.security.capabilities?.network?.methods, 'security.capabilities.network.methods');
  stringList(config.security.capabilities?.dataScopes, 'security.capabilities.dataScopes');
  stringList(config.security.capabilities?.credentialRefs, 'security.capabilities.credentialRefs');
  if ((config.security.capabilities?.filesystem?.operations ?? []).some((operation) => !['list', 'read', 'write', 'delete'].includes(operation))) {
    errors.push('security.capabilities.filesystem.operations contains an unsupported operation');
  }
  if ((config.security.capabilities?.network?.methods ?? []).some((method) => !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))) {
    errors.push('security.capabilities.network.methods contains an unsupported method');
  }
  positiveInteger(config.security.events?.replayWindowMs, 'security.events.replayWindowMs', 1_000);
  positiveInteger(config.session.maxContextMessages, 'session.maxContextMessages');
  positiveInteger(config.session.maxContextChars, 'session.maxContextChars', 1_000);
  positiveInteger(config.session.maxMessageChars, 'session.maxMessageChars', 1_000);
  positiveInteger(config.memory.maxRecallEntries, 'memory.maxRecallEntries');
  positiveInteger(config.memory.maxEntryChars, 'memory.maxEntryChars', 100);
  if (!['explicit'].includes(config.memory.captureMode)) errors.push('memory.captureMode must be explicit');
  const portability = config.memory.portability ?? {};
  positiveInteger(portability.pollMs, 'memory.portability.pollMs', 1_000);
  positiveInteger(portability.maxConcurrentSyncs, 'memory.portability.maxConcurrentSyncs');
  if (portability.maxConcurrentSyncs > 16) errors.push('memory.portability.maxConcurrentSyncs cannot exceed 16');
  positiveInteger(portability.maxSyncHistory, 'memory.portability.maxSyncHistory', 100);
  if (portability.maxSyncHistory > 100_000) errors.push('memory.portability.maxSyncHistory cannot exceed 100000');
  positiveInteger(portability.maxBundleBytes, 'memory.portability.maxBundleBytes', 1_024);
  if (portability.maxBundleBytes > 8_000_000) errors.push('memory.portability.maxBundleBytes cannot exceed 8000000');
  positiveInteger(portability.maxEntries, 'memory.portability.maxEntries');
  if (portability.maxEntries > 10_000) errors.push('memory.portability.maxEntries cannot exceed 10000');
  if (!Number.isFinite(portability.maxImportedConfidence) || portability.maxImportedConfidence < 0 || portability.maxImportedConfidence > 1) {
    errors.push('memory.portability.maxImportedConfidence must be between 0 and 1');
  }
  if (typeof portability.requireSignatureForRemote !== 'boolean') {
    errors.push('memory.portability.requireSignatureForRemote must be a boolean');
  }
  const encryption = portability.encryption ?? {};
  if (typeof encryption.requireForRemote !== 'boolean') {
    errors.push('memory.portability.encryption.requireForRemote must be a boolean');
  }
  if (encryption.activeKeyId != null && (
    typeof encryption.activeKeyId !== 'string'
    || !/^[a-z0-9][a-z0-9._-]*$/i.test(encryption.activeKeyId)
    || encryption.activeKeyId.length > 128
  )) {
    errors.push('memory.portability.encryption.activeKeyId is invalid');
  }
  for (const [id, keyConfig] of Object.entries(encryption.keys ?? {})) {
    if (!id || id.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) errors.push(`Memory encryption key id is invalid: ${id}`);
    if (!keyConfig.key) {
      errors.push(`Memory encryption key ${id} is unresolved`);
    } else {
      const text = String(keyConfig.key).trim();
      if (!/^[a-f0-9]{64}$/i.test(text)) {
        const validBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0;
        const decoded = validBase64 ? Buffer.from(text, 'base64') : Buffer.alloc(0);
        if (decoded.length !== 32 || decoded.toString('base64') !== text) {
          errors.push(`Memory encryption key ${id} must contain exactly 32 bytes in canonical base64 or hex`);
        }
      }
    }
    if (keyConfig.keyEnv && !/^[A-Z_][A-Z0-9_]*$/i.test(keyConfig.keyEnv)) {
      errors.push(`Memory encryption key ${id} keyEnv is invalid`);
    }
  }
  if (encryption.activeKeyId && !encryption.keys?.[encryption.activeKeyId]) {
    errors.push('memory.portability.encryption.activeKeyId must reference a configured key');
  }
  if (portability.signer) {
    if (!portability.signer.id || String(portability.signer.id).length > 128 || !/^[a-z0-9][a-z0-9._-]*$/i.test(portability.signer.id)) {
      errors.push('memory.portability.signer.id is invalid');
    }
    if (!portability.signer.privateKey) errors.push('memory.portability.signer private key is unresolved');
    if (portability.signer.privateKeyEnv && !/^[A-Z_][A-Z0-9_]*$/i.test(portability.signer.privateKeyEnv)) {
      errors.push('memory.portability.signer.privateKeyEnv is invalid');
    }
  }
  for (const [id, signer] of Object.entries(portability.trustedSigners ?? {})) {
    if (!id || id.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) errors.push(`Trusted memory signer id is invalid: ${id}`);
    if (!signer.publicKey) errors.push(`Trusted memory signer ${id} public key is unresolved`);
    if (signer.publicKeyEnv && !/^[A-Z_][A-Z0-9_]*$/i.test(signer.publicKeyEnv)) {
      errors.push(`Trusted memory signer ${id} publicKeyEnv is invalid`);
    }
  }
  for (const [id, provider] of Object.entries(portability.providers ?? {})) {
    if (!id || id.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) errors.push(`Memory provider id is invalid: ${id}`);
    if (!['file', 'directory-cas', 'https', 'https-cas'].includes(provider.type)) {
      errors.push(`Memory provider ${id} has an unsupported type`);
      continue;
    }
    if (['file', 'directory-cas'].includes(provider.type)) {
      if (typeof provider.path !== 'string' || !provider.path || provider.path.length > 4_096 || provider.path.includes('\0')) {
        errors.push(`Memory provider ${id} path is invalid`);
      }
    } else {
      try {
        const url = new URL(provider.url);
        if (url.username || url.password || url.hash || url.search) errors.push(`Memory provider ${id} URL cannot contain credentials, query parameters, or fragments`);
        if (url.protocol !== 'https:' && !(provider.allowPrivateNetwork === true && url.protocol === 'http:')) {
          errors.push(`Memory provider ${id} must use HTTPS unless private-network access is explicit`);
        }
        if (url.protocol === 'https:' && url.port && url.port !== '443' && provider.allowPrivateNetwork !== true) {
          errors.push(`Memory provider ${id} requires allowPrivateNetwork for a non-standard HTTPS port`);
        }
      } catch {
        errors.push(`Memory provider ${id} URL is invalid`);
      }
      if (provider.push !== false && !portability.signer) errors.push(`Remote memory provider ${id} requires a configured signer for push`);
    }
    if (provider.tokenEnv && !/^[A-Z_][A-Z0-9_]*$/i.test(provider.tokenEnv)) errors.push(`Memory provider ${id} tokenEnv is invalid`);
    if (provider.token && (typeof provider.token !== 'string' || provider.token.length > 8_192 || provider.token.includes('\0'))) {
      errors.push(`Memory provider ${id} token is invalid`);
    }
    if (provider.pull != null && typeof provider.pull !== 'boolean') errors.push(`Memory provider ${id} pull must be a boolean`);
    if (provider.push != null && typeof provider.push !== 'boolean') errors.push(`Memory provider ${id} push must be a boolean`);
    if (provider.pushMethod && !['POST', 'PUT'].includes(provider.pushMethod)) errors.push(`Memory provider ${id} pushMethod must be POST or PUT`);
    if (provider.timeoutMs != null) {
      positiveInteger(provider.timeoutMs, `memory.portability.providers.${id}.timeoutMs`, 100);
      if (provider.timeoutMs >= config.kernel.serviceTimeoutMs) errors.push(`Memory provider ${id} timeoutMs must be lower than kernel.serviceTimeoutMs`);
    }
    for (const direction of ['pull', 'push']) {
      const interval = provider[`${direction}IntervalMs`];
      if (interval != null) positiveInteger(interval, `memory.portability.providers.${id}.${direction}IntervalMs`, 60_000);
    }
    if (provider.pullIntervalMs && provider.type.endsWith('-cas')) {
      errors.push(`Content-addressed memory provider ${id} cannot auto-pull without an explicit digest`);
    }
    if (provider.autoActivate != null && typeof provider.autoActivate !== 'boolean') errors.push(`Memory provider ${id} autoActivate must be a boolean`);
    if (provider.allowPrivateNetwork != null && typeof provider.allowPrivateNetwork !== 'boolean') {
      errors.push(`Memory provider ${id} allowPrivateNetwork must be a boolean`);
    }
  }
  const hasRemoteMemoryPull = Object.values(portability.providers ?? {})
    .some((provider) => ['https', 'https-cas'].includes(provider.type) && provider.pull !== false);
  const hasRemoteMemoryPush = Object.values(portability.providers ?? {})
    .some((provider) => ['https', 'https-cas'].includes(provider.type) && provider.push !== false);
  if (hasRemoteMemoryPull && portability.requireSignatureForRemote && !Object.keys(portability.trustedSigners ?? {}).length) {
    errors.push('Remote memory pull requires at least one trusted signer');
  }
  if (hasRemoteMemoryPull && encryption.requireForRemote && !Object.keys(encryption.keys ?? {}).length) {
    errors.push('Encrypted remote memory pull requires at least one decryption key');
  }
  if (hasRemoteMemoryPush && encryption.requireForRemote && !encryption.activeKeyId) {
    errors.push('Encrypted remote memory push requires an active encryption key');
  }
  positiveInteger(config.sensing.pulseMs, 'sensing.pulseMs', 100);
  positiveInteger(config.sensing.monitorConcurrency, 'sensing.monitorConcurrency');
  positiveInteger(config.sensing.inboxPollMs, 'sensing.inboxPollMs', 1_000);
  positiveInteger(config.operations.reconcileIntervalMs, 'operations.reconcileIntervalMs', 1_000);
  positiveInteger(config.operations.maxReconcileAttempts, 'operations.maxReconcileAttempts');
  for (const [source, locator] of Object.entries(config.security.events?.sourceSecrets ?? {})) {
    if (!source || source.length > 256) errors.push('Event authentication source names must contain 1 to 256 characters');
    if (typeof locator !== 'string' || !/^env:[A-Z_][A-Z0-9_]*$/i.test(locator)) errors.push(`Event source ${source} must use an env: secret reference`);
  }
  return errors;
}
