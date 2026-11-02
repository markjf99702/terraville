// Bundle the game into a single self-contained HTML file.
//   index.html      full document, for GitHub Pages or opening locally
//   dist/page.html  body-only fragment for publishing as an Artifact
// Run it (npm run build) to write both. test/e2e.mjs imports buildPage() to check index.html is up to date.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/** The text of index.html and dist/page.html, built from src/ in memory. */
export async function buildPage() {
  const js = (await build({
    absWorkingDir: root,
    entryPoints: ['src/main.ts'],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2020',
    write: false,
    logLevel: 'warning',
  })).outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

  // The fonts go in as data: URIs, so the page stays one file that opens from disk and works as an Artifact.
  const css = (await build({
    absWorkingDir: root,
    entryPoints: ['src/style.css'],
    bundle: true,
    minify: true,
    write: false,
    loader: { '.woff2': 'dataurl' },
    logLevel: 'warning',
  })).outputFiles[0].text;

  const head = [
    '<title>Terraville</title>',
    '<meta name="description" content="Shape a landscape, then grow a city on it: a city builder in the spirit of the 1989 classic, with a terrain editor, challenges and disasters.">',
    `<style>${css}</style>`,
  ].join('\n');
  const body = `<noscript>Terraville needs JavaScript to draw the map and run the city.</noscript>\n<div id="app"></div>\n<script>${js}</script>`;

  // Only the hosted copy has the link preview, installs to a home screen and works offline; the Artifact copy is a
  // single page.
  const preview = [
    '<meta property="og:title" content="Terraville">',
    '<meta property="og:description" content="Shape a landscape, then grow a city on it.">',
    '<meta property="og:image" content="https://terraville.junkdrawer.works/og.png">',
    '<meta property="og:url" content="https://terraville.junkdrawer.works/">',
    '<meta name="twitter:card" content="summary_large_image">',
  ].join('\n');
  const install = [
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="icon" href="icon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="icon-180.png">',
  ].join('\n');
  const offline = `<script>if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});</script>`;

  return {
    index: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="theme-color" content="#0e1412">\n${head}\n${preview}\n${install}\n</head>\n<body>\n${body}\n${offline}\n</body>\n</html>\n`,
    page: `${head}\n${body}\n`,
    jsKB: js.length / 1024,
    cssKB: css.length / 1024,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { index, page, jsKB, cssKB } = await buildPage();
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist/page.html'), page);
  writeFileSync(join(root, 'index.html'), index);
  console.log(`built index.html (${jsKB.toFixed(0)} KB js, ${cssKB.toFixed(0)} KB css)`);
}
