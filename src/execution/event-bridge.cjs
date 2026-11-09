"use strict";
// Single-slot, awaited producer/async-generator rendezvous. No detached queue.
function createEventBridge() {
  let slot, wake, ended = false, failure;
  function notify() { wake?.(); wake = null; }
  return {
    send(value) {
      if (ended) return Promise.reject(failure || new Error("Event consumer closed"));
      if (slot) return Promise.reject(new Error("Producer did not await event consumption"));
      return new Promise((resolve, reject) => { slot = { value, resolve, reject }; notify(); });
    },
    finish(error) {
      ended = true; failure = error;
      if (error && slot) { slot.reject(error); slot = null; }
      notify();
    },
    async *events() {
      try {
        while (true) {
          if (slot) {
            const item = slot; slot = null;
            let acknowledged = false;
            try { yield item.value; acknowledged = true; item.resolve(); }
            catch (error) { item.reject(error); throw error; }
            finally { if (!acknowledged) item.reject(failure || new Error("Event consumer closed")); }
            continue;
          }
          if (ended) { if (failure) throw failure; return; }
          await new Promise(resolve => { wake = resolve; });
        }
      } finally {
        ended = true;
        failure ||= new Error("Event consumer closed");
        if (slot) { slot.reject(failure); slot = null; }
        notify();
      }
    },
  };
}
module.exports = { createEventBridge };
