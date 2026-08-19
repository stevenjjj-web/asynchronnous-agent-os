export class SandboxRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(name, adapter) {
    if (!name || typeof adapter?.execute !== 'function') throw new Error('A sandbox adapter requires a name and execute function');
    if (this.adapters.has(name)) throw new Error(`Sandbox adapter already registered: ${name}`);
    if (adapter.isolation && !['process', 'container', 'microvm'].includes(adapter.isolation)) {
      throw new Error(`Unsupported sandbox isolation level: ${adapter.isolation}`);
    }
    this.adapters.set(name, { name, description: '', isolation: 'none', ...adapter });
    return this;
  }

  list() {
    return [...this.adapters.values()].map(({ execute, ...adapter }) => adapter);
  }

  has(name) {
    return this.adapters.has(name);
  }

  isStrong(name) {
    return ['process', 'container', 'microvm'].includes(this.adapters.get(name)?.isolation);
  }

  async run(name, input) {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`Sandbox adapter is unavailable: ${name}`);
    return adapter.execute(input);
  }
}
