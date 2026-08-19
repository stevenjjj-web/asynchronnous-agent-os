import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  sign as signValue,
  verify as verifyValue,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  readPrivateTextFile,
} from '../platform/fs-safety.js';
import { requestBoundedText } from '../security/public-fetch.js';

export const MEMORY_BUNDLE_FORMAT = 'agent-os.memory-bundle';
export const MEMORY_BUNDLE_VERSION = 1;
export const ENCRYPTED_MEMORY_BUNDLE_FORMAT = 'agent-os.memory-bundle-encrypted';

const MEMORY_KINDS = new Set(['fact', 'preference', 'decision', 'episode', 'procedure', 'note']);

function canonicalize(value, depth = 0) {
  if (depth > 64) throw new Error('Memory bundle exceeds the maximum nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Memory bundle contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
  if (!value || typeof value !== 'object') throw new Error('Memory bundle contains an unsupported value');
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`Memory bundle contains an unsafe key: ${key}`);
    return [key, canonicalize(value[key], depth + 1)];
  }));
}

export function canonicalMemoryJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function bundleDigest(payload) {
  return `sha256:${sha256(canonicalMemoryJson(payload))}`;
}

function configuredEncryptionKey(value) {
  const text = String(value ?? '').trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error('Memory encryption key must contain exactly 32 bytes in canonical base64 or hex');
  }
  const key = Buffer.from(text, 'base64');
  if (key.toString('base64') !== text) {
    throw new Error('Memory encryption key must contain exactly 32 bytes in canonical base64 or hex');
  }
  if (key.length !== 32) throw new Error('Memory encryption key must contain exactly 32 bytes in base64 or hex');
  return key;
}

function encryptedEnvelopeDigest(envelope) {
  return `sha256:${sha256(canonicalMemoryJson({
    format: envelope.format,
    version: envelope.version,
    encryption: envelope.encryption,
    ciphertext: envelope.ciphertext,
  }))}`;
}

function deriveMemoryNonce(key, serialized) {
  const nonceKey = createHmac('sha256', key).update('agent-os/memory/nonce/v1').digest();
  return createHmac('sha256', nonceKey).update(serialized).digest().subarray(0, 12);
}

function decodeCanonicalBase64(value, name, maximum) {
  const text = boundedString(value, name, maximum);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error(`${name} must be canonical base64`);
  }
  const decoded = Buffer.from(text, 'base64');
  if (decoded.toString('base64') !== text) throw new Error(`${name} must be canonical base64`);
  return decoded;
}

function safeDigestEqual(left, right) {
  const leftValue = Buffer.from(String(left));
  const rightValue = Buffer.from(String(right));
  return leftValue.length === rightValue.length && timingSafeEqual(leftValue, rightValue);
}

function encryptMemoryBundle(inner, config) {
  const encryption = config.memory.portability.encryption ?? {};
  if (!encryption.activeKeyId) return null;
  const keyConfig = encryption.keys?.[encryption.activeKeyId];
  if (!keyConfig?.key) throw new Error(`Active memory encryption key is unresolved: ${encryption.activeKeyId}`);
  const key = configuredEncryptionKey(keyConfig.key);
  const nonce = deriveMemoryNonce(key, inner.serialized);
  const header = {
    algorithm: 'AES-256-GCM',
    nonceDerivation: 'HMAC-SHA256-FULL-BUNDLE-v1',
    keyId: encryption.activeKeyId,
    nonce: nonce.toString('base64'),
  };
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(canonicalMemoryJson({ format: ENCRYPTED_MEMORY_BUNDLE_FORMAT, version: 1, ...header })));
  const ciphertext = Buffer.concat([cipher.update(inner.serialized, 'utf8'), cipher.final()]);
  const envelope = {
    format: ENCRYPTED_MEMORY_BUNDLE_FORMAT,
    version: 1,
    encryption: { ...header, tag: cipher.getAuthTag().toString('base64') },
    ciphertext: ciphertext.toString('base64'),
  };
  envelope.digest = encryptedEnvelopeDigest(envelope);
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized) > config.memory.portability.maxBundleBytes) {
    throw new Error(`Encrypted memory bundle exceeds the ${config.memory.portability.maxBundleBytes}-byte limit`);
  }
  return { bundle: envelope, serialized, digest: envelope.digest, payloadDigest: inner.digest, encrypted: true };
}

function boundedString(value, name, maximum) {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) {
    throw new Error(`${name} must contain 1 to ${maximum} characters`);
  }
  return value;
}

