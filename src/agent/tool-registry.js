const RISK_LEVEL = { low: 0, medium: 1, high: 2, critical: 3 };

export const ActionControl = Object.freeze({
  value(value, state) { return { __agentControl: 'value', value, state }; },
  wait(wait, state) { return { __agentControl: 'wait', wait, state }; },
});

export function isActionControl(value) {
  return value?.__agentControl === 'value' || value?.__agentControl === 'wait';
}

function validateSchema(value, schema, path = 'arguments') {
  if (!schema) return;
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} must be one of: ${schema.enum.join(', ')}`);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
    for (const required of schema.required ?? []) {
      if (value[required] === undefined) throw new Error(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!schema.properties?.[key]) throw new Error(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) validateSchema(value[key], property, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path} has too many items`);
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
  } else if (schema.type === 'string' && typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  } else if (schema.type === 'integer' && !Number.isInteger(value)) {
    throw new Error(`${path} must be an integer`);
  } else if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${path} must be a number`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} is below minimum`);
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} exceeds maximum`);
}

export class ToolRegistry {
  constructor({
    approvalRisk = 'high', hooks, policy = {}, capabilities, resources,
    pools, operations, credentials, sandboxes,
  } = {}) {
    this.tools = new Map();
    this.approvalRisk = approvalRisk;
    this.hooks = hooks;
    this.policy = { allow: ['*'], deny: [], ...policy };
    this.capabilities = capabilities;
    this.resources = resources;
    this.pools = pools;
    this.operations = operations;
    this.credentials = credentials;
    this.sandboxes = sandboxes;
  }

  register(definition) {
    if (!definition?.name || typeof definition.execute !== 'function') throw new Error('Invalid tool definition');
    if (this.tools.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`);
    const tool = {
      risk: 'low',
      description: '',
      resourcePool: 'default',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      ...definition,
    };
    if (tool.sideEffect?.mode === 'non-idempotent') {
      tool.resourcePool = 'isolated-side-effects';
      if ((RISK_LEVEL[tool.risk] ?? 0) < RISK_LEVEL.high) tool.risk = 'high';
    }
    if (['browser', 'code'].includes(tool.resourcePool) && !tool.sandbox) {
      throw new Error(`Tool ${tool.name} requires a registered sandbox adapter for pool ${tool.resourcePool}`);
    }
    if (tool.sandbox && !this.sandboxes?.has(tool.sandbox)) {
      throw new Error(`Tool ${tool.name} references an unavailable sandbox adapter: ${tool.sandbox}`);
    }
    this.tools.set(definition.name, tool);
    this.operations?.registerTool(tool);
    return this;
  }

  list() {
    return [...this.tools.values()].map(({ execute, ...tool }) => tool);
  }

  get(name) {
    return this.tools.get(name) ?? null;
  }

  modelDefinitions() {
    return this.list().filter((tool) => this.isAllowed(tool.name)).map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }

  isAllowed(name) {
    if (this.policy.deny?.includes(name) || this.policy.deny?.includes('*')) return false;
    return this.policy.allow?.includes('*') || this.policy.allow?.includes(name);
  }

  requiresApproval(tool) {
    return (RISK_LEVEL[tool.risk] ?? 0) >= (RISK_LEVEL[this.approvalRisk] ?? 2);
  }

  async execute(name, args, context) {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
    if (!this.isAllowed(name)) return { ok: false, error: `Tool blocked by policy: ${name}` };
    validateSchema(args, tool.parameters);
    try {
      this.capabilities?.authorizeTool(context.task.goal_id, tool, args, context);
      this.resources?.recordToolCall({
        goalId: context.task.goal_id,
        toolName: name,
        resourcePool: tool.resourcePool,
        idempotencyKey: `${context.idempotencyKey}:usage`,
      });
      await this.hooks?.emit('before_tool_call', { tool: name, args, context });
      const directExecute = () => tool.execute(args, {
        ...context,
        tool,
        credentials: this.credentials,
        requiresApproval: this.requiresApproval(tool),
      });
      const execute = () => tool.sandbox
        ? this.sandboxes.run(tool.sandbox, { tool, args, context, execute: directExecute })
        : directExecute();
      const result = await this.pools.run(tool.resourcePool, () => (
        this.operations
          ? this.operations.execute(tool, args, context, execute)
          : execute()
      ), context.signal);
      await this.hooks?.emit('after_tool_call', { tool: name, args, result, context });
      return result;
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason ?? error;
      const result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      await this.hooks?.emit('after_tool_call', { tool: name, args, result, context });
      return result;
    }
  }
}
