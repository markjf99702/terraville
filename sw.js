// Offline support: keep a copy of the app so it works with no signal.
// Cities live in localStorage (and Drive, if it's on), not here. The fonts are inside index.html, so they work
// offline too.
// Network first, so a new version shows up as soon as you're online, but a page the network hasn't answered in a few
// seconds opens from the copy instead (see page()).

// An installed copy downloads the whole list again only when this file changes by a byte. Otherwise each file in it is
// refreshed only when a page that loads it is visited online, and the copy could mix two releases. So FILES is a
// fingerprint of every file in SHELL: change any of them and test/e2e.mjs fails until FILES is changed to match (it
// says what to), which changes this file, so every copy is made whole again at once.
const CACHE = 'terraville-v1'; // bump the number when the file list changes
const FILES = '1bbbcab5'; // test/e2e.mjs checks this
const SHELL = [
  './', 'index.html', 'carry.js', 'privacy.html', 'icon.svg', 'icon-180.png', 'icon-192.png', 'manifest.webmanifest',
];

// Each file straight from the server (a quick "not modified" for one that hasn't changed), not from the browser's own
// copies, which can be ten minutes old (see fresh() below): a copy made from those could mix in the last release.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// How long a page waits for the network before it opens from the copy instead.
const PATIENCE = 4000; // ms
// The pages (by their client ids) that opened from the copy: the rest of their files come from it too, so a page
// never mixes the copy's files with newer ones. (The browser stops the worker once it has been idle a while, and the
// list goes with it.)
const fromCopy = new Set();

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') e.respondWith(page(e));
  else if (fromCopy.has(e.clientId)) e.respondWith(kept(e.request).then(r => r || network(e)));
  else e.respondWith(network(e).catch(() => offline(e.request)));
});

// A page, from the network. On a connection that's up but not answering (a train, a captive wifi, one bar of signal),
// it opens from the copy after PATIENCE instead, if the copy has it. With no copy of the page, it waits on for the
// network. With no network at all, it opens from the copy straight away, as it always has.
function page(e) {
  let answered = false, copied = false;
  // The network's answer goes into the copy, unless the copy answered first: that page's files came from the copy,
  // and a newer page kept beside them would be the mix this is avoiding, next time it opens from the copy.
  const net = network(e, () => !copied);
  // Safari before 16 doesn't say which page a load becomes (no resultingClientId), so the page's files couldn't come
  // from the copy too, and would wait on the network anyway. There a page waits for the network, as it always has.
  if (!e.resultingClientId) return net.catch(() => offline(e.request));
  return new Promise((resolve, reject) => {
    const answer = res => { if (!answered) { answered = true; resolve(res); } };
    const slow = setTimeout(() => kept(e.request).then(copy => {
      if (!copy || answered) return;
      copied = true;
      fromCopy.add(e.resultingClientId);
      if (fromCopy.size > 50) fromCopy.delete(fromCopy.values().next().value); // the oldest, long gone
      answer(copy);
    }), PATIENCE);
    net.then(res => { clearTimeout(slow); answer(res); },
      () => { clearTimeout(slow); offline(e.request).then(answer, reject); });
  });
}

// A file from the network, kept in the copy for next time (unless keep() says not). The worker stays up until it's in.
function network(e, keep = () => true) {
  let stored;
  const got = fresh(e.request).then(res => {
    if (res.ok && keep()) { const copy = res.clone(); stored = caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  });
  try { e.waitUntil(got.then(() => stored, () => {})); } catch { /* the event is over: the copy goes in anyway */ }
  return got;
}

// A file from the copy, marked like the network's (see askAgainNextTime() below), so a reload once the network is
// back asks again rather than reusing it.
const kept = request => caches.match(request, { ignoreSearch: true }).then(r => r && askAgainNextTime(r));
// With no network: the file from the copy, or for anything it hasn't got, the app's page.
const offline = request => kept(request).then(r => r || caches.match('index.html'));

// GitHub Pages lets browsers keep files for ten minutes, so without this an update can take that long to show up.
// Ask the server every time instead; a file that hasn't changed comes back as a quick "not modified".
function fresh(request) {
  const got = request.mode === 'navigate'
    // A page load can't be answered with a redirected response, so fall back to the plain request if there was one.
    ? fetch(request.url, { cache: 'no-cache' }).then(res => (res.redirected ? fetch(request) : res))
    : fetch(request, { cache: 'no-cache' });
  return got.then(askAgainNextTime);
}

// The open tab keeps its own copy of each file too, and would reuse it on a reload without asking.
// Marking the copy it gets from here no-cache sends that reload back through fresh() as well.
function askAgainNextTime(res) {
  if (res.status !== 200 || res.type !== 'basic' || res.redirected) return res;
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-cache');
  headers.delete('content-encoding'); // the body here is already unpacked
  headers.delete('content-length');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
