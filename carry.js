// Brings saves over from the game's old address, junkdrawer.works/GAME/, the first time it opens at GAME.junkdrawer.works.
// A browser keeps each address's saves apart, so without this the move would start everyone from scratch.
//
// It runs before anything else on the page. On the first visit here it stops the page from loading (so the game
// can't start and save over what's coming), asks junkdrawer.works/carry.html, in a hidden frame, for this game's
// saves, writes any it doesn't already have, and loads the page again. After that it does nothing, and it never
// does anything away from https://*.junkdrawer.works (a local copy, an Artifact, the tests).
(() => {
  const HOME = 'https://junkdrawer.works', DONE = 'junkdrawer.carried', TRIES = 'junkdrawer.carry-tries';
  let local, session;
  try {
    if (location.protocol !== 'https:' || !/^[a-z0-9-]+\.junkdrawer\.works$/.test(location.hostname)) return;
    local = localStorage;
    session = sessionStorage;
    if (local.getItem(DONE) || session.getItem(DONE)) return;
  } catch { return; } // storage is blocked, so there's nowhere to put saves anyway

  window.stop();
  let finished = false;
  const finish = carried => {
    if (finished) return;
    finished = true;
    try {
      if (carried) local.setItem(DONE, new Date().toISOString());
      else {
        // Didn't work (offline, say): play without them for now and try again next visit, three times at most.
        const tries = Number(local.getItem(TRIES) || 0) + 1;
        local.setItem(TRIES, String(tries));
        if (tries >= 3) local.setItem(DONE, 'gave up');
        session.setItem(DONE, 'later');
      }
    } catch { /* storage full: the reload plays on regardless */ }
    location.reload();
  };
  let timer = setTimeout(() => finish(false), 8000);

  // A store's entries, written only where this address has nothing under that key yet.
  const putAll = ({ db, version, store, keyPath, autoIncrement, entries }) => new Promise((resolve, reject) => {
    const req = indexedDB.open(db, version);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store, { keyPath, autoIncrement });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const conn = req.result, t = conn.transaction(store, 'readwrite'), s = t.objectStore(store);
      for (const [key, value] of entries) {
        const has = s.count(key);
        has.onsuccess = () => { if (!has.result) keyPath == null ? s.put(value, key) : s.put(value); };
      }
      t.oncomplete = () => { conn.close(); resolve(); };
      t.onerror = t.onabort = () => { conn.close(); reject(t.error); };
    };
  });

  const frame = document.createElement('iframe');
  addEventListener('message', async e => {
    if (finished || e.origin !== HOME || e.source !== frame.contentWindow || !e.data || !e.data.carried) return;
    clearTimeout(timer);
    try {
      const { local: items = {}, idb = [] } = e.data.carried;
      for (const [key, value] of Object.entries(items)) if (local.getItem(key) === null) local.setItem(key, value);
      for (const store of idb) await putAll(store);
      finish(true);
    } catch { finish(false); }
  });
  frame.onload = () => {
    frame.contentWindow.postMessage({ carry: true }, HOME);
    clearTimeout(timer);
    timer = setTimeout(() => finish(false), 3000); // loaded but never answered: not there yet
  };
  frame.hidden = true;
  frame.src = HOME + '/carry.html';
  document.documentElement.appendChild(frame);
})();
