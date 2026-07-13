export class ResourcePoolManager {
  constructor(capacities = {}) {
    this.pools = new Map(Object.entries(capacities).map(([name, capacity]) => [name, {
      name,
      capacity: Math.max(1, Number(capacity)),
      active: 0,
      queue: [],
    }]));
  }

  ensure(name) {
    if (!this.pools.has(name)) this.pools.set(name, { name, capacity: 1, active: 0, queue: [] });
    return this.pools.get(name);
  }

  async run(name, operation, signal) {
    const pool = this.ensure(name ?? 'default');
    await this.acquire(pool, signal);
    try {
      if (signal?.aborted) throw signal.reason ?? new Error('Resource acquisition was interrupted');
      return await operation();
    } finally {
      pool.active -= 1;
      this.drain(pool);
    }
  }

  acquire(pool, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Resource acquisition was interrupted'));
    if (pool.active < pool.capacity) {
      pool.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null };
      entry.onAbort = () => {
        const index = pool.queue.indexOf(entry);
        if (index >= 0) pool.queue.splice(index, 1);
        reject(signal.reason ?? new Error('Resource acquisition was interrupted'));
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      pool.queue.push(entry);
    });
  }

  drain(pool) {
    while (pool.active < pool.capacity && pool.queue.length) {
      const entry = pool.queue.shift();
      entry.signal?.removeEventListener('abort', entry.onAbort);
      if (entry.signal?.aborted) {
        entry.reject(entry.signal.reason ?? new Error('Resource acquisition was interrupted'));
        continue;
      }
      pool.active += 1;
      entry.resolve();
    }
  }

  status() {
    return [...this.pools.values()].map((pool) => ({
      name: pool.name,
      capacity: pool.capacity,
      active: pool.active,
      queued: pool.queue.length,
    }));
  }
}
