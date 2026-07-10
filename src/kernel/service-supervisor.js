import { randomUUID } from 'node:crypto';

export class ServiceSupervisor {
  constructor({ store, heartbeatMs = 1_000, serviceTimeoutMs = 15_000 }) {
    this.store = store;
    this.heartbeatMs = heartbeatMs;
    this.serviceTimeoutMs = serviceTimeoutMs;
    this.id = `kernel:${randomUUID()}`;
    this.startedAt = null;
    this.definitions = new Map();
    this.services = new Map();
    this.watchdog = null;
    this.stopping = false;
  }

  register(name, run, metadata = {}) {
    if (!name || typeof run !== 'function') throw new Error('A resident service requires a name and run function');
    if (this.definitions.has(name)) throw new Error(`Resident service already registered: ${name}`);
    this.definitions.set(name, { name, run, metadata });
    return this;
  }

  start() {
    if (this.startedAt) return this;
    this.stopping = false;
    const lease = this.store.acquireKernelLease(this.id, this.serviceTimeoutMs);
    if (!lease.acquired) {
      throw new Error(`Another Agent OS kernel is alive (pid ${lease.holder.host_pid}, owner ${lease.holder.owner_id})`);
    }
    this.startedAt = Date.now();
    const recovered = this.store.recoverKernelProcesses('A new kernel generation recovered this process record');
    this.store.startKernelProcess({
      id: this.id,
      name: 'Agent OS Kernel',
      kind: 'kernel',
      hostPid: process.pid,
      metadata: { recovered, serviceCount: this.definitions.size },
    });
    for (const definition of this.definitions.values()) this.launch(definition, 1, 0);
    this.watchdog = setInterval(() => this.pulse(), this.heartbeatMs);
    this.pulse();
    return this;
  }

  launch(definition, generation, restartCount) {
    if (this.stopping) return;
    const id = `${this.id}:service:${definition.name}:${generation}`;
    const controller = new AbortController();
    const entry = {
      id,
      name: definition.name,
      generation,
      restartCount,
      controller,
      lastHeartbeatAt: Date.now(),
      metadata: { ...definition.metadata },
      status: 'running',
      promise: null,
    };
    this.services.set(definition.name, entry);
    this.store.startKernelProcess({
      id,
      parentId: this.id,
      name: definition.name,
      kind: 'resident-service',
      hostPid: process.pid,
      generation,
      restartCount,
      metadata: entry.metadata,
    });

    const heartbeat = (metadata = {}) => {
      if (controller.signal.aborted) return;
      entry.lastHeartbeatAt = Date.now();
      entry.metadata = { ...entry.metadata, ...metadata };
      this.store.heartbeatKernelProcess(id, entry.metadata);
    };

    entry.promise = (async () => {
      try {
        await definition.run({ signal: controller.signal, heartbeat, serviceId: id });
        if (controller.signal.aborted && !this.stopping) {
          throw controller.signal.reason ?? new Error(`Resident service was aborted: ${definition.name}`);
        }
        if (!controller.signal.aborted) throw new Error(`Resident service exited unexpectedly: ${definition.name}`);
        entry.status = 'stopped';
        this.store.stopKernelProcess(id, 'STOPPED');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.status = this.stopping ? 'stopped' : 'failed';
        this.store.stopKernelProcess(id, this.stopping ? 'STOPPED' : 'FAILED', this.stopping ? null : message);
        if (!this.stopping) {
          const delayMs = Math.min(30_000, 250 * 2 ** Math.min(restartCount, 7));
          setTimeout(() => this.launch(definition, generation + 1, restartCount + 1), delayMs);
        }
      }
    })();
  }

  pulse() {
    if (this.stopping) return;
    const timestamp = Date.now();
    if (!this.store.renewKernelLease(this.id, this.serviceTimeoutMs)) {
      this.store.setSystemState('kernel.daemon', { ...this.status(), status: 'lease-lost', detectedAt: timestamp });
      void this.stop();
      return;
    }
    for (const entry of this.services.values()) {
      if (entry.status === 'running' && !entry.controller.signal.aborted && timestamp - entry.lastHeartbeatAt > this.serviceTimeoutMs) {
        entry.status = 'stopping';
        entry.controller.abort(new Error(`Resident service heartbeat expired: ${entry.name}`));
      }
    }
    const status = this.status();
    this.store.heartbeatKernelProcess(this.id, status);
    this.store.setSystemState('kernel.daemon', status);
  }

  status() {
    return {
      status: this.stopping ? 'stopping' : 'alive',
      processId: this.id,
      hostPid: process.pid,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      services: [...this.services.values()].map((entry) => ({
        id: entry.id,
        name: entry.name,
        generation: entry.generation,
        restartCount: entry.restartCount,
        lastHeartbeatAt: entry.lastHeartbeatAt,
        status: entry.status,
        metadata: entry.metadata,
      })),
    };
  }

  async stop() {
    if (!this.startedAt || this.stopping) return;
    this.stopping = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const entry of this.services.values()) {
      entry.status = 'stopping';
      entry.controller.abort(new Error('Kernel is stopping'));
    }
    await Promise.allSettled([...this.services.values()].map((entry) => entry.promise));
    this.store.stopKernelProcess(this.id, 'STOPPED');
    this.store.releaseKernelLease(this.id);
    this.store.setSystemState('kernel.daemon', { ...this.status(), status: 'stopped', stoppedAt: Date.now() });
  }
}
