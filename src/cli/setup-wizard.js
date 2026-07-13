import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { writeConfigFile, writeSecretFile } from '../platform/config.js';
import { owlArt, MASCOT_TAGLINE } from './mascot.js';

export const MODEL_PRESETS = Object.freeze({
  openai: {
    label: 'OpenAI',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    envName: 'OPENAI_API_KEY',
  },
  openrouter: {
    label: 'OpenRouter',
    provider: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4.1-mini',
    envName: 'OPENROUTER_API_KEY',
  },
  deepseek: {
    label: 'DeepSeek',
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    envName: 'DEEPSEEK_API_KEY',
  },
  custom: {
    label: 'Custom OpenAI-compatible endpoint',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'local-model',
    envName: 'AGENT_MODEL_API_KEY',
  },
  offline: {
    label: 'Offline mode',
    provider: 'offline',
    baseUrl: null,
    model: 'offline',
    envName: null,
  },
});

export const BUDGET_PROFILES = Object.freeze({
  safe: {
    label: 'Safe',
    goalDefaults: {
      maxInputTokens: 40_000, maxOutputTokens: 8_000, maxCostUsd: 1,
      maxToolCalls: 30, maxWallTimeMs: 1_800_000, maxContextChars: 60_000,
      maxFanOut: 3, maxDepth: 2,
    },
    globalDaily: { maxTokens: 500_000, maxCostUsd: 10, maxToolCalls: 500 },
    agentDaily: { maxTokens: 200_000, maxCostUsd: 5, maxToolCalls: 200 },
  },
  balanced: {
    label: 'Balanced',
    goalDefaults: {
      maxInputTokens: 120_000, maxOutputTokens: 40_000, maxCostUsd: 5,
      maxToolCalls: 100, maxWallTimeMs: 3_600_000, maxContextChars: 100_000,
      maxFanOut: 8, maxDepth: 3,
    },
    globalDaily: { maxTokens: 2_000_000, maxCostUsd: 50, maxToolCalls: 2_000 },
    agentDaily: { maxTokens: 500_000, maxCostUsd: 15, maxToolCalls: 500 },
  },
  power: {
    label: 'Power',
    goalDefaults: {
      maxInputTokens: 300_000, maxOutputTokens: 100_000, maxCostUsd: 20,
      maxToolCalls: 300, maxWallTimeMs: 14_400_000, maxContextChars: 180_000,
      maxFanOut: 16, maxDepth: 5,
    },
    globalDaily: { maxTokens: 8_000_000, maxCostUsd: 200, maxToolCalls: 8_000 },
    agentDaily: { maxTokens: 2_000_000, maxCostUsd: 75, maxToolCalls: 2_000 },
  },
});

function userPath(value) {
  const expanded = String(value).startsWith('~/') ? `${homedir()}/${String(value).slice(2)}` : value;
  return resolve(expanded);
}

