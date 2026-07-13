import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormatter } from '../src/cli/format.js';
import { canAnimate, renderWelcome, startupFrame, welcomeBanner } from '../src/cli/banner.js';

function healthFixture() {
  return {
    stats: {
      tasks: { RUNNING: 1, READY: 2, WAITING: 3 },
      memories: 12,
      activeCapabilityContracts: 4,
    },
    kernel: { status: 'alive', hostPid: 4242, services: [{}, {}, {}, {}, {}] },
    modelConfigured: true,
  };
}

function outputFixture({ isTTY = false, columns = 80 } = {}) {
  const chunks = [];
  return {
    isTTY,
    columns,
    chunks,
    write(value) {
      chunks.push(String(value));
      return true;
    },
  };
}

test('animated kernel owl is responsive and the permanent banner reports live kernel state', () => {
  const output = outputFixture();
  const format = createFormatter({ color: false, stdout: output });
  assert.ok(startupFrame({ format, phase: 2, columns: 100 }).every((line) => line.length === 74));
  assert.ok(startupFrame({ format, phase: 2, columns: 60 }).every((line) => line.length === 46));
  const banner = welcomeBanner({
    health: healthFixture(), format, version: '0.5.0', sessionKey: 'session:test', columns: 80,
  });
  assert.match(banner, /Agent OS v0\.5\.0/);
  assert.match(banner, /◉  ◉/);
  assert.match(banner, /awake while your work is waiting/);
  assert.match(banner, /KERNEL ONLINE/);
  assert.match(banner, /1 running · 2 ready · 3 waiting/);
  assert.match(banner, /session:test/);
});

test('startup animation respects terminal and reduced-motion boundaries', async () => {
  assert.equal(canAnimate({ output: outputFixture({ isTTY: false }), env: {} }), false);
  assert.equal(canAnimate({ output: outputFixture({ isTTY: true }), env: { CI: '1' } }), false);
  assert.equal(canAnimate({ output: outputFixture({ isTTY: true }), env: { AGENT_OS_NO_ANIMATION: 'true' } }), false);

  const output = outputFixture({ isTTY: true });
  const format = createFormatter({ color: false, stdout: output });
  await renderWelcome({
    client: { get: async () => healthFixture() },
    format,
    version: '0.5.0',
    sessionKey: 'session:animated',
    output,
    frameDelayMs: 0,
    env: {},
  });
  const rendered = output.chunks.join('');
  assert.match(rendered, /\u001b\[\?25l/);
  assert.match(rendered, /\u001b\[\?25h/);
  assert.match(rendered, /session:animated/);
});