function optionalTimestamp(value, name) {
  if (value == null) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${name} must be a timestamp`);
  return result;
}

function requiredTimestamp(value, name) {
  const result = optionalTimestamp(value, name);
  if (result == null) throw new Error(`${name} is required`);
  return result;
}

function boundedUnit(value, name, fallback) {
  const result = Number(value ?? fallback);
  if (!Number.isFinite(result) || result < 0 || result > 1) throw new Error(`${name} must be between 0 and 1`);
  return result;
}

function validatePortableMemory(input, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Portable memory must be an object');
  const portableId = boundedString(input.portableId, 'Portable memory id', 256);
  const content = boundedString(input.content, 'Portable memory content', config.memory.maxEntryChars);
  if (content !== content.trim()) throw new Error('Portable memory content cannot have leading or trailing whitespace');
  const kind = input.kind ?? 'note';
  if (!MEMORY_KINDS.has(kind)) throw new Error(`Unsupported portable memory kind: ${kind}`);
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 50 || tags.some((tag) => typeof tag !== 'string' || !tag || tag.length > 100)) {
    throw new Error('Portable memory tags are invalid');
  }
  const provenance = canonicalize(input.provenance ?? {});
  if (Buffer.byteLength(JSON.stringify(provenance)) > 200_000) throw new Error('Portable memory provenance exceeds 200000 bytes');
  const validFrom = optionalTimestamp(input.validFrom, 'Portable memory validFrom');
  const validUntil = optionalTimestamp(input.validUntil, 'Portable memory validUntil');
  if (validFrom != null && validUntil != null && validUntil <= validFrom) {
    throw new Error('Portable memory validUntil must be later than validFrom');
  }
  return {
    portableId,
    kind,
    content,
    source: input.source == null ? 'unknown' : boundedString(input.source, 'Portable memory source', 256),
    importance: boundedUnit(input.importance, 'Portable memory importance', 0.5),
    confidence: boundedUnit(input.confidence, 'Portable memory confidence', 0.7),
    status: ['ACTIVE', 'CANDIDATE', 'RETRACTED', 'SUPERSEDED', 'CONTRADICTED'].includes(input.status)
      ? input.status
      : 'ACTIVE',
    tags: [...tags],
    expiresAt: optionalTimestamp(input.expiresAt, 'Portable memory expiresAt'),
    validFrom,
    validUntil,
    lastConfirmedAt: optionalTimestamp(input.lastConfirmedAt, 'Portable memory lastConfirmedAt'),
    createdAt: optionalTimestamp(input.createdAt, 'Portable memory createdAt'),
    updatedAt: optionalTimestamp(input.updatedAt, 'Portable memory updatedAt'),
    provenance,
  };
}

function portableMemoryFromStored(memory) {
  const original = memory.provenance?.import?.original;
  if (original && typeof original === 'object' && original.portableId) {
    return {
      portableId: original.portableId,
      kind: memory.kind,
      content: memory.content,
      source: original.source,
      importance: original.importance,
      confidence: original.confidence,
      status: memory.status === 'ACTIVE' ? original.status : memory.status,
      tags: original.tags,
      expiresAt: original.expiresAt,
      validFrom: original.validFrom,
      validUntil: original.validUntil,
      lastConfirmedAt: original.lastConfirmedAt,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
      provenance: memory.provenance.upstream ?? {},
    };
  }
  return {
    portableId: memory.id,
    kind: memory.kind,
    content: memory.content,
    source: memory.source,
    importance: memory.importance,
    confidence: memory.confidence,
    status: memory.status,
    tags: memory.tags,
    expiresAt: memory.expires_at,
    validFrom: memory.valid_from,
    validUntil: memory.valid_until,
    lastConfirmedAt: memory.last_confirmed_at,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at,
    provenance: memory.provenance,
  };
}

function assertEd25519Key(key, expectedType, name) {
  if (key.type !== expectedType || key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${name} must be an Ed25519 ${expectedType} key`);
  }
  return key;
}

function configuredPrivateKey(value) {
  try { return createPrivateKey(value); } catch (originalError) {
    try {
      return createPrivateKey({ key: Buffer.from(String(value), 'base64'), format: 'der', type: 'pkcs8' });
    } catch {
      throw new Error('Memory signing key is not valid PEM or base64 PKCS8 DER', { cause: originalError });
    }
  }
}

function configuredPublicKey(value) {
  try { return createPublicKey(value); } catch (originalError) {
    try {
      return createPublicKey({ key: Buffer.from(String(value), 'base64'), format: 'der', type: 'spki' });
    } catch {
      throw new Error('Trusted memory public key is not valid PEM or base64 SPKI DER', { cause: originalError });
    }
  }
}

