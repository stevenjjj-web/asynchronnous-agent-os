import { owlArt } from './mascot.js';

const ENTER_ALT_SCREEN = '\u001b[?1049h';
const EXIT_ALT_SCREEN = '\u001b[?1049l';
const SAVE_CURSOR = '\u001b7';
const RESTORE_CURSOR = '\u001b8';

function fit(value, width) {
  const text = String(value ?? '');
  if (text.length > width) return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
  return text.padEnd(width);
}

function poolStatus(pools, name, label) {
  const pool = pools?.find((item) => item.name === name);
  return pool ? `${label} ${pool.active}/${pool.capacity}${pool.queued ? `+${pool.queued}q` : ''}` : `${label} -`;
}

function waitingLabel(task, inbox) {
  if (inbox?.waiting?.[0]) return inbox.waiting[0].prompt;
  if (inbox?.listening?.[0]) {
    const item = inbox.listening[0];
    return `listening · ${item.channel}:${item.accountId}:${item.threadKey}`;
  }
  return task?.title ?? 'no thread needs external input';
}

export function dashboardLines(snapshot, {
  format, columns = 100, phase = 0, sessionKey, focusedGoal,
} = {}) {
  const width = Math.max(72, Math.min(120, Number(columns || 100)));
  const leftWidth = 18;
  const rightWidth = width - leftWidth - 7;
  const border = (left, fill, right) => `${left}${fill.repeat(width - 2)}${right}`;
  const full = (content) => `│ ${fit(content, width - 4)} │`;
  const paired = (left, right) => `│ ${fit(left, leftWidth)} │ ${fit(right, rightWidth)} │`;
  const stats = snapshot.stats ?? {};
  const tasks = stats.tasks ?? {};
  const activeGoal = snapshot.goals?.find((goal) => goal.status === 'ACTIVE');
  const runningTask = snapshot.tasks?.find((task) => task.status === 'RUNNING');
  const readyTask = snapshot.tasks?.find((task) => task.status === 'READY');
  const waitingTask = snapshot.tasks?.find((task) => task.status === 'WAITING');
  const attention = snapshot.cognition?.lastAssessment;
  const memory = snapshot.memories?.[0];
  const explainedThreads = snapshot.taskManager?.threads ?? [];
  const runningExplanation = explainedThreads.find((thread) => thread.status === 'RUNNING');
  const waitingExplanation = explainedThreads.find((thread) => thread.status === 'WAITING');
  const observedThread = runningExplanation ?? waitingExplanation ?? explainedThreads[0];
  const owl = owlArt({ phase, compact: true });
  const operatingView = [
    `THREADS  ● ${tasks.RUNNING ?? 0} run   ◆ ${tasks.READY ?? 0} ready   ◐ ${tasks.WAITING ?? 0} wait   ◇ ${tasks.BLOCKED ?? 0} blocked`,
    `RUN      ${runningExplanation ? `${runningExplanation.title} · ${runningExplanation.reason}` : runningTask?.title ?? 'idle · no thread owns an execution slot'}`,
    `READY    ${readyTask?.title ?? (activeGoal?.title ?? 'no queued cognitive work')}`,
    `WAIT     ${waitingExplanation ? `${waitingExplanation.title} · ${waitingExplanation.reason}` : waitingLabel(waitingTask, snapshot.inbox)}`,
    `MIND     ${stats.memories ?? 0} memories · ${stats.sessions ?? 0} sessions · INBOX ${snapshot.inbox?.counts?.actionable ?? 0} · ${Number(observedThread?.usage?.tokens ?? 0)} tok · ${observedThread?.pricing?.status === 'unpriced' ? 'unpriced' : `$${Number(observedThread?.usage?.costUsd ?? 0).toFixed(4)}`}`,
    `POOLS    ${poolStatus(snapshot.pools, 'network', 'net')} · ${poolStatus(snapshot.pools, 'code', 'code')} · ${poolStatus(snapshot.pools, 'isolated-side-effects', 'effects')} · ATTN ${attention ? Number(attention.score).toFixed(1) : '-'}`,
  ];
  const right = operatingView;
  const status = snapshot.kernel?.status === 'alive' ? '● ALIVE' : '◐ DEGRADED';
  const header = `AGENT OS  /  KERNEL OWL     ${status} · pid ${snapshot.kernel?.hostPid ?? '-'} · ${snapshot.kernel?.services?.length ?? 0} resident services`;
  const focus = focusedGoal ? `${focusedGoal.title} · ${focusedGoal.id.slice(0, 8)}` : 'general attention';
  const footer = `FOCUS ${focus}   ·   SESSION ${sessionKey ?? 'new'}   ·   MEMORY ${memory ? memory.content : 'explicit only'}   ·   /`;
  return [
    format.cyan(border('╭', '─', '╮')),
    format.bold(full(header)),
    format.dim(border('├', '─', '┤')),
    ...owl.map((line, index) => (index < 3 ? format.cyan : format.blue)(paired(line, right[index]))),
    format.dim(full(footer)),
    format.cyan(border('╰', '─', '╯')),
  ];
}

