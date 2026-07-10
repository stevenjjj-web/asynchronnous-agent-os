import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { GoalStatus, TaskStatus, TERMINAL_TASK_STATUSES, WaitKind } from '../domain/states.js';

const now = () => Date.now();
const encode = (value) => JSON.stringify(value ?? null);
const decode = (value, fallback = null) => {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

function hydrateGoal(row) {
  if (!row) return null;
  return { ...row, metadata: decode(row.metadata_json, {}) };
}

function hydrateTask(row) {
  if (!row) return null;
  return {
    ...row,
    workflow: decode(row.workflow_json, []),
    snapshot: decode(row.snapshot_json, { pc: 0, variables: {} }),
    result: decode(row.result_json),
    dependsOn: decode(row.depends_on_json, []),
  };
}

function hydrateEvent(row) {
  if (!row) return null;
  return { ...row, payload: decode(row.payload_json, {}) };
}

function hydrateAudit(row) {
  if (!row) return null;
  return { ...row, data: decode(row.data_json, {}) };
}

function hydrateSession(row) {
  if (!row) return null;
  return { ...row, metadata: decode(row.metadata_json, {}) };
}

function hydrateMessage(row) {
  if (!row) return null;
  return { ...row, content: decode(row.content_json, {}) };
}

function hydrateMemory(row) {
  if (!row) return null;
  return { ...row, tags: decode(row.tags_json, []) };
}

function hydrateApproval(row) {
  if (!row) return null;
  return { ...row, parameters: decode(row.parameters_json, {}), resolution: decode(row.resolution_json) };
}

function hydrateSchedule(row) {
  if (!row) return null;
  return { ...row, payload: decode(row.payload_json, {}) };
}

function hydrateOutbox(row) {
  if (!row) return null;
  return { ...row, payload: decode(row.payload_json, {}) };
}

function hydrateMonitor(row) {
  if (!row) return null;
  return {
    ...row,
    config: decode(row.config_json, {}),
    lastState: decode(row.last_state_json),
  };
}

function hydrateInterrupt(row) {
  if (!row) return null;
  return { ...row, payload: decode(row.payload_json, {}) };
}

function hydrateKernelProcess(row) {
  if (!row) return null;
  return { ...row, metadata: decode(row.metadata_json, {}) };
}

function hydrateGoalContract(row) {
  if (!row) return null;
  return {
    ...row,
    budget: decode(row.budget_json, {}),
    usage: decode(row.usage_json, {}),
    capabilities: decode(row.capabilities_json, {}),
  };
}

function hydrateOperation(row) {
  if (!row) return null;
  return {
    ...row,
    request: decode(row.request_json, {}),
    prepared: decode(row.prepared_json),
    result: decode(row.result_json),
    reconciliation: decode(row.reconciliation_json),
    compensation: decode(row.compensation_json),
  };
}

function hydrateAttentionAssessment(row) {
  if (!row) return null;
  return { ...row, signals: decode(row.signals_json, {}), decision: decode(row.decision_json, {}) };
}

function hydrateCredentialRef(row) {
  if (!row) return null;
  return { ...row, metadata: decode(row.metadata_json, {}) };
}

export class Store {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'workflow',
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 50,
        workflow_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        result_json TEXT,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        wait_kind TEXT,
        wait_topic TEXT,
        wait_key TEXT,
        wake_at INTEGER,
        lease_owner TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_run_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_runnable
        ON tasks(status, next_run_at, priority DESC, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_waiting_event
        ON tasks(status, wait_topic, wait_key);
      CREATE INDEX IF NOT EXISTS idx_tasks_waiting_timer
        ON tasks(status, wake_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id, created_at);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        correlation_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_match
        ON events(topic, correlation_key, created_at);

      CREATE TABLE IF NOT EXISTS event_deliveries (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        delivered_at INTEGER NOT NULL,
        PRIMARY KEY(event_id, task_id)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_goal ON audit_log(goal_id, id DESC);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace TEXT NOT NULL,
        model_key TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        peer_key TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        last_interaction_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        run_id TEXT,
        provenance TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at, id);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        tags_json TEXT NOT NULL DEFAULT '[]',
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        goal_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        risk TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by TEXT,
        resolution_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at DESC);

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        schedule_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        interval_ms INTEGER,
        next_run_at INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        last_goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        channel TEXT NOT NULL,
        target TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        idempotency_key TEXT UNIQUE,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS monitors (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sensor_type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        next_poll_at INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'IDLE',
        lease_token TEXT,
        lease_expires_at INTEGER,
        last_state_json TEXT,
        last_observation_at INTEGER,
        last_changed_at INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors(enabled, status, next_poll_at);

      CREATE TABLE IF NOT EXISTS monitor_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        changed INTEGER NOT NULL,
        summary TEXT NOT NULL,
        state_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_monitor_observations ON monitor_observations(monitor_id, id DESC);

      CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kernel_processes (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES kernel_processes(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        host_pid INTEGER,
        generation INTEGER NOT NULL DEFAULT 1,
        restart_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        started_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        stopped_at INTEGER,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kernel_processes_status
        ON kernel_processes(status, heartbeat_at DESC);

      CREATE TABLE IF NOT EXISTS kernel_leases (
        lease_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        host_pid INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interrupts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        target_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        dispatched_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        priority INTEGER NOT NULL,
        force INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        requested_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        handled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_interrupts_pending
        ON interrupts(status, priority DESC, requested_at ASC);

      CREATE TABLE IF NOT EXISTS goal_contracts (
        goal_id TEXT PRIMARY KEY REFERENCES goals(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        parent_goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        deadline_at INTEGER,
        budget_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        capability_status TEXT NOT NULL DEFAULT 'ACTIVE',
        capability_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_contracts_deadline
        ON goal_contracts(deadline_at, capability_status);

      CREATE TABLE IF NOT EXISTS resource_usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        amount REAL NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_resource_usage_scope
        ON resource_usage_ledger(tenant_id, agent_id, resource_type, created_at);

      CREATE TABLE IF NOT EXISTS capability_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credential_refs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        locator TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        expires_at INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        mode TEXT NOT NULL,
        resource_pool TEXT NOT NULL,
        state TEXT NOT NULL,
        request_json TEXT NOT NULL,
        prepared_json TEXT,
        result_json TEXT,
        reconciliation_json TEXT,
        compensation_json TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        reconcile_attempt INTEGER NOT NULL DEFAULT 0,
        next_reconcile_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        compensated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_operations_reconcile
        ON operations(state, next_reconcile_at);

      CREATE TABLE IF NOT EXISTS attention_assessments (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        score REAL NOT NULL,
        expected_value REAL NOT NULL,
        estimated_cost REAL NOT NULL,
        signals_json TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attention_assessments_agent
        ON attention_assessments(agent_id, created_at DESC);
    `);

    this.ensureColumn('goals', 'agent_id', "TEXT NOT NULL DEFAULT 'main'");
    this.ensureColumn('goals', 'session_id', 'TEXT');
    this.ensureColumn('goals', 'revision', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('goals', 'tenant_id', "TEXT NOT NULL DEFAULT 'default'");
    this.ensureColumn('goals', 'deadline_at', 'INTEGER');
    this.ensureColumn('tasks', 'session_id', 'TEXT');
    this.ensureColumn('tasks', 'lease_token', 'TEXT');
    this.ensureColumn('tasks', 'lease_expires_at', 'INTEGER');
    this.ensureColumn('tasks', 'pause_requested', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('tasks', 'cancel_requested', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('tasks', 'paused_from_status', 'TEXT');
    this.ensureColumn('tasks', 'revision', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('tasks', 'preempt_requested', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('tasks', 'preempt_reason', 'TEXT');
    this.ensureColumn('tasks', 'preempted_by', 'TEXT');
    this.ensureColumn('tasks', 'preemption_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('events', 'expires_at', 'INTEGER');
    this.ensureColumn('events', 'tenant_id', 'TEXT');
    this.ensureColumn('events', 'agent_id', 'TEXT');
    this.ensureColumn('events', 'nonce', 'TEXT');
    this.ensureColumn('events', 'authenticated', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('events', 'auth_subject', 'TEXT');
    this.ensureColumn('sessions', 'tenant_id', "TEXT NOT NULL DEFAULT 'default'");
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_nonce ON events(source, nonce) WHERE nonce IS NOT NULL');

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          content,
          tags,
          content='memories',
          content_rowid='rowid',
          tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags_json);
          INSERT INTO memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags_json);
        END;
      `);
      const memoryCount = this.db.prepare('SELECT COUNT(*) AS count FROM memories').get().count;
      const ftsCount = this.db.prepare('SELECT COUNT(*) AS count FROM memory_fts').get().count;
      if (memoryCount !== ftsCount) this.db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
      this.memoryFts = true;
    } catch {
      this.memoryFts = false;
    }
    this.db.exec('PRAGMA user_version = 5');
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createGoalWithTasks(goalInput, taskInputs) {
    return this.transaction(() => {
      const timestamp = now();
      const goalId = goalInput.id ?? randomUUID();
      const contract = goalInput.contract ?? {
        tenantId: goalInput.tenantId ?? 'default',
        agentId: goalInput.agentId ?? 'main',
        parentGoalId: goalInput.metadata?.parentGoalId ?? null,
        deadlineAt: goalInput.deadlineAt ?? null,
        budget: {
          maxInputTokens: 1_000_000,
          maxOutputTokens: 1_000_000,
          maxCostUsd: 100,
          maxToolCalls: 10_000,
          maxWallTimeMs: 86_400_000,
          maxContextChars: 200_000,
          maxFanOut: 100,
          maxDepth: 10,
        },
        capabilities: {
          tools: ['*'],
          resourcePools: ['*'],
          filesystem: { roots: ['.'], operations: ['list', 'read', 'write', 'delete'] },
          network: { domains: ['*'], methods: ['GET'] },
          accounts: {},
          dataScopes: ['agent:self'],
          credentialRefs: [],
        },
      };
      this.db.prepare(`
        INSERT INTO goals(
          id, title, objective, status, metadata_json, agent_id, session_id,
          tenant_id, deadline_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        goalId,
        goalInput.title,
        goalInput.objective,
        GoalStatus.ACTIVE,
        encode(goalInput.metadata ?? {}),
        goalInput.agentId ?? 'main',
        goalInput.sessionId ?? null,
        contract.tenantId ?? goalInput.tenantId ?? 'default',
        contract.deadlineAt ?? goalInput.deadlineAt ?? null,
        timestamp,
        timestamp,
      );

      const tasks = taskInputs.map((input) => {
        const taskId = input.id ?? randomUUID();
        const dependencies = input.dependsOn ?? [];
        const status = dependencies.length ? TaskStatus.BLOCKED : TaskStatus.READY;
        const snapshot = input.snapshot ?? { pc: 0, variables: {}, checkpoints: [] };
        this.db.prepare(`
          INSERT INTO tasks(
            id, goal_id, title, kind, status, priority, workflow_json, snapshot_json,
            depends_on_json, session_id, max_attempts, next_run_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          goalId,
          input.title,
          input.kind ?? 'workflow',
          status,
          input.priority ?? 50,
          encode(input.workflow ?? []),
          encode(snapshot),
          encode(dependencies),
          input.sessionId ?? goalInput.sessionId ?? null,
          input.maxAttempts ?? 3,
          timestamp,
          timestamp,
          timestamp,
        );
        this.appendAudit(goalId, taskId, 'TASK_CREATED', `${input.title} was created`, { status, priority: input.priority ?? 50 });
        return this.getTask(taskId);
      });

      this.db.prepare(`
        INSERT INTO goal_contracts(
          goal_id, agent_id, tenant_id, parent_goal_id, deadline_at,
          budget_json, usage_json, capabilities_json, capability_status,
          capability_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
      `).run(
        goalId,
        contract.agentId ?? goalInput.agentId ?? 'main',
        contract.tenantId ?? goalInput.tenantId ?? 'default',
        contract.parentGoalId ?? null,
        contract.deadlineAt ?? null,
        encode(contract.budget ?? {}),
        encode(contract.usage ?? {}),
        encode(contract.capabilities ?? {}),
        contract.capabilityExpiresAt ?? null,
        timestamp,
        timestamp,
      );

      this.appendAudit(goalId, null, 'GOAL_CREATED', `Goal "${goalInput.title}" was created`, { taskCount: tasks.length });
      this.appendCapabilityAudit(goalId, 'FROZEN', contract.createdBy ?? 'kernel', {
        parentGoalId: contract.parentGoalId ?? null,
        deadlineAt: contract.deadlineAt ?? null,
      });
      return { goal: this.getGoal(goalId), tasks };
    });
  }

  getGoal(id) {
    return hydrateGoal(this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id));
  }

  listGoals(limit = 30) {
    return this.db.prepare('SELECT * FROM goals ORDER BY created_at DESC LIMIT ?').all(limit).map(hydrateGoal);
  }

  getGoalContract(goalId) {
    return hydrateGoalContract(this.db.prepare('SELECT * FROM goal_contracts WHERE goal_id = ?').get(goalId));
  }

  recordResourceUsage(input) {
    return this.transaction(() => {
      if (input.idempotencyKey) {
        const existing = this.db.prepare('SELECT * FROM resource_usage_ledger WHERE idempotency_key = ?')
          .get(input.idempotencyKey);
        if (existing) return { recorded: false, contract: this.getGoalContract(existing.goal_id), ledger: existing };
      }
      const contract = this.getGoalContract(input.goalId);
      if (!contract) throw new Error(`Missing goal contract: ${input.goalId}`);
      const amount = Number(input.amount ?? 0);
      const usage = { ...contract.usage, [input.resourceType]: Number(contract.usage[input.resourceType] ?? 0) + amount };
      this.db.prepare(`
        UPDATE goal_contracts SET usage_json = ?, updated_at = ? WHERE goal_id = ?
      `).run(encode(usage), now(), input.goalId);
      const result = this.db.prepare(`
        INSERT INTO resource_usage_ledger(
          idempotency_key, goal_id, agent_id, tenant_id, resource_type,
          amount, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.idempotencyKey ?? null,
        input.goalId,
        contract.agent_id,
        contract.tenant_id,
        input.resourceType,
        amount,
        encode(input.metadata ?? {}),
        now(),
      );
      const ledger = this.db.prepare('SELECT * FROM resource_usage_ledger WHERE id = ?').get(result.lastInsertRowid);
      return { recorded: true, contract: this.getGoalContract(input.goalId), ledger: { ...ledger, metadata: decode(ledger.metadata_json, {}) } };
    });
  }

  aggregateResourceUsage({ tenantId, agentId, resourceType, since = 0 } = {}) {
    const clauses = ['created_at >= ?'];
    const params = [since];
    if (tenantId) {
      clauses.push('tenant_id = ?');
      params.push(tenantId);
    }
    if (agentId) {
      clauses.push('agent_id = ?');
      params.push(agentId);
    }
    if (resourceType) {
      clauses.push('resource_type = ?');
      params.push(resourceType);
    }
    return Number(this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM resource_usage_ledger
      WHERE ${clauses.join(' AND ')}
    `).get(...params).total);
  }

  appendCapabilityAudit(goalId, action, actor, detail = {}) {
    this.db.prepare(`
      INSERT INTO capability_audit(goal_id, action, actor, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(goalId, action, actor, encode(detail), now());
  }

  listCapabilityAudit(goalId, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM capability_audit WHERE goal_id = ? ORDER BY id DESC LIMIT ?
    `).all(goalId, limit).map((row) => ({ ...row, detail: decode(row.detail_json, {}) }));
  }

  setCapabilityStatus(goalId, status, actor, detail = {}) {
    this.db.prepare(`
      UPDATE goal_contracts SET capability_status = ?, updated_at = ? WHERE goal_id = ?
    `).run(status, now(), goalId);
    this.appendCapabilityAudit(goalId, status, actor, detail);
    return this.getGoalContract(goalId);
  }

  createCredentialRef(input) {
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO credential_refs(
        id, tenant_id, agent_id, provider, locator, status, expires_at,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
    `).run(
      id,
      input.tenantId ?? 'default',
      input.agentId ?? 'main',
      input.provider ?? 'environment',
      input.locator,
      input.expiresAt ?? null,
      encode(input.metadata ?? {}),
      timestamp,
      timestamp,
    );
    return this.getCredentialRef(id);
  }

  getCredentialRef(id) {
    return hydrateCredentialRef(this.db.prepare('SELECT * FROM credential_refs WHERE id = ?').get(id));
  }

  setCredentialRefStatus(id, status) {
    this.db.prepare('UPDATE credential_refs SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    return this.getCredentialRef(id);
  }

  getTask(id) {
    return hydrateTask(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  }

  listTasks(goalId) {
    return this.db.prepare(`
      SELECT * FROM tasks WHERE goal_id = ? ORDER BY priority DESC, created_at ASC
    `).all(goalId).map(hydrateTask);
  }

  listAllTasks({ status, sessionId, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (sessionId) {
      clauses.push('session_id = ?');
      params.push(sessionId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ?
    `).all(...params, limit).map(hydrateTask);
  }

  getGoalView(id) {
    const goal = this.getGoal(id);
    if (!goal) return null;
    return {
      goal,
      tasks: this.listTasks(id),
      audit: this.db.prepare(`
        SELECT * FROM audit_log WHERE goal_id = ? ORDER BY id DESC LIMIT 120
      `).all(id).map(hydrateAudit),
    };
  }

  getReadyTasks(limit = 20) {
    const timestamp = now();
    return this.db.prepare(`
      SELECT t.* FROM tasks t
      JOIN goals g ON g.id = t.goal_id
      WHERE t.status = ? AND t.next_run_at <= ?
      ORDER BY (
        t.priority
        + MIN(30, MAX(0, CAST((? - t.next_run_at) / 1000 AS INTEGER)))
        + CASE
            WHEN g.deadline_at IS NULL THEN 0
            WHEN g.deadline_at <= ? THEN 500
            ELSE MAX(0, 120 - CAST((g.deadline_at - ?) / 30000 AS INTEGER))
          END
      ) DESC, g.deadline_at IS NULL, g.deadline_at ASC, t.next_run_at ASC, t.created_at ASC
      LIMIT ?
    `).all(TaskStatus.READY, timestamp, timestamp, timestamp, timestamp, limit).map(hydrateTask);
  }

  claimTask(id, workerId, leaseMs = 30_000) {
    const timestamp = now();
    const leaseToken = randomUUID();
    const result = this.db.prepare(`
      UPDATE tasks
      SET status = ?, lease_owner = ?, lease_token = ?, lease_expires_at = ?,
          attempt = attempt + 1, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = ? AND next_run_at <= ?
    `).run(TaskStatus.RUNNING, workerId, leaseToken, timestamp + leaseMs, timestamp, id, TaskStatus.READY, timestamp);
    if (!result.changes) return null;
    const task = this.getTask(id);
    this.appendAudit(task.goal_id, id, 'TASK_RUNNING', `${task.title} acquired an execution quantum`, { workerId, attempt: task.attempt });
    return task;
  }

  checkpointTask(id, snapshot, message = 'Reasoning snapshot saved', leaseToken = null) {
    const task = this.getTask(id);
    if (!task) return null;
    const updated = this.db.prepare(`
      UPDATE tasks SET snapshot_json = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND (? IS NULL OR lease_token = ?)
    `).run(encode(snapshot), now(), id, leaseToken, leaseToken);
    if (!updated.changes) return this.getTask(id);
    if (message) this.appendAudit(task.goal_id, id, 'CHECKPOINT_SAVED', message, { pc: snapshot.pc });
    return this.getTask(id);
  }

  yieldTask(id, snapshot, reason = 'Execution quantum yielded', leaseToken = null) {
    const task = this.getTask(id);
    if (!task || task.status !== TaskStatus.RUNNING) return null;
    const updated = this.db.prepare(`
      UPDATE tasks
      SET status = ?, snapshot_json = ?, lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, next_run_at = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = ? AND (? IS NULL OR lease_token = ?)
    `).run(TaskStatus.READY, encode(snapshot), now(), now(), id, TaskStatus.RUNNING, leaseToken, leaseToken);
    if (!updated.changes) return this.getTask(id);
    this.appendAudit(task.goal_id, id, 'TASK_YIELDED', reason, { pc: snapshot.pc });
    return this.getTask(id);
  }

  waitForTimer(id, snapshot, wakeAt, reason, leaseToken = null) {
    const task = this.getTask(id);
    if (!task || task.status !== TaskStatus.RUNNING) return null;
    const updated = this.db.prepare(`
      UPDATE tasks
      SET status = ?, snapshot_json = ?, wait_kind = ?, wake_at = ?, lease_owner = NULL,
          lease_token = NULL, lease_expires_at = NULL, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = ? AND (? IS NULL OR lease_token = ?)
    `).run(TaskStatus.WAITING, encode(snapshot), WaitKind.TIMER, wakeAt, now(), id, TaskStatus.RUNNING, leaseToken, leaseToken);
    if (!updated.changes) return this.getTask(id);
    this.appendAudit(task.goal_id, id, 'TASK_WAITING', reason, { waitKind: WaitKind.TIMER, wakeAt });
    return this.getTask(id);
  }

  waitForEvent(id, snapshot, { topic, correlationKey, deadline }, reason, leaseToken = null) {
    const task = this.getTask(id);
    if (!task || task.status !== TaskStatus.RUNNING) return null;
    const updated = this.db.prepare(`
      UPDATE tasks
      SET status = ?, snapshot_json = ?, wait_kind = ?, wait_topic = ?, wait_key = ?,
          wake_at = ?, lease_owner = NULL, updated_at = ?
          , lease_token = NULL, lease_expires_at = NULL, revision = revision + 1
      WHERE id = ? AND status = ? AND (? IS NULL OR lease_token = ?)
    `).run(
      TaskStatus.WAITING,
      encode(snapshot),
      WaitKind.EVENT,
      topic,
      correlationKey,
      deadline ?? null,
      now(),
      id,
      TaskStatus.RUNNING,
      leaseToken,
      leaseToken,
    );
    if (!updated.changes) return this.getTask(id);
    this.appendAudit(task.goal_id, id, 'TASK_WAITING', reason, {
      waitKind: WaitKind.EVENT,
      topic,
      correlationKey,
      deadline: deadline ?? null,
    });
    return this.getTask(id);
  }

  completeTask(id, snapshot, result, leaseToken = null) {
    const task = this.getTask(id);
    if (!task || task.status !== TaskStatus.RUNNING) return null;
    const timestamp = now();
    const updated = this.db.prepare(`
      UPDATE tasks
      SET status = ?, snapshot_json = ?, result_json = ?, lease_owner = NULL,
          lease_token = NULL, lease_expires_at = NULL,
          wait_kind = NULL, wait_topic = NULL, wait_key = NULL, wake_at = NULL,
          revision = revision + 1, updated_at = ?, completed_at = ?
      WHERE id = ? AND status = ? AND (? IS NULL OR lease_token = ?)
    `).run(TaskStatus.SUCCEEDED, encode(snapshot), encode(result), timestamp, timestamp, id, TaskStatus.RUNNING, leaseToken, leaseToken);
    if (!updated.changes) return this.getTask(id);
    this.appendAudit(task.goal_id, id, 'TASK_SUCCEEDED', `${task.title} completed`, { result });
    this.reconcileBlocked(task.goal_id);
    this.reconcileGoal(task.goal_id);
    return this.getTask(id);
  }

  failTask(id, error, { retryable = true, leaseToken = null } = {}) {
    const task = this.getTask(id);
    if (!task) return null;
    if (leaseToken && task.lease_token !== leaseToken) return task;
    const canRetry = retryable && task.failure_count + 1 < task.max_attempts;
    const status = canRetry ? TaskStatus.READY : TaskStatus.FAILED;
    const backoff = canRetry ? Math.min(30_000, 500 * 2 ** Math.max(0, task.attempt - 1)) : 0;
    const timestamp = now();
    this.db.prepare(`
      UPDATE tasks
      SET status = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          wait_kind = NULL, wait_topic = NULL,
          wait_key = NULL, wake_at = NULL, next_run_at = ?, last_error = ?,
          failure_count = failure_count + 1, revision = revision + 1, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      status,
      timestamp + backoff,
      error instanceof Error ? error.message : String(error),
      timestamp,
      canRetry ? null : timestamp,
      id,
    );
    this.appendAudit(task.goal_id, id, canRetry ? 'TASK_RETRY_SCHEDULED' : 'TASK_FAILED', canRetry ? `Execution failed; retrying in ${backoff}ms` : 'Task execution failed', {
      error: error instanceof Error ? error.message : String(error),
      failureCount: task.failure_count + 1,
      maxAttempts: task.max_attempts,
    });
    if (!canRetry) {
      this.reconcileBlocked(task.goal_id);
      this.reconcileGoal(task.goal_id);
    }
    return this.getTask(id);
  }

  publishEvent(input) {
    return this.transaction(() => {
      const existing = input.idempotencyKey
        ? this.db.prepare('SELECT * FROM events WHERE idempotency_key = ?').get(input.idempotencyKey)
        : input.nonce
          ? this.db.prepare('SELECT * FROM events WHERE source = ? AND nonce = ?').get(input.source ?? 'external', input.nonce)
          : null;
      if (existing) return { event: hydrateEvent(existing), awakened: [], duplicate: true };

      const event = {
        id: input.id ?? randomUUID(),
        topic: input.topic,
        correlationKey: input.correlationKey,
        payload: input.payload ?? {},
        source: input.source ?? 'external',
        idempotencyKey: input.idempotencyKey ?? null,
        tenantId: input.tenantId ?? null,
        agentId: input.agentId ?? null,
        nonce: input.nonce ?? null,
        authenticated: input.authenticated === true,
        authSubject: input.authSubject ?? null,
        createdAt: now(),
      };
      this.db.prepare(`
        INSERT INTO events(
          id, topic, correlation_key, payload_json, source, idempotency_key,
          tenant_id, agent_id, nonce, authenticated, auth_subject, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.topic,
        event.correlationKey,
        encode(event.payload),
        event.source,
        event.idempotencyKey,
        event.tenantId,
        event.agentId,
        event.nonce,
        event.authenticated ? 1 : 0,
        event.authSubject,
        event.createdAt,
      );

      const waiting = this.db.prepare(`
        SELECT t.* FROM tasks t
        JOIN goals g ON g.id = t.goal_id
        WHERE t.status = ? AND t.wait_kind = ? AND t.wait_topic = ? AND t.wait_key = ?
          AND (? IS NULL OR g.tenant_id = ?)
          AND (? IS NULL OR g.agent_id = ?)
      `).all(
        TaskStatus.WAITING,
        WaitKind.EVENT,
        event.topic,
        event.correlationKey,
        event.tenantId,
        event.tenantId,
        event.agentId,
        event.agentId,
      ).map(hydrateTask);

      const awakened = [];
      for (const task of waiting) {
        const snapshot = {
          ...task.snapshot,
          pendingEvent: {
            id: event.id,
            topic: event.topic,
            correlationKey: event.correlationKey,
            payload: event.payload,
            createdAt: event.createdAt,
          },
        };
        this.db.prepare(`
          INSERT OR IGNORE INTO event_deliveries(event_id, task_id, delivered_at) VALUES (?, ?, ?)
        `).run(event.id, task.id, now());
        this.db.prepare(`
          UPDATE tasks
          SET status = ?, snapshot_json = ?, wait_kind = NULL, wait_topic = NULL,
              wait_key = NULL, wake_at = NULL, next_run_at = ?, updated_at = ?
          WHERE id = ? AND status = ?
        `).run(TaskStatus.READY, encode(snapshot), now(), now(), task.id, TaskStatus.WAITING);
        this.appendAudit(task.goal_id, task.id, 'EVENT_RECEIVED', `Event ${event.topic} received; task awakened`, {
          eventId: event.id,
          correlationKey: event.correlationKey,
        });
        awakened.push(task.id);
      }
      return { event, awakened, duplicate: false };
    });
  }

  listEvents({ topic, correlationKey, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (topic) {
      clauses.push('topic = ?');
      params.push(topic);
    }
    if (correlationKey) {
      clauses.push('correlation_key = ?');
      params.push(correlationKey);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ?
    `).all(...params, limit).map(hydrateEvent);
  }

  consumeQueuedEvent(taskId, topic, correlationKey) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const row = this.db.prepare(`
      SELECT e.* FROM events e
      LEFT JOIN event_deliveries d ON d.event_id = e.id AND d.task_id = ?
      WHERE e.topic = ? AND e.correlation_key = ? AND e.created_at >= ? AND d.event_id IS NULL
      ORDER BY e.created_at ASC LIMIT 1
    `).get(taskId, topic, correlationKey, task.created_at);
    if (!row) return null;
    return hydrateEvent(row);
  }

  consumeEventAndCheckpoint(taskId, eventId, snapshot, leaseToken = null) {
    return this.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE tasks SET snapshot_json = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND status = ? AND (? IS NULL OR lease_token = ?)
      `).run(encode(snapshot), now(), taskId, TaskStatus.RUNNING, leaseToken, leaseToken);
      if (updated.changes) {
        this.db.prepare(`
          INSERT OR IGNORE INTO event_deliveries(event_id, task_id, delivered_at) VALUES (?, ?, ?)
        `).run(eventId, taskId, now());
      }
      return this.getTask(taskId);
    });
  }

  renewLease(taskId, leaseToken, leaseMs = 30_000) {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE tasks SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = ? AND lease_token = ?
    `).run(timestamp + leaseMs, timestamp, taskId, TaskStatus.RUNNING, leaseToken);
    return Boolean(result.changes);
  }

  recoverExpiredLeases() {
    const timestamp = now();
    const expired = this.db.prepare(`
      SELECT * FROM tasks WHERE status = ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).all(TaskStatus.RUNNING, timestamp).map(hydrateTask);
    for (const task of expired) {
      this.db.prepare(`
        UPDATE tasks
        SET status = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            next_run_at = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND status = ? AND lease_token = ?
      `).run(TaskStatus.READY, timestamp, timestamp, task.id, TaskStatus.RUNNING, task.lease_token);
      this.appendAudit(task.goal_id, task.id, 'LEASE_EXPIRED', 'The worker lease expired; task returned to the ready queue', { previousOwner: task.lease_owner });
    }
    return expired.map((task) => task.id);
  }

  getTaskControl(id) {
    return this.db.prepare(`
      SELECT status, pause_requested, cancel_requested, preempt_requested,
        preempt_reason, preempted_by, lease_token
      FROM tasks WHERE id = ?
    `).get(id) ?? null;
  }

  requestTaskPreemption(id, interruptId, reason) {
    const task = this.getTask(id);
    if (!task || task.status !== TaskStatus.RUNNING) return task;
    const result = this.db.prepare(`
      UPDATE tasks
      SET preempt_requested = 1, preempt_reason = ?, preempted_by = ?,
          revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(reason, interruptId ?? null, now(), id, TaskStatus.RUNNING);
    if (result.changes) {
      this.appendAudit(task.goal_id, id, 'PREEMPT_REQUESTED', reason, { interruptId: interruptId ?? null });
    }
    return this.getTask(id);
  }

  preemptRunningTask(id, snapshot, leaseToken) {
    const task = this.getTask(id);
    if (!task || task.status !== TaskStatus.RUNNING || task.lease_token !== leaseToken) return task;
    const reason = task.preempt_reason ?? 'A higher-priority interrupt requested the execution slot';
    const updated = this.db.prepare(`
      UPDATE tasks
      SET status = ?, snapshot_json = ?, preempt_requested = 0, preempt_reason = NULL,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          next_run_at = ?, preemption_count = preemption_count + 1,
          revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = ? AND lease_token = ?
    `).run(TaskStatus.READY, encode(snapshot), now(), now(), id, TaskStatus.RUNNING, leaseToken);
    if (updated.changes) {
      this.appendAudit(task.goal_id, id, 'TASK_PREEMPTED', reason, {
        pc: snapshot.pc,
        interruptId: task.preempted_by,
        preemptionCount: task.preemption_count + 1,
      });
    }
    return this.getTask(id);
  }

  pauseTask(id) {
    const task = this.getTask(id);
    if (!task || TERMINAL_TASK_STATUSES.has(task.status) || task.status === TaskStatus.PAUSED) return task;
    if (task.status === TaskStatus.RUNNING) {
      this.db.prepare(`
        UPDATE tasks SET pause_requested = 1, revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(now(), id);
      this.appendAudit(task.goal_id, id, 'PAUSE_REQUESTED', 'Pause requested at the next safe checkpoint', {});
      return this.getTask(id);
    }
    this.db.prepare(`
      UPDATE tasks
      SET status = ?, paused_from_status = ?, revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(TaskStatus.PAUSED, task.status, now(), id);
    this.appendAudit(task.goal_id, id, 'TASK_PAUSED', 'Task paused', { from: task.status });
    return this.getTask(id);
  }

  pauseRunningTask(id, snapshot, leaseToken) {
    const task = this.getTask(id);
    if (!task || task.status !== TaskStatus.RUNNING || task.lease_token !== leaseToken) return task;
    const updated = this.db.prepare(`
      UPDATE tasks
      SET status = ?, paused_from_status = ?, pause_requested = 0, snapshot_json = ?,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = ? AND lease_token = ?
    `).run(TaskStatus.PAUSED, TaskStatus.READY, encode(snapshot), now(), id, TaskStatus.RUNNING, leaseToken);
    if (updated.changes) this.appendAudit(task.goal_id, id, 'TASK_PAUSED', 'Task paused at a safe checkpoint', { pc: snapshot.pc });
    return this.getTask(id);
  }

  resumeTask(id) {
    const task = this.getTask(id);
    if (!task || task.status !== TaskStatus.PAUSED) return task;
    let status = TaskStatus.READY;
    if (task.paused_from_status === TaskStatus.BLOCKED) status = TaskStatus.BLOCKED;
    if (task.paused_from_status === TaskStatus.WAITING && task.wait_kind === WaitKind.TIMER && task.wake_at > now()) status = TaskStatus.WAITING;
    this.db.prepare(`
      UPDATE tasks
      SET status = ?, paused_from_status = NULL, pause_requested = 0,
          next_run_at = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(status, now(), now(), id, TaskStatus.PAUSED);
    this.appendAudit(task.goal_id, id, 'TASK_RESUMED', 'Task resumed', { status });
    if (status === TaskStatus.BLOCKED) this.reconcileBlocked(task.goal_id);
    return this.getTask(id);
  }

  cancelTask(id, reason = 'Cancelled by the operator') {
    const task = this.getTask(id);
    if (!task || TERMINAL_TASK_STATUSES.has(task.status)) return task;
    if (task.status === TaskStatus.RUNNING) {
      this.db.prepare(`
        UPDATE tasks SET cancel_requested = 1, revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(now(), id);
      this.appendAudit(task.goal_id, id, 'CANCEL_REQUESTED', reason, {});
      return this.getTask(id);
    }
    const timestamp = now();
    this.db.prepare(`
      UPDATE tasks SET status = ?, completed_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?
    `).run(TaskStatus.CANCELLED, timestamp, timestamp, id);
    this.appendAudit(task.goal_id, id, 'TASK_CANCELLED', reason, {});
    this.reconcileBlocked(task.goal_id);
    this.reconcileGoal(task.goal_id);
    return this.getTask(id);
  }

  cancelRunningTask(id, snapshot, leaseToken, reason = 'Cancellation took effect at a safe checkpoint') {
    const task = this.getTask(id);
    if (!task || task.status !== TaskStatus.RUNNING || task.lease_token !== leaseToken) return task;
    const timestamp = now();
    const updated = this.db.prepare(`
      UPDATE tasks
      SET status = ?, snapshot_json = ?, cancel_requested = 0, lease_owner = NULL,
          lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?,
          revision = revision + 1
      WHERE id = ? AND status = ? AND lease_token = ?
    `).run(TaskStatus.CANCELLED, encode(snapshot), timestamp, timestamp, id, TaskStatus.RUNNING, leaseToken);
    if (updated.changes) {
      this.appendAudit(task.goal_id, id, 'TASK_CANCELLED', reason, { pc: snapshot.pc });
      this.reconcileBlocked(task.goal_id);
      this.reconcileGoal(task.goal_id);
    }
    return this.getTask(id);
  }

  wakeDueTimers() {
    const timestamp = now();
    const due = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = ? AND wait_kind = ? AND wake_at <= ?
    `).all(TaskStatus.WAITING, WaitKind.TIMER, timestamp).map(hydrateTask);
    for (const task of due) {
      this.db.prepare(`
        UPDATE tasks
        SET status = ?, wait_kind = NULL, wake_at = NULL, next_run_at = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `).run(TaskStatus.READY, timestamp, timestamp, task.id, TaskStatus.WAITING);
      this.appendAudit(task.goal_id, task.id, 'TIMER_FIRED', 'The wait timer fired; task entered the ready queue', {});
    }
    return due.map((task) => task.id);
  }

  expireEventWaits() {
    const timestamp = now();
    const expired = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = ? AND wait_kind = ? AND wake_at IS NOT NULL AND wake_at <= ?
    `).all(TaskStatus.WAITING, WaitKind.EVENT, timestamp).map(hydrateTask);
    for (const task of expired) {
      this.failTask(task.id, new Error(`Timed out while waiting for event ${task.wait_topic}`), { retryable: false });
    }
    return expired.map((task) => task.id);
  }

  reconcileBlocked(goalId) {
    const blocked = this.db.prepare(`SELECT * FROM tasks WHERE goal_id = ? AND status = ?`).all(goalId, TaskStatus.BLOCKED).map(hydrateTask);
    for (const task of blocked) {
      const dependencies = task.dependsOn.map((id) => this.getTask(id)).filter(Boolean);
      const hasFailed = dependencies.some((dependency) => [TaskStatus.FAILED, TaskStatus.CANCELLED].includes(dependency.status));
      const allSucceeded = dependencies.length === task.dependsOn.length && dependencies.every((dependency) => dependency.status === TaskStatus.SUCCEEDED);
      if (hasFailed) {
        this.db.prepare(`
          UPDATE tasks SET status = ?, last_error = ?, updated_at = ?, completed_at = ? WHERE id = ?
        `).run(TaskStatus.FAILED, 'An upstream dependency failed', now(), now(), task.id);
        this.appendAudit(goalId, task.id, 'TASK_FAILED', 'An upstream dependency failed; the task cannot continue', { dependsOn: task.dependsOn });
      } else if (allSucceeded) {
        this.db.prepare(`
          UPDATE tasks SET status = ?, next_run_at = ?, updated_at = ? WHERE id = ?
        `).run(TaskStatus.READY, now(), now(), task.id);
        this.appendAudit(goalId, task.id, 'DEPENDENCIES_RESOLVED', 'All dependencies completed; task entered the ready queue', { dependsOn: task.dependsOn });
      }
    }
  }

  reconcileGoal(goalId) {
    const tasks = this.listTasks(goalId);
    if (!tasks.length) return;
    const allTerminal = tasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status));
    if (!allTerminal) return;
    const status = tasks.every((task) => task.status === TaskStatus.SUCCEEDED)
      ? GoalStatus.SUCCEEDED
      : GoalStatus.FAILED;
    this.db.prepare(`
      UPDATE goals SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?
    `).run(status, now(), now(), goalId);
    this.appendAudit(goalId, null, status === GoalStatus.SUCCEEDED ? 'GOAL_SUCCEEDED' : 'GOAL_FAILED', status === GoalStatus.SUCCEEDED ? 'Every task in the goal completed' : 'The goal ended because a task failed', {});
  }

  recoverOrphanedTasks() {
    const orphaned = this.db.prepare(`SELECT * FROM tasks WHERE status = ?`).all(TaskStatus.RUNNING).map(hydrateTask);
    for (const task of orphaned) {
      this.db.prepare(`
        UPDATE tasks SET status = ?, lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, next_run_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(TaskStatus.READY, now(), now(), task.id);
      this.appendAudit(task.goal_id, task.id, 'TASK_RECOVERED', 'Runtime restarted; task recovered from its latest snapshot', { pc: task.snapshot.pc });
    }
    return orphaned.length;
  }

  upsertAgent(input) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO agents(id, name, workspace, model_key, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, workspace = excluded.workspace, model_key = excluded.model_key,
        enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(input.id, input.name, input.workspace, input.model, input.enabled === false ? 0 : 1, timestamp, timestamp);
    return this.getAgent(input.id);
  }

  getAgent(id) {
    return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) ?? null;
  }

  listAgents() {
    return this.db.prepare('SELECT * FROM agents ORDER BY id').all();
  }

  getOrCreateSession(input) {
    const existing = this.db.prepare('SELECT * FROM sessions WHERE session_key = ?').get(input.sessionKey);
    if (existing) return hydrateSession(existing);
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO sessions(
        id, session_key, agent_id, tenant_id, channel, peer_key, title, metadata_json,
        last_interaction_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sessionKey,
      input.agentId ?? 'main',
      input.tenantId ?? 'default',
      input.channel ?? 'web',
      input.peerKey ?? 'owner',
      input.title ?? null,
      encode(input.metadata ?? {}),
      timestamp,
      timestamp,
      timestamp,
    );
    return this.getSession(id);
  }

  getSession(idOrKey) {
    return hydrateSession(this.db.prepare(`
      SELECT * FROM sessions WHERE id = ? OR session_key = ? LIMIT 1
    `).get(idOrKey, idOrKey));
  }

  listSessions({ agentId, limit = 50 } = {}) {
    const rows = agentId
      ? this.db.prepare('SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?').all(agentId, limit)
      : this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit);
    return rows.map(hydrateSession);
  }

  appendMessage(input) {
    const session = this.getSession(input.sessionId);
    if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
    const timestamp = input.createdAt ?? now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT OR IGNORE INTO messages(id, session_id, role, content_json, run_id, provenance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      session.id,
      input.role,
      encode(typeof input.content === 'string' ? { text: input.content } : input.content),
      input.runId ?? null,
      input.provenance ?? (input.role === 'user' ? 'user' : 'agent'),
      timestamp,
    );
    this.db.prepare(`
      UPDATE sessions SET last_interaction_at = ?, updated_at = ? WHERE id = ?
    `).run(timestamp, timestamp, session.id);
    return hydrateMessage(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  }

  getMessage(id) {
    return hydrateMessage(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  }

  setMessageRunId(id, runId) {
    this.db.prepare('UPDATE messages SET run_id = ? WHERE id = ?').run(runId, id);
    return this.getMessage(id);
  }

  appendMessageAndEnqueueOutbox(messageInput, outboxInput) {
    return this.transaction(() => {
      const session = this.getSession(messageInput.sessionId);
      if (!session) throw new Error(`Unknown session: ${messageInput.sessionId}`);
      const timestamp = messageInput.createdAt ?? now();
      const messageId = messageInput.id ?? randomUUID();
      this.db.prepare(`
        INSERT OR IGNORE INTO messages(id, session_id, role, content_json, run_id, provenance, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        session.id,
        messageInput.role,
        encode(typeof messageInput.content === 'string' ? { text: messageInput.content } : messageInput.content),
        messageInput.runId ?? null,
        messageInput.provenance ?? 'agent',
        timestamp,
      );
      this.db.prepare('UPDATE sessions SET last_interaction_at = ?, updated_at = ? WHERE id = ?')
        .run(timestamp, timestamp, session.id);

      let outbox = outboxInput.idempotencyKey
        ? this.db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get(outboxInput.idempotencyKey)
        : null;
      if (!outbox) {
        const outboxId = outboxInput.id ?? randomUUID();
        this.db.prepare(`
          INSERT INTO outbox(
            id, session_id, channel, target, payload_json, status,
            next_attempt_at, idempotency_key, created_at
          ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
        `).run(
          outboxId,
          session.id,
          outboxInput.channel,
          outboxInput.target,
          encode(outboxInput.payload),
          timestamp,
          outboxInput.idempotencyKey ?? null,
          timestamp,
        );
        outbox = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(outboxId);
      }
      return {
        message: hydrateMessage(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)),
        outbox: hydrateOutbox(outbox),
      };
    });
  }

  listMessages(sessionIdOrKey, { limit = 50, before } = {}) {
    const session = this.getSession(sessionIdOrKey);
    if (!session) return [];
    const rows = before
      ? this.db.prepare(`
          SELECT * FROM messages WHERE session_id = ? AND created_at < ?
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(session.id, before, limit)
      : this.db.prepare(`
          SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(session.id, limit);
    return rows.reverse().map(hydrateMessage);
  }

  listMessagesThrough(sessionIdOrKey, messageId, { limit = 50 } = {}) {
    const session = this.getSession(sessionIdOrKey);
    if (!session) return [];
    const target = this.db.prepare('SELECT rowid FROM messages WHERE id = ? AND session_id = ?')
      .get(messageId, session.id);
    if (!target) return this.listMessages(session.id, { limit });
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND rowid <= ?
      ORDER BY rowid DESC LIMIT ?
    `).all(session.id, target.rowid, limit).reverse().map(hydrateMessage);
  }

  addMemory(input) {
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO memories(
        id, agent_id, kind, content, source, importance, tags_json, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.agentId ?? 'main',
      input.kind ?? 'fact',
      input.content,
      input.source ?? 'agent',
      Math.max(0, Math.min(1, Number(input.importance ?? 0.5))),
      encode(input.tags ?? []),
      input.expiresAt ?? null,
      timestamp,
      timestamp,
    );
    return hydrateMemory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id));
  }

  getMemory(id) {
    return hydrateMemory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id));
  }

  searchMemories(agentId, query, { limit = 8 } = {}) {
    const timestamp = now();
    const terms = String(query ?? '').trim().split(/\s+/u).filter(Boolean).slice(0, 12);
    if (!terms.length) {
      return this.db.prepare(`
        SELECT * FROM memories
        WHERE agent_id = ? AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY importance DESC, updated_at DESC LIMIT ?
      `).all(agentId, timestamp, limit).map(hydrateMemory);
    }
    if (this.memoryFts) {
      const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      try {
        return this.db.prepare(`
          SELECT m.*, bm25(memory_fts) AS search_rank
          FROM memory_fts JOIN memories m ON m.rowid = memory_fts.rowid
          WHERE memory_fts MATCH ? AND m.agent_id = ?
            AND (m.expires_at IS NULL OR m.expires_at > ?)
          ORDER BY search_rank ASC, m.importance DESC LIMIT ?
        `).all(ftsQuery, agentId, timestamp, limit).map(hydrateMemory);
      } catch {
        // Fall through to a conservative substring search for malformed FTS input.
      }
    }
    const conditions = terms.map(() => '(LOWER(content) LIKE LOWER(?) OR LOWER(tags_json) LIKE LOWER(?))').join(' OR ');
    const patterns = terms.flatMap((term) => [`%${term}%`, `%${term}%`]);
    return this.db.prepare(`
      SELECT * FROM memories
      WHERE agent_id = ? AND (${conditions}) AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY importance DESC, updated_at DESC LIMIT ?
    `).all(agentId, ...patterns, timestamp, limit).map(hydrateMemory);
  }

  listMemories(agentId = 'main', limit = 50) {
    return this.db.prepare(`
      SELECT * FROM memories WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?
    `).all(agentId, limit).map(hydrateMemory);
  }

  deleteMemory(id) {
    return Boolean(this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes);
  }

  createApproval(input) {
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO approvals(
        id, goal_id, task_id, session_id, action, risk, parameters_json, status, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
    `).run(
      id,
      input.goalId ?? null,
      input.taskId ?? null,
      input.sessionId ?? null,
      input.action,
      input.risk ?? 'high',
      encode(input.parameters ?? {}),
      now(),
    );
    return this.getApproval(id);
  }

  getApproval(id) {
    return hydrateApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id));
  }

  listApprovals(status, limit = 50) {
    const rows = status
      ? this.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY requested_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM approvals ORDER BY requested_at DESC LIMIT ?').all(limit);
    return rows.map(hydrateApproval);
  }

  resolveApproval(id, decision, { resolvedBy = 'owner', note } = {}) {
    const approval = this.getApproval(id);
    if (!approval || approval.status !== 'PENDING') return approval;
    const status = decision === 'approve' ? 'APPROVED' : 'DENIED';
    this.db.prepare(`
      UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, resolution_json = ?
      WHERE id = ? AND status = 'PENDING'
    `).run(status, now(), resolvedBy, encode({ decision, note: note ?? null }), id);
    return this.getApproval(id);
  }

  createSchedule(input) {
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO schedules(
        id, agent_id, name, schedule_kind, payload_json, interval_ms, next_run_at,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.agentId ?? 'main',
      input.name,
      input.kind ?? (input.intervalMs ? 'INTERVAL' : 'ONCE'),
      encode(input.payload ?? {}),
      input.intervalMs ?? null,
      input.nextRunAt,
      input.enabled === false ? 0 : 1,
      timestamp,
      timestamp,
    );
    return this.getSchedule(id);
  }

  getSchedule(id) {
    return hydrateSchedule(this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id));
  }

  listSchedules(limit = 100) {
    return this.db.prepare('SELECT * FROM schedules ORDER BY next_run_at ASC LIMIT ?').all(limit).map(hydrateSchedule);
  }

  getDueSchedules(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?
    `).all(now(), limit).map(hydrateSchedule);
  }

  markScheduleRun(id, goalId) {
    const schedule = this.getSchedule(id);
    if (!schedule) return null;
    const timestamp = now();
    const isRecurring = schedule.schedule_kind === 'INTERVAL' && schedule.interval_ms > 0;
    this.db.prepare(`
      UPDATE schedules SET enabled = ?, last_run_at = ?, last_goal_id = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(isRecurring ? 1 : 0, timestamp, goalId, isRecurring ? timestamp + schedule.interval_ms : schedule.next_run_at, timestamp, id);
    return this.getSchedule(id);
  }

  setScheduleEnabled(id, enabled) {
    this.db.prepare('UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), id);
    return this.getSchedule(id);
  }

  enqueueOutbox(input) {
    if (input.idempotencyKey) {
      const existing = this.db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get(input.idempotencyKey);
      if (existing) return hydrateOutbox(existing);
    }
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO outbox(
        id, session_id, channel, target, payload_json, status, next_attempt_at,
        idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
    `).run(id, input.sessionId ?? null, input.channel, input.target, encode(input.payload), timestamp, input.idempotencyKey ?? null, timestamp);
    return hydrateOutbox(this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id));
  }

  listOutbox({ status, limit = 50 } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM outbox WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(hydrateOutbox);
  }

  getDueOutbox(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM outbox WHERE status IN ('PENDING', 'RETRY') AND next_attempt_at <= ?
      ORDER BY created_at ASC LIMIT ?
    `).all(now(), limit).map(hydrateOutbox);
  }

  markOutboxDelivered(id) {
    this.db.prepare(`
      UPDATE outbox SET status = 'DELIVERED', delivered_at = ?, attempt = attempt + 1 WHERE id = ?
    `).run(now(), id);
  }

  markOutboxFailed(id, error) {
    const row = this.db.prepare('SELECT attempt FROM outbox WHERE id = ?').get(id);
    const attempt = Number(row?.attempt ?? 0) + 1;
    this.db.prepare(`
      UPDATE outbox SET status = ?, attempt = ?, next_attempt_at = ?, last_error = ? WHERE id = ?
    `).run(attempt >= 5 ? 'FAILED' : 'RETRY', attempt, now() + Math.min(60_000, 1_000 * 2 ** attempt), String(error), id);
  }

  prepareOperation(input) {
    const existing = this.db.prepare('SELECT * FROM operations WHERE idempotency_key = ?').get(input.idempotencyKey);
    if (existing) return { operation: hydrateOperation(existing), duplicate: true };
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO operations(
        id, idempotency_key, goal_id, task_id, tool_name, mode,
        resource_pool, state, request_json, prepared_json,
        next_reconcile_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.idempotencyKey,
      input.goalId,
      input.taskId,
      input.toolName,
      input.mode,
      input.resourcePool ?? 'isolated-side-effects',
      encode(input.request ?? {}),
      encode(input.prepared),
      input.nextReconcileAt ?? null,
      timestamp,
      timestamp,
    );
    return { operation: this.getOperation(id), duplicate: false };
  }

  getOperation(idOrKey) {
    return hydrateOperation(this.db.prepare(`
      SELECT * FROM operations WHERE id = ? OR idempotency_key = ? LIMIT 1
    `).get(idOrKey, idOrKey));
  }

  listOperations({ state, goalId, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (state) {
      clauses.push('state = ?');
      params.push(state);
    }
    if (goalId) {
      clauses.push('goal_id = ?');
      params.push(goalId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT * FROM operations ${where} ORDER BY created_at DESC LIMIT ?
    `).all(...params, limit).map(hydrateOperation);
  }

  transitionOperation(id, state, input = {}) {
    const operation = this.getOperation(id);
    if (!operation) return null;
    const timestamp = now();
    this.db.prepare(`
      UPDATE operations
      SET state = ?, prepared_json = COALESCE(?, prepared_json),
          result_json = COALESCE(?, result_json),
          reconciliation_json = COALESCE(?, reconciliation_json),
          compensation_json = COALESCE(?, compensation_json),
          attempt = attempt + ?, reconcile_attempt = reconcile_attempt + ?,
          next_reconcile_at = ?, last_error = ?, updated_at = ?,
          confirmed_at = CASE WHEN ? = 'CONFIRMED' THEN ? ELSE confirmed_at END,
          compensated_at = CASE WHEN ? = 'COMPENSATED' THEN ? ELSE compensated_at END
      WHERE id = ?
    `).run(
      state,
      input.prepared === undefined ? null : encode(input.prepared),
      input.result === undefined ? null : encode(input.result),
      input.reconciliation === undefined ? null : encode(input.reconciliation),
      input.compensation === undefined ? null : encode(input.compensation),
      input.incrementAttempt ? 1 : 0,
      input.incrementReconcile ? 1 : 0,
      input.nextReconcileAt ?? null,
      input.error ?? null,
      timestamp,
      state,
      timestamp,
      state,
      timestamp,
      id,
    );
    return this.getOperation(id);
  }

  getOperationsDueForReconciliation(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM operations
      WHERE state IN ('UNCERTAIN', 'RECONCILING')
        AND (next_reconcile_at IS NULL OR next_reconcile_at <= ?)
      ORDER BY updated_at ASC LIMIT ?
    `).all(now(), limit).map(hydrateOperation);
  }

  addAttentionAssessment(input) {
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO attention_assessments(
        id, agent_id, score, expected_value, estimated_cost,
        signals_json, decision_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.agentId ?? 'main',
      input.score,
      input.expectedValue,
      input.estimatedCost,
      encode(input.signals ?? {}),
      encode(input.decision ?? {}),
      now(),
    );
    return hydrateAttentionAssessment(this.db.prepare('SELECT * FROM attention_assessments WHERE id = ?').get(id));
  }

  listAttentionAssessments({ agentId = 'main', limit = 50 } = {}) {
    return this.db.prepare(`
      SELECT * FROM attention_assessments
      WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(agentId, limit).map(hydrateAttentionAssessment);
  }

  createMonitor(input) {
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO monitors(
        id, agent_id, name, sensor_type, config_json, interval_ms, next_poll_at,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.agentId ?? 'main',
      input.name,
      input.sensorType,
      encode(input.config ?? {}),
      input.intervalMs,
      input.nextPollAt ?? timestamp,
      input.enabled === false ? 0 : 1,
      timestamp,
      timestamp,
    );
    return this.getMonitor(id);
  }

  getMonitor(id) {
    return hydrateMonitor(this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id));
  }

  listMonitors({ agentId, enabled, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (agentId) {
      clauses.push('agent_id = ?');
      params.push(agentId);
    }
    if (enabled !== undefined) {
      clauses.push('enabled = ?');
      params.push(enabled ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT * FROM monitors ${where} ORDER BY enabled DESC, next_poll_at ASC LIMIT ?
    `).all(...params, limit).map(hydrateMonitor);
  }

  getDueMonitors(limit = 20) {
    const timestamp = now();
    return this.db.prepare(`
      SELECT * FROM monitors
      WHERE enabled = 1 AND status = 'IDLE' AND next_poll_at <= ?
      ORDER BY next_poll_at ASC LIMIT ?
    `).all(timestamp, limit).map(hydrateMonitor);
  }

  claimMonitor(id, leaseMs = 30_000) {
    const timestamp = now();
    const token = randomUUID();
    const result = this.db.prepare(`
      UPDATE monitors
      SET status = 'RUNNING', lease_token = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND enabled = 1 AND status = 'IDLE' AND next_poll_at <= ?
    `).run(token, timestamp + leaseMs, timestamp, id, timestamp);
    return result.changes ? this.getMonitor(id) : null;
  }

  completeMonitor(id, leaseToken, input) {
    const monitor = this.getMonitor(id);
    if (!monitor || monitor.lease_token !== leaseToken) return null;
    const timestamp = now();
    const nextPollAt = timestamp + monitor.interval_ms;
    const result = this.db.prepare(`
      UPDATE monitors
      SET status = 'IDLE', lease_token = NULL, lease_expires_at = NULL,
          last_state_json = ?, last_observation_at = ?, last_changed_at = ?,
          next_poll_at = ?, failure_count = 0, last_error = NULL,
          revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'RUNNING' AND lease_token = ?
    `).run(
      encode(input.state),
      timestamp,
      input.changed ? timestamp : monitor.last_changed_at,
      nextPollAt,
      timestamp,
      id,
      leaseToken,
    );
    if (!result.changes) return this.getMonitor(id);
    if (input.changed || input.recordUnchanged) {
      this.db.prepare(`
        INSERT INTO monitor_observations(monitor_id, changed, summary, state_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, input.changed ? 1 : 0, input.summary ?? 'Observation completed', encode(input.state), timestamp);
    }
    return this.getMonitor(id);
  }

  failMonitor(id, leaseToken, error) {
    const monitor = this.getMonitor(id);
    if (!monitor || monitor.lease_token !== leaseToken) return null;
    const failures = monitor.failure_count + 1;
    const delay = Math.min(monitor.interval_ms * 8, monitor.interval_ms * 2 ** Math.min(failures, 5));
    this.db.prepare(`
      UPDATE monitors
      SET status = 'IDLE', lease_token = NULL, lease_expires_at = NULL,
          failure_count = ?, last_error = ?, next_poll_at = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'RUNNING' AND lease_token = ?
    `).run(failures, String(error), now() + delay, now(), id, leaseToken);
    return this.getMonitor(id);
  }

  recoverExpiredMonitorLeases() {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE monitors
      SET status = 'IDLE', lease_token = NULL, lease_expires_at = NULL,
          next_poll_at = ?, updated_at = ?
      WHERE status = 'RUNNING' AND lease_expires_at <= ?
    `).run(timestamp, timestamp, timestamp);
    return Number(result.changes);
  }

  setMonitorEnabled(id, enabled) {
    const monitor = this.getMonitor(id);
    if (!monitor) return null;
    if (monitor.status === 'RUNNING') {
      this.db.prepare('UPDATE monitors SET enabled = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, now(), id);
      return this.getMonitor(id);
    }
    this.db.prepare(`
      UPDATE monitors SET enabled = ?, status = 'IDLE', lease_token = NULL,
        lease_expires_at = NULL, next_poll_at = ?, updated_at = ? WHERE id = ?
    `).run(enabled ? 1 : 0, now(), now(), id);
    return this.getMonitor(id);
  }

  triggerMonitor(id) {
    const monitor = this.getMonitor(id);
    if (!monitor || monitor.status === 'RUNNING') return monitor;
    this.db.prepare(`
      UPDATE monitors SET enabled = 1, status = 'IDLE', lease_token = NULL,
        lease_expires_at = NULL, next_poll_at = ?, updated_at = ? WHERE id = ?
    `).run(now(), now(), id);
    return this.getMonitor(id);
  }

  listMonitorObservations(id, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM monitor_observations WHERE monitor_id = ? ORDER BY id DESC LIMIT ?
    `).all(id, limit).map((row) => ({ ...row, state: decode(row.state_json) }));
  }

  setSystemState(key, value) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO system_state(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, encode(value), timestamp);
    return { key, value, updatedAt: timestamp };
  }

  getSystemState(key) {
    const row = this.db.prepare('SELECT * FROM system_state WHERE key = ?').get(key);
    return row ? { key: row.key, value: decode(row.value_json, {}), updatedAt: row.updated_at } : null;
  }

  recoverKernelProcesses(reason = 'Kernel host process is no longer running') {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE kernel_processes
      SET status = 'ORPHANED', stopped_at = ?, last_error = ?
      WHERE status IN ('STARTING', 'RUNNING', 'STOPPING')
    `).run(timestamp, reason);
    return Number(result.changes);
  }

  acquireKernelLease(ownerId, leaseMs) {
    return this.transaction(() => {
      const timestamp = now();
      const existing = this.db.prepare(`
        SELECT * FROM kernel_leases WHERE lease_key = 'primary'
      `).get();
      if (existing && existing.owner_id !== ownerId && existing.expires_at > timestamp) {
        return { acquired: false, holder: existing };
      }
      this.db.prepare(`
        INSERT INTO kernel_leases(lease_key, owner_id, host_pid, expires_at, updated_at)
        VALUES ('primary', ?, ?, ?, ?)
        ON CONFLICT(lease_key) DO UPDATE SET
          owner_id = excluded.owner_id,
          host_pid = excluded.host_pid,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `).run(ownerId, process.pid, timestamp + leaseMs, timestamp);
      return { acquired: true, holder: this.db.prepare(`SELECT * FROM kernel_leases WHERE lease_key = 'primary'`).get() };
    });
  }

  renewKernelLease(ownerId, leaseMs) {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE kernel_leases SET expires_at = ?, updated_at = ?
      WHERE lease_key = 'primary' AND owner_id = ?
    `).run(timestamp + leaseMs, timestamp, ownerId);
    return Boolean(result.changes);
  }

  releaseKernelLease(ownerId) {
    return Boolean(this.db.prepare(`
      DELETE FROM kernel_leases WHERE lease_key = 'primary' AND owner_id = ?
    `).run(ownerId).changes);
  }

  startKernelProcess(input) {
    const timestamp = now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO kernel_processes(
        id, parent_id, name, kind, status, host_pid, generation,
        restart_count, metadata_json, started_at, heartbeat_at
      ) VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.parentId ?? null,
      input.name,
      input.kind ?? 'service',
      input.hostPid ?? process.pid,
      input.generation ?? 1,
      input.restartCount ?? 0,
      encode(input.metadata ?? {}),
      timestamp,
      timestamp,
    );
    return this.getKernelProcess(id);
  }

  getKernelProcess(id) {
    return hydrateKernelProcess(this.db.prepare('SELECT * FROM kernel_processes WHERE id = ?').get(id));
  }

  heartbeatKernelProcess(id, metadata) {
    const processRecord = this.getKernelProcess(id);
    if (!processRecord || processRecord.status !== 'RUNNING') return processRecord;
    this.db.prepare(`
      UPDATE kernel_processes SET heartbeat_at = ?, metadata_json = ?
      WHERE id = ? AND status = 'RUNNING'
    `).run(now(), encode(metadata ?? processRecord.metadata), id);
    return this.getKernelProcess(id);
  }

  stopKernelProcess(id, status = 'STOPPED', error = null) {
    const timestamp = now();
    this.db.prepare(`
      UPDATE kernel_processes
      SET status = ?, stopped_at = ?, heartbeat_at = ?, last_error = ?
      WHERE id = ?
    `).run(status, timestamp, timestamp, error, id);
    return this.getKernelProcess(id);
  }

  listKernelProcesses({ status, parentId, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (parentId) {
      clauses.push('parent_id = ?');
      params.push(parentId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT * FROM kernel_processes ${where}
      ORDER BY started_at DESC LIMIT ?
    `).all(...params, limit).map(hydrateKernelProcess);
  }

  createInterrupt(input) {
    const id = input.id ?? randomUUID();
    const priority = Math.max(0, Math.min(100, Number(input.priority ?? 100)));
    this.db.prepare(`
      INSERT INTO interrupts(
        id, agent_id, goal_id, target_task_id, kind, priority, force,
        status, reason, payload_json, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
    `).run(
      id,
      input.agentId ?? 'main',
      input.goalId ?? null,
      input.targetTaskId ?? null,
      input.kind ?? 'user',
      priority,
      input.force === false ? 0 : 1,
      input.reason ?? 'A higher-priority instruction requires attention',
      encode(input.payload ?? {}),
      now(),
    );
    return this.getInterrupt(id);
  }

  getInterrupt(id) {
    return hydrateInterrupt(this.db.prepare('SELECT * FROM interrupts WHERE id = ?').get(id));
  }

  listInterrupts({ status, limit = 100 } = {}) {
    const rows = status
      ? this.db.prepare(`
          SELECT * FROM interrupts WHERE status = ?
          ORDER BY priority DESC, requested_at ASC LIMIT ?
        `).all(status, limit)
      : this.db.prepare(`
          SELECT * FROM interrupts ORDER BY requested_at DESC LIMIT ?
        `).all(limit);
    return rows.map(hydrateInterrupt);
  }

  markInterruptDispatched(id, taskId = null) {
    const timestamp = now();
    this.db.prepare(`
      UPDATE interrupts
      SET status = 'DISPATCHED', dispatched_task_id = ?, dispatched_at = ?
      WHERE id = ? AND status = 'PENDING'
    `).run(taskId, timestamp, id);
    return this.getInterrupt(id);
  }

  reconcileInterrupts() {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE interrupts
      SET status = 'HANDLED', handled_at = ?
      WHERE status = 'DISPATCHED'
        AND (
          goal_id IS NULL
          OR EXISTS (
            SELECT 1 FROM goals
            WHERE goals.id = interrupts.goal_id
              AND goals.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
          )
        )
    `).run(timestamp);
    return Number(result.changes);
  }

  appendAudit(goalId, taskId, type, message, data = {}) {
    this.db.prepare(`
      INSERT INTO audit_log(goal_id, task_id, type, message, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(goalId, taskId, type, message, encode(data), now());
  }

  listAudit({ goalId, taskId, afterId, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (goalId) {
      clauses.push('goal_id = ?');
      params.push(goalId);
    }
    if (taskId) {
      clauses.push('task_id = ?');
      params.push(taskId);
    }
    if (afterId !== undefined) {
      clauses.push('id > ?');
      params.push(afterId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?
    `).all(...params, limit).map(hydrateAudit);
  }

  getStats() {
    const taskCounts = this.db.prepare(`SELECT status, COUNT(*) AS count FROM tasks GROUP BY status`).all();
    const goalCounts = this.db.prepare(`SELECT status, COUNT(*) AS count FROM goals GROUP BY status`).all();
    return {
      tasks: Object.fromEntries(taskCounts.map((row) => [row.status, row.count])),
      goals: Object.fromEntries(goalCounts.map((row) => [row.status, row.count])),
      events: this.db.prepare('SELECT COUNT(*) AS count FROM events').get().count,
      sessions: this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
      memories: this.db.prepare('SELECT COUNT(*) AS count FROM memories').get().count,
      pendingApprovals: this.db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE status = 'PENDING'").get().count,
      enabledSchedules: this.db.prepare('SELECT COUNT(*) AS count FROM schedules WHERE enabled = 1').get().count,
      pendingOutbox: this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status IN ('PENDING', 'RETRY')").get().count,
      enabledMonitors: this.db.prepare('SELECT COUNT(*) AS count FROM monitors WHERE enabled = 1').get().count,
      pendingInterrupts: this.db.prepare("SELECT COUNT(*) AS count FROM interrupts WHERE status = 'PENDING'").get().count,
      residentProcesses: this.db.prepare("SELECT COUNT(*) AS count FROM kernel_processes WHERE status = 'RUNNING'").get().count,
    };
  }

  close() {
    this.db.close();
  }
}