export function createMemoryBundle({ memories, agentId, tenantId, signer = null, createdAt = Date.now() }, config) {
  const portability = config.memory.portability;
  if (!Array.isArray(memories) || memories.length > portability.maxEntries) {
    throw new Error(`Memory export exceeds the ${portability.maxEntries}-entry limit`);
  }
  const payload = canonicalize({
    createdAt: requiredTimestamp(createdAt, 'Memory bundle createdAt'),
    exporter: {
      agentId: boundedString(agentId, 'Exporter agent id', 128),
      tenantId: boundedString(tenantId, 'Exporter tenant id', 128),
    },
    memories: memories.map((memory) => validatePortableMemory(memory, config)),
  });
  const digest = bundleDigest(payload);
  const bundle = {
    format: MEMORY_BUNDLE_FORMAT,
    version: MEMORY_BUNDLE_VERSION,
    digest,
    payload,
  };
  if (signer) {
    const signerId = boundedString(signer.id, 'Memory bundle signer id', 128);
    if (!signer.privateKey) throw new Error(`Memory signer ${signerId} has no resolved private key`);
    const privateKey = assertEd25519Key(configuredPrivateKey(signer.privateKey), 'private', 'Memory signing key');
    bundle.signature = {
      algorithm: 'Ed25519',
      signerId,
      value: signValue(null, Buffer.from(canonicalMemoryJson(payload)), privateKey).toString('base64'),
    };
  }
  const serialized = JSON.stringify(bundle);
  if (Buffer.byteLength(serialized) > portability.maxBundleBytes) {
    throw new Error(`Memory bundle exceeds the ${portability.maxBundleBytes}-byte limit`);
  }
  return { bundle, serialized, digest };
}

