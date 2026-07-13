export class ChannelRegistry {
  constructor({ hooks, eventBus, store, tenantId = 'default' }) {
    this.channels = new Map();
    this.hooks = hooks;
    this.eventBus = eventBus;
    this.store = store;
    this.tenantId = tenantId;
  }

  register(id, adapter) {
    if (this.channels.has(id)) throw new Error(`Channel already registered: ${id}`);
    if (typeof adapter.send !== 'function' && typeof adapter.listen !== 'function' && adapter.inbound !== true) {
      throw new Error(`Channel ${id} must implement send(), listen(), or declare inbound support`);
    }
    this.channels.set(id, { id, ...adapter });
    return this;
  }

  list() {
    return [...this.channels.values()].map(({ send, listen, ...channel }) => ({
      ...channel,
      canSend: typeof send === 'function',
      canListen: typeof listen === 'function',
      canReceive: channel.inbound === true || typeof listen === 'function',
    }));
  }

  has(id) {
    return this.channels.has(id);
  }

  correlationKey(channelId, accountId, threadKey) {
    return [channelId, accountId, threadKey].map((value) => encodeURIComponent(String(value))).join(':');
  }

  ingest(channelId, input) {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Unknown inbound channel: ${channelId}`);
    if (channel.inbound !== true && typeof channel.listen !== 'function') {
      throw new Error(`Channel does not accept inbound messages: ${channelId}`);
    }
    const messageId = String(input.messageId ?? '').trim();
    const accountId = String(input.accountId ?? '').trim();
    const threadKey = String(input.threadKey ?? '').trim();
    if (!messageId || !accountId || !threadKey) {
      throw new Error('Inbound channel messages require messageId, accountId, and threadKey');
    }
    const tenantId = input.tenantId ?? this.tenantId;
    if (tenantId !== this.tenantId) throw new Error('Inbound channel message has invalid tenant ownership');
    const recorded = this.store.recordChannelMessage({
      channelId,
      messageId,
      accountId,
      threadKey,
      sender: input.sender == null ? null : String(input.sender),
      text: input.text == null ? null : String(input.text),
      payload: input.payload ?? {},
      tenantId,
      agentId: input.agentId ?? 'main',
      receivedAt: input.receivedAt,
    });
    if (recorded.message.status === 'DELIVERED') return { ...recorded, event: null };
    return { ...recorded, ...this.deliverInbound(recorded.message) };
  }

  deliverInbound(message) {
    const result = this.eventBus.publish({
      topic: 'channel.message',
      correlationKey: this.correlationKey(message.channel_id, message.account_id, message.thread_key),
      payload: {
        channel: message.channel_id,
        accountId: message.account_id,
        threadKey: message.thread_key,
        messageId: message.external_message_id,
        sender: message.sender,
        text: message.text,
        data: message.payload,
        receivedAt: message.received_at,
      },
      source: `channel:${message.channel_id}`,
      idempotencyKey: `channel-message:${message.id}`,
      tenantId: message.tenant_id,
      agentId: message.agent_id,
      authenticated: true,
      authSubject: `channel:${message.channel_id}:${message.account_id}`,
    });
    this.store.markChannelMessageDelivered(message.id, result.event.id);
    return result;
  }

  reconcileInbound(limit = 50) {
    const pending = this.store.listChannelMessages({ status: 'PENDING', tenantId: this.tenantId, limit });
    return pending.map((message) => this.deliverInbound(message));
  }

  async send(record) {
    const channel = this.channels.get(record.channel);
    if (!channel) throw new Error(`Unknown delivery channel: ${record.channel}`);
    if (typeof channel.send !== 'function') throw new Error(`Channel does not support outbound delivery: ${record.channel}`);
    const prepared = await this.hooks.emit('message_sending', { record, payload: record.payload });
    if (prepared.cancelled) throw new Error('Outbound message cancelled by policy');
    const result = await channel.send({ ...record, payload: prepared.payload ?? record.payload });
    await this.hooks.emit('message_sent', { record, result });
    this.eventBus.emit('change', {
      type: 'MESSAGE_DELIVERED',
      data: { outboxId: record.id, sessionId: record.session_id, channel: record.channel },
      at: Date.now(),
    });
    return result;
  }
}

export class OutboxDispatcher {
  constructor({ store, channels }) {
    this.store = store;
    this.channels = channels;
    this.draining = false;
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const record of this.store.getDueOutbox(20)) {
        try {
          await this.channels.send(record);
          this.store.markOutboxDelivered(record.id);
        } catch (error) {
          this.store.markOutboxFailed(record.id, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
