import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let storeModule = null;

function loadStoreModule() {
  if (!storeModule) {
    storeModule = require('../store.mjs');
  }
  return storeModule;
}

export { require, storeModule, loadStoreModule };
