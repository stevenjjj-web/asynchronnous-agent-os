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
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature,
          ...(Number.isFinite(maxTokens) ? { max_tokens: Math.floor(maxTokens) } : {}),
          ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1_000);
        throw new Error(`Model provider returned ${response.status}: ${detail}`);
      }
      const body = await response.json();
      const message = body.choices?.[0]?.message;
      if (!message) throw new Error('Model provider returned no assistant message');
      return {
        role: 'assistant',
        content: message.content ?? '',
        toolCalls: (message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments ?? '{}',
        })),
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
