import { EventEmitter } from 'node:events';

export class PersistentEventBus extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
  }

  publish(input) {
    const result = this.store.publishEvent(input);
    return this.announce(result);
  }

  announce(result) {
    this.emit('event', result);
    this.emit('change', {
      type: 'EVENT_PUBLISHED',
      event: result.event,
      awakened: result.awakened,
      duplicate: result.duplicate,
    });
    return result;
  }
}
