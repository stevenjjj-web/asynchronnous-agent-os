import { posix } from 'node:path';

export class CapabilityError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CapabilityError';
    this.code = 'CAPABILITY_DENIED';
    this.detail = detail;
  }
}

function copy(value) {
  return structuredClone(value ?? {});
}

function list(value) {
  return [...new Set(Array.isArray(value) ? value : [])];
}

function allows(parent, value) {
  return parent.includes('*') || parent.includes(value);
}

function narrowList(parent, requested, label) {
  const base = list(parent);
  if (requested === undefined) return base;
  const desired = list(requested);
  for (const item of desired) {
    if (!allows(base, item)) throw new CapabilityError(`Child capability expands ${label}: ${item}`);
  }
  return desired;
}

function narrowPolicy(parent, requested, label) {
  if (requested === undefined) return copy(parent);
  if (Array.isArray(parent)) {
    const desired = list(requested);
    for (const item of desired) {
      if (!parent.some((rule) => scopeMatches(rule, item))) {
        throw new CapabilityError(`Child capability expands ${label}: ${item}`);
      }
    }
    return desired;
  }
  if (typeof parent === 'number') {
    const desired = Number(requested);
    if (!Number.isFinite(desired) || desired < 0 || desired > parent) {
      throw new CapabilityError(`Child capability expands ${label}`);
    }
    return desired;
  }
  if (typeof parent === 'boolean') {
    if (requested === true && parent !== true) throw new CapabilityError(`Child capability expands ${label}`);
    return Boolean(requested);
  }
  if (parent && typeof parent === 'object') {
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
      throw new CapabilityError(`Child capability has an invalid ${label}`);
    }
    const output = {};
    for (const [key, value] of Object.entries(requested)) {
      if (!(key in parent)) throw new CapabilityError(`Child capability introduces ${label}.${key}`);
      output[key] = narrowPolicy(parent[key], value, `${label}.${key}`);
    }
    return output;
  }
  if (requested !== parent) throw new CapabilityError(`Child capability changes fixed ${label}`);
  return requested;
}

function domainMatches(rule, hostname) {
  const normalized = hostname.toLowerCase();
  const candidate = rule.toLowerCase();
  return candidate === '*' || candidate === normalized
    || (candidate.startsWith('*.') && normalized.endsWith(candidate.slice(1)));
}

function scopeMatches(rule, value) {
  if (rule === '*') return true;
  const escaped = String(rule).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(String(value));
}

function readPath(object, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], object);
}

