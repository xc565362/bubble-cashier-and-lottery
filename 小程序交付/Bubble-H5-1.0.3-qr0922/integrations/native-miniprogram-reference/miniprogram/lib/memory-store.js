(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LotteryMemory = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const clone = value => JSON.parse(JSON.stringify(value));
  class MemoryStore {
    constructor(initial = {}, persist = () => {}) { this.data = clone(initial); this.persist = persist; this.queue = Promise.resolve(); }
    export() { return clone(this.data); }
    transaction(callback) {
      const task = this.queue.then(async () => {
        const working = clone(this.data);
        const tx = {
          get: async (collection, id) => clone((working[collection] || {})[id] || null),
          set: async (collection, id, value) => {
            if (!working[collection]) working[collection] = {};
            working[collection][id] = clone(value);
          }
        };
        const result = await callback(tx);
        this.persist(clone(working));
        this.data = working;
        return result;
      });
      this.queue = task.catch(() => {});
      return task;
    }
  }
  return { MemoryStore };
});
