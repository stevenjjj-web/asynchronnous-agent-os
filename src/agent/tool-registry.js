const RISK_LEVEL = { low: 0, medium: 1, high: 2, critical: 3 };

export const ActionControl = Object.freeze({
  value(value, state) { return { __agentControl: 'value', value, state }; },
  wait(wait, state) { return { __agentControl: 'wait', wait, state }; },
});

export function isActionControl(value) {
  return value?.__agentControl === 'value' || value?.__agentControl === 'wait';
}

function validateSchema(value, schema, path = 'arguments', depth = 0) {
  if (!schema) return;
  if (depth > 32) throw new Error('Tool arguments exceed the maximum nesting depth');
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} must be one of: ${schema.enum.join(', ')}`);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
    if (Object.keys(value).length > (schema.maxProperties ?? 1_000)) throw new Error(`${path} has too many properties`);
    for (const required of schema.required ?? []) {
      if (value[required] === undefined) throw new Error(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!schema.properties?.[key]) throw new Error(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) validateSchema(value[key], property, `${path}.${key}`, depth + 1);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (value.length > (schema.maxItems ?? 10_000)) throw new Error(`${path} has too many items`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path} has too many items`);
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, depth + 1));
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
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path} is too short`);
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${path} is too long`);
  if (typeof value === 'string' && schema.maxLength === undefined && value.length > 1_000_000) throw new Error(`${path} exceeds the default string limit`);
  if (typeof value === 'string' && schema.pattern && !(new RegExp(schema.pattern).test(value))) throw new Error(`${path} has an invalid format`);
}

function assertBoundedResult(result, maxBytes = 2_000_000) {
  let serialized;
  try { serialized = JSON.stringify(result); } catch { throw new Error('Tool result must be JSON-serializable'); }
  if (Buffer.byteLength(serialized ?? 'null') > maxBytes) throw new Error(`Tool result exceeds the ${maxBytes}-byte limit`);
  return result;
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
    if (tool.sideEffect) {
      const mode = tool.sideEffect.mode ?? 'idempotent';
      if (!['idempotent', 'local-idempotent', 'reconcilable', 'non-idempotent'].includes(mode)) {
        throw new Error(`Tool ${tool.name} declares an unsupported side-effect mode: ${mode}`);
      }
      for (const method of ['prepare', 'confirm', 'reconcile', 'compensate']) {
        if (tool.sideEffect[method] != null && typeof tool.sideEffect[method] !== 'function') {
          throw new Error(`Tool ${tool.name} sideEffect.${method} must be a function`);
        }
      }
      if (mode === 'reconcilable' && typeof tool.sideEffect.reconcile !== 'function') {
        throw new Error(`Reconcilable tool ${tool.name} must implement sideEffect.reconcile`);
      }
    }
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
    if (['browser', 'code'].includes(tool.resourcePool) && !this.sandboxes?.isStrong(tool.sandbox)) {
      throw new Error(`Tool ${tool.name} requires process, container, or microVM sandbox isolation`);
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

  modelDefinitions(goalId) {
    return this.list().filter((tool) => (
      this.isAllowed(tool.name)
      && (!goalId || !this.capabilities || this.capabilities.canExposeTool(goalId, tool))
    )).map((tool) => ({
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
      const prepared = await this.hooks?.emit('before_tool_call', { tool: name, args, context })
        ?? { tool: name, args, context };
      if (prepared.cancelled) throw new Error('Tool call cancelled by policy');
      const effectiveArgs = prepared.args ?? args;
      validateSchema(effectiveArgs, tool.parameters);
      this.capabilities?.authorizeTool(context.task.goal_id, tool, effectiveArgs, context);
      this.resources?.recordToolCall({
        goalId: context.task.goal_id,
        toolName: name,
        resourcePool: tool.resourcePool,
        idempotencyKey: `${context.idempotencyKey}:usage`,
      });
      const directExecute = async () => assertBoundedResult(await tool.execute(effectiveArgs, {
          ...context,
          tool,
          credentials: this.credentials,
          requiresApproval: this.requiresApproval(tool),
        }));
      const execute = () => tool.sandbox
        ? this.sandboxes.run(tool.sandbox, { tool, args: effectiveArgs, context, execute: directExecute })
        : directExecute();
      const result = await this.pools.run(tool.resourcePool, () => (
        this.operations
          ? this.operations.execute(tool, effectiveArgs, context, execute)
          : execute()
      ), context.signal);
      await this.hooks?.emit('after_tool_call', { tool: name, args: effectiveArgs, result, context });
      return result;
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason ?? error;
      const result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      await this.hooks?.emit('after_tool_call', { tool: name, args, result, context });
      return result;
    }
  }
}