function pathWithin(root, requested) {
  const normalize = (value) => {
    const normalized = posix.normalize(String(value || '.'));
    if (posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) return null;
    return normalized;
  };
  const normalizedRoot = normalize(root);
  const normalizedPath = normalize(requested);
  if (!normalizedRoot || !normalizedPath) return false;
  return normalizedRoot === '.' || normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export class CapabilityKernel {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
  }

  freeze({ parentGoalId, requested, expiresAt } = {}) {
    const parent = parentGoalId
      ? this.store.getGoalContract(parentGoalId)?.capabilities
      : this.config.security.capabilities;
    if (!parent) throw new CapabilityError(`Missing parent capability contract: ${parentGoalId}`);
    const desired = requested ?? {};
    const filesystemRoots = desired.filesystem?.roots === undefined
      ? list(parent.filesystem?.roots)
      : list(desired.filesystem.roots);
    for (const root of filesystemRoots) {
      if (!list(parent.filesystem?.roots).some((allowedRoot) => pathWithin(allowedRoot, root))) {
        throw new CapabilityError(`Child capability expands filesystem root: ${root}`);
      }
    }
    const networkDomains = desired.network?.domains === undefined
      ? list(parent.network?.domains)
      : list(desired.network.domains);
    for (const domain of networkDomains) {
      if (!list(parent.network?.domains).some((rule) => domainMatches(rule, domain.replace(/^\*\./, 'probe.')))) {
        throw new CapabilityError(`Child capability expands network domain: ${domain}`);
      }
    }
    const accounts = desired.accounts === undefined ? copy(parent.accounts ?? {}) : {};
    for (const [type, requestedValues] of Object.entries(desired.accounts ?? {})) {
      if (!(type in (parent.accounts ?? {}))) throw new CapabilityError(`Child capability introduces account type: ${type}`);
      accounts[type] = narrowList(parent.accounts[type], requestedValues, `account scope ${type}`);
    }
    return {
      version: 1,
      tools: narrowList(parent.tools, desired.tools, 'tool set'),
      resourcePools: narrowList(parent.resourcePools, desired.resourcePools, 'resource pool set'),
      filesystem: {
        roots: filesystemRoots,
        operations: narrowList(parent.filesystem?.operations, desired.filesystem?.operations, 'filesystem operations'),
      },
      network: {
        domains: networkDomains,
        methods: narrowList(parent.network?.methods, desired.network?.methods, 'network methods'),
      },
      accounts,
      dataScopes: narrowList(parent.dataScopes, desired.dataScopes, 'data scopes'),
      credentialRefs: narrowList(parent.credentialRefs, desired.credentialRefs, 'credential references'),
      constraints: narrowPolicy(parent.constraints ?? {}, desired.constraints, 'constraints'),
      expiresAt: expiresAt ?? desired.expiresAt ?? null,
    };
  }

  authorizeTool(goalId, tool, args, context = {}) {
    const contract = this.store.getGoalContract(goalId);
    if (!contract) throw new CapabilityError('Goal capability contract is missing');
    if (contract.capability_status !== 'ACTIVE') {
      this.deny(goalId, `Goal capabilities are ${contract.capability_status.toLowerCase()}`, { tool: tool.name });
    }
    if (contract.capability_expires_at && Date.now() >= contract.capability_expires_at) {
      this.store.setCapabilityStatus(goalId, 'EXPIRED', 'kernel', { expiredAt: Date.now() });
      this.deny(goalId, 'Goal capabilities have expired', { tool: tool.name });
    }
    const capabilities = contract.capabilities;
    if (!allows(list(capabilities.tools), tool.name)) this.deny(goalId, `Tool is not in the frozen capability set: ${tool.name}`, { tool: tool.name });
    if (!allows(list(capabilities.resourcePools), tool.resourcePool)) {
      this.deny(goalId, `Resource pool is not in the frozen capability set: ${tool.resourcePool}`, { tool: tool.name, resourcePool: tool.resourcePool });
    }
    if (context.session) {
      if (context.session.agent_id !== contract.agent_id || context.session.tenant_id !== contract.tenant_id) {
        this.deny(goalId, 'Task ownership does not match the goal contract', { tool: tool.name });
      }
    }
    if (tool.capability?.filesystemOperation) {
      if (!allows(list(capabilities.filesystem?.operations), tool.capability.filesystemOperation)) {
        this.deny(goalId, `Filesystem operation denied: ${tool.capability.filesystemOperation}`, { tool: tool.name });
      }
      if (!list(capabilities.filesystem?.roots).some((root) => pathWithin(root, args.path ?? '.'))) {
        this.deny(goalId, `Filesystem path is outside the authorized scope: ${args.path}`, { tool: tool.name, path: args.path });
      }
    }
    if (tool.capability?.networkUrlArg) {
      const url = new URL(args[tool.capability.networkUrlArg]);
      const method = String(tool.capability.networkMethod ?? 'GET').toUpperCase();
      if (!allows(list(capabilities.network?.methods), method)) this.deny(goalId, `Network method denied: ${method}`, { tool: tool.name, method });
      if (!list(capabilities.network?.domains).some((rule) => domainMatches(rule, url.hostname))) {
        this.deny(goalId, `Network domain denied: ${url.hostname}`, { tool: tool.name, hostname: url.hostname });
      }
    }
    if (tool.capability?.accountArg) {
      const type = tool.capability.accountType;
      const account = args[tool.capability.accountArg];
      if (!allows(list(capabilities.accounts?.[type]), account)) {
        this.deny(goalId, `Account scope denied: ${type}:${account}`, { tool: tool.name, accountType: type, account });
      }
    }
    if (tool.capability?.credentialRefArg) {
      const reference = args[tool.capability.credentialRefArg];
      if (!list(capabilities.credentialRefs).includes(reference)) {
        this.deny(goalId, `Credential reference denied: ${reference}`, { tool: tool.name, credentialRef: reference });
      }
    }
    const requiredDataScopes = Array.isArray(tool.capability?.dataScopes)
      ? tool.capability.dataScopes
      : tool.capability?.dataScope
        ? [tool.capability.dataScope]
        : [];
    for (const dataScope of requiredDataScopes) {
      if (!allows(list(capabilities.dataScopes), dataScope)) {
        this.deny(goalId, `Data scope denied: ${dataScope}`, { tool: tool.name, dataScope });
      }
    }
    for (const binding of tool.capability?.argumentScopes ?? []) {
      const authorized = readPath(capabilities.constraints, binding.scope);
      if (!Array.isArray(authorized)) {
        this.deny(goalId, `Capability constraint is missing: ${binding.scope}`, { tool: tool.name });
      }
      const raw = args[binding.arg];
      const values = binding.many ? raw : [raw];
      if (!Array.isArray(values) || values.some((value) => !authorized.some((rule) => scopeMatches(rule, value)))) {
        this.deny(goalId, `Argument is outside capability constraint: ${binding.arg}`, {
          tool: tool.name, argument: binding.arg, scope: binding.scope,
        });
      }
    }
    for (const binding of tool.capability?.numericLimits ?? []) {
      const limit = Number(readPath(capabilities.constraints, binding.scope));
      const raw = args[binding.arg];
      const value = binding.measure === 'length' ? raw?.length : Number(raw);
      if (!Number.isFinite(limit) || !Number.isFinite(value) || value > limit) {
        this.deny(goalId, `Argument exceeds capability limit: ${binding.arg}`, {
          tool: tool.name, argument: binding.arg, scope: binding.scope, limit, value,
        });
      }
    }
    return contract;
  }

  canExposeTool(goalId, tool) {
    const contract = this.store.getGoalContract(goalId);
    if (!contract || contract.capability_status !== 'ACTIVE') return false;
    if (contract.capability_expires_at && Date.now() >= contract.capability_expires_at) return false;
    const capabilities = contract.capabilities ?? {};
    return allows(list(capabilities.tools), tool.name)
      && allows(list(capabilities.resourcePools), tool.resourcePool);
  }

  deny(goalId, message, detail = {}) {
    this.store.appendCapabilityAudit(goalId, 'DENIED', 'kernel', { message, ...detail });
    throw new CapabilityError(message, detail);
  }

  revoke(goalId, actor = 'operator', reason = 'Capability revoked') {
    return this.store.setCapabilityStatus(goalId, 'REVOKED', actor, { reason });
  }
}

export class CredentialBroker {
  constructor({ store }) {
    this.store = store;
  }

  async withCredential(goalId, referenceId, operation) {
    const contract = this.store.getGoalContract(goalId);
    if (!contract?.capabilities.credentialRefs?.includes(referenceId)) throw new CapabilityError(`Credential reference denied: ${referenceId}`);
    const reference = this.store.getCredentialRef(referenceId);
    if (!reference || reference.status !== 'ACTIVE') throw new CapabilityError(`Credential reference is unavailable: ${referenceId}`);
    if (reference.expires_at && Date.now() >= reference.expires_at) throw new CapabilityError(`Credential reference expired: ${referenceId}`);
    if (reference.tenant_id !== contract.tenant_id || reference.agent_id !== contract.agent_id) {
      throw new CapabilityError('Credential ownership does not match the goal contract');
    }
    if (reference.provider !== 'environment') throw new CapabilityError(`Unsupported credential provider: ${reference.provider}`);
    const secret = process.env[reference.locator];
    if (!secret) throw new CapabilityError(`Credential provider could not resolve reference: ${referenceId}`);
    this.store.appendCapabilityAudit(goalId, 'CREDENTIAL_USED', 'credential-broker', { referenceId });
    return operation(secret);
  }
}
