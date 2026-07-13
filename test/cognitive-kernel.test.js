import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig } from '../src/platform/config.js';
import { PersonalAgentSystem } from '../src/system.js';

function createConfig(home, provider = 'offline') {
  const config = defaultConfig({ projectRoot: home, home });
  config.runtime.tickMs = 10;
  config.runtime.maxConcurrency = 2;
  config.runtime.leaseMs = 500;
  config.kernel.heartbeatMs = 25;
  config.kernel.serviceTimeoutMs = 1_000;
  config.kernel.housekeepingMs = 10;
  config.kernel.interruptPollMs = 5;
  config.models.default = { provider, model: provider };
  config.agents[0].workspace = join(home, 'workspace');
  return config;
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(10);
  }
  throw new Error('Condition was not met before timeout');
}

test('semantic resource claims serialize conflicting thought threads durably', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-semantic-claims-'));
  const system = new PersonalAgentSystem(createConfig(home, 'claim-probe'));
  let active = 0;
  let maximum = 0;
  system.providers.register('claim-probe', () => ({
    async complete() {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(50);
      active -= 1;
      return { content: 'Completed under the semantic resource contract', toolCalls: [], usage: null };
    },
  }));
  await system.start();
  try {
    const first = await system.sessions.submit({
      text: 'Update the primary mailbox index',
      threadKey: 'claims-a',
      resourceClaims: [{ scope: 'account:mail:primary', mode: 'exclusive' }],
    });
    const second = await system.sessions.submit({
      text: 'Send a report through the primary mailbox',
      threadKey: 'claims-b',
      resourceClaims: [{ scope: 'account:mail:primary', mode: 'exclusive' }],
    });
    await waitFor(() => ['SUCCEEDED', 'FAILED'].includes(system.store.getGoal(second.goal.id)?.status), 5_000);
    assert.equal(system.store.getGoal(first.goal.id).status, 'SUCCEEDED');
    assert.equal(system.store.getGoal(second.goal.id).status, 'SUCCEEDED');
    assert.equal(maximum, 1);
    const deferrals = system.store.listAudit({ goalId: second.goal.id, limit: 200 })
      .filter((entry) => entry.type === 'TASK_RESOURCE_DEFERRED');
    assert.ok(deferrals.some((entry) => entry.message.includes('account:mail:primary')));
    assert.ok(system.store.listResourceClaims({ goalId: first.goal.id }).every((claim) => claim.status === 'RELEASED'));
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('an external observation invalidates an assumption and starts a bounded plan repair thread', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-plan-repair-'));
  const system = new PersonalAgentSystem(createConfig(home, 'repair-probe'));
  system.providers.register('repair-probe', () => ({
    async complete({ messages }) {
      const user = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const tool = [...messages].reverse().find((message) => message.role === 'tool');
      if (user.includes('Repair the parent goal plan')) {
        return { content: 'Preserve completed research and switch the pending order to the backup supplier.', toolCalls: [], usage: null };
      }
      if (tool) {
        const repaired = messages.some((message) => message.role === 'system' && String(message.content).includes('cognitive-update'));
        return {
          content: repaired ? 'The parent thread resumed with the revised plan.' : 'The parent thread resumed without a revision.',
          toolCalls: [],
          usage: null,
        };
      }
      return {
        content: '',
        toolCalls: [{
          id: 'wait-parent',
          name: 'request_user_input',
          arguments: JSON.stringify({ prompt: 'Confirm the final purchase quantity' }),
        }],
        usage: null,
      };
    },
  }));
  await system.start();
  try {
    const accepted = await system.sessions.submit({
      text: 'Prepare a purchase using the current supplier quote',
      assumptions: [{
        id: 'assumption:supplier-quote',
        statement: 'The current supplier quote remains valid',
        confidence: 0.8,
        watch: { topic: 'supplier.quote.changed', correlationKey: 'quote-42' },
      }],
    });
    await waitFor(() => system.store.listTasks(accepted.goal.id).some((task) => task.status === 'WAITING'));
    system.publishEvent({
      topic: 'supplier.quote.changed',
      correlationKey: 'quote-42',
      payload: { available: false, replacement: 'backup-supplier' },
      source: 'supplier-listener',
      tenantId: 'default',
      agentId: 'main',
      authenticated: true,
      idempotencyKey: 'supplier-quote-change-42',
    });
    const repairGoal = await waitFor(() => system.store.listGoals(100).find((goal) => (
      goal.metadata.parentGoalId === accepted.goal.id
      && String(goal.metadata.createdBy).startsWith('plan-repair:')
    )));
    await waitFor(() => system.store.getGoal(repairGoal.id)?.status === 'SUCCEEDED');
    const versions = await waitFor(() => {
      const current = system.store.listPlanVersions(accepted.goal.id, 20);
      return current.some((version) => version.trigger.type === 'repair-completed') ? current : null;
    });
    const assumption = system.store.getGoalAssumption('assumption:supplier-quote');
    assert.equal(assumption.status, 'INVALIDATED');
    assert.equal(assumption.invalidated_by_event_id != null, true);
    assert.equal(versions[0].status, 'CURRENT');
    assert.equal(versions[0].plan.repairGoalId, repairGoal.id);
    assert.ok(versions.some((version) => version.status === 'REPAIRED' && version.trigger.repairGoalId === repairGoal.id));
    assert.equal(versions[0].trigger.assumptionId, 'assumption:supplier-quote');
    assert.match(versions[0].plan.revision.text, /backup supplier/);
    const repairContract = system.store.getGoalContract(repairGoal.id);
    assert.equal(repairContract.capabilities.tools.includes('workspace_write'), false);
    assert.deepEqual(repairContract.capabilities.credentialRefs, []);
    assert.equal(system.store.getGoal(accepted.goal.id).status, 'ACTIVE');
    const waiting = system.store.listTasks(accepted.goal.id).find((task) => task.status === 'WAITING');
    assert.ok(waiting);
    assert.ok(waiting.snapshot.cognitiveNotices.some((notice) => notice.id === `plan-revision:${repairGoal.id}`));
    assert.match(JSON.stringify(waiting.snapshot.actionStates), /cognitive-update/);
    system.publishEvent({
      topic: waiting.wait_topic,
      correlationKey: waiting.wait_key,
      payload: { message: 'Order 50 units' },
      idempotencyKey: 'purchase-quantity-reply',
    });
    await waitFor(() => system.store.getGoal(accepted.goal.id).status === 'SUCCEEDED');
    assert.match(system.store.listMessages(accepted.session.id).at(-1).content.text, /revised plan/);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('temporal memory preserves provenance and excludes superseded, contradicted, and expired beliefs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-os-temporal-memory-'));
  const system = new PersonalAgentSystem(createConfig(home));
  try {
    const original = system.memory.remember({
      agentId: 'main',
      content: 'The release window is Friday',
      kind: 'fact',
      confidence: 0.6,
      source: 'calendar-import',
      provenance: { calendarEventId: 'event-old' },
    });
    const replacement = system.memory.remember({
      agentId: 'main',
      content: 'The release window is Thursday',
      kind: 'fact',
      confidence: 0.85,
      source: 'operator',
      supersedesId: original.id,
      provenance: { messageId: 'message-42' },
    });
    system.memory.remember({
      agentId: 'main',
      content: 'An expired release window was Wednesday',
      kind: 'fact',
      validUntil: Date.now() - 1,
      source: 'legacy-import',
    });
    assert.equal(system.store.getMemory(original.id).status, 'SUPERSEDED');
    assert.deepEqual(replacement.provenance, { messageId: 'message-42' });
    let recalled = system.memory.recall('main', 'release window', { limit: 20 });
    assert.deepEqual(recalled.map((memory) => memory.id), [replacement.id]);

    const correction = system.memory.remember({
      agentId: 'main',
      content: 'The release window is still under review',
      kind: 'fact',
      confidence: 0.7,
      source: 'release-manager',
      contradictsIds: [replacement.id],
    });
    assert.equal(system.store.getMemory(replacement.id).status, 'CONTRADICTED');
    const confirmed = system.memory.confirm(correction.id, { confidence: 0.95, source: 'owner' });
    assert.equal(confirmed.confidence, 0.95);
    assert.equal(confirmed.provenance.lastConfirmationSource, 'owner');
    recalled = system.memory.recall('main', 'release window', { limit: 20 });
    assert.deepEqual(recalled.map((memory) => memory.id), [correction.id]);
  } finally {
    await system.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
