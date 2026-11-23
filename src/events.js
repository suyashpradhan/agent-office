// Event bus: the orchestrator publishes, the dashboard subscribes (over Server-Sent Events).
// The UI never polls and never mutates state itself - it sends commands to the API and
// redraws from the events that come back. Paperclip's server/src/realtime works the same way.

import { EventEmitter } from 'node:events';

export function createBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  return {
    publish(type, payload) {
      emitter.emit('event', { type, ...payload, at: Date.now() });
    },
    subscribe(fn) {
      emitter.on('event', fn);
      return () => emitter.off('event', fn);
    },
  };
}
