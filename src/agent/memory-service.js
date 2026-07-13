import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
    for (const field of ['importance', 'confidence']) {
      if (input[field] != null && (!Number.isFinite(Number(input[field])) || Number(input[field]) < 0 || Number(input[field]) > 1)) {
        throw new Error(`${field} must be a number between 0 and 1`);
      }
    }
    if (input.tags != null && (!Array.isArray(input.tags) || input.tags.length > 50)) {
      throw new Error('Memory tags must be an array with at most 50 entries');
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
    const memory = this.store.addMemory({
      ...input,
      agentId: agent.id,
      tenantId: input.tenantId ?? 'default',
      content,
      kind,
      expiresAt: timestamp(input.expiresAt, 'expiresAt'),
      validFrom: timestamp(input.validFrom, 'validFrom'),
      validUntil: timestamp(input.validUntil, 'validUntil'),
    });

    const date = new Date().toISOString().slice(0, 10);
    const directory = join(agent.workspace, 'memory');
    mkdirSync(directory, { recursive: true });
    appendFileSync(
      join(directory, `${date}.md`),
      `\n- ${new Date(memory.created_at).toISOString()} [${memory.kind}] [id=${memory.id}] [confidence=${memory.confidence}] [source=${memory.source}] ${content.replaceAll('\n', ' ')}\n`,
      'utf8',
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
      const lines = readFileSync(diary, 'utf8').split('\n');
      const retained = lines.filter((line) => (
        !line.includes(`[id=${memory.id}]`)
        && !line.includes(`[${memory.kind}] ${flattened}`)
      ));
      const temporary = `${diary}.${process.pid}.tmp`;
      writeFileSync(temporary, retained.join('\n'), 'utf8');
      renameSync(temporary, diary);
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
    return this.store.confirmMemory(id, input);
  }
}