export function parseMemoryBundle(input, config, { requireSignature = false, requireEncryption = false } = {}) {
  const portability = config.memory.portability;
  const serialized = typeof input === 'string' ? input : JSON.stringify(input);
  if (Buffer.byteLength(serialized) > portability.maxBundleBytes) {
    throw new Error(`Memory bundle exceeds the ${portability.maxBundleBytes}-byte limit`);
  }
  let bundle;
  try { bundle = typeof input === 'string' ? JSON.parse(input) : structuredClone(input); } catch {
    throw new Error('Memory bundle is not valid JSON');
  }
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('Memory bundle must be an object');
  if (bundle.format === ENCRYPTED_MEMORY_BUNDLE_FORMAT) {
    if (bundle.version !== 1 || !bundle.encryption || typeof bundle.encryption !== 'object' || Array.isArray(bundle.encryption)) {
      throw new Error('Encrypted memory bundle format or version is unsupported');
    }
    if (
      bundle.encryption.algorithm !== 'AES-256-GCM'
      || bundle.encryption.nonceDerivation !== 'HMAC-SHA256-FULL-BUNDLE-v1'
    ) throw new Error('Memory bundle encryption algorithm is unsupported');
    const keyId = boundedString(bundle.encryption.keyId, 'Memory encryption key id', 128);
    const nonce = decodeCanonicalBase64(bundle.encryption.nonce, 'Memory encryption nonce', 64);
    const tag = decodeCanonicalBase64(bundle.encryption.tag, 'Memory encryption authentication tag', 64);
    const ciphertext = decodeCanonicalBase64(bundle.ciphertext, 'Encrypted memory ciphertext', Math.ceil(portability.maxBundleBytes * 4 / 3) + 4);
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('Encrypted memory bundle has invalid cryptographic parameters');
    const digest = encryptedEnvelopeDigest(bundle);
    if (!safeDigestEqual(bundle.digest, digest)) throw new Error('Encrypted memory bundle digest does not match its envelope');
    const keyConfig = portability.encryption?.keys?.[keyId];
    if (!keyConfig?.key) throw new Error(`Memory decryption key is unavailable: ${keyId}`);
    const key = configuredEncryptionKey(keyConfig.key);
    const header = {
      algorithm: 'AES-256-GCM',
      nonceDerivation: 'HMAC-SHA256-FULL-BUNDLE-v1',
      keyId,
      nonce: bundle.encryption.nonce,
    };
    let plaintext;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(canonicalMemoryJson({ format: ENCRYPTED_MEMORY_BUNDLE_FORMAT, version: 1, ...header })));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Encrypted memory bundle authentication failed');
    }
    const inner = parseMemoryBundle(plaintext, config, { requireSignature, requireEncryption: false });
    if (inner.encrypted) throw new Error('Nested encrypted memory bundles are not supported');
    const expectedNonce = deriveMemoryNonce(key, inner.serialized);
    if (!timingSafeEqual(nonce, expectedNonce)) throw new Error('Encrypted memory bundle nonce does not match its payload');
    return {
      ...inner,
      bundle: {
        format: ENCRYPTED_MEMORY_BUNDLE_FORMAT,
        version: 1,
        encryption: { ...header, tag: bundle.encryption.tag },
        ciphertext: bundle.ciphertext,
        digest,
      },
      digest,
      payloadDigest: inner.digest,
      encrypted: true,
      encryptionKeyId: keyId,
      serialized,
    };
  }
  if (requireEncryption) throw new Error('Remote memory bundle requires authenticated encryption');
  if (bundle.format !== MEMORY_BUNDLE_FORMAT || bundle.version !== MEMORY_BUNDLE_VERSION) {
    throw new Error('Memory bundle format or version is unsupported');
  }
  if (!bundle.payload || !Array.isArray(bundle.payload.memories)) throw new Error('Memory bundle payload is invalid');
  if (bundle.payload.memories.length > portability.maxEntries) {
    throw new Error(`Memory bundle exceeds the ${portability.maxEntries}-entry limit`);
  }
  const payload = canonicalize({
    createdAt: requiredTimestamp(bundle.payload.createdAt, 'Memory bundle createdAt'),
    exporter: {
      agentId: boundedString(bundle.payload.exporter?.agentId, 'Exporter agent id', 128),
      tenantId: boundedString(bundle.payload.exporter?.tenantId, 'Exporter tenant id', 128),
    },
    memories: bundle.payload.memories.map((memory) => validatePortableMemory(memory, config)),
  });
  const digest = bundleDigest(payload);
  if (bundle.digest !== digest) throw new Error('Memory bundle digest does not match its payload');

  let signatureStatus = 'unsigned';
  let signerId = null;
  let trusted = false;
  if (bundle.signature != null) {
    if (bundle.signature.algorithm !== 'Ed25519') throw new Error('Memory bundle signature algorithm is unsupported');
    signerId = boundedString(bundle.signature.signerId, 'Memory bundle signer id', 128);
    const signature = Buffer.from(boundedString(bundle.signature.value, 'Memory bundle signature', 1_024), 'base64');
    const trustedSigner = portability.trustedSigners?.[signerId];
    if (!trustedSigner?.publicKey) {
      signatureStatus = 'unknown-signer';
      if (requireSignature) throw new Error(`Memory bundle signer is not trusted: ${signerId}`);
    } else {
      const publicKey = assertEd25519Key(configuredPublicKey(trustedSigner.publicKey), 'public', 'Trusted memory public key');
      if (!verifyValue(null, Buffer.from(canonicalMemoryJson(payload)), publicKey, signature)) {
        throw new Error('Memory bundle signature is invalid');
      }
      signatureStatus = 'verified';
      trusted = true;
    }
  } else if (requireSignature) {
    throw new Error('Remote memory bundle requires a trusted signature');
  }
  return {
    bundle: { ...bundle, payload },
    digest,
    payloadDigest: digest,
    payload,
    signerId,
    signatureStatus,
    trusted,
    signed: bundle.signature != null,
    encrypted: false,
    encryptionKeyId: null,
    serialized,
  };
}

function providerPath(home, configuredPath) {
  const value = boundedString(configuredPath, 'Memory provider path', 4_096);
  return isAbsolute(value) ? value : resolve(home, value);
}

function normalizeDigest(value) {
  const match = String(value ?? '').match(/^sha256:([a-f0-9]{64})$/i);
  if (!match) throw new Error('Content-addressed memory operations require a sha256 digest');
  return `sha256:${match[1].toLowerCase()}`;
}

function casFilename(digest) {
  return `${normalizeDigest(digest).slice('sha256:'.length)}.json`;
}

class MemoryProviderRegistry {
  constructor(config) {
    this.config = config;
    this.providers = new Map(Object.entries(config.memory.portability.providers ?? {}));
    this.custom = new Map();
  }

  register(id, adapter) {
    boundedString(id, 'Memory provider id', 128);
    if (!adapter || typeof adapter !== 'object' || typeof adapter.pull !== 'function' && typeof adapter.push !== 'function') {
      throw new Error(`Memory provider ${id} must implement pull() or push()`);
    }
    this.custom.set(id, { type: adapter.type ?? 'plugin', remote: adapter.remote !== false, ...adapter });
    return this;
  }

  get(id) {
    const provider = this.providers.get(id) ?? this.custom.get(id);
    if (!provider) throw new Error(`Unknown memory provider: ${id}`);
    return { id, ...provider };
  }

