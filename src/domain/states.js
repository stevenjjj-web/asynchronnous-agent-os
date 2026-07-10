export const TaskStatus = Object.freeze({
  CREATED: 'CREATED',
  READY: 'READY',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
  BLOCKED: 'BLOCKED',
  PAUSED: 'PAUSED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

export const GoalStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

export const WaitKind = Object.freeze({
  TIMER: 'TIMER',
  EVENT: 'EVENT',
});

export const TERMINAL_TASK_STATUSES = new Set([
  TaskStatus.SUCCEEDED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
]);

export function assertTransition(from, to) {
  const allowed = {
    [TaskStatus.CREATED]: [TaskStatus.READY, TaskStatus.BLOCKED, TaskStatus.CANCELLED],
    [TaskStatus.READY]: [TaskStatus.RUNNING, TaskStatus.PAUSED, TaskStatus.CANCELLED],
    [TaskStatus.RUNNING]: [TaskStatus.READY, TaskStatus.WAITING, TaskStatus.SUCCEEDED, TaskStatus.FAILED, TaskStatus.CANCELLED],
    [TaskStatus.WAITING]: [TaskStatus.READY, TaskStatus.FAILED, TaskStatus.PAUSED, TaskStatus.CANCELLED],
    [TaskStatus.BLOCKED]: [TaskStatus.READY, TaskStatus.FAILED, TaskStatus.PAUSED, TaskStatus.CANCELLED],
    [TaskStatus.PAUSED]: [TaskStatus.READY, TaskStatus.WAITING, TaskStatus.BLOCKED, TaskStatus.CANCELLED],
    [TaskStatus.SUCCEEDED]: [],
    [TaskStatus.FAILED]: [TaskStatus.READY],
    [TaskStatus.CANCELLED]: [],
  };

  if (!allowed[from]?.includes(to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}
