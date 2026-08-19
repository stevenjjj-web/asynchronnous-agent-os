import { chmodSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const SEVERITY_ORDER = { critical: 0, high: 1, warning: 2, info: 3 };

function finding(severity, id, title, detail, remediation = null) {
  return { severity, id, title, detail, remediation };
}

function filePermissionFinding(path, expectedMode, id) {
  if (!existsSync(path)) return null;
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      return finding('critical', `${id}.symlink`, 'Sensitive path is a symbolic link', path, 'Replace it with an operator-owned regular file or directory.');
    }
    if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      return finding('high', `${id}.permissions`, 'Sensitive path permissions are too broad', `${path} has mode ${(stats.mode & 0o777).toString(8)}`, `Set mode ${expectedMode.toString(8)}.`);
    }
  } catch (error) {
    return finding('high', `${id}.inspect`, 'Sensitive path could not be inspected', `${path}: ${error.message}`);
  }
  return null;
}

function walkKnownSensitiveFiles(config) {
  const files = [
    config.configPath,
    config.security.secretFile,
    config.database,
    `${config.database}-wal`,
    `${config.database}-shm`,
    join(config.home, 'gateway.pid'),
    join(config.home, 'logs', 'gateway.log'),
  ].filter(Boolean);
  const directories = [
    config.home,
    config.configPath ? dirname(config.configPath) : null,
    config.security.secretFile ? dirname(config.security.secretFile) : null,
    config.database ? dirname(config.database) : null,
    config.home ? join(config.home, 'logs') : null,
  ].filter(Boolean);
  for (const provider of Object.values(config.memory?.portability?.providers ?? {})) {
    if (!provider.path) continue;
    const path = isAbsolute(provider.path) ? provider.path : resolve(config.home, provider.path);
    if (provider.type === 'file') files.push(path);
    if (provider.type === 'directory-cas') directories.push(path);
  }
  let truncated = false;
  for (const agent of config.agents ?? []) {
    if (!existsSync(agent.workspace)) continue;
    const pending = [agent.workspace];
    let visited = 0;
    while (pending.length) {
      const path = pending.pop();
      if (visited >= 10_000) {
        truncated = true;
        break;
      }
      visited += 1;
      let stats;
      try { stats = lstatSync(path); } catch { files.push(path); continue; }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        files.push(path);
        continue;
      }
      directories.push(path);
      try {
        for (const name of readdirSync(path)) pending.push(join(path, name));
      } catch {
        files.push(path);
      }
    }
  }
  return {
    files: [...new Set(files)].filter(existsSync),
    directories: [...new Set(directories)].filter(existsSync),
    truncated,
  };
}

