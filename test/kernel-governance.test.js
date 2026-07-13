import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig } from '../src/platform/config.js';
import { PersonalAgentSystem } from '../src/system.js';

function createConfig(home) {
  const config = defaultConfig({ projectRoot: home, home });
  config.runtime.tickMs = 10;
  config.runtime.maxConcurrency = 1;
  config.runtime.leaseMs = 500;
  config.kernel.heartbeatMs = 25;
  config.kernel.serviceTimeoutMs = 1_000;
  config.kernel.housekeepingMs = 10;
  config.kernel.interruptPollMs = 5;
  config.models.default = { provider: 'offline', model: 'offline' };
  config.agents[0].workspace = join(home, 'workspace');
  return config;
}

test('goal contracts freeze budgets, deadlines, context, and capability subsets atomically', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-contract-'));
  const system = new PersonalAgentSystem(createConfig(home));
  try {
    const deadlineAt = Date.now() + 2_000;
    const parent = await system.sessions.submit({
      text: 'A low-priority goal with an urgent deadline',
      priority: 20,
      deadlineAt,
      budget: { maxToolCalls: 2, maxContextChars: 1_200, maxFanOut: 1, maxDepth: 1 },
      capabilities: {
        tools: ['goal_status', 'spawn_goals'],
        resourcePools: ['default'],
        filesystem: { roots: ['.'], operations: [] },
        network: { domains: [], methods: [] },
        accounts: {},
        dataScopes: ['agent:self'],
        credentialRefs: [],
      },
    });
    const ordinary = await system.sessions.submit({
      text: 'A high-priority goal without a deadline',
      priority: 100,
      threadKey: 'ordinary',
    });
    const contract = system.store.getGoalContract(parent.goal.id);
    assert.equal(contract.deadline_at, deadlineAt);
    assert.equal(contract.budget.maxToolCalls, 2);
    assert.equal(contract.capabilities.tools.includes('goal_status'), true);
    assert.equal(system.store.getReadyTasks(1)[0].goal_id, parent.goal.id);

    const child = system.buildGoalContract({
      parentGoalId: parent.goal.id,
      agentId: 'main',
      tenantId: 'default',
      budget: { maxToolCalls: 1 },
      capabilities: { tools: ['goal_status'] },
    });
    assert.equal(child.budget.maxToolCalls, 1);
    assert.deepEqual(child.capabilities.tools, ['goal_status']);
    assert.throws(() => system.buildGoalContract({
      parentGoalId: parent.goal.id,
      agentId: 'main',
      tenantId: 'default',
      capabilities: { tools: ['http_fetch'] },
    }), /expands tool set/);
    assert.throws(() => system.buildGoalContract({
      parentGoalId: parent.goal.id,
      agentId: 'main',
      tenantId: 'default',
      capabilities: { filesystem: { roots: ['/etc'] } },
    }), /expands filesystem root/);
    assert.throws(() => system.resources.authorizeFanOut(parent.goal.id, 2, 1), /fan-out/);

    const built = system.contextBuilder.build(parent.session.id, [], {
      throughMessageId: parent.message.id,
      goalId: parent.goal.id,
    });
    const contextChars = built.messages.reduce((sum, message) => sum + message.content.length, 0);
    assert.ok(contextChars <= 1_200);
    assert.ok(system.store.getGoalContract(ordinary.goal.id));
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('capability enforcement scopes tools, paths, credentials, expiry, and revocation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-capability-'));
  const config = createConfig(home);
  config.security.capabilities.credentialRefs = ['mail-primary'];
  config.security.capabilities.accounts = { email: ['primary'] };
  config.security.capabilities.constraints = {
    email: {
      recipients: ['*@example.com'],
      messageTypes: ['transactional', 'notification'],
      maxRecipientsPerCall: 2,
      maxBodyChars: 100,
    },
  };
  const system = new PersonalAgentSystem(config);
  system.tools.register({
    name: 'scoped_mail',
    resourcePool: 'default',
    capability: {
      accountArg: 'account',
      accountType: 'email',
      argumentScopes: [
        { arg: 'to', scope: 'email.recipients', many: true },
        { arg: 'messageType', scope: 'email.messageTypes' },
      ],
      numericLimits: [
        { arg: 'to', scope: 'email.maxRecipientsPerCall', measure: 'length' },
        { arg: 'body', scope: 'email.maxBodyChars', measure: 'length' },
      ],
    },
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        to: { type: 'array', items: { type: 'string' } },
        messageType: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['account', 'to', 'messageType', 'body'],
      additionalProperties: false,
    },
    execute: async () => ({ ok: true }),
  });
  const previousSecret = process.env.AGENT_OS_TEST_SECRET;
  process.env.AGENT_OS_TEST_SECRET = 'never-return-this-secret';
  try {
    system.store.createCredentialRef({
      id: 'mail-primary',
      agentId: 'main',
      tenantId: 'default',
      provider: 'environment',
      locator: 'AGENT_OS_TEST_SECRET',
    });
    const accepted = await system.sessions.submit({
      text: 'Read only an allowed workspace subtree',
      capabilities: {
        tools: ['workspace_read', 'scoped_mail'],
        resourcePools: ['filesystem', 'default'],
        filesystem: { roots: ['allowed'], operations: ['read'] },
        network: { domains: [], methods: [] },
        accounts: { email: ['primary'] },
        dataScopes: ['agent:self'],
        credentialRefs: ['mail-primary'],
        constraints: {
          email: {
            recipients: ['alice@example.com'],
            messageTypes: ['transactional'],
            maxRecipientsPerCall: 1,
            maxBodyChars: 50,
          },
        },
      },
    });
    const task = accepted.tasks[0];
    const context = {
      task,
      session: accepted.session,
      idempotencyKey: 'capability:test',
    };
    const deniedTool = await system.tools.execute('http_fetch', { url: 'https://example.com' }, context);
    assert.match(deniedTool.error, /frozen capability set/);
    const deniedPath = await system.tools.execute('workspace_read', { path: 'outside/file.txt' }, {
      ...context,
      idempotencyKey: 'capability:path',
    });
    assert.match(deniedPath.error, /outside the authorized scope/);
    const allowedMail = await system.tools.execute('scoped_mail', {
      account: 'primary', to: ['alice@example.com'], messageType: 'transactional', body: 'Hello',
    }, { ...context, idempotencyKey: 'capability:mail:allowed' });
    assert.equal(allowedMail.ok, true);
    const deniedRecipient = await system.tools.execute('scoped_mail', {
      account: 'primary', to: ['bob@example.com'], messageType: 'transactional', body: 'Hello',
    }, { ...context, idempotencyKey: 'capability:mail:recipient' });
    assert.match(deniedRecipient.error, /outside capability constraint/);
    const deniedBody = await system.tools.execute('scoped_mail', {
      account: 'primary', to: ['alice@example.com'], messageType: 'transactional', body: 'x'.repeat(51),
    }, { ...context, idempotencyKey: 'capability:mail:body' });
    assert.match(deniedBody.error, /exceeds capability limit/);
    assert.ok(system.store.listCapabilityAudit(accepted.goal.id).some((entry) => entry.action === 'DENIED'));
    const resolvedLength = await system.credentials.withCredential(accepted.goal.id, 'mail-primary', async (secret) => secret.length);
    assert.equal(resolvedLength, 'never-return-this-secret'.length);
    assert.doesNotMatch(JSON.stringify(system.store.getGoalContract(accepted.goal.id)), /never-return-this-secret/);

    system.capabilities.revoke(accepted.goal.id, 'test', 'Scope no longer required');
    const revoked = await system.tools.execute('workspace_read', { path: 'allowed/file.txt' }, {
      ...context,
      idempotencyKey: 'capability:revoked',
    });
    assert.match(revoked.error, /revoked/);
    assert.ok(system.store.listCapabilityAudit(accepted.goal.id).some((entry) => entry.action === 'REVOKED'));
  } finally {
    if (previousSecret === undefined) delete process.env.AGENT_OS_TEST_SECRET;
    else process.env.AGENT_OS_TEST_SECRET = previousSecret;
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('tool budgets and isolated resource pools are enforced independently', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-resources-'));
  const config = createConfig(home);
  config.resources.pools.code = 1;
  config.resources.globalDaily.maxToolCalls = 2;
  const system = new PersonalAgentSystem(config);
  assert.throws(() => system.tools.register({
    name: 'unsandboxed_code',
    resourcePool: 'code',
    execute: async () => ({ ok: true }),
  }), /requires a registered sandbox adapter/);
  assert.throws(() => system.tools.register({
    name: 'missing_sandbox',
    resourcePool: 'code',
    sandbox: 'missing',
    execute: async () => ({ ok: true }),
  }), /unavailable sandbox adapter/);
  system.sandboxes.register('test-isolated', {
    description: 'Test-only sandbox adapter.',
    execute: ({ execute }) => execute(),
  });
  let active = 0;
  let maximum = 0;
  system.tools.register({
    name: 'code_probe',
    description: 'Test isolated code capacity.',
    risk: 'low',
    resourcePool: 'code',
    sandbox: 'test-isolated',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(40);
      active -= 1;
      return { ok: true };
    },
  });
  try {
    const accepted = await system.sessions.submit({
      text: 'Run bounded code probes',
      budget: { maxToolCalls: 3 },
    });
    const context = { task: accepted.tasks[0], session: accepted.session };
    await Promise.all([
      system.tools.execute('code_probe', {}, { ...context, idempotencyKey: 'pool:1' }),
      system.tools.execute('code_probe', {}, { ...context, idempotencyKey: 'pool:2' }),
    ]);
    assert.equal(maximum, 1);
    const exhausted = await system.tools.execute('code_probe', {}, { ...context, idempotencyKey: 'pool:3' });
    assert.match(exhausted.error, /daily tool-call quota is exhausted/);
    assert.equal(system.store.getGoalContract(accepted.goal.id).usage.toolCalls, 2);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('side-effect operations reconcile uncertain results and support compensation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-operation-'));
  const system = new PersonalAgentSystem(createConfig(home));
  let externalCreated = false;
  let executeCount = 0;
  let legacyExecuteCount = 0;
  system.tools.register({
    name: 'external_ticket',
    description: 'Create an external ticket with reconciliation.',
    risk: 'medium',
    resourcePool: 'network',
    sideEffect: {
      mode: 'reconcilable',
      async reconcile() {
        return externalCreated
          ? { confirmed: true, result: { ok: true, ticketId: 'ticket-42' } }
          : { absent: true };
      },
      async compensate() {
        externalCreated = false;
        return { cancelled: true };
      },
    },
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
    async execute() {
      executeCount += 1;
      externalCreated = true;
      throw new Error('Request timed out after the remote system accepted it');
    },
  });
  system.tools.register({
    name: 'legacy_payment',
    description: 'A non-idempotent legacy side effect.',
    risk: 'high',
    sideEffect: { mode: 'non-idempotent' },
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      legacyExecuteCount += 1;
      return { ok: true };
    },
  });
  try {
    const accepted = await system.sessions.submit({ text: 'Create a tracked external ticket' });
    const context = {
      task: accepted.tasks[0],
      session: accepted.session,
      idempotencyKey: 'ticket:operation:42',
    };
    const isolated = await system.tools.execute('legacy_payment', {}, {
      ...context,
      idempotencyKey: 'legacy-payment:1',
    });
    assert.match(isolated.error, /requires explicit approval/);
    const crashedOperation = system.store.prepareOperation({
      idempotencyKey: 'legacy-payment:crashed',
      goalId: context.task.goal_id,
      taskId: context.task.id,
      toolName: 'legacy_payment',
      mode: 'non-idempotent',
      resourcePool: 'isolated-side-effects',
      request: {},
    }).operation;
    system.store.transitionOperation(crashedOperation.id, 'EXECUTING', { incrementAttempt: true });
    const crashRecovery = await system.tools.execute('legacy_payment', {}, {
      ...context,
      idempotencyKey: 'legacy-payment:crashed',
      approvalGranted: true,
    });
    assert.equal(crashRecovery.uncertain, true, JSON.stringify(crashRecovery));
    assert.equal(legacyExecuteCount, 0);
    const uncertain = await system.tools.execute('external_ticket', { title: 'Investigate' }, context);
    assert.equal(uncertain.uncertain, true);
    assert.equal(system.store.getOperation(uncertain.operationId).state, 'UNCERTAIN');

    const reconciled = await system.tools.execute('external_ticket', { title: 'Investigate' }, context);
    assert.equal(reconciled.ticketId, 'ticket-42');
    assert.equal(reconciled._operation.state, 'CONFIRMED');
    assert.equal(executeCount, 1);

    const compensated = await system.operations.compensate(reconciled._operation.id, 'Ticket is no longer needed');
    assert.equal(compensated.state, 'COMPENSATED');
    assert.equal(externalCreated, false);
    assert.equal((await system.operations.compensate(reconciled._operation.id)).state, 'COMPENSATED');
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('attention allocation scores deadlines, observations, conflicts, and long-blocked work', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-attention-'));
  const config = createConfig(home);
  config.security.capabilities.accounts = { email: ['primary'] };
  config.cognition.criticalThreshold = 55;
  const system = new PersonalAgentSystem(config);
  try {
    const first = await system.sessions.submit({
      text: 'Ship the release before the deadline',
      threadKey: 'deadline-a',
      deadlineAt: Date.now() + 1_000,
      conflictKeys: ['release-channel'],
      capabilities: { accounts: { email: ['primary'] } },
    });
    await system.sessions.submit({
      text: 'Pause the same release channel',
      threadKey: 'deadline-b',
      conflictKeys: ['release-channel'],
      capabilities: { accounts: { email: ['primary'] } },
    });
    const blockedAt = Date.now() - config.cognition.blockedAfterMs - 1;
    system.store.db.prepare(`
      UPDATE tasks SET status = 'WAITING', wait_kind = 'EVENT', wait_topic = 'test',
        wait_key = 'blocked', updated_at = ? WHERE id = ?
    `).run(blockedAt, first.tasks[0].id);
    system.publishEvent({
      topic: 'monitor.changed',
      correlationKey: 'attention-test',
      payload: { changed: true },
      source: 'test',
      tenantId: 'default',
      agentId: 'main',
      authenticated: true,
      idempotencyKey: 'attention-observation-1',
    });

    const assessment = system.attention.assess('main');
    assert.equal(assessment.decision.shouldWake, true);
    assert.equal(assessment.decision.critical, true);
    assert.ok(assessment.signals.deadlineRisks.length >= 1);
    assert.ok(assessment.signals.newObservationIds.length >= 1);
    assert.ok(assessment.signals.conflicts.length >= 1);
    assert.ok(assessment.signals.longBlockedTaskIds.includes(first.tasks[0].id));
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('external event authentication binds ownership and rejects replayed nonces', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-event-auth-'));
  const config = createConfig(home);
  config.security.events.requireSignature = true;
  config.security.events.sourceSecrets = { github: 'env:AGENT_OS_EVENT_TEST_KEY' };
  const previous = process.env.AGENT_OS_EVENT_TEST_KEY;
  process.env.AGENT_OS_EVENT_TEST_KEY = 'event-test-key';
  const system = new PersonalAgentSystem(config);
  try {
    const timestamp = Date.now();
    const input = {
      source: 'github',
      topic: 'ci.completed',
      correlationKey: 'repo:main:42',
      payload: { status: 'passed' },
      tenantId: 'default',
      agentId: 'main',
      timestamp,
      nonce: 'github-delivery-42',
    };
    const canonical = [
      timestamp,
      input.nonce,
      input.topic,
      input.correlationKey,
      input.tenantId,
      input.agentId,
      JSON.stringify(input.payload),
    ].join('.');
    const signature = createHmac('sha256', process.env.AGENT_OS_EVENT_TEST_KEY).update(canonical).digest('hex');
    const auth = system.eventAuthenticator.verify({ ...input, signature });
    assert.equal(auth.authenticated, true);
    const first = system.publishEvent({ ...input, ...auth });
    const replay = system.publishEvent({ ...input, ...auth });
    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.throws(() => system.eventAuthenticator.verify({ ...input, nonce: 'different', signature }), /signature is invalid/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_EVENT_TEST_KEY;
    else process.env.AGENT_OS_EVENT_TEST_KEY = previous;
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
