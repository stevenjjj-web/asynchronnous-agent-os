const CODES = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m',
  blue: '\u001b[34m', cyan: '\u001b[36m', gray: '\u001b[90m',
};

export function createFormatter({ color = true, stdout = process.stdout } = {}) {
  const enabled = color && stdout.isTTY && !process.env.NO_COLOR;
  const paint = (name, value) => enabled ? `${CODES[name]}${value}${CODES.reset}` : String(value);
  return {
    enabled,
    bold: (value) => paint('bold', value),
    dim: (value) => paint('dim', value),
    red: (value) => paint('red', value),
    green: (value) => paint('green', value),
    yellow: (value) => paint('yellow', value),
    blue: (value) => paint('blue', value),
    cyan: (value) => paint('cyan', value),
    gray: (value) => paint('gray', value),
  };
}

export function relativeTime(timestamp) {
  if (!timestamp) return '-';
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 1_000) return 'now';
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function truncate(value, width = 48) {
  const text = String(value ?? '');
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

export function table(rows, columns) {
  if (!rows.length) return '(none)';
  const widths = columns.map((column) => Math.min(
    column.max ?? 60,
    Math.max(column.label.length, ...rows.map((row) => String(column.value(row) ?? '').length)),
  ));
  const render = (values) => values.map((value, index) => truncate(value, widths[index]).padEnd(widths[index])).join('  ');
  return [
    render(columns.map((column) => column.label)),
    render(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => render(columns.map((column) => column.value(row)))),
  ].join('\n');
}

export function statusMark(status, format) {
  const marks = {
    RUNNING: format.cyan('●'), READY: format.blue('◆'), WAITING: format.yellow('◐'),
    BLOCKED: format.gray('◇'), PAUSED: format.yellow('Ⅱ'), SUCCEEDED: format.green('✓'),
    FAILED: format.red('✗'), CANCELLED: format.gray('×'), ACTIVE: format.cyan('●'),
  };
  return marks[status] ?? '·';
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
