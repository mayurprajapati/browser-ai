/**
 * Tab Groups Shim
 *
 * The agent identifies which tabs it owns entirely through chrome.tabGroups:
 * every tab lookup in the bundled tab-group manager compares tab.groupId against
 * chrome.tabGroups.TAB_GROUP_ID_NONE. Chromium forks that ship their own tab
 * stacking instead of Chrome tab groups (Vivaldi) leave chrome.tabGroups
 * undefined, so those comparisons throw and the agent never registers a tab.
 *
 * This emulates the slice of the API the bundles actually use, backed by a map
 * persisted in storage.local (the service worker is ephemeral, so the map has to
 * survive restarts). It is inert on browsers with the real API.
 */

(function() {
  'use strict';

  if (!globalThis.chrome?.tabs) return;
  if (chrome.tabGroups && typeof chrome.tabs.group === 'function') return;

  const STATE_KEY = 'tabGroupsShimState';
  const NONE = -1;

  const state = { nextId: 1, groups: {}, tabs: {} };

  const ready = (async () => {
    try {
      const stored = await chrome.storage.local.get(STATE_KEY);
      Object.assign(state, stored?.[STATE_KEY] || {});
    } catch (e) {
      console.warn('[TabGroups Shim] Could not restore state:', e);
    }
  })();

  let saving = Promise.resolve();
  function save() {
    saving = saving.then(() => chrome.storage.local.set({ [STATE_KEY]: state })).catch(() => {});
    return saving;
  }

  // Chrome resolves these as promises when no callback is passed, and the bundles
  // use both forms, so mirror that contract exactly.
  function finish(promise, callback) {
    if (typeof callback !== 'function') return promise;
    promise.then(value => callback(value), () => callback(undefined));
    return undefined;
  }

  function groupIdFor(tabId) {
    const gid = state.tabs[tabId];
    return typeof gid === 'number' ? gid : NONE;
  }

  function decorate(tab) {
    if (tab && typeof tab.id === 'number') tab.groupId = groupIdFor(tab.id);
    return tab;
  }

  const nativeGet = chrome.tabs.get.bind(chrome.tabs);
  const nativeQuery = chrome.tabs.query.bind(chrome.tabs);

  chrome.tabs.get = function(tabId, callback) {
    return finish(ready.then(() => nativeGet(tabId)).then(decorate), callback);
  };

  chrome.tabs.query = function(queryInfo, callback) {
    const info = Object.assign({}, queryInfo);
    const hasGroupFilter = Object.prototype.hasOwnProperty.call(info, 'groupId');
    const wanted = info.groupId;
    // Passing an unknown key to the native query throws on browsers without the API.
    delete info.groupId;

    const promise = ready
      .then(() => nativeQuery(info))
      .then(tabs => {
        tabs.forEach(decorate);
        return hasGroupFilter ? tabs.filter(tab => tab.groupId === wanted) : tabs;
      });
    return finish(promise, callback);
  };

  chrome.tabs.group = function(options, callback) {
    const promise = ready.then(async () => {
      const raw = options?.tabIds;
      const tabIds = Array.isArray(raw) ? raw.slice() : [raw];
      if (!tabIds.length || typeof tabIds[0] !== 'number') throw new Error('No tabIds provided');

      let groupId = options?.groupId;
      if (typeof groupId !== 'number' || !state.groups[groupId]) {
        groupId = state.nextId++;
        let windowId;
        try {
          windowId = (await nativeGet(tabIds[0])).windowId;
        } catch {}
        state.groups[groupId] = {
          id: groupId,
          title: '',
          color: 'grey',
          collapsed: false,
          windowId: typeof windowId === 'number' ? windowId : chrome.windows?.WINDOW_ID_NONE ?? -1
        };
      }

      for (const tabId of tabIds) state.tabs[tabId] = groupId;
      await save();
      return groupId;
    });
    return finish(promise, callback);
  };

  chrome.tabs.ungroup = function(tabIds, callback) {
    const promise = ready.then(async () => {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const tabId of ids) delete state.tabs[tabId];
      dropEmptyGroups();
      await save();
    });
    return finish(promise, callback);
  };

  function dropEmptyGroups() {
    const live = new Set(Object.values(state.tabs));
    for (const gid of Object.keys(state.groups)) {
      if (!live.has(Number(gid))) delete state.groups[gid];
    }
  }

  function matchesQuery(group, info) {
    if (!info) return true;
    for (const key of ['windowId', 'title', 'color', 'collapsed']) {
      if (info[key] !== undefined && group[key] !== info[key]) return false;
    }
    return true;
  }

  function stubEvent() {
    return { addListener() {}, removeListener() {}, hasListener() { return false; } };
  }

  chrome.tabGroups = {
    TAB_GROUP_ID_NONE: NONE,
    Color: {
      GREY: 'grey', BLUE: 'blue', RED: 'red', YELLOW: 'yellow', GREEN: 'green',
      PINK: 'pink', PURPLE: 'purple', CYAN: 'cyan', ORANGE: 'orange'
    },

    get(groupId, callback) {
      const promise = ready.then(() => {
        const group = state.groups[groupId];
        if (!group) throw new Error(`No group with id: ${groupId}`);
        return Object.assign({}, group);
      });
      return finish(promise, callback);
    },

    query(queryInfo, callback) {
      const promise = ready.then(() =>
        Object.values(state.groups).filter(g => matchesQuery(g, queryInfo)).map(g => Object.assign({}, g))
      );
      return finish(promise, callback);
    },

    update(groupId, properties, callback) {
      const promise = ready.then(async () => {
        const group = state.groups[groupId];
        if (!group) throw new Error(`No group with id: ${groupId}`);
        Object.assign(group, properties || {});
        await save();
        return Object.assign({}, group);
      });
      return finish(promise, callback);
    },

    move(groupId, _moveProperties, callback) {
      return finish(ready.then(() => Object.assign({}, state.groups[groupId] || {})), callback);
    },

    // The bundles register no tabGroups listeners; these exist so a future one
    // does not throw.
    onCreated: stubEvent(),
    onUpdated: stubEvent(),
    onMoved: stubEvent(),
    onRemoved: stubEvent()
  };

  chrome.tabs.onRemoved.addListener(async tabId => {
    await ready;
    if (state.tabs[tabId] === undefined) return;
    delete state.tabs[tabId];
    dropEmptyGroups();
    save();
  });

  console.log('[TabGroups Shim] chrome.tabGroups is missing in this browser - emulating it.');
})();
