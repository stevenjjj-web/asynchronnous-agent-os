import { createHash } from 'node:crypto';
import { ActionControl, isActionControl } from './tool-registry.js';

function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.length > 1_000_000) throw new Error('Tool arguments are invalid or oversized');
  const value = JSON.parse(raw || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be a JSON object');
  return value;
}

function assistantMessage(response) {
  return {
    role: 'assistant',
    content: response.content ?? '',
    ...(response.toolCalls?.length ? {
      tool_calls: response.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    } : {}),
  };
}

function evidenceRecord({ id, sourceType = 'tool', source, value, observedAt = Date.now() }) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    id,
    sourceType,
    source,
    observedAt,
    digest: createHash('sha256').update(serialized).digest('hex'),
    excerpt: serialized.slice(0, 500),
  };
}

export class AgentTurnService {
  constructor({ store, config, providers, tools, contextBuilder, hooks, resources }) {
    this.store = store;
    this.config = config;
    this.providers = providers;
    this.tools = tools;
    this.contextBuilder = contextBuilder;
    this.hooks = hooks;
    this.resources = resources;
  }

  resolveModel(agent, session, goal) {
    const modelKey = goal?.metadata.modelKey ?? session.metadata.modelKey ?? agent.model_key;
    const baseConfig = this.config.models[modelKey];
    if (!baseConfig) throw new Error(`Unknown model config: ${modelKey}`);
    const modelId = goal?.metadata.modelId ?? session.metadata.modelId ?? baseConfig.model;
    const modelConfig = { ...baseConfig, model: modelId };
    return {
      modelKey,
      modelId,
      modelConfig,
      provider: this.providers.create(modelConfig.provider, modelConfig),
    };
  }

