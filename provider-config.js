(function() {
  'use strict';

  const registry = globalThis.BrowserAIRegistry;

  if (!registry) {
    console.error('[Provider Config] BrowserAIRegistry is not available');
    return;
  }

  async function initialize() {
    try {
      const state = await registry.loadState();
      await registry.syncStateToChrome(state);
      console.log('[Provider Config] Prism provider state initialized');
    } catch (error) {
      console.error('[Provider Config] Failed to initialize provider state:', error);
    }
  }

  initialize();

  console.log('[Provider Config] Module loaded');
})();
