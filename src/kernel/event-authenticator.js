import { createHmac, timingSafeEqual } from 'node:crypto';

function stable(value, depth = 0) {
  if (depth > 64) throw new Error('External event payload exceeds the maximum nesting depth');
  if (Array.isArray(value)) return value.map((item) => stable(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`External event payload contains an unsafe key: ${key}`);
      return [key, stable(value[key], depth + 1)];
    }));
  }
  return value;
}

function equalHex(left, right) {
  try {
    const normalizedLeft = String(left).replace(/^sha256=/, '');
    const normalizedRight = String(right).replace(/^sha256=/, '');
    if (!/^[a-f0-9]{64}$/i.test(normalizedLeft) || !/^[a-f0-9]{64}$/i.test(normalizedRight)) return false;
    const leftBuffer = Buffer.from(normalizedLeft, 'hex');
    const rightBuffer = Buffer.from(normalizedRight, 'hex');
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

export function canonicalEventEnvelope(input) {
  return [
    'agent-os-event-v1',
    input.source,
    Number(input.timestamp),
    input.nonce,
    input.topic,
    input.correlationKey,
    input.tenantId ?? 'default',
    input.agentId ?? 'main',
    JSON.stringify(stable(input.payload ?? {})),
  ].join('.');
}

export class EventAuthenticator {
  constructor({ config }) {
    this.config = config;
  }

  verify(input) {
    const policy = this.config.security.events;
    if (!policy.requireSignature && !input.signature) {
      return { authenticated: false, authSubject: null, nonce: input.nonce ?? null };
    }
    const timestamp = Number(input.timestamp);
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > policy.replayWindowMs) {
      throw new Error('External event timestamp is outside the replay window');
    }
    if (!input.nonce || typeof input.nonce !== 'string') throw new Error('External event nonce is required');
    if (input.nonce.length > 256) throw new Error('External event nonce exceeds 256 characters');
    for (const [name, value] of Object.entries({ source: input.source, topic: input.topic, correlationKey: input.correlationKey })) {
      if (typeof value !== 'string' || !value || value.length > 256) throw new Error(`External event ${name} is invalid`);
    }
    const locator = policy.sourceSecrets[input.source];
    if (!locator) throw new Error(`No event authentication key is configured for source: ${input.source}`);
    if (typeof locator !== 'string' || !locator.startsWith('env:')) {
      throw new Error(`Event authentication key locator must use env: for source: ${input.source}`);
    }
    const variable = locator.slice(4);
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(variable)) throw new Error(`Invalid event authentication environment reference for source: ${input.source}`);
    const secret = process.env[variable];
    if (!secret) throw new Error(`Event authentication key could not be resolved for source: ${input.source}`);
    const canonical = canonicalEventEnvelope({ ...input, timestamp });
    const expected = createHmac('sha256', secret).update(canonical).digest('hex');
    if (!equalHex(input.signature ?? '', expected)) throw new Error('External event signature is invalid');
    return { authenticated: true, authSubject: input.source, nonce: input.nonce };
  }
}
