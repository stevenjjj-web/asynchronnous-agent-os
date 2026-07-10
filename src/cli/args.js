export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split('=', 2);
    const next = argv[index + 1];
    if (inline !== undefined) flags[name] = inline;
    else if (next && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else flags[name] = true;
  }
  return { flags, positionals };
}

export function numberFlag(flags, name, fallback) {
  const value = flags[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}
