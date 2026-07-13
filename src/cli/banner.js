import { setTimeout as delay } from 'node:timers/promises';
import { MASCOT_TAGLINE, owlArt } from './mascot.js';

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

function center(value, width) {
  const text = String(value);
  const available = Math.max(0, width - 2);
  const clipped = text.length > available ? text.slice(0, available) : text;
  const left = Math.max(0, Math.floor((available - clipped.length) / 2));
  return `│${' '.repeat(left)}${clipped}${' '.repeat(Math.max(0, available - clipped.length - left))}│`;
}

export function startupFrame({ format, phase = 0, columns = 80, settled = false } = {}) {
  const compact = columns < 72;
  const width = Math.max(38, Math.min(compact ? 48 : 76, columns - 2));
  const art = owlArt({ phase: settled ? 0 : phase, compact });
  return [
    ...art.map((line, index) => format[index < 3 ? 'cyan' : index < art.length - 2 ? 'blue' : 'yellow'](center(line, width).slice(1, -1))),
    format.bold(center('A G E N T   O S', width).slice(1, -1)),
    format.dim(center(MASCOT_TAGLINE, width).slice(1, -1)),
  ];
}

export function canAnimate({ output = process.stdout, enabled = true, env = process.env } = {}) {
  const disabledByEnvironment = ['1', 'true', 'yes'].includes(String(env.AGENT_OS_NO_ANIMATION ?? '').toLowerCase());
  return Boolean(
    enabled
    && output.isTTY
    && env.TERM !== 'dumb'
    && !env.CI
    && !disabledByEnvironment
  );
}

function shortSession(sessionKey, columns) {
  const label = sessionKey || 'new terminal session';
  const maximum = Math.max(24, Math.min(72, columns - 14));
  return label.length <= maximum ? label : `…${label.slice(-(maximum - 1))}`;
}

export function welcomeBanner({ health, format, version, sessionKey, columns = 80 } = {}) {
  const stats = health.stats ?? {};
  const tasks = stats.tasks ?? {};
  const services = health.kernel?.services?.length ?? 0;
  const kernelAlive = health.kernel?.status === 'alive';
  const status = kernelAlive ? format.green('● KERNEL ONLINE') : format.yellow('◐ KERNEL DEGRADED');
  const model = health.modelConfigured ? format.green('model connected') : format.yellow('offline fallback');
  const frame = startupFrame({ format, columns, settled: true });
  return [
    ...frame,
    '',
    `${format.bold(`Agent OS v${version}`)}  ${status} ${format.dim(`· pid ${health.kernel?.hostPid ?? '-'}`)}`,
    `${format.dim('Runtime')}  ${services} resident services · ${tasks.RUNNING ?? 0} running · ${tasks.READY ?? 0} ready · ${tasks.WAITING ?? 0} waiting`,
    `${format.dim('Mind')}     ${stats.memories ?? 0} memories · ${stats.activeCapabilityContracts ?? 0} active contracts · ${model}`,
    `${format.dim('Session')}  ${shortSession(sessionKey, columns)}`,
    '',
    format.dim('type / for commands  ·  /task parallel work  ·  /quit or Ctrl+C exit'),
    '',
  ].join('\n');
}

export async function renderWelcome({
  client,
  format,
  version,
  sessionKey,
  output = process.stdout,
  animate = true,
  frameDelayMs = 55,
  env = process.env,
} = {}) {
  const columns = Number(output.columns ?? 80);
  const healthResult = client.get('/api/health').then(
    (health) => ({ health }),
    (error) => ({ error }),
  );

  if (!canAnimate({ output, enabled: animate, env })) {
    const result = await healthResult;
    if (result.error) throw result.error;
    output.write(welcomeBanner({ health: result.health, format, version, sessionKey, columns }));
    return result.health;
  }

  const phaseCount = 8;
  let renderedLines = 0;
  const clearFrame = () => {
    if (!renderedLines) return;
    output.write(`\u001b[${renderedLines}A\r\u001b[J`);
    renderedLines = 0;
  };
  const restoreCursor = () => output.write(SHOW_CURSOR);
  process.once('exit', restoreCursor);
  output.write(HIDE_CURSOR);
  try {
    for (let phase = 0; phase < phaseCount; phase += 1) {
      clearFrame();
      const frame = startupFrame({ format, phase, columns });
      output.write(`${frame.join('\n')}\n`);
      renderedLines = frame.length;
      await delay(frameDelayMs);
    }
    const result = await healthResult;
    clearFrame();
    if (result.error) throw result.error;
    output.write(welcomeBanner({ health: result.health, format, version, sessionKey, columns }));
    return result.health;
  } finally {
    process.removeListener('exit', restoreCursor);
    output.write(SHOW_CURSOR);
  }
}
