import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class PluginManager {
  constructor({ config, tools, actions, channels, hooks, sensors, listeners }) {
    this.config = config;
    this.tools = tools;
    this.actions = actions;
    this.channels = channels;
    this.hooks = hooks;
    this.sensors = sensors;
    this.listeners = listeners;
    this.loaded = [];
    this.diagnostics = [];
  }

  async loadConfigured() {
    for (const configuredPath of this.config.security.pluginPaths ?? []) {
      const path = resolve(configuredPath);
      try {
        const module = await import(pathToFileURL(path).href);
        const plugin = module.default ?? module.plugin ?? module;
        if (!plugin?.id || typeof plugin.register !== 'function') throw new Error('Plugin must export { id, register(api) }');
        if (this.loaded.some((entry) => entry.id === plugin.id)) throw new Error(`Duplicate plugin id: ${plugin.id}`);
        await plugin.register(this.createApi(plugin));
        this.loaded.push({ id: plugin.id, name: plugin.name ?? plugin.id, path });
      } catch (error) {
        this.diagnostics.push({ path, level: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { loaded: this.loaded, diagnostics: this.diagnostics };
  }

  createApi(plugin) {
    return Object.freeze({
      pluginId: plugin.id,
      registerTool: (tool) => this.tools.register(tool),
      registerAction: (name, handler) => this.actions.register(name, handler),
      registerChannel: (id, adapter) => this.channels.register(id, adapter),
      registerSensor: (type, sensor) => this.sensors.register(type, sensor),
      registerListener: (name, listener) => this.listeners.register(name, listener),
      on: (name, handler, options) => this.hooks.on(name, handler, options),
    });
  }
}
