import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
    const maxChars = this.config.memory.maxEntryChars ?? 12_000;
    if (content.length > maxChars) throw new Error(`Memory exceeds ${maxChars} characters`);
    const memory = this.store.addMemory({ ...input, agentId: agent.id, content });

    const date = new Date().toISOString().slice(0, 10);
    const directory = join(agent.workspace, 'memory');
    mkdirSync(directory, { recursive: true });
    appendFileSync(
      join(directory, `${date}.md`),
      `\n- ${new Date(memory.created_at).toISOString()} [${memory.kind}] ${content.replaceAll('\n', ' ')}\n`,
      'utf8',
    );
    return memory;
  }

  recall(agentId, query, options = {}) {
    return this.store.searchMemories(agentId, query, {
      limit: options.limit ?? this.config.memory.maxRecallEntries ?? 8,
    });
  }

  renderForPrompt(memories) {
    if (!memories.length) return 'No relevant long-term memory was found.';
    return memories.map((memory) => (
      `- [${memory.kind}; importance=${memory.importance}] ${memory.content}`
    )).join('\n');
  }
}