  list() {
    return [...this.providers.entries(), ...this.custom.entries()].map(([id, provider]) => {
      const custom = this.custom.has(id);
      const remote = provider.remote === true || ['https', 'https-cas'].includes(provider.type);
      return {
        id,
        type: provider.type,
        remote,
        canPull: custom ? typeof provider.pull === 'function' : provider.pull !== false,
        canPush: custom ? typeof provider.push === 'function' : provider.push !== false,
        pullIntervalMs: provider.pullIntervalMs ?? null,
        pushIntervalMs: provider.pushIntervalMs ?? null,
        autoActivate: provider.autoActivate === true,
        signatureRequired: remote && this.config.memory.portability.requireSignatureForRemote,
        encryptionRequired: remote && this.config.memory.portability.encryption?.requireForRemote !== false,
      };
    });
  }

  async pull(id, { digest, signal } = {}) {
    const provider = this.get(id);
    if (provider.pull === false) throw new Error(`Memory provider does not allow pull: ${id}`);
    if (this.custom.has(id)) {
      if (typeof provider.pull !== 'function') throw new Error(`Memory provider does not support pull: ${id}`);
      const result = await provider.pull({ digest, signal, maxBytes: this.config.memory.portability.maxBundleBytes });
      const content = typeof result === 'string' ? result : result?.content;
      if (typeof content !== 'string' || Buffer.byteLength(content) > this.config.memory.portability.maxBundleBytes) {
        throw new Error(`Memory provider ${id} returned an invalid or oversized bundle`);
      }
      return {
        content,
        remote: provider.remote !== false,
        location: result?.location ?? `plugin:${id}`,
        expectedDigest: provider.contentAddressed && digest ? normalizeDigest(digest) : null,
      };
    }
    if (provider.type === 'file') {
      const path = providerPath(this.config.home, provider.path);
      return {
        content: readPrivateTextFile(path, { maxBytes: this.config.memory.portability.maxBundleBytes }),
        remote: false,
        location: path,
        expectedDigest: null,
      };
    }
    if (provider.type === 'directory-cas') {
      const path = join(providerPath(this.config.home, provider.path), casFilename(digest));
      return {
        content: readPrivateTextFile(path, { maxBytes: this.config.memory.portability.maxBundleBytes }),
        remote: false,
        location: path,
        expectedDigest: normalizeDigest(digest),
      };
    }
    const url = provider.type === 'https-cas'
      ? new URL(casFilename(digest), `${provider.url.replace(/\/$/, '')}/`).href
      : provider.url;
    const response = await requestBoundedText(url, {
      method: 'GET',
      headers: provider.token ? { authorization: `Bearer ${provider.token}` } : {},
      maxBytes: this.config.memory.portability.maxBundleBytes,
      timeoutMs: provider.timeoutMs ?? Math.max(100, Math.min(10_000, this.config.kernel.serviceTimeoutMs - this.config.kernel.heartbeatMs)),
      allowPrivateNetwork: provider.allowPrivateNetwork === true,
      signal,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`Memory provider pull returned HTTP ${response.status}`);
    return {
      content: response.content,
      remote: true,
      location: response.url,
      expectedDigest: provider.type === 'https-cas' ? normalizeDigest(digest) : null,
    };
  }

  async push(id, { serialized, digest, signal } = {}) {
    const provider = this.get(id);
    if (provider.push === false) throw new Error(`Memory provider does not allow push: ${id}`);
    if (this.custom.has(id)) {
      if (typeof provider.push !== 'function') throw new Error(`Memory provider does not support push: ${id}`);
      const result = await provider.push({ serialized, digest, signal, contentType: 'application/vnd.agent-os.memory-bundle+json' });
      return { ...result, stored: true, remote: provider.remote !== false, location: result?.location ?? `plugin:${id}`, digest };
    }
    if (provider.type === 'file') {
      const path = providerPath(this.config.home, provider.path);
      atomicWritePrivateFile(path, serialized);
      return { stored: true, remote: false, location: path, digest };
    }
    if (provider.type === 'directory-cas') {
      const directory = ensurePrivateDirectory(providerPath(this.config.home, provider.path));
      const path = join(directory, casFilename(digest));
      if (existsSync(path)) {
        const existing = readPrivateTextFile(path, { maxBytes: this.config.memory.portability.maxBundleBytes });
        if (parseMemoryBundle(existing, this.config).digest !== normalizeDigest(digest)) {
          throw new Error('Existing content-addressed memory object does not match its filename digest');
        }
      } else {
        atomicWritePrivateFile(path, serialized);
      }
      return { stored: true, remote: false, location: path, digest };
    }
    const cas = provider.type === 'https-cas';
    const url = cas
      ? new URL(casFilename(digest), `${provider.url.replace(/\/$/, '')}/`).href
      : provider.url;
    const response = await requestBoundedText(url, {
      method: cas ? 'PUT' : (provider.pushMethod ?? 'POST'),
      headers: {
        ...(provider.token ? { authorization: `Bearer ${provider.token}` } : {}),
        'content-type': 'application/vnd.agent-os.memory-bundle+json',
        'x-agent-os-content-digest': digest,
        'idempotency-key': `memory-bundle:${digest}`,
        ...(cas ? { 'if-none-match': '*' } : {}),
      },
      body: serialized,
      maxBytes: this.config.memory.portability.maxBundleBytes,
      timeoutMs: provider.timeoutMs ?? Math.max(100, Math.min(10_000, this.config.kernel.serviceTimeoutMs - this.config.kernel.heartbeatMs)),
      allowPrivateNetwork: provider.allowPrivateNetwork === true,
      signal,
    });
    if (!(response.status >= 200 && response.status < 300) && !(cas && [409, 412].includes(response.status))) {
      throw new Error(`Memory provider push returned HTTP ${response.status}`);
    }
    return { stored: true, remote: true, location: url, digest, status: response.status };
  }
}

export class MemoryPortabilityService {
  constructor({ store, memory, config }) {
    this.store = store;
    this.memory = memory;
    this.config = config;
    this.providers = new MemoryProviderRegistry(config);
    this.syncing = false;
  }

