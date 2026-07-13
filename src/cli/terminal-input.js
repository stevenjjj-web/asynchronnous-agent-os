import { emitKeypressEvents } from 'node:readline';
import { suggestCommands } from './command-palette.js';

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function visibleLength(value) {
  return String(value).replace(ANSI_PATTERN, '').length;
}

function fit(value, width) {
  const text = String(value ?? '');
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(1, width - 1))}…`;
}

export function commandDropdownLines(commands, {
  selectedIndex = 0, pageSize = 6, columns = 100, format, titleLabel = 'Commands', footer,
} = {}) {
  if (!commands.length) return [];
  const width = Math.max(54, Math.min(100, Number(columns ?? 100) - 2));
  const safeIndex = Math.max(0, Math.min(commands.length - 1, selectedIndex));
  const pageStart = Math.floor(safeIndex / pageSize) * pageSize;
  const page = commands.slice(pageStart, pageStart + pageSize);
  const first = pageStart + 1;
  const last = pageStart + page.length;
  const title = ` ${titleLabel} ${first}-${last}/${commands.length} `;
  const topFill = Math.max(0, width - title.length - 2);
  const lines = [format.cyan(`╭${title}${'─'.repeat(topFill)}╮`)];
  for (let index = 0; index < pageSize; index += 1) {
    const command = page[index];
    if (!command) {
      lines.push(format.dim(`│ ${' '.repeat(width - 4)} │`));
      continue;
    }
    const absoluteIndex = pageStart + index;
    const selected = absoluteIndex === safeIndex;
    const marker = selected ? '›' : ' ';
    const usageWidth = Math.max(20, Math.min(34, Math.floor(width * 0.38)));
    const content = `${marker} ${fit(command.usage, usageWidth)} ${fit(command.description, width - usageWidth - 7)}`;
    const row = `│ ${fit(content, width - 4)} │`;
    lines.push(selected ? format.cyan(format.bold(row)) : row);
  }
  const footerText = footer ?? ' ↑↓ move  PgUp/PgDn page  Tab/Enter select  Esc close ';
  lines.push(format.dim(`╰${fit(footerText, width - 2)}╯`));
  return lines;
}

export class TerminalInput {
  constructor({ input = process.stdin, output = process.stdout, format }) {
    this.input = input;
    this.output = output;
    this.format = format;
    this.active = false;
    this.pending = null;
    this.buffer = '';
    this.cursor = 0;
    this.prompt = '';
    this.commandsEnabled = false;
    this.selectionOptions = null;
    this.menuSuppressed = false;
    this.selectedIndex = 0;
    this.renderedDropdownLines = 0;
    this.history = [];
    this.historyIndex = 0;
    this.wasRaw = false;
    this.onKeypress = (character, key = {}) => this.handleKeypress(character, key);
    this.onResize = () => this.render();
  }

  start() {
    if (this.active) return;
    if (!this.input.isTTY || typeof this.input.setRawMode !== 'function') {
      throw new Error('Interactive terminal input requires a TTY');
    }
    this.wasRaw = Boolean(this.input.isRaw);
    emitKeypressEvents(this.input);
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on('keypress', this.onKeypress);
    this.output.on?.('resize', this.onResize);
    this.active = true;
  }

  question(prompt, { commands = false } = {}) {
    if (!this.active) throw new Error('Terminal input is not running');
    if (this.pending) throw new Error('Terminal input already has an active question');
    this.prompt = prompt;
    this.buffer = '';
    this.cursor = 0;
    this.commandsEnabled = commands;
    this.selectionOptions = null;
    this.menuSuppressed = false;
    this.selectedIndex = 0;
    this.historyIndex = this.history.length;
    this.render();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  select(prompt, options) {
    if (!this.active) throw new Error('Terminal input is not running');
    if (this.pending) throw new Error('Terminal input already has an active question');
    if (!Array.isArray(options) || !options.length) throw new Error('Selection requires at least one option');
    this.prompt = prompt;
    this.buffer = '';
    this.cursor = 0;
    this.commandsEnabled = false;
    this.selectionOptions = options.map((option) => ({
      ...option,
      name: String(option.value),
      usage: String(option.label ?? option.value),
      description: String(option.description ?? ''),
    }));
    this.menuSuppressed = false;
    this.selectedIndex = 0;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, selection: true };
      this.render();
    });
  }

  suggestions() {
    if (this.selectionOptions) {
      const query = this.buffer.trim().toLowerCase();
      if (!query) return this.selectionOptions;
      return this.selectionOptions.filter((option) => (
        `${option.label ?? ''} ${option.value} ${option.description ?? ''}`.toLowerCase().includes(query)
      ));
    }
    if (!this.commandsEnabled || this.menuSuppressed || !this.buffer.startsWith('/')) return [];
    return suggestCommands(this.buffer, Number.POSITIVE_INFINITY);
  }

  pageSize() {
    const available = Number(this.output.rows ?? 30) - 17;
    return Math.max(4, Math.min(8, available));
  }

  handleKeypress(character, key) {
    if (!this.pending) return;
    const suggestions = this.suggestions();
    if (key.ctrl && key.name === 'c') {
      if (this.buffer) {
        this.buffer = '';
        this.cursor = 0;
        this.menuSuppressed = false;
        this.selectedIndex = 0;
        this.render();
      } else {
        this.finish(this.commandsEnabled ? '/quit' : '');
      }
      return;
    }
    if (key.ctrl && key.name === 'u') {
      this.buffer = '';
      this.cursor = 0;
      this.menuSuppressed = false;
      this.selectedIndex = 0;
      this.render();
      return;
    }
    if (key.ctrl && key.name === 'a' || key.name === 'home') {
      this.cursor = 0;
      this.render();
      return;
    }
    if (key.ctrl && key.name === 'e' || key.name === 'end') {
      this.cursor = this.buffer.length;
      this.render();
      return;
    }
    if (key.name === 'left') {
      this.cursor = Math.max(0, this.cursor - 1);
      this.render();
      return;
    }
    if (key.name === 'right') {
      this.cursor = Math.min(this.buffer.length, this.cursor + 1);
      this.render();
      return;
    }
    if (key.name === 'up' || key.name === 'down') {
      if (suggestions.length) {
        const delta = key.name === 'up' ? -1 : 1;
        this.selectedIndex = (this.selectedIndex + delta + suggestions.length) % suggestions.length;
      } else if (!this.selectionOptions) {
        this.navigateHistory(key.name === 'up' ? -1 : 1);
      }
      this.render();
      return;
    }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      if (suggestions.length) {
        const delta = key.name === 'pageup' ? -this.pageSize() : this.pageSize();
        this.selectedIndex = Math.max(0, Math.min(suggestions.length - 1, this.selectedIndex + delta));
        this.render();
      }
      return;
    }
    if (key.name === 'tab' && suggestions.length) {
      if (this.selectionOptions) {
        this.finishSelection(suggestions);
        return;
      }
      this.applySelection(suggestions);
      return;
    }
    if (key.name === 'escape') {
      if (this.selectionOptions) {
        this.finish(null, 'cancelled');
        return;
      }
      this.menuSuppressed = true;
      this.render();
      return;
    }
    if (key.name === 'backspace') {
      if (this.cursor > 0) {
        this.buffer = `${this.buffer.slice(0, this.cursor - 1)}${this.buffer.slice(this.cursor)}`;
        this.cursor -= 1;
        this.afterEdit();
      }
      return;
    }
    if (key.name === 'delete') {
      if (this.cursor < this.buffer.length) {
        this.buffer = `${this.buffer.slice(0, this.cursor)}${this.buffer.slice(this.cursor + 1)}`;
        this.afterEdit();
      }
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (this.selectionOptions) {
        if (suggestions.length) this.finishSelection(suggestions);
        return;
      }
      if (suggestions.length && !this.buffer.includes(' ')) {
        const selected = suggestions[Math.max(0, Math.min(suggestions.length - 1, this.selectedIndex))];
        const exact = selected.name === this.buffer || selected.aliases?.includes(this.buffer);
        if (exact) this.finish(this.buffer);
        else this.applySelection(suggestions);
      } else {
        this.finish(this.buffer);
      }
      return;
    }
    if (character && !key.ctrl && !key.meta && character >= ' ') {
      this.buffer = `${this.buffer.slice(0, this.cursor)}${character}${this.buffer.slice(this.cursor)}`;
      this.cursor += character.length;
      this.afterEdit();
    }
  }

  afterEdit() {
    this.menuSuppressed = false;
    this.selectedIndex = 0;
    this.render();
  }

  applySelection(suggestions) {
    const selected = suggestions[Math.max(0, Math.min(suggestions.length - 1, this.selectedIndex))];
    const suffix = selected.usage.includes('<') || selected.usage.includes('[') ? ' ' : '';
    this.buffer = `${selected.name}${suffix}`;
    this.cursor = this.buffer.length;
    this.menuSuppressed = true;
    this.render();
  }

  finishSelection(suggestions) {
    const selected = suggestions[Math.max(0, Math.min(suggestions.length - 1, this.selectedIndex))];
    this.finish(selected.value, selected.label ?? selected.value);
  }

  navigateHistory(delta) {
    if (!this.history.length) return;
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
    this.buffer = this.historyIndex === this.history.length ? '' : this.history[this.historyIndex];
    this.cursor = this.buffer.length;
  }

  clearRenderedBlock() {
    this.output.write('\r\u001b[2K');
    for (let index = 0; index < this.renderedDropdownLines; index += 1) {
      this.output.write('\n\r\u001b[2K');
    }
    if (this.renderedDropdownLines) this.output.write(`\u001b[${this.renderedDropdownLines}A`);
    this.output.write('\r');
  }

  render() {
    if (!this.pending && !this.prompt) return;
    const suggestions = this.suggestions();
    this.selectedIndex = Math.max(0, Math.min(Math.max(0, suggestions.length - 1), this.selectedIndex));
    const dropdown = commandDropdownLines(suggestions, {
      selectedIndex: this.selectedIndex,
      pageSize: this.pageSize(),
      columns: this.output.columns,
      format: this.format,
      titleLabel: this.selectionOptions ? 'Models' : 'Commands',
      footer: this.selectionOptions
        ? ' type to filter  ↑↓ move  PgUp/PgDn page  Enter select  Esc cancel '
        : undefined,
    });
    this.clearRenderedBlock();
    this.output.write(`${this.prompt}${this.buffer}`);
    for (const line of dropdown) this.output.write(`\n\r\u001b[2K${line}`);
    this.renderedDropdownLines = dropdown.length;
    if (dropdown.length) this.output.write(`\u001b[${dropdown.length}A`);
    const column = visibleLength(this.prompt) + this.cursor;
    this.output.write(`\r${column ? `\u001b[${column}C` : ''}`);
  }

  finish(value, display = value) {
    const pending = this.pending;
    if (!pending) return;
    this.clearRenderedBlock();
    this.output.write(`${this.prompt}${display ?? ''}\n`);
    this.renderedDropdownLines = 0;
    this.prompt = '';
    this.selectionOptions = null;
    this.pending = null;
    const trimmed = String(value ?? '').trim();
    if (this.commandsEnabled && trimmed && !this.history.includes(trimmed)) this.history.push(trimmed);
    pending.resolve(value);
  }

  stop() {
    if (!this.active) return;
    if (this.pending) this.pending.reject(new Error('Terminal input stopped'));
    this.clearRenderedBlock();
    this.input.off('keypress', this.onKeypress);
    this.output.off?.('resize', this.onResize);
    this.input.setRawMode(this.wasRaw);
    this.active = false;
    this.pending = null;
  }
}
