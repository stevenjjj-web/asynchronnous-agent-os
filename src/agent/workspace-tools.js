import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  atomicWriteWithinRoot,
  readPrivateTextFile,
  resolveWithinRoot,
} from '../platform/fs-safety.js';
import { fetchPublicText } from '../security/public-fetch.js';

const PROTECTED_WORKSPACE_FILES = new Set(['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md', 'MEMORY.md']);

function assertMutableWorkspacePath(requested) {
  const normalized = String(requested).replaceAll('\\', '/').replace(/^\.\//, '');
  if (PROTECTED_WORKSPACE_FILES.has(normalized)) {
    throw new Error('Core workspace policy and memory files cannot be modified through agent tools');
  }
}

export function createWorkspaceTools(store) {
  return [
    {
      name: 'workspace_list',
      description: 'Lists files and directories in the personal agent workspace.',
      risk: 'low',
      resourcePool: 'filesystem',
      capability: { filesystemOperation: 'list' },
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        additionalProperties: false,
      },
      execute: async ({ path = '.' }, { session }) => {
        const agent = store.getAgent(session.agent_id);
        const target = resolveWithinRoot(agent.workspace, path);
        if (!lstatSync(target).isDirectory()) throw new Error('workspace_list requires a directory');
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
      resourcePool: 'filesystem',
      capability: { filesystemOperation: 'read' },
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, maxChars: { type: 'integer', minimum: 1, maximum: 200000 } },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async ({ path, maxChars = 50_000 }, { session }) => {
        const agent = store.getAgent(session.agent_id);
        const target = resolveWithinRoot(agent.workspace, path);
        const content = readPrivateTextFile(target, { maxBytes: 1_000_000 });
        return { ok: true, path, content: content.slice(0, maxChars), truncated: content.length > maxChars };
      },
    },
    {
      name: 'workspace_write',
      description: 'Creates or overwrites a UTF-8 text file inside the personal agent workspace.',
      risk: 'medium',
      resourcePool: 'filesystem',
      capability: { filesystemOperation: 'write' },
      sideEffect: { mode: 'local-idempotent' },
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      execute: async ({ path, content }, { session }) => {
        if (content.length > 1_000_000) throw new Error('File content exceeds 1 MB');
        const agent = store.getAgent(session.agent_id);
        assertMutableWorkspacePath(path);
        atomicWriteWithinRoot(agent.workspace, path, content);
        return { ok: true, path, bytes: Buffer.byteLength(content) };
      },
    },
    {
      name: 'workspace_delete',
      description: 'Permanently deletes a file or empty directory from the personal agent workspace.',
      risk: 'high',
      resourcePool: 'isolated-side-effects',
      capability: { filesystemOperation: 'delete' },
      sideEffect: { mode: 'non-idempotent' },
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, reason: { type: 'string' } },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
      execute: async ({ path }, { session }) => {
        const agent = store.getAgent(session.agent_id);
        assertMutableWorkspacePath(path);
        const target = resolveWithinRoot(agent.workspace, path);
        if (target === resolve(agent.workspace)) throw new Error('Cannot delete workspace root');
        rmSync(target, { recursive: false, force: false });
        return { ok: true, path };
      },
    },
    {
      name: 'http_fetch',
      description: 'Reads text from a public HTTPS URL. Redirects, private addresses, and non-text responses are rejected.',
      risk: 'medium',
      resourcePool: 'network',
      capability: { networkUrlArg: 'url', networkMethod: 'GET' },
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' }, maxChars: { type: 'integer', minimum: 1, maximum: 200000 } },
        required: ['url'],
        additionalProperties: false,
      },
      execute: async ({ url, maxChars = 60_000 }) => fetchPublicText(url, { maxChars }),
    },
  ];
}

export const safeFetchText = fetchPublicText;
