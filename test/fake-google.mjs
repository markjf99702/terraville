// A stand-in for Google sign-in and the Drive API, for testing Drive saving in Playwright without Google.
// From the junkdrawer house kit, with two additions: a search with several appProperties conditions meets them all
// (Terraville asks for its own device's copy of a city), and a multipart PATCH (which Terraville uses to replace a file
// and its details at once) updates the file's details and content as a multipart POST makes them.
// Every browser context given the same fake shares one Drive, so two contexts are two devices.
//
//   import { fakeGoogle } from './fake-google.mjs';
//   const g = fakeGoogle();
//   await g.install(ctx, { rewrite: { '**/sync.js': s => s.replace("['https://junkdrawer.works']", "['https://junkdrawer.works', 'http://localhost:8080']") } });
//   … g.files() lists what's in the fake Drive; g.calls records every request.
//
// Sign-in: the fake google.accounts.oauth2 answers every requestAccessToken() with the token 'tok-' + the
// localStorage '__who' value (default 'mark'), so different accounts are different Drives. A token of
// 'tok-expired' gets 401s. window.__prompts records each request's options and window.__cfg the client config.
const GIS = `window.google={accounts:{oauth2:{
  initTokenClient:function(cfg){window.__cfg=cfg;return{requestAccessToken:function(o){window.__prompts=(window.__prompts||[]).concat([o||{}]);setTimeout(function(){cfg.callback({access_token:'tok-'+(localStorage.getItem('__who')||'mark'),expires_in:3599,scope:cfg.scope,token_type:'Bearer'});},20);}};},
  hasGrantedAllScopes:function(r,s){return (r.scope||'').indexOf(s)>=0;},
  revoke:function(t,cb){window.__revoked=(window.__revoked||0)+1;cb&&cb();}}}};`;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };

export function fakeGoogle() {
  const drive = { files: {}, next: 1 }, calls = [];
  async function handle(route) {
    const req = route.request(), url = new URL(req.url()), m = req.method(), p = url.pathname;
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    calls.push(m + ' ' + p + url.search);
    const json = (o, status = 200) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
    const auth = (req.headers()['authorization'] || '').replace('Bearer ', '');
    if (!auth.startsWith('tok-') || auth === 'tok-expired') return json({ error: { code: 401 } }, 401);
    const owner = auth.slice(4), mine = id => drive.files[id] && drive.files[id].owner === owner ? drive.files[id] : null;
    let mm;
    if (m === 'GET' && p === '/drive/v3/files') {
      const q = url.searchParams.get('q') || '', aps = [...q.matchAll(/appProperties has \{ key='([^']+)' and value='([^']+)' \}/g)], name = /name\s*=\s*'([^']+)'/.exec(q);
      const hit = Object.entries(drive.files).filter(([, f]) => f.owner === owner && !f.trashed && aps.every(ap => (f.appProperties || {})[ap[1]] === ap[2]) && (!name || f.name === name[1]));
      return json({ files: hit.map(([id, f]) => ({ id, name: f.name, version: String(f.version), modifiedTime: new Date(f.modified).toISOString(), appProperties: f.appProperties })) });
    }
    if (m === 'GET' && p === '/drive/v3/about') return json({ user: { displayName: owner, emailAddress: owner + '@gmail.com' } });
    if (m === 'POST' && p === '/drive/v3/files') { // metadata only, e.g. a folder
      const id = 'f' + drive.next++; drive.files[id] = { owner, ...JSON.parse(req.postData() || '{}'), version: 1, modified: Date.now(), body: null };
      return json({ id, version: '1' });
    }
    if (m === 'POST' && p === '/upload/drive/v3/files') { // uploadType=multipart
      const raw = req.postData() || '', boundary = /boundary=([^;]+)/.exec(req.headers()['content-type'] || '')[1];
      const parts = raw.split('--' + boundary).map(x => x.replace(/^\r\n/, '')).filter(x => x && !x.startsWith('--'));
      const bodyOf = x => x.slice(x.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
      const meta = JSON.parse(bodyOf(parts[0])), parent = meta.parents && meta.parents[0];
      if (parent && !mine(parent)) return json({ error: 'parent not found' }, 404);
      const id = 'f' + drive.next++; drive.files[id] = { owner, ...meta, version: 1, modified: Date.now(), body: bodyOf(parts[1]) };
      return json({ id, version: '1' });
    }
    if ((mm = /^\/drive\/v3\/files\/([\w-]+)$/.exec(p))) {
      const f = mine(mm[1]); if (!f) return json({ error: 'not found' }, 404);
      if (m === 'GET') return url.searchParams.get('alt') === 'media' ? route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: f.body || '' }) : json({ id: mm[1], name: f.name, version: String(f.version), appProperties: f.appProperties });
      if (m === 'PATCH') { Object.assign(f, JSON.parse(req.postData() || '{}')); f.version++; return json({ id: mm[1], version: String(f.version) }); }
      if (m === 'DELETE') { delete drive.files[mm[1]]; return route.fulfill({ status: 204, headers: CORS }); }
    }
    if (m === 'PATCH' && (mm = /^\/upload\/drive\/v3\/files\/([\w-]+)$/.exec(p))) { // uploadType=media, or multipart (Terraville)
      const f = mine(mm[1]); if (!f) return json({ error: 'not found' }, 404);
      if (url.searchParams.get('uploadType') === 'multipart') {
        const raw = req.postData() || '', boundary = /boundary=([^;]+)/.exec(req.headers()['content-type'] || '')[1];
        const parts = raw.split('--' + boundary).map(x => x.replace(/^\r\n/, '')).filter(x => x && !x.startsWith('--'));
        const bodyOf = x => x.slice(x.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
        const meta = JSON.parse(bodyOf(parts[0]));
        if (meta.name) f.name = meta.name;
        if (meta.appProperties) f.appProperties = { ...f.appProperties, ...meta.appProperties };
        f.body = bodyOf(parts[1]);
      } else f.body = req.postData();
      f.version++; f.modified = Date.now(); return json({ id: mm[1], version: String(f.version) });
    }
    return json({ error: 'the fake Drive has no ' + m + ' ' + p }, 400);
  }
  return {
    drive, calls,
    files: () => Object.entries(drive.files).map(([id, f]) => ({ id, ...f })),
    async install(ctx, { rewrite = {} } = {}) {
      for (const [glob, fn] of Object.entries(rewrite)) {
        await ctx.route(glob, async route => { const r = await route.fetch(); route.fulfill({ response: r, body: fn(await r.text()) }); });
      }
      await ctx.route('https://accounts.google.com/gsi/client', r => r.fulfill({ contentType: 'application/javascript', body: GIS }));
      await ctx.route('https://www.googleapis.com/**', handle);
    }
  };
}
