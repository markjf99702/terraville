// Keeping cities in the player's own Google Drive, so they follow them from
// device to device. The drive.file scope lets Terraville see only the files it
// made itself: a Terraville folder holding one city code per city per device
// ("Riverton (iPhone).txt"). Each device writes only its own files, so two
// devices never overwrite each other; opening a city takes its newest copy.

/**
 * The OAuth client shared with the other junkdrawer.works projects. A client ID
 * is not a secret: Google accepts it only from the origins listed below.
 */
export const GOOGLE_CLIENT_ID = '897653851078-p5jrh2bto6h3bj0lc4jist3k1vsc1pj4.apps.googleusercontent.com';
export const DRIVE_ORIGINS = ['https://junkdrawer.works'];
export const DRIVE_HOME = 'https://junkdrawer.works/terraville/';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/files';
const UP = 'https://www.googleapis.com/upload/drive/v3/files';
const KEY = 'terraville.drive';

/** One device's copy of one city, as listed in Drive. */
export interface DriveCopy {
  fileId: string;
  city: string;
  name: string;
  pop: number;
  /** Game month. */
  date: number;
  /** When it was saved, in ms since 1970. */
  saved: number;
  device: string;
  label: string;
  /** Written by this device. */
  mine: boolean;
}

export interface CityMeta {
  city: string;
  name: string;
  pop: number;
  date: number;
  saved: number;
}

export type DriveStatus = 'unavailable' | 'off' | 'signin' | 'busy' | 'ok' | 'error';

interface State {
  on: boolean;
  token: string;
  exp: number;
  err: string;
  folder: string;
  /** City id to this device's file for it. */
  files: Record<string, string>;
  /** City id to the save time of the copy last uploaded. */
  pushed: Record<string, number>;
  last: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
}

interface TokenClient {
  requestAccessToken(o?: { prompt?: string }): void;
}

export interface GisOAuth2 {
  initTokenClient(c: {
    client_id: string;
    scope: string;
    callback: (r: TokenResponse) => void;
    error_callback?: (e: { type?: string }) => void;
  }): TokenClient;
  hasGrantedAllScopes?(r: TokenResponse, ...scopes: string[]): boolean;
  revoke?(token: string, done?: () => void): void;
}

export interface DriveDeps {
  fetch: typeof fetch;
  storage: Storage | null;
  now: () => number;
  device: { id: string; label: string };
  origin: string;
  /** Loads Google's sign-in library. Tests pass a fake. */
  loadGis?: () => Promise<GisOAuth2>;
}

class DriveError extends Error {
  constructor(readonly kind: 'auth' | 'gone' | 'other', message: string = kind) {
    super(message);
  }
}

function fresh(): State {
  return { on: false, token: '', exp: 0, err: '', folder: '', files: {}, pushed: {}, last: 0 };
}

function loadGoogle(): Promise<GisOAuth2> {
  const g = () => (window as unknown as { google?: { accounts?: { oauth2?: GisOAuth2 } } }).google?.accounts?.oauth2;
  if (g()) return Promise.resolve(g()!);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (g() ? resolve(g()!) : reject(new Error('no oauth2')));
    s.onerror = () => reject(new Error('load'));
    document.head.appendChild(s);
  });
}

export class Drive {
  private st: State = fresh();
  private gis: GisOAuth2 | null = null;
  private client: TokenClient | null = null;
  private loading = false;
  private queue = new Map<string, { code: string; meta: CityMeta }>();
  private busy = false;
  private listeners: (() => void)[] = [];
  /** Called when Google hands over a token, to upload whatever waited. */
  onSignedIn: (() => void) | null = null;

  constructor(private deps: DriveDeps) {
    try {
      Object.assign(this.st, JSON.parse(deps.storage?.getItem(KEY) ?? '{}'));
    } catch {
      /* start fresh */
    }
  }

  /** Sync works only where Google accepts the client ID. */
  available(): boolean {
    return !!GOOGLE_CLIENT_ID && DRIVE_ORIGINS.includes(this.deps.origin);
  }

  get connected(): boolean {
    return this.available() && this.st.on;
  }

  get error(): string {
    return this.st.err;
  }

  get lastUpload(): number {
    return this.st.last;
  }

  hasToken(): boolean {
    return !!this.st.token && this.deps.now() < this.st.exp;
  }

