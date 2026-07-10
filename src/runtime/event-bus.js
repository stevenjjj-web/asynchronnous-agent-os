import { EventEmitter } from 'node:events';

export class PersistentEventBus extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
  }

  publish(input) {
    const result = this.store.publishEvent(input);
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
