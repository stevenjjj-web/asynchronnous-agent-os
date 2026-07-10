export class AsyncSignal {
  constructor() {
    this.waiters = new Set();
  }

  notify(value = true) {
    for (const resolve of this.waiters) resolve(value);
    this.waiters.clear();
  }

  async wait({ signal, timeoutMs } = {}) {
    if (signal?.aborted) return false;
    return new Promise((resolve) => {
      let timeout;
      const finish = (value) => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(finish);
        resolve(value);
      };
      const onAbort = () => finish(false);
      this.waiters.add(finish);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs !== undefined) timeout = setTimeout(() => finish(false), timeoutMs);
    });
  }
}

export async function waitForAbort(signal) {
  if (signal.aborted) return;
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}
