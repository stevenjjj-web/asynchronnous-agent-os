import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';

function assertWithin(root, target) {
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Path escapes the agent workspace');
}

function safePath(workspace, requested = '.', { write = false } = {}) {
  if (typeof requested !== 'string' || requested.includes('\0')) throw new Error('Invalid workspace path');
  const root = realpathSync(resolve(workspace));
  const lexicalTarget = resolve(root, requested);
  assertWithin(root, lexicalTarget);
  if (!write) {
    const actual = realpathSync(lexicalTarget);
    assertWithin(root, actual);
    return actual;
  }
  if (existsSync(lexicalTarget)) {
    const actual = realpathSync(lexicalTarget);
    assertWithin(root, actual);
    return actual;
  }
  mkdirSync(dirname(lexicalTarget), { recursive: true });
  const actualParent = realpathSync(dirname(lexicalTarget));
  assertWithin(root, actualParent);
  return resolve(actualParent, basename(lexicalTarget));
}

export function createWorkspaceTools(store) {
  return [
    {
      name: 'workspace_list',
      description: 'Lists files and directories in the personal agent workspace.',
      risk: 'low',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        additionalProperties: false,
      },
      execute: async ({ path = '.' }, { session }) => {
        const agent = store.getAgent(session.agent_id);
        const target = safePath(agent.workspace, path);
        const entries = readdirSync(target, { withFileTypes: true }).slice(0, 200).map((entry) => {
          const fullPath = resolve(target, entry.name);
          const stats = lstatSync(fullPath);
          return {
            path: relative(agent.workspace, fullPath),
            type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            modifiedAt: stats.mtimeMs,
          };
        });
        return { ok: true, entries };
      },
    },
    {
      name: 'workspace_read',
      description: 'Reads a UTF-8 text file from the personal agent workspace.',
      risk: 'low',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, maxChars: { type: 'integer', minimum: 1, maximum: 200000 } },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async ({ path, maxChars = 50_000 }, { session }) => {
        const agent = store.getAgent(session.agent_id);
        const content = readFileSync(safePath(agent.workspace, path), 'utf8');
        return { ok: true, path, content: content.slice(0, maxChars), truncated: content.length > maxChars };
      },
    },
    {
      name: 'workspace_write',
      description: 'Creates or overwrites a UTF-8 text file inside the personal agent workspace.',
      risk: 'medium',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      execute: async ({ path, content }, { session }) => {
        if (content.length > 1_000_000) throw new Error('File content exceeds 1 MB');
        const agent = store.getAgent(session.agent_id);
        const target = safePath(agent.workspace, path, { write: true });
        writeFileSync(target, content, 'utf8');
        return { ok: true, path, bytes: Buffer.byteLength(content) };
      },
    },
    {
      name: 'workspace_delete',
      description: 'Permanently deletes a file or empty directory from the personal agent workspace.',
      risk: 'high',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, reason: { type: 'string' } },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
      execute: async ({ path }, { session }) => {
        const agent = store.getAgent(session.agent_id);
        const target = safePath(agent.workspace, path);
        if (target === resolve(agent.workspace)) throw new Error('Cannot delete workspace root');
        rmSync(target, { recursive: false, force: false });
        return { ok: true, path };
      },
    },
    {
      name: 'http_fetch',
      description: 'Reads text from a public HTTPS URL. Redirects, private addresses, and non-text responses are rejected.',
      risk: 'medium',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' }, maxChars: { type: 'integer', minimum: 1, maximum: 200000 } },
        required: ['url'],
        additionalProperties: false,
      },
      execute: async ({ url, maxChars = 60_000 }) => safeFetchText(url, { maxChars }),
    },
  ];
}

export async function safeFetchText(url, { maxChars = 60_000, timeoutMs = 15_000 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS URLs are allowed');
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost'
    || hostname.endsWith('.local')
    || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)
  ) {
    throw new Error('Private and local network targets are blocked');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed, {
      redirect: 'error',
      signal: controller.signal,
      headers: { 'user-agent': 'AgentOS/0.4' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    if (!/^(text\/|application\/(json|xml|xhtml\+xml))/i.test(type)) {
      throw new Error(`Unsupported content type: ${type}`);
    }
    const content = await response.text();
    return {
      ok: true,
      url: parsed.href,
      content: content.slice(0, maxChars),
      truncated: content.length > maxChars,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
  } finally {
    clearTimeout(timeout);
  }
}