export function buildSetupConfiguration(current, answers, timestamp = Date.now()) {
  const config = structuredClone(current);
  const preset = MODEL_PRESETS[answers.modelPreset];
  const profile = BUDGET_PROFILES[answers.budgetProfile];
  if (!preset) throw new Error(`Unknown model preset: ${answers.modelPreset}`);
  if (!profile) throw new Error(`Unknown budget profile: ${answers.budgetProfile}`);
  config.agents[0] = {
    ...config.agents[0],
    name: answers.agentName,
    workspace: userPath(answers.workspace),
    model: 'default',
  };
  const networkAccess = answers.accessProfile === 'network';
  config.gateway = {
    ...config.gateway,
    bind: networkAccess ? '0.0.0.0' : '127.0.0.1',
    auth: {
      ...config.gateway.auth,
      token: null,
      tokenEnv: null,
      tokenRef: networkAccess ? 'gateway.auth.token' : null,
    },
  };
  config.models.default = {
    ...config.models.default,
    provider: preset.provider,
    baseUrl: answers.baseUrl ?? preset.baseUrl,
    model: answers.modelId ?? preset.model,
    apiKeyEnv: answers.secretMode === 'environment' ? answers.apiKeyEnv : null,
    apiKeyRef: answers.secretMode === 'file' ? 'model.default.apiKey' : null,
  };
  config.resources = {
    ...config.resources,
    goalDefaults: { ...profile.goalDefaults },
    globalDaily: { ...profile.globalDaily },
    agentDaily: { ...profile.agentDaily },
  };
  config.cognition = {
    ...config.cognition,
    enabled: true,
    autoReflect: answers.autonomy === 'assist',
  };
  config.memory = {
    ...config.memory,
    captureMode: 'explicit',
  };
  config.security = {
    ...config.security,
    approvalRisk: answers.approvalRisk ?? 'high',
  };
  config.onboarding = {
    completedAt: timestamp,
    version: 1,
    budgetProfile: answers.budgetProfile,
    autonomy: answers.autonomy,
  };
  return config;
}

async function ask(input, output, format, question, fallback) {
  const rl = createInterface({ input, output, terminal: true });
  try {
    const suffix = fallback === undefined ? ' ' : ` ${format.dim(`[${fallback}]`)} `;
    const answer = (await rl.question(`${format.cyan('›')} ${question}${suffix}`)).trim();
    return answer || fallback || '';
  } finally {
    rl.close();
  }
}

async function choose(input, output, format, question, options, fallback = 1) {
  output.write(`\n${format.bold(question)}\n`);
  options.forEach((option, index) => output.write(`  ${format.cyan(index + 1)}  ${option.label}${option.description ? format.dim(` — ${option.description}`) : ''}\n`));
  const answer = await ask(input, output, format, 'Choose', String(fallback));
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= options.length) throw new Error(`Invalid selection: ${answer}`);
  return options[index].value;
}