  async run(input, context) {
    const session = this.store.getSession(input.sessionId ?? context.task.session_id);
    if (!session) throw new Error('Agent turn requires a session');
    const recallTask = context.task.dependsOn.map((id) => this.store.getTask(id)).find((task) => task?.kind === 'memory-recall');
    const recalled = recallTask?.result?.memories ?? [];
    const goal = this.store.getGoal(context.task.goal_id);
    const built = context.actionState?.messages
      ? { session, agent: this.store.getAgent(session.agent_id), messages: context.actionState.messages }
      : this.contextBuilder.build(session.id, recalled, {
          throughMessageId: goal?.metadata.messageId,
          goalId: context.task.goal_id,
        });
    const selectedModel = this.resolveModel(built.agent, session, goal);
    let messages = built.messages;
    let pending = context.actionState?.pending ?? null;
    const trace = [...(context.actionState?.trace ?? [])];
    const evidence = context.actionState?.evidence
      ? [...context.actionState.evidence]
      : recalled.map((memory) => evidenceRecord({
          id: `memory:${memory.id}`,
          sourceType: 'memory',
          source: memory.id,
          value: memory.content,
          observedAt: memory.created_at,
        }));

    if (pending) {
      const resumed = await this.resumePendingTool(pending, context, session);
      if (isActionControl(resumed) && resumed.__agentControl === 'wait') {
        return ActionControl.wait(resumed.wait, { messages, pending: { ...pending, toolState: resumed.state }, trace, evidence });
      }
      const resumedValue = isActionControl(resumed) ? resumed.value : resumed;
      messages = [...messages, {
        role: 'tool',
        tool_call_id: pending.call.id,
        content: JSON.stringify(resumedValue),
      }];
      evidence.push(evidenceRecord({
        id: `tool:${context.task.id}:${pending.call.id}`,
        source: pending.call.name,
        value: resumedValue,
      }));
      trace.push({ tool: pending.call.name, resumedAt: Date.now() });
      pending = null;
    }

    for (let iteration = 0; iteration < 8; iteration += 1) {
      const prepared = await this.hooks.emit('before_model_call', { session, task: context.task, messages });
      if (prepared.cancelled) throw new Error('Model call cancelled by policy');
      const modelMessages = prepared.messages ?? messages;
      const modelConfig = selectedModel.modelConfig;
      const allowance = this.resources?.assertModelCall(context.task.goal_id, modelMessages, modelConfig);
      const response = await selectedModel.provider.complete({
        messages: modelMessages,
        tools: this.tools.modelDefinitions(context.task.goal_id),
        signal: context.signal,
        maxTokens: allowance?.maxOutputTokens,
      });
      this.resources?.recordModelUsage({
        goalId: context.task.goal_id,
        usage: response.usage,
        estimatedInputTokens: allowance?.estimatedInputTokens,
        estimatedOutputTokens: Math.ceil(JSON.stringify(response).length / 4),
        modelConfig,
        idempotencyKey: `${context.idempotencyKey}:model:${iteration}:attempt:${context.task.attempt}`,
      });
      await this.hooks.emit('after_model_call', { session, task: context.task, response });
      messages = [...messages, assistantMessage(response)];

      if (!response.toolCalls?.length) {
        return ActionControl.value({
          text: response.content ?? '',
          usage: response.usage,
          model: selectedModel.modelId,
          modelKey: selectedModel.modelKey,
          trace,
          evidence,
        });
      }

      for (const call of response.toolCalls) {
        const tool = this.tools.get(call.name);
        let args;
        try {
          args = parseArguments(call.arguments);
        } catch (error) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: error.message }) });
          continue;
        }
        if (!tool) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` }) });
          continue;
        }

        if (this.tools.requiresApproval(tool)) {
          const approvalId = `approval:${context.task.id}:${call.id}`;
          let approval = this.store.getApproval(approvalId);
          if (!approval) {
            approval = this.store.createApproval({
              id: approvalId,
              goalId: context.task.goal_id,
              taskId: context.task.id,
              sessionId: session.id,
              action: call.name,
              risk: tool.risk,
              parameters: args,
            });
          }
          return ActionControl.wait({
            kind: 'event',
            topic: 'approval.resolved',
            correlationKey: approval.id,
            reason: `Tool ${call.name} requires user approval`,
          }, { messages, pending: { type: 'approval', call, args, approvalId: approval.id }, trace, evidence });
        }

        const result = await this.tools.execute(call.name, args, {
          task: context.task,
          session,
          idempotencyKey: `${context.idempotencyKey}:tool:${call.id}`,
          resumeEvent: null,
          signal: context.signal,
        });
        if (isActionControl(result) && result.__agentControl === 'wait') {
          return ActionControl.wait(result.wait, {
            messages,
            pending: { type: 'tool', call, args, toolState: result.state, wait: result.wait },
            trace,
            evidence,
          });
        }
        const toolValue = isActionControl(result) ? result.value : result;
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(toolValue),
        });
        evidence.push(evidenceRecord({
          id: `tool:${context.task.id}:${call.id}`,
          source: call.name,
          value: toolValue,
        }));
        trace.push({ tool: call.name, at: Date.now() });
      }
    }
    throw new Error('Agent tool loop exceeded 8 iterations');
  }

  async resumePendingTool(pending, context, session) {
    if (!context.resumeEvent) {
      if (pending.wait?.kind === 'timer') {
        return this.tools.execute(pending.call.name, pending.args, {
          task: context.task,
          session,
          idempotencyKey: `${context.idempotencyKey}:tool:${pending.call.id}`,
          resumeEvent: null,
          toolState: pending.toolState,
          signal: context.signal,
        });
      }
      return ActionControl.wait({
        kind: 'event',
        topic: pending.type === 'approval' ? 'approval.resolved' : pending.wait?.topic,
        correlationKey: pending.type === 'approval' ? pending.approvalId : pending.wait?.correlationKey,
        reason: 'Waiting for a resume event',
      }, pending.toolState);
    }
    if (pending.type === 'approval') {
      const approved = context.resumeEvent.payload?.decision === 'approve'
        || context.resumeEvent.payload?.status === 'APPROVED';
      if (!approved) return { ok: false, error: 'The user denied this tool call' };
    }
    return this.tools.execute(pending.call.name, pending.args, {
      task: context.task,
      session,
      idempotencyKey: `${context.idempotencyKey}:tool:${pending.call.id}`,
      resumeEvent: context.resumeEvent,
      toolState: pending.toolState,
      approvalGranted: pending.type === 'approval',
      signal: context.signal,
    });
  }
}
