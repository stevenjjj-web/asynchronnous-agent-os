function waitPrompt(task) {
  const state = task.snapshot?.actionStates?.[task.snapshot.pc];
  return state?.pending?.args?.prompt
    ?? state?.pending?.toolState?.prompt
    ?? state?.pending?.wait?.reason
    ?? 'This thought thread needs external input.';
}

function channelWait(task) {
  const state = task.snapshot?.actionStates?.[task.snapshot.pc];
  const args = state?.pending?.args ?? state?.pending?.toolState ?? {};
  return {
    channel: args.channel ?? 'unknown',
    accountId: args.accountId ?? 'unknown',
    threadKey: args.threadKey ?? 'unknown',
  };
}

function startsWithId(value, target) {
  return value === target || value.startsWith(target);
}

export class AttentionInbox {
  constructor({ store, tenantId = 'default', publishEvent }) {
    this.store = store;
    this.tenantId = tenantId;
    this.publishEvent = publishEvent;
  }

  snapshot({ limit = 20 } = {}) {
    const allWaiting = this.store.listAllTasks({ status: 'WAITING', limit: 500 });
    const waiting = allWaiting
      .filter((task) => task.wait_kind === 'EVENT' && task.wait_topic === 'user.reply')
      .map((task) => {
        const goal = this.store.getGoal(task.goal_id);
        if (!goal || goal.tenant_id !== this.tenantId) return null;
        const session = goal.session_id ? this.store.getSession(goal.session_id) : null;
        return {
          type: 'user-input',
          goalId: goal.id,
          goalTitle: goal.title,
          taskId: task.id,
          taskTitle: task.title,
          sessionId: session?.id ?? null,
          sessionKey: session?.session_key ?? null,
          prompt: waitPrompt(task),
          waitingSince: task.updated_at,
          deadlineAt: task.wake_at,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.waitingSince - right.waitingSince)
      .slice(0, limit);
    const listening = allWaiting
      .filter((task) => task.wait_kind === 'EVENT' && task.wait_topic === 'channel.message')
      .map((task) => {
        const goal = this.store.getGoal(task.goal_id);
        if (!goal || goal.tenant_id !== this.tenantId) return null;
        return {
          type: 'channel-listener',
          goalId: goal.id,
          goalTitle: goal.title,
          taskId: task.id,
          waitingSince: task.updated_at,
          deadlineAt: task.wake_at,
          ...channelWait(task),
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.waitingSince - right.waitingSince)
      .slice(0, limit);
    const approvals = this.store.listApprovals('PENDING', limit * 2)
      .map((approval) => {
        const goal = this.store.getGoal(approval.goal_id);
        if (!goal || goal.tenant_id !== this.tenantId) return null;
        return {
          type: 'approval',
          id: approval.id,
          goalId: goal.id,
          goalTitle: goal.title,
          taskId: approval.task_id,
          action: approval.action,
          risk: approval.risk,
          requestedAt: approval.requested_at,
        };
      })
      .filter(Boolean)
      .slice(0, limit);
    const completions = this.store.listGoals(200)
      .filter((goal) => goal.tenant_id === this.tenantId && goal.status !== 'ACTIVE' && goal.completed_at)
      .sort((left, right) => right.completed_at - left.completed_at)
      .slice(0, Math.min(8, limit))
      .map((goal) => ({
        type: 'completion',
        goalId: goal.id,
        goalTitle: goal.title,
        status: goal.status,
        completedAt: goal.completed_at,
        sessionId: goal.session_id,
      }));
    return {
      waiting,
      listening,
      approvals,
      completions,
      counts: {
        input: waiting.length,
        approvals: approvals.length,
        recentCompletions: completions.length,
        listening: listening.length,
        actionable: waiting.length + approvals.length,
      },
    };
  }

  reply({ target, message, idempotencyKey } = {}) {
    const text = String(message ?? '').trim();
    if (!text) throw new Error('Reply message is required');
    const inbox = this.snapshot({ limit: 100 });
    const matches = target
      ? inbox.waiting.filter((item) => startsWithId(item.goalId, target) || startsWithId(item.taskId, target))
      : inbox.waiting;
    if (!matches.length) throw new Error(target
      ? `No thought thread waiting for input matches: ${target}`
      : 'No thought thread is waiting for user input');
    if (matches.length > 1) throw new Error(target
      ? `Reply target is ambiguous: ${target}`
      : 'Multiple thought threads need input; specify a goal or task id');
    const selected = matches[0];
    const task = this.store.getTask(selected.taskId);
    const goal = this.store.getGoal(selected.goalId);
    const result = this.publishEvent({
      topic: task.wait_topic,
      correlationKey: task.wait_key,
      payload: { message: text },
      source: 'attention-inbox',
      idempotencyKey: idempotencyKey ?? `attention-reply:${task.id}:${Date.now()}`,
      tenantId: goal.tenant_id,
      agentId: goal.agent_id,
      authenticated: true,
      authSubject: 'owner',
    });
    return { selected, ...result };
  }
}
