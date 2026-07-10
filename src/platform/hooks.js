export class HookBus {
  constructor() {
    this.handlers = new Map();
  }

  on(name, handler, { priority = 0 } = {}) {
    const entries = this.handlers.get(name) ?? [];
    entries.push({ handler, priority });
    entries.sort((a, b) => b.priority - a.priority);
    this.handlers.set(name, entries);
    return () => this.off(name, handler);
  }

  off(name, handler) {
    this.handlers.set(name, (this.handlers.get(name) ?? []).filter((entry) => entry.handler !== handler));
  }

  async emit(name, event) {
    let current = event;
    for (const { handler } of this.handlers.get(name) ?? []) {
      const result = await handler(current);
      if (result?.cancel) return { ...current, ...result, cancelled: true };
      if (result?.patch) current = { ...current, ...result.patch };
    }
    return current;
  }
}
