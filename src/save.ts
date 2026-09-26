// Saving cities in the browser, plus portable text codes for sharing.
import { deviceLabel } from './drive';
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
    return Array.isArray(list) ? list.sort((a, b) => b.savedAt - a.savedAt) : [];
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

/** The slot a city's autosave keeps up to date. */
export function citySlot(city: string): string {
  return `c-${city}`;
}

export function newCityId(): string {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return a[0].toString(36) + a[1].toString(36);
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

export async function decode(code: string): Promise<SaveFile> {
  const c = code.trim().replace(/\s+/g, '');
  let bytes: Uint8Array;
  if (c.startsWith('TV1g:')) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed city codes.');
    bytes = await pipe(fromB64(c.slice(5)), new DecompressionStream('gzip'));
  } else if (c.startsWith('TV1j:')) {
    bytes = fromB64(c.slice(5));
  } else {
    throw new Error('That does not look like a Terraville city code. Codes start with TV1.');
  }
  const file = JSON.parse(new TextDecoder().decode(bytes)) as SaveFile;
  if (!file || file.v !== 1 || !file.world) throw new Error('The city code is incomplete.');
  return file;
}

export function worldFrom(file: SaveFile): World {
  return World.deserialize(file.world);
}
