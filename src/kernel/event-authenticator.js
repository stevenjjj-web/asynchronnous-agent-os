import { createHmac, timingSafeEqual } from 'node:crypto';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function equalHex(left, right) {
  try {
    const leftBuffer = Buffer.from(left.replace(/^sha256=/, ''), 'hex');
    const rightBuffer = Buffer.from(right.replace(/^sha256=/, ''), 'hex');
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
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
    const locator = policy.sourceSecrets[input.source];
    if (!locator) throw new Error(`No event authentication key is configured for source: ${input.source}`);
    const variable = locator.startsWith('env:') ? locator.slice(4) : locator;
    const secret = process.env[variable];
    if (!secret) throw new Error(`Event authentication key could not be resolved for source: ${input.source}`);
    const canonical = [
      timestamp,
      input.nonce,
      input.topic,
      input.correlationKey,
      input.tenantId ?? 'default',
      input.agentId ?? 'main',
      JSON.stringify(stable(input.payload ?? {})),
    ].join('.');
    const expected = createHmac('sha256', secret).update(canonical).digest('hex');
    if (!equalHex(input.signature ?? '', expected)) throw new Error('External event signature is invalid');
    return { authenticated: true, authSubject: input.source, nonce: input.nonce };
  }
}
