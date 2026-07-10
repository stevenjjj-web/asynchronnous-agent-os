export class ChannelRegistry {
  constructor({ hooks, eventBus }) {
    this.channels = new Map();
    this.hooks = hooks;
    this.eventBus = eventBus;
  }

  register(id, adapter) {
    if (this.channels.has(id)) throw new Error(`Channel already registered: ${id}`);
    if (typeof adapter.send !== 'function') throw new Error(`Channel ${id} must implement send()`);
    this.channels.set(id, { id, ...adapter });
    return this;
  }

  list() {
    return [...this.channels.values()].map(({ send, ...channel }) => channel);
  }

  async send(record) {
    const channel = this.channels.get(record.channel);
    if (!channel) throw new Error(`Unknown delivery channel: ${record.channel}`);
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