  listProviders() {
    return this.providers.list();
  }

  registerProvider(id, adapter) {
    this.providers.register(id, adapter);
    return this;
  }

  finishRun(run, status, input) {
    const result = this.store.finishMemorySyncRun(run.id, status, input);
    this.store.pruneMemorySyncRuns({
      agentId: run.agent_id,
      tenantId: run.tenant_id,
      retain: this.config.memory.portability.maxSyncHistory,
    });
    return result;
  }

  exportBundle({ agentId = 'main', tenantId = 'default', includeInactive = false, limit, unsigned = false } = {}) {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const maximum = this.config.memory.portability.maxEntries;
    const requestedLimit = Number(limit ?? maximum);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > maximum) {
      throw new Error(`Memory export limit must be between 1 and ${maximum}`);
    }
    const rows = this.store.listMemories(agentId, requestedLimit, tenantId)
      .filter((memory) => includeInactive || memory.status === 'ACTIVE');
    const memories = rows.map(portableMemoryFromStored);
    const signer = unsigned ? null : this.config.memory.portability.signer;
    const createdAt = rows.reduce((latest, memory) => Math.max(latest, Number(memory.updated_at ?? 0)), 0);
    const inner = createMemoryBundle({ memories, agentId, tenantId, signer, createdAt }, this.config);
    const encrypted = encryptMemoryBundle(inner, this.config);
    return {
      ...(encrypted ?? { ...inner, payloadDigest: inner.digest, encrypted: false }),
      signed: Boolean(inner.bundle.signature),
      count: memories.length,
      contentDigest: `sha256:${sha256(canonicalMemoryJson(memories))}`,
    };
  }

