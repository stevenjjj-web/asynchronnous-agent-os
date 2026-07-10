import { ActionControl, isActionControl } from './tool-registry.js';

function parseArguments(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
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

export class AgentTurnService {
  constructor({ store, config, providers, tools, contextBuilder, hooks }) {
    this.store = store;
    this.config = config;
    this.providers = providers;
    this.tools = tools;
    this.contextBuilder = contextBuilder;
    this.hooks = hooks;
  }

  resolveProvider(agent) {
    const modelConfig = this.config.models[agent.model_key];
    if (!modelConfig) throw new Error(`Unknown model config: ${agent.model_key}`);
    return this.providers.create(modelConfig.provider, modelConfig);
  }

  async run(input, context) {
    const session = this.store.getSession(input.sessionId ?? context.task.session_id);
    if (!session) throw new Error('Agent turn requires a session');
    const recallTask = context.task.dependsOn.map((id) => this.store.getTask(id)).find((task) => task?.kind === 'memory-recall');
    const recalled = recallTask?.result?.memories ?? [];
    const goal = this.store.getGoal(context.task.goal_id);
    const built = context.actionState?.messages
      ? { session, agent: this.store.getAgent(session.agent_id), messages: context.actionState.messages }
      : this.contextBuilder.build(session.id, recalled, { throughMessageId: goal?.metadata.messageId });
    const provider = this.resolveProvider(built.agent);
    let messages = built.messages;
    let pending = context.actionState?.pending ?? null;
    const trace = [...(context.actionState?.trace ?? [])];

    if (pending) {
      const resumed = await this.resumePendingTool(pending, context, session);
      if (isActionControl(resumed) && resumed.__agentControl === 'wait') {
        return ActionControl.wait(resumed.wait, { messages, pending: { ...pending, toolState: resumed.state }, trace });
      }
      messages = [...messages, {
        role: 'tool',
        tool_call_id: pending.call.id,
        content: JSON.stringify(isActionControl(resumed) ? resumed.value : resumed),
      }];
      trace.push({ tool: pending.call.name, resumedAt: Date.now() });
      pending = null;
    }

    for (let iteration = 0; iteration < 8; iteration += 1) {
      const prepared = await this.hooks.emit('before_model_call', { session, task: context.task, messages });
      const response = await provider.complete({
        messages: prepared.messages ?? messages,
        tools: this.tools.modelDefinitions(),
        signal: context.signal,
      });
      await this.hooks.emit('after_model_call', { session, task: context.task, response });
      messages = [...messages, assistantMessage(response)];

      if (!response.toolCalls?.length) {
        return ActionControl.value({
          text: response.content ?? '',
          usage: response.usage,
          model: built.agent.model_key,
          trace,
        });
      }

      for (const call of response.toolCalls) {
        const tool = this.tools.get(call.name);
        const args = parseArguments(call.arguments);
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
          }, { messages, pending: { type: 'approval', call, args, approvalId: approval.id }, trace });
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
          });
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(isActionControl(result) ? result.value : result),
        });
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
