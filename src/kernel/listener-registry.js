export class ListenerRegistry {
  constructor({ eventBus, store, tenantId = 'default' }) {
    this.eventBus = eventBus;
    this.store = store;
    this.tenantId = tenantId;
    this.listeners = new Map();
  }

  register(name, listener) {
    if (!name || typeof listener?.run !== 'function') throw new Error('A listener requires a name and run function');
    if (this.listeners.has(name)) throw new Error(`Listener already registered: ${name}`);
    this.listeners.set(name, { name, description: '', ...listener });
    return this;
  }

  list() {
    return [...this.listeners.values()].map(({ run, ...listener }) => listener);
  }

  definitions() {
    return [...this.listeners.values()].map((listener) => ({
      name: `listener:${listener.name}`,
      metadata: { role: 'external-event-listener', listener: listener.name, description: listener.description },
      run: (context) => listener.run({
        ...context,
        store: this.store,
        publish: (event) => this.eventBus.publish({
          ...event,
          source: event.source ?? `listener:${listener.name}`,
          tenantId: event.tenantId ?? this.tenantId,
          agentId: event.agentId ?? 'main',
          authenticated: event.authenticated ?? true,
          authSubject: event.authSubject ?? `listener:${listener.name}`,
        }),
      }),
    }));
  }
}