  importBundle(input, {
    agentId = 'main', tenantId = 'default', activate = false, remote = false, providerId = 'manual',
  } = {}) {
    const requireSignature = remote && this.config.memory.portability.requireSignatureForRemote;
    const requireEncryption = remote && this.config.memory.portability.encryption?.requireForRemote !== false;
    const parsed = parseMemoryBundle(input, this.config, { requireSignature, requireEncryption });
    if (remote && activate && !parsed.trusted) {
      throw new Error('Remote memory activation requires a trusted bundle signature');
    }
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const pending = [];
    const pendingIds = new Set();
    const promotions = new Map();
    let duplicates = 0;
    const status = activate ? 'ACTIVE' : 'CANDIDATE';
    for (const portable of parsed.payload.memories) {
      const directExisting = this.store.getMemory(portable.portableId);
      if (directExisting) {
        if (directExisting.agent_id !== agentId || directExisting.tenant_id !== tenantId) {
          throw new Error(`Portable memory id belongs to a different owner: ${portable.portableId}`);
        }
        const existingPortable = validatePortableMemory(portableMemoryFromStored(directExisting), this.config);
        if (canonicalMemoryJson(existingPortable) === canonicalMemoryJson(portable)) {
          if (activate && directExisting.status === 'CANDIDATE') promotions.set(directExisting.id, portable.confidence);
          duplicates += 1;
          continue;
        }
      }
      const recordDigest = sha256(canonicalMemoryJson(portable));
      const id = `memory.import:${sha256(`${portable.portableId}\0${recordDigest}`)}`;
      if (pendingIds.has(id)) {
        duplicates += 1;
        continue;
      }
      const existing = this.store.getMemory(id);
      if (existing) {
        if (existing.agent_id !== agentId || existing.tenant_id !== tenantId || existing.content !== portable.content) {
          throw new Error(`Imported memory id collision: ${id}`);
        }
        if (activate && existing.status === 'CANDIDATE') promotions.set(id, portable.confidence);
        duplicates += 1;
        continue;
      }
      pendingIds.add(id);
      pending.push({
        id,
        agentId,
        tenantId,
        kind: portable.kind,
        content: portable.content,
        source: `import:${parsed.signerId ?? providerId}`,
        importance: portable.importance,
        confidence: activate
          ? portable.confidence
          : Math.min(portable.confidence, this.config.memory.portability.maxImportedConfidence),
        status,
        tags: ['imported', ...portable.tags.filter((tag) => tag !== 'imported')].slice(0, 50),
        expiresAt: portable.expiresAt,
        validFrom: portable.validFrom,
        validUntil: portable.validUntil,
        lastConfirmedAt: activate ? portable.lastConfirmedAt : null,
        provenance: {
          trust: 'imported-untrusted-data',
          import: {
            bundleDigest: parsed.digest,
            payloadDigest: parsed.payloadDigest,
            providerId,
            remote,
            encrypted: parsed.encrypted,
            encryptionKeyId: parsed.encryptionKeyId,
            signatureStatus: parsed.signatureStatus,
            signerId: parsed.signerId,
            portableId: portable.portableId,
            recordDigest: `sha256:${recordDigest}`,
            importedAt: Date.now(),
            original: {
              portableId: portable.portableId,
              source: portable.source,
              importance: portable.importance,
              confidence: portable.confidence,
              status: portable.status,
              tags: portable.tags,
              expiresAt: portable.expiresAt,
              validFrom: portable.validFrom,
              validUntil: portable.validUntil,
              lastConfirmedAt: portable.lastConfirmedAt,
              createdAt: portable.createdAt,
              updatedAt: portable.updatedAt,
            },
          },
          upstream: portable.provenance,
        },
      });
    }
    const imported = this.store.transaction(() => {
      for (const [id, confidence] of promotions) {
        this.store.confirmMemory(id, { confidence, source: `import:${providerId}` });
      }
      return pending.map((memory) => this.store.addMemory(memory, { withinTransaction: true }));
    });
    const warnings = [];
    for (const memory of imported) {
      try {
        this.memory.mirrorMemory(memory);
      } catch (error) {
        warnings.push(`Memory diary mirror failed for ${memory.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      digest: parsed.digest,
      signatureStatus: parsed.signatureStatus,
      signerId: parsed.signerId,
      trusted: parsed.trusted,
      encrypted: parsed.encrypted,
      encryptionKeyId: parsed.encryptionKeyId,
      status,
      imported: imported.length,
      duplicates,
      memoryIds: imported.map((memory) => memory.id),
      warnings,
    };
  }

  importTracked(input, options = {}) {
    const run = this.store.startMemorySyncRun({
      providerId: options.providerId ?? 'manual',
      direction: 'IMPORT',
      agentId: options.agentId ?? 'main',
      tenantId: options.tenantId ?? 'default',
    });
    try {
      const result = this.importBundle(input, options);
      this.finishRun(run, 'SUCCEEDED', result);
      return result;
    } catch (error) {
      this.finishRun(run, 'FAILED', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  exportTracked(options = {}) {
    const run = this.store.startMemorySyncRun({
      providerId: options.providerId ?? 'manual',
      direction: 'EXPORT',
      agentId: options.agentId ?? 'main',
      tenantId: options.tenantId ?? 'default',
    });
    try {
      const result = this.exportBundle(options);
      this.finishRun(run, 'SUCCEEDED', {
        digest: result.digest,
        signatureStatus: result.signed ? 'signed' : 'unsigned',
        metadata: { count: result.count, encrypted: result.encrypted, payloadDigest: result.payloadDigest },
      });
      return result;
    } catch (error) {
      this.finishRun(run, 'FAILED', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async pull(providerId, options = {}) {
    const run = this.store.startMemorySyncRun({
      providerId, direction: 'PULL', agentId: options.agentId ?? 'main', tenantId: options.tenantId ?? 'default',
    });
    try {
      const pulled = await this.providers.pull(providerId, options);
      if (pulled.expectedDigest) {
        const inspected = parseMemoryBundle(pulled.content, this.config, {
          requireSignature: pulled.remote && this.config.memory.portability.requireSignatureForRemote,
          requireEncryption: pulled.remote && this.config.memory.portability.encryption?.requireForRemote !== false,
        });
        if (inspected.digest !== pulled.expectedDigest) throw new Error('Content-addressed memory provider returned a different bundle digest');
      }
      const result = this.importBundle(pulled.content, {
        ...options,
        remote: pulled.remote,
        providerId,
      });
      this.finishRun(run, 'SUCCEEDED', { ...result, metadata: { location: pulled.location } });
      return { ...result, providerId, location: pulled.location };
    } catch (error) {
      this.finishRun(run, 'FAILED', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async push(providerId, options = {}) {
    const run = this.store.startMemorySyncRun({
      providerId, direction: 'PUSH', agentId: options.agentId ?? 'main', tenantId: options.tenantId ?? 'default',
    });
    try {
      const exported = options.preparedBundle ?? this.exportBundle(options);
      const provider = this.providers.get(providerId);
      const remote = provider.remote === true || ['https', 'https-cas'].includes(provider.type);
      if (remote && !exported.signed) {
        throw new Error('Remote memory push requires a configured signing key');
      }
      if (remote && this.config.memory.portability.encryption?.requireForRemote !== false && !exported.encrypted) {
        throw new Error('Remote memory push requires a configured encryption key');
      }
      const result = await this.providers.push(providerId, { ...options, ...exported });
      this.finishRun(run, 'SUCCEEDED', {
        digest: exported.digest,
        signatureStatus: exported.signed ? 'signed' : 'unsigned',
        metadata: { location: result.location, encrypted: exported.encrypted, payloadDigest: exported.payloadDigest },
      });
      return {
        ...result,
        providerId,
        count: exported.count,
        contentDigest: exported.contentDigest,
      };
    } catch (error) {
      this.finishRun(run, 'FAILED', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async syncProvider(provider, { timestamp, signal }) {
    const stateKey = `memory.sync.provider.${provider.id}`;
    const state = this.store.getSystemState(stateKey)?.value ?? {};
    const next = { ...state };
    if (provider.pullIntervalMs && !provider.type.endsWith('-cas') && timestamp - Number(state.lastPullAt ?? 0) >= provider.pullIntervalMs) {
      next.lastPullAt = timestamp;
      try {
        const result = await this.pull(provider.id, { activate: provider.autoActivate, signal });
        next.lastPullDigest = result.digest;
        next.lastPullError = null;
      } catch (error) {
        next.lastPullError = error instanceof Error ? error.message : String(error);
      }
    }
    if (provider.pushIntervalMs && timestamp - Number(state.lastPushAt ?? 0) >= provider.pushIntervalMs) {
      next.lastPushAt = timestamp;
      try {
        const exported = this.exportBundle();
        if (exported.contentDigest !== state.lastPushContentDigest) {
          const result = await this.push(provider.id, { preparedBundle: exported, signal });
          next.lastPushDigest = result.digest;
          next.lastPushContentDigest = result.contentDigest;
        }
        next.lastPushError = null;
      } catch (error) {
        next.lastPushError = error instanceof Error ? error.message : String(error);
      }
    }
    if (canonicalMemoryJson(next) !== canonicalMemoryJson(state)) this.store.setSystemState(stateKey, next);
  }

  async syncDue({ signal } = {}) {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const providers = this.listProviders();
      const timestamp = Date.now();
      let cursor = 0;
      const worker = async () => {
        while (!signal?.aborted) {
          const index = cursor;
          cursor += 1;
          if (index >= providers.length) return;
          await this.syncProvider(providers[index], { timestamp, signal });
        }
      };
      const concurrency = Math.min(providers.length, this.config.memory.portability.maxConcurrentSyncs);
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally {
      this.syncing = false;
    }
  }

  async run({ signal, heartbeat }) {
    while (!signal.aborted) {
      const beat = () => heartbeat({
        role: 'encrypted-signed-memory-provider-synchronization',
        providers: this.listProviders().length,
        syncing: this.syncing,
        observedAt: Date.now(),
      });
      beat();
      const heartbeatTimer = setInterval(beat, Math.max(50, Math.floor(this.config.kernel.heartbeatMs / 2)));
      heartbeatTimer.unref?.();
      try {
        await this.syncDue({ signal });
      } finally {
        clearInterval(heartbeatTimer);
      }
      beat();
      await new Promise((resolveWait) => {
        const finish = () => {
          signal.removeEventListener('abort', abort);
          resolveWait();
        };
        const timeout = setTimeout(finish, Math.min(
          this.config.memory.portability.pollMs,
          this.config.kernel.heartbeatMs,
        ));
        const abort = () => {
          clearTimeout(timeout);
          finish();
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
}
