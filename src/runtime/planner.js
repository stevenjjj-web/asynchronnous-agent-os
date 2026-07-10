import { randomUUID } from 'node:crypto';

export class IntentPlanner {
  compile(objective, options = {}) {
    const goalId = randomUUID();
    const clarifyId = randomUUID();
    const contextId = randomUUID();
    const riskId = randomUUID();
    const synthesisId = randomUUID();
    const reviewId = randomUUID();
    const replyKey = `goal:${goalId}:requirements`;
    const requireReply = options.requireReply !== false;
    const priority = Math.max(10, Math.min(100, Number(options.priority ?? 80)));

    const clarifyWorkflow = [
      { type: 'record', message: 'Analyzing the user goal and confirming success criteria' },
      ...(requireReply ? [{
        type: 'await_event',
        topic: 'user.reply',
        correlationKey: replyKey,
        saveAs: 'userReply',
        reason: 'Critical constraints require user input. The task is suspended and its execution slot has been released.',
        timeoutMs: options.replyTimeoutMs ?? 86_400_000,
      }] : [{ type: 'set', name: 'userReply', value: { message: 'No external input is required' } }]),
      { type: 'record', message: 'External reply received: {{userReply.message}}. Resuming from the saved snapshot.' },
      {
        type: 'complete',
        result: {
          successCriteria: ['Goal boundaries are clear', 'Critical constraints are recorded', 'Downstream tasks have the required inputs'],
          userReply: '{{userReply}}',
        },
      },
    ];

    return {
      goal: {
        id: goalId,
        title: objective.length > 30 ? `${objective.slice(0, 30)}…` : objective,
        objective,
        metadata: { replyTopic: 'user.reply', replyKey, createdBy: 'intent-planner-v1' },
      },
      tasks: [
        {
          id: clarifyId,
          title: 'Confirm requirements and success criteria',
          priority: Math.min(100, priority + 10),
          workflow: clarifyWorkflow,
        },
        {
          id: contextId,
          title: 'Collect context in parallel',
          priority: Math.max(0, priority - 10),
          workflow: [
            { type: 'record', message: 'Collecting goal context without waiting for the user' },
            { type: 'delay', durationMs: options.contextDelayMs ?? 1_400, reason: 'External context retrieval is in progress. Suspend I/O and release the execution slot.' },
            { type: 'call', action: 'collect_context', input: { objective: '{{objective}}' }, saveAs: 'context' },
            { type: 'complete', result: '{{context}}' },
          ],
        },
        {
          id: riskId,
          title: 'Assess risks in parallel',
          priority: Math.max(0, priority - 15),
          workflow: [
            { type: 'record', message: 'Running an independent risk preflight' },
            { type: 'delay', durationMs: options.riskDelayMs ?? 800, reason: 'The risk analysis tool is running asynchronously' },
            { type: 'call', action: 'analyze_risks', input: { objective: '{{objective}}' }, saveAs: 'risks' },
            { type: 'complete', result: '{{risks}}' },
          ],
        },
        {
          id: synthesisId,
          title: 'Synthesize context and produce a plan',
          priority,
          dependsOn: [clarifyId, contextId, riskId],
          workflow: [
            { type: 'record', message: 'All prerequisites are complete. Starting plan synthesis.' },
            { type: 'call', action: 'compose_plan', input: { objective: '{{objective}}' }, saveAs: 'plan' },
            { type: 'complete', result: '{{plan}}' },
          ],
        },
        {
          id: reviewId,
          title: 'Review quality and deliver',
          priority: Math.max(0, priority - 20),
          dependsOn: [synthesisId],
          workflow: [
            { type: 'record', message: 'Running an independent quality review of the final plan' },
            { type: 'delay', durationMs: options.reviewDelayMs ?? 600, reason: 'The quality review is running asynchronously' },
            { type: 'call', action: 'quality_review', input: { objective: '{{objective}}' }, saveAs: 'review' },
            { type: 'complete', result: '{{review}}' },
          ],
        },
      ],
    };
  }
}
