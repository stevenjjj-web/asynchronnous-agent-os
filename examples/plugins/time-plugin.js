export default {
  id: 'example-time',
  name: 'Example Time Tool',
  register(api) {
    api.registerTool({
      name: 'current_time',
      description: 'Returns the current time in the requested time zone.',
      risk: 'low',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string' } },
        required: ['timezone'],
        additionalProperties: false,
      },
      execute: async ({ timezone }) => ({
        ok: true,
        timezone,
        value: new Intl.DateTimeFormat('zh-CN', {
          dateStyle: 'full',
          timeStyle: 'long',
          timeZone: timezone,
        }).format(new Date()),
      }),
    });
  },
};
