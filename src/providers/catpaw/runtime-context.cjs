"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const storage = new AsyncLocalStorage();
function current() {
  const value = storage.getStore();
  if (!value) throw new Error("CatPaw execution context unavailable");
  return value;
}
module.exports = { current, run: (value, fn) => storage.run(value, fn) };
