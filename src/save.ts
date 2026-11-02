// Saving cities in the browser, plus portable text codes for sharing.
import { deviceLabel } from './drive';
import type { Drive } from './drive';
import { SavedWorld, World } from './world';

export interface SaveFile {
  v: 1;
  world: SavedWorld;
  cam?: { x: number; y: number; zoom: number };
  mode: 'city' | 'editor';
  terrain?: unknown;
}

export interface SlotMeta {
  id: string;
  name: string;
  pop: number;
  date: number;
  savedAt: number;
  mode: 'city' | 'editor';
  /** Set on a city's own save, which its autosave keeps up to date. */
  city?: string;
}

const INDEX = 'terraville.slots';
const PREFIX = 'terraville.slot.';

function store(): Storage | null {
  try {
    const s = window.localStorage;
    const k = '__tv_probe';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

export function storageAvailable(): boolean {
  return store() !== null;
}

export function listSlots(): SlotMeta[] {
  const s = store();
  if (!s) return [];
  try {
    const list = JSON.parse(s.getItem(INDEX) ?? '[]') as SlotMeta[];
    // Anything in the list that isn't a save's details is skipped, so it can't hide the rest or stop the page.
    return Array.isArray(list) ? list.filter((m) => m && typeof m === 'object').sort((a, b) => b.savedAt - a.savedAt) : [];
  } catch {
    return [];
  }
}

function writeIndex(list: SlotMeta[]): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(INDEX, JSON.stringify(list));
  } catch {
    /* storage full or blocked */
  }
}

const WINS = 'terraville.wins';

/** The challenges won in this browser, each with the earliest year it was won in. */
export function challengeWins(): Record<string, number> {
  const s = store();
  if (!s) return {};
  try {
    const kept = JSON.parse(s.getItem(WINS) ?? '{}');
    const wins: Record<string, number> = {};
    if (kept && typeof kept === 'object' && !Array.isArray(kept)) {
      for (const [id, year] of Object.entries(kept)) if (Number.isInteger(year) && (year as number) >= 1900 && (year as number) < 3000) wins[id] = year as number;
    }
    return wins;
  } catch {
    return {};
  }
}

/** Keep a challenge's win in this browser, unless it was won in an earlier year before. */
export function recordWin(id: string, year: number): void {
  const s = store();
  if (!s) return;
  const wins = challengeWins();
  if (wins[id] !== undefined && wins[id] <= year) return;
  wins[id] = year;
  try {
    s.setItem(WINS, JSON.stringify(wins));
  } catch {
    /* storage full or blocked */
  }
}

const DRAFT = 'terraville.draft';

/** The land being shaped in the terrain editor, kept as one draft: its seed, when it was saved, and its city code. */
export interface Draft {
  seed: string;
  savedAt: number;
  code: string;
}

/** Keep the editor's land as the draft, in place of the one before. */
export function saveDraft(draft: Draft): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(DRAFT, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** The draft kept in this browser, or null when there is none (or what is there isn't one). */
export function readDraft(): Draft | null {
  try {
    const d = JSON.parse(store()?.getItem(DRAFT) ?? 'null');
    return d && typeof d === 'object' && typeof d.seed === 'string' && Number.isFinite(d.savedAt) && typeof d.code === 'string' ? (d as Draft) : null;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    store()?.removeItem(DRAFT);
  } catch {
    /* blocked */
  }
}

export async function saveSlot(id: string, file: SaveFile, pop: number): Promise<boolean> {
  try {
    return saveCode(await encode(file), { id, name: file.world.city.name, pop, date: file.world.city.month, savedAt: Date.now(), mode: file.mode });
  } catch {
    return false;
  }
}

/** Store an already encoded city code under a slot. */
export function saveCode(code: string, meta: SlotMeta): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(PREFIX + meta.id, code);
    const list = listSlots().filter((m) => m.id !== meta.id);
    list.push(meta);
    writeIndex(list);
    return true;
  } catch {
    return false;
  }
}

