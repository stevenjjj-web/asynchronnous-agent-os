import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstatSync, realpathSync } from 'node:fs';

function validatePluginPath(configuredPath, requirePrivateFiles) {
  const lexical = resolve(configuredPath);
  const stats = lstatSync(lexical);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('Plugin path must be a regular file and may not be a symbolic link');
  if (process.platform !== 'win32') {
    if (requirePrivateFiles && (stats.mode & 0o022) !== 0) {
      throw new Error('Plugin file must not be writable by group or other users');
    }
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      throw new Error('Plugin file must be owned by the Agent OS process user');
    }
    const parent = lstatSync(dirname(lexical));
    if (!parent.isDirectory() || (parent.mode & 0o022) !== 0) {
      throw new Error('Plugin parent directory must not be writable by group or other users');
    }
    if (typeof process.getuid === 'function' && parent.uid !== process.getuid()) {
      throw new Error('Plugin parent directory must be owned by the Agent OS process user');
    }
  }
  const canonical = realpathSync(lexical);
  if (canonical !== lexical) throw new Error('Plugin path must be canonical');
  return canonical;
}

export class PluginManager {
  constructor({ config, tools, actions, channels, hooks, sensors, listeners, sandboxes, memoryPortability }) {
    this.config = config;
    this.tools = tools;
    this.actions = actions;
    this.channels = channels;
    this.hooks = hooks;
    this.sensors = sensors;
    this.listeners = listeners;
    this.sandboxes = sandboxes;
    this.memoryPortability = memoryPortability;
    this.loaded = [];
    this.diagnostics = [];
  }

  async loadConfigured() {
    const policy = this.config.security.plugins ?? {};
    for (const configuredPath of this.config.security.pluginPaths ?? []) {
      const path = resolve(configuredPath);
      try {
        const canonicalPath = validatePluginPath(path, policy.requirePrivateFiles !== false);
        const module = await import(pathToFileURL(canonicalPath).href);
        const plugin = module.default ?? module.plugin ?? module;
        if (!plugin?.id || typeof plugin.register !== 'function') throw new Error('Plugin must export { id, register(api) }');
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(plugin.id)) throw new Error(`Invalid plugin id: ${plugin.id}`);
        if (policy.allowIds?.length && !policy.allowIds.includes(plugin.id)) throw new Error(`Plugin is not allowlisted: ${plugin.id}`);
        if (this.loaded.some((entry) => entry.id === plugin.id)) throw new Error(`Duplicate plugin id: ${plugin.id}`);
        await plugin.register(this.createApi(plugin));
        this.loaded.push({ id: plugin.id, name: plugin.name ?? plugin.id, path: canonicalPath });
      } catch (error) {
        this.diagnostics.push({ path, level: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.diagnostics.length && policy.failClosed !== false) {
      throw new Error(`Plugin loading failed closed: ${this.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join('; ')}`);
    }
    return { loaded: this.loaded, diagnostics: this.diagnostics };
  }

  createApi(plugin) {
    return Object.freeze({
      pluginId: plugin.id,
      registerTool: (tool) => this.tools.register(tool),
      registerAction: (name, handler) => this.actions.register(name, handler),
      registerChannel: (id, adapter) => {
        this.channels.register(id, adapter);
        if (typeof adapter.listen === 'function') {
          this.listeners.register(`channel-${id}`, {
            description: adapter.description ?? `Resident inbound listener for ${id}`,
            run: (context) => adapter.listen({
              ...context,
              ingest: (message) => this.channels.ingest(id, message),
            }),
          });
        }
        return this.channels;
      },
      registerSensor: (type, sensor) => this.sensors.register(type, sensor),
      registerListener: (name, listener) => this.listeners.register(name, listener),
      registerSandbox: (name, adapter) => this.sandboxes.register(name, adapter),
      registerMemoryProvider: (id, adapter) => this.memoryPortability.registerProvider(id, adapter),
      on: (name, handler, options) => this.hooks.on(name, handler, options),
    });
  }
}
