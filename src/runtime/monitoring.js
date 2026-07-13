import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { safeFetchText } from '../agent/workspace-tools.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sameState(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function resolveWorkspaceDirectory(workspace, requested) {
  const root = realpathSync(workspace);
  const target = resolve(root, requested);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Monitor path escapes the workspace');
  mkdirSync(target, { recursive: true });
  const actual = realpathSync(target);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error('Monitor path resolves outside the workspace');
  return actual;
}

export class SensorRegistry {
  constructor() {
    this.sensors = new Map();
  }

  register(type, sensor) {
    if (!type || typeof sensor?.poll !== 'function') throw new Error('A sensor requires a type and poll()');
    if (this.sensors.has(type)) throw new Error(`Sensor already registered: ${type}`);
    this.sensors.set(type, { type, description: '', ...sensor });
    return this;
  }

  get(type) {
    return this.sensors.get(type) ?? null;
  }

  list() {
    return [...this.sensors.values()].map(({ poll, ...sensor }) => sensor);
  }
}

export function createBuiltinSensors() {
  return new SensorRegistry()
    .register('workspace_inbox', {
      description: 'Detects files added to an agent workspace inbox directory.',
      async poll({ monitor, agent }) {
        const directory = resolveWorkspaceDirectory(agent.workspace, monitor.config.path ?? 'inbox');
        const files = readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => {
            const stats = statSync(resolve(directory, entry.name));
            return { name: entry.name, size: stats.size, modifiedAt: stats.mtimeMs };
          })
          .sort((left, right) => left.name.localeCompare(right.name));
        const previousNames = new Set((monitor.lastState?.files ?? []).map((file) => file.name));
        const added = files.filter((file) => !previousNames.has(file.name));
        return {
          state: { files },
          changed: monitor.lastState ? added.length > 0 : Boolean(monitor.config.triggerOnInitial && files.length),
          summary: added.length ? `New inbox files: ${added.map((file) => file.name).join(', ')}` : 'Inbox unchanged',
          observation: { added },
        };
      },
    })
    .register('https', {
      description: 'Detects changes in a public HTTPS text resource.',
      async poll({ monitor }) {
        const response = await safeFetchText(monitor.config.url, {
          maxChars: monitor.config.maxChars ?? 100_000,
          timeoutMs: monitor.config.timeoutMs ?? 15_000,
        });
        const hash = createHash('sha256').update(response.content).digest('hex');
        const state = { hash, etag: response.etag, lastModified: response.lastModified, url: response.url };
        return {
          state,
          changed: monitor.lastState ? monitor.lastState.hash !== hash : Boolean(monitor.config.triggerOnInitial),
          summary: monitor.lastState?.hash === hash ? 'Resource unchanged' : `Resource changed: ${response.url}`,
          observation: { preview: response.content.slice(0, 2_000), ...state },
        };
      },
    });
}

export class MonitoringService {
  constructor({ store, eventBus, sessions, sensors, config }) {
    this.store = store;
    this.eventBus = eventBus;
    this.sessions = sessions;
    this.sensors = sensors;
    this.config = config;
    this.startedAt = Date.now();
    this.lastPulseAt = 0;
    this.pulseSequence = 0;
    this.active = new Map();
  }

  ensureDefaults() {
    if (!this.config.sensing.enabled || !this.config.sensing.defaultInboxMonitor) return;
    for (const agent of this.store.listAgents()) {
      const exists = this.store.listMonitors({
        agentId: agent.id, tenantId: this.config.security.tenantId,
      }).some((monitor) => (
        monitor.sensor_type === 'workspace_inbox' && monitor.config.systemDefault === true
      ));
      if (!exists) {
        this.store.createMonitor({
          agentId: agent.id,
          tenantId: this.config.security.tenantId,
          name: 'Workspace inbox',
          sensorType: 'workspace_inbox',
          intervalMs: this.config.sensing.inboxPollMs,
          config: {
            path: 'inbox',
            triggerOnInitial: false,
            autoGoal: true,
            systemDefault: true,
          },
        });
      }
    }
  }

  tick() {
    if (!this.config.sensing.enabled) return;
    this.pulse();
    this.store.recoverExpiredMonitorLeases();
    const capacity = Math.max(0, this.config.sensing.monitorConcurrency - this.active.size);
    for (const candidate of this.store.getDueMonitors(capacity, this.config.security.tenantId)) {
      const monitor = this.store.claimMonitor(candidate.id, this.config.runtime.leaseMs);
      if (!monitor) continue;
      const execution = this.run(monitor).finally(() => this.active.delete(monitor.id));
      this.active.set(monitor.id, execution);
    }
  }

