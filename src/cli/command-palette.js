export const COMMAND_CATALOG = Object.freeze([
  { name: '/task', usage: '/task <instruction>', group: 'Work', description: 'Launch a parallel goal and keep the prompt free', aliases: ['/bg'] },
  { name: '/focus', usage: '/focus <goal-id>', group: 'Work', description: 'Bind follow-up work to one persistent goal' },
  { name: '/unfocus', usage: '/unfocus', group: 'Work', description: 'Return input routing to the general inbox' },
  { name: '/inbox', usage: '/inbox', group: 'Attention', description: 'Show threads waiting for input, approvals, and completions' },
  { name: '/reply', usage: '/reply [goal-id] <message>', group: 'Attention', description: 'Resume a thought thread waiting for you' },
  { name: '/interrupt', usage: '/interrupt <instruction>', group: 'Attention', description: 'Raise urgent work and preempt safely' },
  { name: '/tasks', usage: '/tasks', group: 'Observe', description: 'Inspect runnable, waiting, and blocked thought threads', aliases: ['/threads'] },
  { name: '/manager', usage: '/manager', group: 'Observe', description: 'Open the explainable thought-thread task manager', aliases: ['/ps'] },
  { name: '/inspect', usage: '/inspect <task-id>', group: 'Observe', description: 'Explain one thread, checkpoint, wait, usage, and authority' },
  { name: '/trace', usage: '/trace <goal-id>', group: 'Observe', description: 'Replay a goal DAG, causal chain, and evidence set' },
  { name: '/plan', usage: '/plan <goal-id>', group: 'Observe', description: 'Inspect plan versions, assumptions, and cognitive repairs' },
  { name: '/goals', usage: '/goals', group: 'Observe', description: 'Inspect persistent objectives' },
  { name: '/status', usage: '/status', group: 'Observe', description: 'Show kernel, scheduler, sensing, and delivery state' },
  { name: '/kernel', usage: '/kernel', group: 'Observe', description: 'Show resident kernel services' },
  { name: '/resources', usage: '/resources', group: 'Observe', description: 'Show quotas and isolated execution pools' },
  { name: '/channels', usage: '/channels', group: 'Observe', description: 'Show inbound listeners and outbound channel adapters' },
  { name: '/attention', usage: '/attention', group: 'Observe', description: 'Show the latest cognitive attention decision' },
  { name: '/approvals', usage: '/approvals', group: 'Attention', description: 'List pending side-effect approvals' },
  { name: '/interrupts', usage: '/interrupts', group: 'Attention', description: 'List durable interrupt records' },
  { name: '/pause', usage: '/pause <task-id>', group: 'Control', description: 'Pause a thread at its next safe checkpoint' },
  { name: '/resume', usage: '/resume <task-id>', group: 'Control', description: 'Return a paused thread to scheduling' },
  { name: '/cancel', usage: '/cancel <task-id>', group: 'Control', description: 'Cancel a thread through the durable control path' },
  { name: '/priority', usage: '/priority <task-id> <0-100>', group: 'Control', description: 'Change scheduler priority with an audit record' },
  { name: '/budget', usage: '/budget <goal-id> <field> <value>', group: 'Control', description: 'Revise a goal budget within its frozen ceiling' },
  { name: '/revoke', usage: '/revoke <goal-id>', group: 'Control', description: 'Revoke every capability held by a goal' },
  { name: '/model', usage: '/model [key|default|status]', group: 'Context', description: 'Inspect or switch the model for future goals in this session' },
  { name: '/new', usage: '/new', group: 'Context', description: 'Start clean context without deleting stored data' },
  { name: '/history', usage: '/history', group: 'Context', description: 'Show the current conversation transcript' },
  { name: '/memory', usage: '/memory [query]', group: 'Context', description: 'List or search explicit long-term memory' },
  { name: '/forget', usage: '/forget <memory-id>', group: 'Context', description: 'Permanently delete one long-term memory' },
  { name: '/purge', usage: '/purge', group: 'Context', description: 'Delete the current terminal session history' },
  { name: '/clear', usage: '/clear', group: 'Terminal', description: 'Clear the scrolling terminal log' },
  { name: '/commands', usage: '/commands', group: 'Terminal', description: 'Show the complete command catalog', aliases: ['/help'] },
  { name: '/quit', usage: '/quit', group: 'Terminal', description: 'Leave the terminal while Agent OS keeps running', aliases: ['/exit'] },
]);

function candidates(command) {
  return [command.name, ...(command.aliases ?? [])];
}

export function suggestCommands(input, limit = 6) {
  const line = String(input ?? '').trimStart();
  if (!line.startsWith('/')) return [];
  const token = line.split(/\s+/, 1)[0].toLowerCase();
  const exact = COMMAND_CATALOG.find((command) => candidates(command).includes(token));
  if (exact && line.length > token.length) return [exact];
  const matches = COMMAND_CATALOG.filter((command) => candidates(command).some((name) => name.startsWith(token)));
  const exactIndex = matches.findIndex((command) => candidates(command).includes(token));
  if (exactIndex > 0) matches.unshift(...matches.splice(exactIndex, 1));
  return matches.slice(0, limit);
}

export function commandCatalogLines(format) {
  const lines = [];
  let group = null;
  for (const command of COMMAND_CATALOG) {
    if (command.group !== group) {
      group = command.group;
      if (lines.length) lines.push('');
      lines.push(format.bold(group));
    }
    const aliases = command.aliases?.length ? format.dim(` (${command.aliases.join(', ')})`) : '';
    lines.push(`  ${format.cyan(command.usage.padEnd(30))} ${command.description}${aliases}`);
  }
  return lines;
}
