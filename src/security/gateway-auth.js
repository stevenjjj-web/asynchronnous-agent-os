import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const comparisonKey = randomBytes(32);

export function isLoopbackAddress(address) {
  const value = String(address ?? '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function secureEqual(left, right) {
  const digest = (value) => createHmac('sha256', comparisonKey).update(String(value ?? '')).digest();
  return timingSafeEqual(digest(left), digest(right));
}

export function bearerToken(req) {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string') return null;
  const match = raw.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

export class BoundedRateLimiter {
  constructor({ windowMs, maxAttempts, lockoutMs = windowMs, maxEntries = 10_000 } = {}) {
    this.windowMs = windowMs;
    this.maxAttempts = maxAttempts;
    this.lockoutMs = lockoutMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  prune(timestamp = Date.now()) {
    for (const [key, entry] of this.entries) {
      entry.attempts = entry.attempts.filter((attempt) => attempt > timestamp - this.windowMs);
      if (!entry.attempts.length && (!entry.lockedUntil || entry.lockedUntil <= timestamp)) this.entries.delete(key);
    }
  }

  check(key, timestamp = Date.now()) {
    const entry = this.entries.get(String(key));
    if (!entry) return { allowed: true, retryAfterMs: 0 };
    if (entry.lockedUntil > timestamp) return { allowed: false, retryAfterMs: entry.lockedUntil - timestamp };
    entry.attempts = entry.attempts.filter((attempt) => attempt > timestamp - this.windowMs);
    return { allowed: entry.attempts.length < this.maxAttempts, retryAfterMs: 0 };
  }

  record(key, timestamp = Date.now()) {
    const normalized = String(key ?? 'unknown');
    if (!this.entries.has(normalized) && this.entries.size >= this.maxEntries) {
      this.prune(timestamp);
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    }
    const entry = this.entries.get(normalized) ?? { attempts: [], lockedUntil: 0 };
    entry.attempts = entry.attempts.filter((attempt) => attempt > timestamp - this.windowMs);
    entry.attempts.push(timestamp);
    if (entry.attempts.length >= this.maxAttempts) entry.lockedUntil = timestamp + this.lockoutMs;
    this.entries.delete(normalized);
    this.entries.set(normalized, entry);
    return this.check(normalized, timestamp);
  }

  reset(key) {
    this.entries.delete(String(key ?? 'unknown'));
  }
}

export function authorizeGatewayRequest(req, config, limiter) {
  const address = req.socket.remoteAddress ?? 'unknown';
  if (config.security.allowLocalBypass && isLoopbackAddress(address)) return { ok: true, method: 'local-bypass' };
  const gate = limiter.check(address);
  if (!gate.allowed) return { ok: false, status: 429, retryAfterMs: gate.retryAfterMs };
  const expected = config.gateway.auth.token;
  if (!expected && config.security.allowRemoteWithoutAuth) return { ok: true, method: 'unauthenticated' };
  const supplied = bearerToken(req);
  if (!expected || !supplied || !secureEqual(supplied, expected)) {
    const blocked = limiter.record(address);
    return { ok: false, status: blocked.allowed ? 401 : 429, retryAfterMs: blocked.retryAfterMs };
  }
  limiter.reset(address);
  return { ok: true, method: 'bearer' };
}
