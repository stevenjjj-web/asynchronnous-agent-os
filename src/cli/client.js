export class GatewayClient {
  constructor({ config, url, token }) {
    const bind = ['0.0.0.0', '::'].includes(config.gateway.bind) ? '127.0.0.1' : config.gateway.bind;
    this.baseUrl = (url ?? `http://${bind}:${config.gateway.port}`).replace(/\/$/, '');
    this.token = token ?? config.gateway.auth.token;
  }

  async request(path, options = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.headers ?? {}),
        },
      });
    } catch (error) {
      throw new Error(`Gateway unavailable at ${this.baseUrl}. Start it with: agent-os gateway run`, { cause: error });
    }
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new Error(body?.error ?? `Gateway returned HTTP ${response.status}`);
    return body;
  }

  get(path) { return this.request(path); }
  post(path, body = {}) { return this.request(path, { method: 'POST', body: JSON.stringify(body) }); }
}
