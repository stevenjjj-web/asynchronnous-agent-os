export class GatewayClient {
  constructor({ config, url, token }) {
    const bind = ['0.0.0.0', '::'].includes(config.gateway.bind) ? '127.0.0.1' : config.gateway.bind;
    this.baseUrl = (url ?? `http://${bind}:${config.gateway.port}`).replace(/\/$/, '');
    this.token = token ?? config.gateway.auth.token;
  }

  async request(path, options = {}) {
    const { timeoutMs = 30_000, ...fetchOptions } = options;
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Gateway request timed out')), timeoutMs);
    timeout.unref?.();
    try {
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          ...fetchOptions,
          signal: controller.signal,
          headers: {
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            ...(fetchOptions.body ? { 'content-type': 'application/json' } : {}),
            ...(fetchOptions.headers ?? {}),
          },
        });
      } catch (error) {
        throw new Error(`Gateway unavailable at ${this.baseUrl}. Start it with: agent-os gateway start`, { cause: error });
      }
      const contentType = response.headers.get('content-type') ?? '';
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > 5_000_000) throw new Error('Gateway response exceeds 5 MB');
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 5_000_000) {
            await reader.cancel('response too large');
            throw new Error('Gateway response exceeds 5 MB');
          }
          chunks.push(Buffer.from(value));
        }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = raw;
      if (contentType.includes('application/json')) {
        try { body = JSON.parse(raw); } catch { throw new Error('Gateway returned invalid JSON'); }
      }
      if (!response.ok) throw new Error(body?.error ?? `Gateway returned HTTP ${response.status}`);
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  get(path) { return this.request(path); }
  post(path, body = {}) { return this.request(path, { method: 'POST', body: JSON.stringify(body) }); }
}
