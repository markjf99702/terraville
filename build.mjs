// Bundle the game into a single self-contained HTML file.
//   index.html      full document, for GitHub Pages or opening locally
//   dist/page.html  body-only fragment for publishing as an Artifact
import { build, transform } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const js = (await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  logLevel: 'warning',
})).outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const css = (await transform(readFileSync('src/style.css', 'utf8'), { loader: 'css', minify: true })).code;

const head = [
  '<title>Terraville</title>',
  '<meta name="description" content="A city builder with a terrain editor, in the spirit of the 1989 classic.">',
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Overpass:wght@400;600;700;800&family=Overpass+Mono:wght@400;600&display=swap">',
  `<style>${css}</style>`,
].join('\n');
const body = `<div id="app"></div>\n<script>${js}</script>`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/page.html', `${head}\n${body}\n`);
writeFileSync(
  'index.html',
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="theme-color" content="#0e1412">\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`,
);
console.log(`built index.html (${(js.length / 1024).toFixed(0)} KB js, ${(css.length / 1024).toFixed(0)} KB css)`);
