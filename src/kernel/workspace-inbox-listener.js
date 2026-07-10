import { statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { waitForAbort } from './async-signal.js';

export function createWorkspaceInboxListener({ store, monitoring, heartbeatMs }) {
  return {
    description: 'Uses operating-system file notifications to wake durable workspace inbox monitors immediately.',
    async run({ signal, heartbeat }) {
      const watchers = [];
      const directories = [];
      let notifications = 0;
      let fallbackWakeups = 0;
      let lastError = null;
      const wake = (agentId) => {
        notifications += 1;
        for (const monitor of store.listMonitors({ agentId })) {
          if (monitor.enabled && monitor.sensor_type === 'workspace_inbox') monitoring.runNow(monitor.id);
        }
      };
      for (const agent of store.listAgents()) {
        const directory = join(agent.workspace, 'inbox');
        directories.push({ agentId: agent.id, directory, modifiedAt: statSync(directory).mtimeMs });
        const watcher = watch(directory, { persistent: false }, () => wake(agent.id));
        watcher.on('error', (error) => {
          lastError = error.message;
          heartbeat({ lastError, notifications, fallbackWakeups });
        });
        watchers.push(watcher);
      }
      const timer = setInterval(() => {
        for (const state of directories) {
          const modifiedAt = statSync(state.directory).mtimeMs;
          if (modifiedAt !== state.modifiedAt) {
            state.modifiedAt = modifiedAt;
            fallbackWakeups += 1;
            wake(state.agentId);
          }
        }
        heartbeat({ watchers: watchers.length, notifications, fallbackWakeups, lastError });
      }, Math.max(100, heartbeatMs));
      heartbeat({ watchers: watchers.length, notifications, fallbackWakeups, lastError });
      try {
        await waitForAbort(signal);
      } finally {
        clearInterval(timer);
        for (const watcher of watchers) watcher.close();
      }
    },
  };
}
