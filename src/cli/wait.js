import { setTimeout as delay } from 'node:timers/promises';
import { relativeTime, statusMark } from './format.js';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

export async function waitForGoal({ client, goalId, sessionId, format, json, ask, pollMs = 250, signal }) {
  const previous = new Map();
  const handledWaits = new Set();
  let lastView;
  while (!signal?.aborted) {
    lastView = await client.get(`/api/goals/${encodeURIComponent(goalId)}`);
    if (!json) renderTransitions(lastView, previous, format);
    for (const task of lastView.tasks) {
      if (task.status !== 'WAITING' || task.wait_kind !== 'EVENT') continue;
      const waitIdentity = `${task.wait_topic}:${task.wait_key}`;
      if (handledWaits.has(waitIdentity)) continue;
      if (task.wait_topic === 'user.reply') {
        if (!ask) return { status: 'waiting', view: lastView, requiresInput: task };
        handledWaits.add(waitIdentity);
        const answer = await ask(`${task.title}> `);
        await client.post(`/api/goals/${encodeURIComponent(goalId)}/reply`, {
          message: answer,
          idempotencyKey: `cli:${goalId}:${task.wait_key}:${Date.now()}`,
        });
      } else if (task.wait_topic === 'approval.resolved') {
        if (!ask) return { status: 'waiting', view: lastView, requiresApproval: task.wait_key };
        handledWaits.add(waitIdentity);
        const answer = (await ask(`Approve ${task.wait_key}? [y/N] `)).trim().toLowerCase();
        await client.post(`/api/approvals/${encodeURIComponent(task.wait_key)}/resolve`, {
          decision: answer === 'y' || answer === 'yes' ? 'approve' : 'deny',
          resolvedBy: 'cli',
        });
      }
    }
    if (TERMINAL.has(lastView.goal.status)) break;
    await delay(pollMs, undefined, { signal }).catch(() => {});
  }
  const session = sessionId ? await client.get(`/api/sessions/${encodeURIComponent(sessionId)}?limit=100`) : null;
  const assistant = session?.messages?.filter((message) => message.role === 'assistant').at(-1) ?? null;
  return { status: lastView?.goal.status?.toLowerCase(), view: lastView, assistant };
}

function renderTransitions(view, previous, format) {
  for (const task of [...view.tasks].sort((left, right) => left.created_at - right.created_at)) {
    if (previous.get(task.id) === task.status) continue;
    previous.set(task.id, task.status);
    const detail = task.status === 'WAITING'
      ? `${task.wait_kind?.toLowerCase()} ${task.wait_topic ?? ''}`.trim()
      : `pc=${task.snapshot.pc}/${task.workflow.length}`;
    process.stderr.write(
      `${format.gray(new Date().toLocaleTimeString())} ${statusMark(task.status, format)} ${task.title} ${format.dim(`→ ${task.status} · ${detail}`)}\n`,
    );
  }
  if (TERMINAL.has(view.goal.status)) {
    process.stderr.write(`${statusMark(view.goal.status, format)} Goal ${view.goal.status.toLowerCase()} ${format.dim(relativeTime(view.goal.completed_at))}\n`);
  }
}
