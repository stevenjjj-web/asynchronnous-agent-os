import { requestBoundedText } from '../security/public-fetch.js';

export class ProviderRegistry {
  constructor() {
    this.factories = new Map();
  }

  register(id, factory) {
    if (this.factories.has(id)) throw new Error(`Provider already registered: ${id}`);
    this.factories.set(id, factory);
    return this;
  }

  create(id, config) {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`Unknown model provider: ${id}`);
    return factory(config);
  }
}

export class OpenAICompatibleProvider {
  constructor(config) {
    this.config = config;
  }

  get configured() {
    return Boolean(this.config.model && this.config.baseUrl);
  }

  async complete({ messages, tools = [], temperature = 0.2, signal, maxTokens }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Model request timed out')), this.config.timeoutMs ?? 90_000);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await requestBoundedText(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: {
          model: this.config.model,
          messages,
          temperature,
          ...(Number.isFinite(maxTokens) ? { max_tokens: Math.floor(maxTokens) } : {}),
          ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        },
        signal: controller.signal,
        timeoutMs: this.config.timeoutMs ?? 90_000,
        maxBytes: 4_000_000,
        allowPrivateNetwork: this.config.allowPrivateNetwork === true,
      });
      if (response.status < 200 || response.status >= 300) {
        const rawDetail = response.content.slice(0, 1_000);
        const detail = this.config.apiKey
          ? rawDetail.replaceAll(this.config.apiKey, '[REDACTED]')
          : rawDetail;
        throw new Error(`Model provider returned ${response.status}: ${detail}`);
      }
      const body = JSON.parse(response.content);
      const message = body.choices?.[0]?.message;
      if (!message) throw new Error('Model provider returned no assistant message');
      const content = message.content ?? '';
      if (typeof content !== 'string' || content.length > 1_000_000) throw new Error('Model provider returned invalid or oversized assistant content');
      if (!Array.isArray(message.tool_calls ?? [])) throw new Error('Model provider returned invalid tool calls');
      if ((message.tool_calls ?? []).length > 128) throw new Error('Model provider returned too many tool calls');
      const toolCalls = (message.tool_calls ?? []).map((call) => {
        const id = String(call.id ?? '');
        const name = String(call.function?.name ?? '');
        const args = String(call.function?.arguments ?? '{}');
        if (!id || id.length > 256 || !/^[a-zA-Z0-9_-]{1,128}$/.test(name) || args.length > 1_000_000) {
          throw new Error('Model provider returned an invalid tool call');
        }
        return { id, name, arguments: args };
      });
      return {
        role: 'assistant',
        content,
        toolCalls,
        usage: body.usage ?? null,
        rawFinishReason: body.choices?.[0]?.finish_reason,
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export class OfflineProvider {
  constructor(config = {}) {
    this.config = config;
  }

  get configured() {
    return true;
  }

  async complete({ messages }) {
    const user = [...messages].reverse().find((message) => message.role === 'user');
    return {
      role: 'assistant',
      content: `The runtime is in offline mode. Your request has been saved as a persistent goal: ${user?.content ?? 'No content provided'}. Configure a model to continue reasoning and using tools.`,
      toolCalls: [],
      usage: null,
      rawFinishReason: 'stop',
    };
  }
}

export function createProviderRegistry() {
  return new ProviderRegistry()
    .register('openai-compatible', (config) => new OpenAICompatibleProvider(config))
    .register('offline', (config) => new OfflineProvider(config));
}
