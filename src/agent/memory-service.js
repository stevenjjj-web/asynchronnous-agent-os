import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendPrivateFile,
  atomicWritePrivateFile,
  ensureDirectoryWithinRoot,
  readPrivateTextFile,
  resolveWithinRoot,
} from '../platform/fs-safety.js';

const MEMORY_KINDS = new Set(['fact', 'preference', 'decision', 'episode', 'procedure', 'note']);

function timestamp(value, name) {
  if (value == null) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid date or timestamp`);
  return parsed;
}

export class MemoryService {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
  }

  remember(input) {
    const agent = this.store.getAgent(input.agentId ?? 'main');
    if (!agent) throw new Error(`Unknown agent: ${input.agentId}`);
    const content = String(input.content ?? '').trim();
    if (!content) throw new Error('Memory content is required');
    const kind = input.kind ?? 'fact';
    if (!MEMORY_KINDS.has(kind)) throw new Error(`Unsupported memory kind: ${kind}`);
    const status = input.status ?? 'ACTIVE';
    if (!['ACTIVE', 'CANDIDATE'].includes(status)) throw new Error(`Unsupported initial memory status: ${status}`);
    for (const field of ['importance', 'confidence']) {
      if (input[field] != null && (!Number.isFinite(Number(input[field])) || Number(input[field]) < 0 || Number(input[field]) > 1)) {
        throw new Error(`${field} must be a number between 0 and 1`);
      }
    }
    if (input.tags != null && (!Array.isArray(input.tags) || input.tags.length > 50)) {
      throw new Error('Memory tags must be an array with at most 50 entries');
    }
    if ((input.tags ?? []).some((tag) => typeof tag !== 'string' || !tag || tag.length > 100)) {
      throw new Error('Memory tags must contain 1 to 100 characters');
    }
    if (input.source != null && (typeof input.source !== 'string' || !input.source || input.source.length > 256)) {
      throw new Error('Memory source must contain 1 to 256 characters');
    }
    const maxChars = this.config.memory.maxEntryChars ?? 12_000;
    if (content.length > maxChars) throw new Error(`Memory exceeds ${maxChars} characters`);
    const existing = input.id ? this.store.getMemory(input.id) : null;
    if (existing) {
      if (
        existing.agent_id !== (input.agentId ?? 'main')
        || existing.tenant_id !== (input.tenantId ?? 'default')
        || existing.content !== content
      ) {
        throw new Error(`Memory id was reused with different ownership or content: ${input.id}`);
      }
      return existing;
    }
    const expiresAt = timestamp(input.expiresAt, 'expiresAt');
    const validFrom = timestamp(input.validFrom, 'validFrom');
    const validUntil = timestamp(input.validUntil, 'validUntil');
    if (validFrom != null && validUntil != null && validUntil <= validFrom) throw new Error('validUntil must be later than validFrom');
    const memory = this.store.addMemory({
      ...input,
      agentId: agent.id,
      tenantId: input.tenantId ?? 'default',
      content,
      kind,
      status,
      expiresAt,
      validFrom,
      validUntil,
    });

    this.mirrorMemory(memory);
    return memory;
  }

  mirrorMemory(memory) {
    const agent = this.store.getAgent(memory.agent_id);
    if (!agent) throw new Error(`Unknown agent: ${memory.agent_id}`);
    const date = new Date(memory.created_at).toISOString().slice(0, 10);
    const directory = ensureDirectoryWithinRoot(agent.workspace, 'memory');
    appendPrivateFile(
      join(directory, `${date}.md`),
      `\n- ${new Date(memory.created_at).toISOString()} [${memory.status}] [${memory.kind}] [id=${memory.id}] [confidence=${memory.confidence}] [source=${memory.source}] ${memory.content.replaceAll('\n', ' ')}\n`,
    );
    return memory;
  }

  forget(id, { agentId = 'main', tenantId = 'default' } = {}) {
    const memory = this.store.getMemory(id);
    if (!memory || memory.agent_id !== agentId || memory.tenant_id !== tenantId) return null;
    const agent = this.store.getAgent(memory.agent_id);
    if (!this.store.deleteMemory(id)) return null;
    const date = new Date(memory.created_at).toISOString().slice(0, 10);
    const diary = join(agent.workspace, 'memory', `${date}.md`);
    if (existsSync(diary)) {
      const flattened = memory.content.replaceAll('\n', ' ');
      const safeDiary = resolveWithinRoot(agent.workspace, `memory/${date}.md`);
      const lines = readPrivateTextFile(safeDiary, { maxBytes: 5_000_000 }).split('\n');
      const retained = lines.filter((line) => (
        !line.includes(`[id=${memory.id}]`)
        && !line.includes(`[${memory.kind}] ${flattened}`)
      ));
      atomicWritePrivateFile(safeDiary, retained.join('\n'));
    }
    return memory;
  }

  recall(agentId, query, options = {}) {
    return this.store.searchMemories(agentId, query, {
      limit: options.limit ?? this.config.memory.maxRecallEntries ?? 8,
      tenantId: options.tenantId ?? 'default',
    });
  }

  renderForPrompt(memories) {
    if (!memories.length) return 'No relevant long-term memory was found.';
    return memories.map((memory) => (
      `- [id=${memory.id}; kind=${memory.kind}; confidence=${memory.confidence}; source=${memory.source}; validUntil=${memory.valid_until ?? 'open'}] ${memory.content}`
    )).join('\n');
  }

  confirm(id, input = {}) {
    if (input.confidence != null && (!Number.isFinite(Number(input.confidence)) || Number(input.confidence) < 0 || Number(input.confidence) > 1)) {
      throw new Error('confidence must be a number between 0 and 1');
    }
    return this.store.confirmMemory(id, input);
  }
}
