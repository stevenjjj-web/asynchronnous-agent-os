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
  constructor({ approvalRisk = 'high', hooks, policy = {} } = {}) {
    this.tools = new Map();
    this.approvalRisk = approvalRisk;
    this.hooks = hooks;
    this.policy = { allow: ['*'], deny: [], ...policy };
  }

  register(definition) {
    if (!definition?.name || typeof definition.execute !== 'function') throw new Error('Invalid tool definition');
    if (this.tools.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`);
    this.tools.set(definition.name, {
      risk: 'low',
      description: '',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      ...definition,
    });
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
    await this.hooks?.emit('before_tool_call', { tool: name, args, context });
    try {
      const result = await tool.execute(args, { ...context, tool, requiresApproval: this.requiresApproval(tool) });
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