export function runSecurityAudit(config) {
  const findings = [];
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(config.gateway.bind);
  if (config.security.allowRemoteWithoutAuth) {
    findings.push(finding('critical', 'gateway.unauthenticated', 'Gateway allows unauthenticated access', `gateway.bind=${config.gateway.bind}`, 'Disable security.allowRemoteWithoutAuth and configure a random bearer token.'));
  }
  if (!loopback && !config.gateway.auth.token) {
    findings.push(finding('critical', 'gateway.public_no_auth', 'Non-loopback Gateway has no authentication token', `gateway.bind=${config.gateway.bind}`, 'Run agent-os setup and require bearer authentication.'));
  }
  if (!loopback) {
    findings.push(finding('critical', 'gateway.remote_plaintext', 'Remote Gateway binding uses plaintext HTTP', 'Bearer credentials and control traffic are exposed to the network without transport encryption.', 'Bind to loopback and use an authenticated TLS reverse proxy, SSH tunnel, or private overlay network.'));
  }
  if (config.security.allowLocalBypass) {
    findings.push(finding('high', 'gateway.local_bypass', 'Local processes bypass Gateway authentication', 'Any process running as the local user can control the Agent OS Gateway.', 'Disable security.allowLocalBypass and use the generated bearer token.'));
  }
  if (config.gateway.auth.token && Buffer.byteLength(config.gateway.auth.token) < 32) {
    findings.push(finding('critical', 'gateway.weak_token', 'Gateway token is too short', 'The token has less than 32 bytes of entropy-bearing material.', 'Generate a 32-byte or longer random token.'));
  }
  if (!config.security.events?.requireSignature) {
    findings.push(finding('critical', 'events.unsigned', 'External events do not require signatures', 'Unsigned events can wake durable tasks and influence decisions.', 'Enable security.events.requireSignature and provision per-source HMAC secrets.'));
  }
  if (config.security.plugins?.failClosed === false) {
    findings.push(finding('high', 'plugins.fail_open', 'Plugin loading is configured fail-open', 'The runtime can start after a configured security plugin fails.', 'Set security.plugins.failClosed to true.'));
  }
  if ((config.security.pluginPaths ?? []).length && !(config.security.plugins?.allowIds ?? []).length) {
    findings.push(finding('warning', 'plugins.no_id_allowlist', 'Plugin paths are explicit but plugin IDs are not allowlisted', 'Plugins run in the Gateway process with full process authority.', 'Set security.plugins.allowIds to the exact reviewed plugin IDs.'));
  }
  if (config.security.tools?.allow?.includes('*')) {
    findings.push(finding('warning', 'tools.wildcard', 'Global tool policy uses a wildcard allow rule', 'Frozen Goal capabilities remain authoritative, but new tools become globally visible automatically.', 'Use an explicit global tool allowlist in production.'));
  }
  if (config.security.capabilities?.network?.domains?.includes('*')) {
    findings.push(finding('high', 'capabilities.network_wildcard', 'Root capability permits every public domain', 'Child Goals cannot expand authority, but a root Goal can access any public HTTPS host.', 'Restrict root network domains to required services.'));
  }
  if (config.security.capabilities?.accounts?.channel?.includes('*')) {
    findings.push(finding('warning', 'capabilities.channel_account_wildcard', 'Root capability can wait on every configured channel account', 'This is useful for a personal single-operator worker, but every newly configured inbound channel account becomes visible to root Goals.', 'Replace the wildcard with reviewed account identifiers when channel accounts have stable IDs.'));
  }
  for (const [name, model] of Object.entries(config.models ?? {})) {
    if (model.allowPrivateNetwork === true) {
      findings.push(finding('high', `models.${name}.private_network`, 'Model provider can connect to private network targets', 'The provider API key and model payload may be sent to an explicitly configured private endpoint.', 'Keep allowPrivateNetwork disabled unless this model is an operator-reviewed private service.'));
    }
  }
  const memoryPortability = config.memory?.portability ?? {};
  const remoteMemoryProviders = Object.entries(memoryPortability.providers ?? {})
    .filter(([, provider]) => ['https', 'https-cas'].includes(provider.type));
  if (remoteMemoryProviders.length && !memoryPortability.requireSignatureForRemote) {
    findings.push(finding('high', 'memory.remote_unsigned', 'Remote memory bundles do not require trusted signatures', 'A remote store can inject candidate memories without proving publisher identity.', 'Enable memory.portability.requireSignatureForRemote and configure Ed25519 trusted signers.'));
  }
  if (remoteMemoryProviders.length && memoryPortability.encryption?.requireForRemote !== true) {
    findings.push(finding('critical', 'memory.remote_unencrypted', 'Remote memory bundles do not require authenticated encryption', 'Long-term memories can be stored by a remote provider as readable plaintext.', 'Enable memory.portability.encryption.requireForRemote and configure a referenced AES-256 key.'));
  }
  if (memoryPortability.signer?.privateKey && !memoryPortability.signer.privateKeyEnv && !memoryPortability.signer.privateKeyRef) {
    findings.push(finding('critical', 'memory.inline_private_key', 'Memory signing key is stored inline', 'The Ed25519 private key is present in runtime configuration rather than a secret reference.', 'Move it to an environment or private secret-file reference.'));
  }
  for (const [id, keyConfig] of Object.entries(memoryPortability.encryption?.keys ?? {})) {
    if (keyConfig.key && !keyConfig.keyEnv && !keyConfig.keyRef) {
      findings.push(finding('critical', `memory.encryption.${id}.inline_key`, 'Memory encryption key is stored inline', 'The AES-256 key is present directly in runtime configuration.', 'Use keyEnv or keyRef and keep the key outside config.json.'));
    }
  }
  for (const [id, provider] of remoteMemoryProviders) {
    if (provider.allowPrivateNetwork === true) {
      findings.push(finding('high', `memory.providers.${id}.private_network`, 'Memory provider can access private network targets', 'Memory bundles and provider credentials may be sent to an explicitly configured private endpoint.', 'Keep allowPrivateNetwork disabled unless this is an operator-reviewed private service.'));
    }
    if (provider.autoActivate === true) {
      findings.push(finding('warning', `memory.providers.${id}.auto_activate`, 'Remote memory is activated automatically', 'A trusted signature proves publisher identity, not semantic truth or current validity.', 'Prefer candidate import followed by operator or policy review.'));
    }
    if (provider.pushIntervalMs) {
      findings.push(finding('warning', `memory.providers.${id}.auto_export`, 'Long-term memory is exported automatically', 'Every active memory in the configured agent scope can be sent to this remote provider on the configured interval.', 'Use a dedicated trusted provider and review its retention, encryption, access, and deletion policies.'));
    }
    if (provider.token && !provider.tokenEnv && !provider.tokenRef) {
      findings.push(finding('critical', `memory.providers.${id}.inline_token`, 'Memory provider token is stored inline', 'The provider credential is present directly in runtime configuration.', 'Use tokenEnv or tokenRef instead.'));
    }
  }
  if (config.security.capabilities?.filesystem?.operations?.includes('delete')) {
    findings.push(finding('warning', 'capabilities.filesystem_delete', 'Root capability includes workspace deletion', 'High-risk approval still applies to the built-in delete tool.', 'Remove delete unless the personal agent needs it.'));
  }
  if (config.security.approvalRisk === 'high' || config.security.approvalRisk === 'critical') {
    findings.push(finding('warning', 'approvals.medium_auto', 'Medium-risk side effects can run without approval', `security.approvalRisk=${config.security.approvalRisk}`, 'Use medium for a cautious production profile.'));
  }

  const sensitive = walkKnownSensitiveFiles(config);
  if (sensitive.truncated) findings.push(finding('warning', 'filesystem.audit_truncated', 'Workspace permission audit reached its entry limit', 'Only the first 10000 entries per workspace were inspected.', 'Split oversized workspaces or audit remaining files separately.'));
  for (const path of sensitive.directories) {
    const result = filePermissionFinding(path, 0o700, 'filesystem.directory');
    if (result) findings.push(result);
  }
  for (const path of sensitive.files) {
    const result = filePermissionFinding(path, 0o600, 'filesystem.file');
    if (result) findings.push(result);
  }
  for (const pluginPath of config.security.pluginPaths ?? []) {
    const result = filePermissionFinding(pluginPath, 0o600, 'plugins.file');
    if (result) findings.push(result);
  }

  findings.push(finding('info', 'trust.single_operator', 'Gateway is a single trusted-operator boundary', 'Session keys route context; they are not hostile-tenant authorization boundaries.', 'Use separate OS users, Gateway processes, state directories, credentials, and sandboxes for mutually untrusted tenants.'));
  findings.push(finding('info', 'sandbox.external_required', 'Browser and code tools require an external strong sandbox', 'The core runtime accepts only adapters declaring process, container, or microVM isolation; it does not ship a container runtime.', 'Deploy and verify a hardened sandbox adapter before enabling browser or code execution.'));
  findings.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
  const summary = findings.reduce((result, item) => {
    result[item.severity] += 1;
    return result;
  }, { critical: 0, high: 0, warning: 0, info: 0 });
  return {
    ok: summary.critical === 0 && summary.high === 0,
    generatedAt: Date.now(),
    trustModel: 'single-trusted-operator-per-gateway',
    summary,
    findings,
  };
}

export function fixSecurityPermissions(config) {
  if (process.platform === 'win32') return { changed: [], unsupported: true };
  const sensitive = walkKnownSensitiveFiles(config);
  const changed = [];
  for (const path of sensitive.directories) {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
    chmodSync(path, 0o700);
    changed.push({ path, mode: '0700' });
  }
  for (const path of sensitive.files) {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) continue;
    chmodSync(path, 0o600);
    changed.push({ path, mode: '0600' });
  }
  return { changed, unsupported: false };
}