  pulse() {
    const timestamp = Date.now();
    if (timestamp - this.lastPulseAt < this.config.sensing.pulseMs) return;
    this.lastPulseAt = timestamp;
    this.pulseSequence += 1;
    const stats = this.store.getStats();
    this.store.setSystemState('runtime.pulse', {
      status: 'alive',
      startedAt: this.startedAt,
      lastPulseAt: timestamp,
      sequence: this.pulseSequence,
      activeThreads: ['CREATED', 'READY', 'RUNNING', 'WAITING', 'BLOCKED', 'PAUSED']
        .reduce((sum, status) => sum + (stats.tasks[status] ?? 0), 0),
      running: stats.tasks.RUNNING ?? 0,
      waiting: stats.tasks.WAITING ?? 0,
      ready: stats.tasks.READY ?? 0,
      enabledMonitors: stats.enabledMonitors,
    });
    this.eventBus.emit('change', {
      type: 'SYSTEM_PULSE',
      data: { sequence: this.pulseSequence, at: timestamp },
      at: timestamp,
    });
  }

  async run(monitor) {
    const sensor = this.sensors.get(monitor.sensor_type);
    if (!sensor) {
      this.store.failMonitor(monitor.id, monitor.lease_token, `Unknown sensor: ${monitor.sensor_type}`);
      return;
    }
    try {
      const agent = this.store.getAgent(monitor.agent_id);
      const result = await sensor.poll({ monitor, agent, store: this.store });
      const changed = result.changed ?? !sameState(monitor.lastState, result.state);
      const completed = this.store.completeMonitor(monitor.id, monitor.lease_token, {
        state: result.state,
        changed,
        summary: result.summary,
        recordUnchanged: monitor.config.recordUnchanged === true,
      });
      if (!completed || !changed) return;
      const event = this.eventBus.publish({
        topic: 'monitor.changed',
        correlationKey: monitor.id,
        payload: {
          monitorId: monitor.id,
          name: monitor.name,
          sensorType: monitor.sensor_type,
          summary: result.summary,
          observation: result.observation,
          revision: completed.revision,
        },
        source: `monitor:${monitor.id}`,
        idempotencyKey: `monitor:${monitor.id}:revision:${completed.revision}`,
        tenantId: monitor.tenant_id,
        agentId: monitor.agent_id,
        authenticated: true,
        authSubject: `sensor:${monitor.sensor_type}`,
      });
      if (monitor.config.autoGoal) {
        const session = this.sessions.getOrCreate({
          agentId: monitor.agent_id,
          tenantId: monitor.tenant_id,
          channel: 'internal',
          peerKey: `monitor:${monitor.id}`,
          metadata: { monitorId: monitor.id },
        });
        const objective = monitor.config.objectiveTemplate
          ? monitor.config.objectiveTemplate.replace('{{summary}}', result.summary ?? '')
          : `A background monitor detected a change. Review and act on this observation:\n${result.summary}`;
        await this.sessions.submit({
          sessionKey: session.session_key,
          text: objective,
          messageId: `monitor:${monitor.id}:revision:${completed.revision}`,
          provenance: `monitor:${monitor.id}`,
          capabilities: monitor.config.capabilities ?? {
            tools: ['memory_search', 'goal_status', 'monitor_status', 'workspace_list', 'workspace_read'],
            resourcePools: ['default', 'memory', 'filesystem'],
            filesystem: { roots: ['.'], operations: ['list', 'read'] },
            network: { domains: [], methods: [] },
            accounts: {},
            dataScopes: ['agent:self'],
            credentialRefs: [],
          },
          budget: monitor.config.budget ?? {
            maxInputTokens: 12_000,
            maxOutputTokens: 2_000,
            maxCostUsd: 0.1,
            maxToolCalls: 8,
            maxWallTimeMs: 300_000,
            maxContextChars: 30_000,
            maxFanOut: 1,
            maxDepth: 1,
          },
        });
      }
      return event;
    } catch (error) {
      this.store.failMonitor(monitor.id, monitor.lease_token, error instanceof Error ? error.message : String(error));
    }
  }

  runNow(id) {
    this.store.triggerMonitor(id);
    this.tick();
  }

  async stop() {
    await Promise.allSettled(this.active.values());
  }
}