  status(): DriveStatus {
    if (!this.available()) return 'unavailable';
    if (!this.st.on) return 'off';
    if (!this.hasToken()) return 'signin';
    if (this.busy) return 'busy';
    if (this.st.err) return 'error';
    return 'ok';
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private save(): void {
    try {
      this.deps.storage?.setItem(KEY, JSON.stringify(this.st));
    } catch {
      /* storage full or blocked */
    }
  }

  /** Load Google's sign-in library ahead of a tap, so connect() can open its pop-up at once. */
  prepare(): void {
    if (!this.available() || this.client || this.loading) return;
    this.loading = true;
    (this.deps.loadGis ?? loadGoogle)().then(
      (g) => {
        this.loading = false;
        this.gis = g;
        this.client = g.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPE,
          callback: (r) => this.onToken(r),
          error_callback: (e) => {
            if (e?.type !== 'popup_closed') {
              this.st.err = 'Google sign-in did not open. If the browser blocks pop-ups, allow them for this page.';
              this.save();
            }
            this.emit();
          },
        });
        this.emit();
      },
      () => {
        this.loading = false;
        this.st.err = 'Could not load Google sign-in. Check the connection.';
        this.emit();
      },
    );
  }

  /**
   * Ask Google for access. Call it straight from a click: Google's sign-in is
   * a pop-up. Returns false while the sign-in library is still loading.
   */
  connect(): boolean {
    if (!this.client) {
      this.prepare();
      return false;
    }
    this.st.err = '';
    this.client.requestAccessToken({ prompt: this.st.on ? '' : 'consent' });
    return true;
  }

  private onToken(r: TokenResponse): void {
    if (!r || r.error || !r.access_token) {
      this.st.err = `Google did not allow access${r?.error ? ` (${r.error})` : ''}.`;
    } else if (this.gis?.hasGrantedAllScopes && !this.gis.hasGrantedAllScopes(r, SCOPE)) {
      this.st.err = 'Terraville needs permission to keep its own files in your Drive. Try again and leave that box ticked.';
    } else {
      this.st.token = r.access_token;
      this.st.exp = this.deps.now() + (Math.max(Number(r.expires_in) || 3600, 120) - 60) * 1000;
      this.st.on = true;
      this.st.err = '';
      this.save();
      this.emit();
      this.onSignedIn?.();
      void this.flush();
      return;
    }
    this.save();
    this.emit();
  }

  /** Stop syncing on this device. The files in Drive stay. */
  disconnect(): void {
    try {
      if (this.st.token) this.gis?.revoke?.(this.st.token, () => {});
    } catch {
      /* ignore */
    }
    this.st = fresh();
    this.queue.clear();
    this.save();
    this.emit();
  }

  // ---- uploads ------------------------------------------------------------

  /** Queue the newest save of a city. Only the latest per city is sent. */
  push(code: string, meta: CityMeta): void {
    if (!this.connected) return;
    this.queue.set(meta.city, { code, meta });
    void this.flush();
  }

  /** Whether this device has a save of the city newer than its copy in Drive. */
  needsPush(city: string, saved: number): boolean {
    return this.connected && (this.st.pushed[city] ?? 0) < saved;
  }

  get pending(): number {
    return this.queue.size;
  }

  async flush(): Promise<void> {
    if (this.busy || !this.hasToken() || !this.queue.size) {
      this.emit();
      return;
    }
    this.busy = true;
    this.emit();
    try {
      while (this.queue.size && this.hasToken()) {
        const [city, job] = this.queue.entries().next().value as [string, { code: string; meta: CityMeta }];
        this.queue.delete(city);
        try {
          await this.upload(job.code, job.meta);
          this.st.err = '';
        } catch (e) {
          // Keep it for the next save or sign-in, unless a newer save queued meanwhile.
          if (!this.queue.has(city)) this.queue.set(city, job);
          if ((e as DriveError).kind !== 'auth') this.st.err = (e as Error).message || 'Upload failed.';
          break;
        }
      }
    } finally {
      this.busy = false;
      this.save();
      this.emit();
    }
  }

  private async upload(code: string, meta: CityMeta): Promise<void> {
    const dev = this.deps.device;
    const head = {
      name: `${meta.name} (${dev.label}).txt`,
      appProperties: {
        terraville: 'city', city: meta.city, device: dev.id, label: dev.label,
        name: meta.name.slice(0, 60), pop: String(meta.pop), date: String(meta.date), saved: String(meta.saved),
      },
    };
    let id = this.st.files[meta.city] ?? '';
    if (!id) {
      const mine = await this.find(`appProperties has { key='city' and value='${meta.city}' } and appProperties has { key='device' and value='${dev.id}' } and trashed = false`, 'id');
      id = (mine[0]?.id as string | undefined) ?? '';
    }
    if (id) {
      try {
        const m = multipart(head, code);
        await this.api('PATCH', `${UP}/${id}?uploadType=multipart&fields=id`, m.body, m.type);
      } catch (e) {
        if ((e as DriveError).kind !== 'gone') throw e;
        id = '';
      }
    }
    if (!id) {
      const make = async () => {
        const m = multipart({ ...head, mimeType: 'text/plain', parents: [await this.folder()] }, code);
        return (await (await this.api('POST', `${UP}?uploadType=multipart&fields=id`, m.body, m.type)).json()).id as string;
      };
      try {
        id = await make();
      } catch (e) {
        // The folder was deleted: make a new one.
        if ((e as DriveError).kind !== 'gone' || !this.st.folder) throw e;
        this.st.folder = '';
        id = await make();
      }
    }
    this.st.files[meta.city] = id;
    this.st.pushed[meta.city] = meta.saved;
    this.st.last = this.deps.now();
  }

  private async folder(): Promise<string> {
    if (this.st.folder) return this.st.folder;
    const found = await this.find("appProperties has { key='terraville' and value='folder' } and trashed = false", 'id');
    let id = found[0]?.id as string | undefined;
    if (!id) {
      const r = await this.api('POST', `${API}?fields=id`, JSON.stringify({
        name: 'Terraville', mimeType: 'application/vnd.google-apps.folder', appProperties: { terraville: 'folder' },
      }), 'application/json');
      id = (await r.json()).id as string;
    }
    this.st.folder = id;
    return id;
  }

  // ---- reading -------------------------------------------------------------

  /** Every copy of every city in Drive, newest first. */
  async list(): Promise<DriveCopy[]> {
    const files = await this.find("appProperties has { key='terraville' and value='city' } and trashed = false", 'id,modifiedTime,appProperties');
    const dev = this.deps.device.id;
    return files
      .map((f) => {
        const p = (f.appProperties ?? {}) as Record<string, string>;
        return {
          fileId: f.id as string,
          city: p.city ?? '',
          name: p.name || 'Untitled',
          pop: Number(p.pop) || 0,
          date: Number(p.date) || 0,
          saved: Number(p.saved) || Date.parse(f.modifiedTime as string) || 0,
          device: p.device ?? '',
          label: p.label || 'another device',
          mine: p.device === dev,
        };
      })
      // Ids go into Drive queries, so only the plain ones Terraville makes.
      .filter((c) => /^[a-z0-9]{1,24}$/.test(c.city))
      .sort((a, b) => b.saved - a.saved);
  }

  /** The city code in one file. */
  async download(fileId: string): Promise<string> {
    return (await this.api('GET', `${API}/${fileId}?alt=media`)).text();
  }

  /** Move every copy of a city to the Drive trash. */
  async remove(city: string): Promise<void> {
    const files = await this.find(`appProperties has { key='city' and value='${city}' } and trashed = false`, 'id');
    for (const f of files) await this.api('PATCH', `${API}/${f.id}`, JSON.stringify({ trashed: true }), 'application/json');
    delete this.st.files[city];
    delete this.st.pushed[city];
    this.queue.delete(city);
    this.save();
  }

  // ---- REST ----------------------------------------------------------------

  private async api(method: string, url: string, body?: string, type?: string): Promise<Response> {
    if (!this.hasToken()) throw new DriveError('auth');
    const headers: Record<string, string> = { Authorization: `Bearer ${this.st.token}` };
    if (type) headers['Content-Type'] = type;
    const r = await this.deps.fetch(url, { method, headers, body });
    if (r.status === 401) {
      this.st.token = '';
      this.st.exp = 0;
      this.save();
      throw new DriveError('auth');
    }
    if (r.status === 404) throw new DriveError('gone');
    if (!r.ok) {
      const t = await r.text();
      const m = /"message":\s*"([^"]+)"/.exec(t);
      throw new DriveError('other', `Google Drive said: ${m ? m[1] : r.status}`);
    }
    return r;
  }

  private async find(q: string, fields: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let page = '';
    do {
      const url = `${API}?spaces=drive&pageSize=1000&fields=nextPageToken,files(${fields})&q=${encodeURIComponent(q)}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`;
      const j = await (await this.api('GET', url)).json();
      out.push(...((j.files ?? []) as Record<string, unknown>[]));
      page = j.nextPageToken ?? '';
    } while (page);
    return out;
  }
}

function multipart(meta: object, body: string): { body: string; type: string } {
  const b = `terraville${Math.random().toString(36).slice(2)}`;
  return {
    body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n--${b}--`,
    type: `multipart/related; boundary=${b}`,
  };
}

/** A name for this device, shown next to its copies in Drive. */
export function deviceLabel(ua: string, touch: number): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Browser';
}
