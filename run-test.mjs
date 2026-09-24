// Bundle a TypeScript test with esbuild and run it under node.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [entry, ...args] = process.argv.slice(2);
const out = join(mkdtempSync(join(tmpdir(), 'tv-')), 'test.cjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', outfile: out, logLevel: 'warning' });
const r = spawnSync(process.execPath, [out, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