export function readCode(id: string): string | null {
  try {
    return store()?.getItem(PREFIX + id) ?? null;
  } catch {
    return null;
  }
}

/** The storage key a slot's code is kept under, as a 'storage' event from another tab names it. */
export function slotKey(id: string): string {
  return PREFIX + id;
}

/** The slot a city's autosave keeps up to date. */
export function citySlot(city: string): string {
  return `c-${city}`;
}

export function newCityId(): string {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return a[0].toString(36) + a[1].toString(36);
}

/** Send Drive every city saved here since its last trip there: `slots` and `read` are this device's saves. */
export function pushSaved(drive: Drive, slots: SlotMeta[], read: (id: string) => string | null): void {
  for (const s of slots) {
    if (!s.city || !drive.needsPush(s.city, s.savedAt)) continue;
    const code = read(s.id);
    if (code) drive.push(code, { city: s.city, name: s.name, pop: s.pop, date: s.date, saved: s.savedAt });
  }
}

/** A lasting id for this browser, and a name for it, to tell its Drive copies apart. */
export function thisDevice(): { id: string; label: string } {
  const label = deviceLabel(navigator.userAgent, navigator.maxTouchPoints || 0);
  const s = store();
  let id = s?.getItem('terraville.device') ?? '';
  if (!/^[a-z0-9]{6,20}$/.test(id)) {
    id = newCityId();
    try {
      s?.setItem('terraville.device', id);
    } catch {
      /* a new id each visit, then */
    }
  }
  return { id, label };
}

export async function loadSlot(id: string): Promise<SaveFile | null> {
  const s = store();
  if (!s) return null;
  try {
    const code = s.getItem(PREFIX + id);
    return code ? await decode(code) : null;
  } catch {
    return null;
  }
}

export function deleteSlot(id: string): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(PREFIX + id);
  } catch {
    /* ignore */
  }
  writeIndex(listSlots().filter((m) => m.id !== id));
}

// ---- codes ------------------------------------------------------------------

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart]);
  const out = blob.stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Compact text form: TV1g: gzip+base64, or TV1j: base64 JSON when gzip is unavailable. */
export async function encode(file: SaveFile): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(file));
  if (typeof CompressionStream !== 'undefined') {
    try {
      return 'TV1g:' + toB64(await pipe(json, new CompressionStream('gzip')));
    } catch {
      /* fall through */
    }
  }
  return 'TV1j:' + toB64(json);
}

/** The plain TV1j: form, made at once. Gzip only comes asynchronously, and a page that is closing never finishes it. */
export function encodeNow(file: SaveFile): string {
  return 'TV1j:' + toB64(new TextEncoder().encode(JSON.stringify(file)));
}

/** What a code that won't open says, whichever way it was broken: messaging apps cut long text. */
export const DAMAGED_CODE = 'That city code is cut short or damaged. Codes are long: copy all of it, or share it as a text file.';

/**
 * Read a city code out of whatever was pasted: quotes, words around it and line breaks inside it don't matter.
 * Throws with a readable message.
 */
export async function decode(text: string): Promise<SaveFile> {
  const m = /TV1([gj]):([A-Za-z0-9+/=\s]+)/.exec(text);
  if (!m) throw new Error('That does not look like a Terraville city code. Codes start with TV1.');
  const gzip = m[1] === 'g';
  if (gzip && typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed city codes.');
  // Words after the code look like more of it, so if it won't open, try again without them, a word at a time.
  const words = m[2].trim().split(/\s+/);
  for (let n = words.length; n > 0 && n >= words.length - 8; n--) {
    try {
      const raw = fromB64(words.slice(0, n).join(''));
      const file = JSON.parse(new TextDecoder().decode(gzip ? await pipe(raw, new DecompressionStream('gzip')) : raw)) as SaveFile;
      if (file && file.v === 1 && file.world) return file;
    } catch {
      /* cut short, damaged, or with words after it */
    }
  }
  throw new Error(DAMAGED_CODE);
}

export function worldFrom(file: SaveFile): World {
  return World.deserialize(file.world);
}