export function askSecret(input, output, prompt = 'API key') {
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('Masked secret input requires a TTY');
  return new Promise((resolveSecret, reject) => {
    let value = '';
    const wasRaw = Boolean(input.isRaw);
    const finish = (error) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      output.write('\n');
      if (error) reject(error);
      else resolveSecret(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('Setup cancelled'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
        } else if (character >= ' ') {
          value += character;
          output.write('•');
        }
      }
    };
    output.write(`› ${prompt} `);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

export async function validateModelEndpoint({ baseUrl, apiKey, timeoutMs = 5_000 }) {
  if (!baseUrl) return { ok: true, skipped: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status, error: (await response.text()).slice(0, 300) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runSetupWizard({ currentConfig, input, output, format }) {
  if (!input.isTTY) throw new Error('Interactive setup requires a TTY');
  output.write('\u001b[2J\u001b[H');
  for (const line of owlArt({ phase: 0, compact: true })) output.write(`${format.cyan(line)}\n`);
  output.write(`\n${format.bold('Welcome to Agent OS')}\n${format.dim(`${MASCOT_TAGLINE}. Let us build a safe home for your persistent agent.`)}\n`);

  const acknowledged = await ask(input, output, format, 'Agent tools can affect files and external systems. Continue?', 'yes');
  if (!/^y(es)?$/i.test(acknowledged)) throw new Error('Setup cancelled');
  const agentName = await ask(input, output, format, 'Agent name', currentConfig.agents[0]?.name ?? 'Personal Agent');
  const workspace = await ask(input, output, format, 'Workspace', currentConfig.agents[0]?.workspace ?? `${currentConfig.home}/workspace`);
  const accessProfile = await choose(input, output, format, 'Gateway access', [
    { value: 'local', label: 'This computer only', description: 'Recommended; listens on localhost' },
    { value: 'network', label: 'Local network', description: 'Requires a generated bearer token' },
  ], ['0.0.0.0', '::'].includes(currentConfig.gateway.bind) ? 2 : 1);
  const gatewayToken = accessProfile === 'network'
    ? currentConfig.gateway.auth?.token ?? randomBytes(32).toString('hex')
    : null;
  const presetEntries = Object.entries(MODEL_PRESETS);
  const currentPresetIndex = presetEntries.findIndex(([, candidate]) => (
    candidate.provider === currentConfig.models.default?.provider
    && candidate.baseUrl === currentConfig.models.default?.baseUrl
  ));
  const modelPreset = await choose(input, output, format, 'Model provider', presetEntries.map(([value, preset]) => ({
    value, label: preset.label,
  })), currentPresetIndex >= 0 ? currentPresetIndex + 1 : 1);
  const preset = MODEL_PRESETS[modelPreset];
  const isCurrentPreset = currentPresetIndex >= 0 && presetEntries[currentPresetIndex][0] === modelPreset;
  let baseUrl = preset.baseUrl;
  let modelId = preset.model;
  let secretMode = 'none';
  let apiKeyEnv = null;
  let enteredApiKey = null;
  if (preset.provider !== 'offline') {
    baseUrl = await ask(input, output, format, 'API base URL', isCurrentPreset ? currentConfig.models.default?.baseUrl : preset.baseUrl);
    modelId = await ask(input, output, format, 'Model ID', isCurrentPreset ? currentConfig.models.default?.model : preset.model);
    secretMode = await choose(input, output, format, 'API credential', [
      { value: 'environment', label: 'Environment reference', description: 'No secret is written by Agent OS' },
      { value: 'file', label: 'Private local secret', description: 'Masked input, stored separately with mode 0600' },
      { value: 'none', label: 'No key', description: 'For a trusted local endpoint without authentication' },
    ], process.env[preset.envName] ? 1 : 2);
    if (secretMode === 'environment') {
      apiKeyEnv = await ask(input, output, format, 'Environment variable', preset.envName);
    } else if (secretMode === 'file') {
      enteredApiKey = await askSecret(input, output, 'API key (hidden)');
      if (!enteredApiKey && !currentConfig.models.default?.apiKeyRef) throw new Error('API key is required');
    }
  }
  const budgetProfile = await choose(input, output, format, 'Resource policy', [
    { value: 'safe', label: 'Safe', description: 'Small budgets and limited fan-out' },
    { value: 'balanced', label: 'Balanced', description: 'Recommended personal-agent defaults' },
    { value: 'power', label: 'Power', description: 'Long research and larger parallel plans' },
  ], 2);
  const autonomy = await choose(input, output, format, 'Background cognition', [
    { value: 'observe', label: 'Observe only', description: 'Stay alive and sense events without autonomous model spend' },
    { value: 'assist', label: 'Attention assist', description: 'Create bounded reflections when expected value is high' },
  ], 1);
  const approvalRisk = await choose(input, output, format, 'Side-effect approvals', [
    { value: 'medium', label: 'Cautious', description: 'Ask before medium- and high-risk effects' },
    { value: 'high', label: 'Standard', description: 'Ask before high-risk effects' },
  ], currentConfig.security.approvalRisk === 'medium' ? 1 : 2);
  const startGatewayAnswer = await ask(input, output, format, 'Start the resident Gateway after setup?', 'yes');
  const answers = {
    agentName, workspace, accessProfile, modelPreset, baseUrl, modelId,
    secretMode, apiKeyEnv, budgetProfile, autonomy, approvalRisk,
  };
  const nextConfig = buildSetupConfiguration(currentConfig, answers);

  let validation = { ok: true, skipped: true };
  if (preset.provider !== 'offline') {
    const shouldTest = await ask(input, output, format, 'Test the provider before saving?', 'yes');
    if (/^y(es)?$/i.test(shouldTest)) {
      const apiKey = secretMode === 'environment'
        ? process.env[apiKeyEnv]
        : secretMode === 'file'
          ? enteredApiKey ?? currentConfig.models.default?.apiKey
          : null;
      output.write(format.dim('  Checking /models…\n'));
      validation = await validateModelEndpoint({ baseUrl, apiKey });
      output.write(validation.ok
        ? `${format.green('  ✓ Provider reachable')}\n`
        : `${format.yellow('  ! Provider check was inconclusive')} ${format.dim(validation.error ?? `HTTP ${validation.status}`)}\n`);
    }
  }
  output.write(`\n${format.bold('Setup summary')}\n`);
  output.write(`  Agent       ${agentName}\n  Model       ${preset.label} · ${modelId}\n  Workspace   ${nextConfig.agents[0].workspace}\n  Access      ${accessProfile === 'network' ? 'local network · bearer token protected' : 'this computer only'}\n  Resources   ${BUDGET_PROFILES[budgetProfile].label}\n  Cognition   ${autonomy}\n  Approvals   ${approvalRisk}\n  Memory      explicit long-term capture\n`);
  const confirmed = await ask(input, output, format, 'Save this configuration?', 'yes');
  if (!/^y(es)?$/i.test(confirmed)) throw new Error('Setup cancelled');
  const secrets = {};
  if (enteredApiKey) secrets.model = { default: { apiKey: enteredApiKey } };
  if (gatewayToken) secrets.gateway = { auth: { token: gatewayToken } };
  if (Object.keys(secrets).length) writeSecretFile(nextConfig.security.secretFile, secrets);
  writeConfigFile(currentConfig.configPath, nextConfig);
  output.write(`\n${format.green('✓ Agent OS is configured')}\n${format.dim(`Config: ${currentConfig.configPath}`)}\n`);
  if (gatewayToken) output.write(`${format.dim(`Gateway bearer token: ${nextConfig.security.secretFile} → gateway.auth.token`)}\n`);
  return {
    config: nextConfig,
    startGateway: /^y(es)?$/i.test(startGatewayAnswer),
    validation,
  };
}

export async function runModelWizard({ currentConfig, input, output, format, initialPreset }) {
  if (!input.isTTY) throw new Error('Interactive model setup requires a TTY');
  output.write(`\n${format.bold('Add a model provider')}\n${format.dim('The new configuration is additive and will not replace unrelated Agent OS settings.')}\n`);
  const presetEntries = Object.entries(MODEL_PRESETS);
  const modelPreset = initialPreset ?? await choose(input, output, format, 'Model provider', presetEntries.map(([value, preset]) => ({
    value,
    label: preset.label,
  })), 1);
  if (!MODEL_PRESETS[modelPreset]) throw new Error(`Unknown model preset: ${modelPreset}`);
  const preset = MODEL_PRESETS[modelPreset];
  const suggestedKey = modelPreset === 'custom' ? 'custom' : modelPreset;
  const modelKey = await ask(input, output, format, 'Configuration key', suggestedKey);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(modelKey)) throw new Error('Model configuration keys may contain only letters, numbers, underscores, and hyphens');
  if (currentConfig.models[modelKey]) {
    const overwrite = await ask(input, output, format, `Replace existing models.${modelKey}?`, 'no');
    if (!/^y(es)?$/i.test(overwrite)) throw new Error('Model setup cancelled');
  }

  const existing = currentConfig.models[modelKey];
  let baseUrl = preset.baseUrl;
  let modelId = preset.model;
  let apiKeyEnv = null;
  let apiKeyRef = null;
  let enteredApiKey = null;
  let resolvedApiKey = null;
  if (preset.provider !== 'offline') {
    baseUrl = await ask(input, output, format, 'API base URL', existing?.baseUrl ?? preset.baseUrl);
    modelId = await ask(input, output, format, 'Initial model ID', existing?.model ?? preset.model);
    if (modelPreset === 'openai') {
      output.write(`\n${format.bold('OpenAI authentication')}\n`);
      output.write(`${format.dim('Use an OpenAI Platform project API key from https://platform.openai.com/api-keys.')}\n`);
      output.write(`${format.dim('This is not your ChatGPT password, and ChatGPT subscriptions do not include API usage.')}\n`);
    }
    const reusable = Object.values(currentConfig.models).find((model) => (
      model.provider === preset.provider && model.baseUrl === baseUrl && model.apiKey
    ));
    const detectedEnvironment = preset.envName && process.env[preset.envName] ? preset.envName : null;
    const credentialOptions = [
      ...(reusable ? [{ value: 'reuse', label: 'Reuse configured credential', description: 'Shares the existing secret reference for this endpoint' }] : []),
      ...(detectedEnvironment ? [{ value: 'detected', label: `Use ${detectedEnvironment}`, description: 'Detected in the current environment' }] : []),
      { value: 'file', label: 'Paste a project API key', description: 'Masked input, stored separately with mode 0600' },
      { value: 'environment', label: 'Environment reference', description: 'No secret is written by Agent OS' },
      { value: 'none', label: 'No key', description: 'For a trusted local endpoint without authentication' },
    ];
    const credentialMode = await choose(input, output, format, 'API credential', credentialOptions, 1);
    if (credentialMode === 'reuse') {
      apiKeyEnv = reusable.apiKeyEnv ?? null;
      apiKeyRef = reusable.apiKeyRef ?? null;
      resolvedApiKey = reusable.apiKey;
    } else if (credentialMode === 'detected') {
      apiKeyEnv = detectedEnvironment;
      resolvedApiKey = process.env[detectedEnvironment];
    } else if (credentialMode === 'environment') {
      apiKeyEnv = await ask(input, output, format, 'Environment variable', preset.envName ?? 'AGENT_MODEL_API_KEY');
      resolvedApiKey = process.env[apiKeyEnv] ?? null;
    } else if (credentialMode === 'file') {
      enteredApiKey = await askSecret(input, output, 'API key (hidden)');
      if (!enteredApiKey) throw new Error('API key is required');
      apiKeyRef = `model.${modelKey}.apiKey`;
      resolvedApiKey = enteredApiKey;
    }
  }

  let validation = { ok: true, skipped: true };
  if (preset.provider !== 'offline') {
    output.write(format.dim('  Checking provider model catalog…\n'));
    validation = await validateModelEndpoint({ baseUrl, apiKey: resolvedApiKey });
    output.write(validation.ok
      ? `${format.green('  ✓ Provider reachable')}\n`
      : `${format.yellow('  ! Provider check was inconclusive')} ${format.dim(validation.error ?? `HTTP ${validation.status}`)}\n`);
  }
  output.write(`\n  Key       ${modelKey}\n  Provider  ${preset.label}\n  Model     ${modelId}\n`);
  const confirmed = await ask(input, output, format, 'Save this model configuration?', 'yes');
  if (!/^y(es)?$/i.test(confirmed)) throw new Error('Model setup cancelled');

  const nextConfig = structuredClone(currentConfig);
  nextConfig.models[modelKey] = {
    ...(existing ?? {}),
    provider: preset.provider,
    baseUrl,
    model: modelId,
    apiKeyEnv,
    apiKeyRef,
    timeoutMs: existing?.timeoutMs ?? 90_000,
    inputCostPerMillion: existing?.inputCostPerMillion ?? 0,
    outputCostPerMillion: existing?.outputCostPerMillion ?? 0,
  };
  if (enteredApiKey) writeSecretFile(nextConfig.security.secretFile, { model: { [modelKey]: { apiKey: enteredApiKey } } });
  writeConfigFile(currentConfig.configPath, nextConfig);
  output.write(`${format.green('✓')} Added models.${modelKey}. The Gateway will reload it now.\n`);
  return { config: nextConfig, modelKey, modelId, validation };
}