export function canUseLiveDashboard({ output = process.stdout, enabled = true, env = process.env } = {}) {
  const disabled = ['1', 'true', 'yes'].includes(String(env.AGENT_OS_SIMPLE_UI ?? '').toLowerCase());
  return Boolean(
    enabled
    && output.isTTY
    && Number(output.columns ?? 0) >= 72
    && Number(output.rows ?? 0) >= 22
    && env.TERM !== 'dumb'
    && !env.CI
    && !disabled
  );
}

export class LiveDashboard {
  constructor({ client, format, output = process.stdout, enabled = true, env = process.env, refreshMs = 750, sessionKey } = {}) {
    this.client = client;
    this.format = format;
    this.output = output;
    this.enabled = enabled;
    this.env = env;
    this.refreshMs = refreshMs;
    this.sessionKey = sessionKey;
    this.phase = 0;
    this.active = false;
    this.refreshing = false;
    this.snapshot = null;
    this.focusedGoal = null;
    this.timer = null;
    this.height = 0;
    this.onResize = () => this.resize();
    this.onExit = () => this.restoreTerminal();
  }

  async start() {
    if (!canUseLiveDashboard({ output: this.output, enabled: this.enabled, env: this.env })) return false;
    this.snapshot = await this.client.get('/api/dashboard');
    this.active = true;
    this.output.write(`${ENTER_ALT_SCREEN}\u001b[2J\u001b[H`);
    this.resize();
    this.output.on?.('resize', this.onResize);
    process.once('exit', this.onExit);
    this.timer = setInterval(() => this.refresh(), this.refreshMs);
    this.timer.unref?.();
    return true;
  }

  setSessionKey(sessionKey) {
    this.sessionKey = sessionKey;
    if (this.snapshot) this.render();
  }

  setFocusedGoal(focusedGoal) {
    this.focusedGoal = focusedGoal;
    if (this.snapshot) this.render();
  }

  async refresh() {
    if (!this.active || this.refreshing) return;
    this.refreshing = true;
    try {
      this.snapshot = await this.client.get('/api/dashboard');
      this.phase = (this.phase + 1) % 8;
      this.render();
    } catch {
      // The conversation remains usable while a transient dashboard refresh fails.
    } finally {
      this.refreshing = false;
    }
  }

  resize() {
    if (!this.active || !this.snapshot) return;
    const lines = dashboardLines(this.snapshot, {
      format: this.format,
      columns: this.output.columns,
      phase: this.phase,
      sessionKey: this.sessionKey,
      focusedGoal: this.focusedGoal,
    });
    this.height = lines.length;
    const rows = Math.max(this.height + 3, Number(this.output.rows ?? 30));
    this.output.write(`\u001b[${this.height + 1};${rows}r\u001b[${this.height + 1};1H`);
    this.render(lines);
  }

  render(prebuilt) {
    if (!this.active || !this.snapshot) return;
    const lines = prebuilt ?? dashboardLines(this.snapshot, {
      format: this.format,
      columns: this.output.columns,
      phase: this.phase,
      sessionKey: this.sessionKey,
      focusedGoal: this.focusedGoal,
    });
    this.output.write(SAVE_CURSOR);
    lines.forEach((line, index) => this.output.write(`\u001b[${index + 1};1H\u001b[2K${line}`));
    this.output.write(RESTORE_CURSOR);
  }

  clearLog() {
    if (!this.active) return false;
    this.output.write(`\u001b[${this.height + 1};1H\u001b[J`);
    return true;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.output.off?.('resize', this.onResize);
    process.removeListener('exit', this.onExit);
    this.restoreTerminal();
  }

  restoreTerminal() {
    this.output.write(`\u001b[r\u001b[?25h${EXIT_ALT_SCREEN}`);
  }
}
