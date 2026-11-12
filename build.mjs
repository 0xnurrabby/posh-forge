import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function fontFace(family, relativeFile) {
  const file = path.join(root, 'node_modules', relativeFile);
  const data = fs.readFileSync(file).toString('base64');
  return [
    '@font-face {',
    `  font-family: "${family}";`,
    '  font-style: normal;',
    '  font-weight: 100 900;',
    '  font-display: swap;',
    `  src: url(data:font/woff2;base64,${data}) format("woff2");`,
    '}'
  ].join('\n');
}

const workerBuild = await esbuild.build({
  entryPoints: [path.join(src, 'worker.js')],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100', 'firefox102', 'safari16'],
  legalComments: 'none'
});

const workerCode = workerBuild.outputFiles[0].text;
const workerBase64 = Buffer.from(workerCode, 'utf8').toString('base64');

const fonts = [
  fontFace('Inter', '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'),
  fontFace('JetBrains Mono', '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2')
].join('\n');

const styles = read(path.join(src, 'styles.css'));
const app = read(path.join(src, 'app.js'));
let html = read(path.join(src, 'template.html'));

function put(haystack, needle, replacement) {
  if (!haystack.includes(needle)) {
    throw new Error(`Build placeholder not found: ${needle}`);
  }
  return haystack.replace(needle, () => replacement);
}

html = put(html, '{{FONTS}}', fonts);
html = put(html, '{{STYLES}}', styles);
html = put(html, '{{WORKER_BASE64}}', workerBase64);
html = put(html, '{{APP}}', app);

if (/\{\{FONTS\}\}|\{\{STYLES\}\}|\{\{APP\}\}|\{\{WORKER_BASE64\}\}/.test(html)) {
  throw new Error('A build placeholder was left behind.');
}

fs.writeFileSync(path.join(root, 'index.html'), html, 'utf8');

const bytes = Buffer.byteLength(html, 'utf8');
console.log(`Built index.html (${(bytes / 1024).toFixed(1)} KiB)`);
console.log(`  worker bundle: ${(Buffer.byteLength(workerCode) / 1024).toFixed(1)} KiB (${(Buffer.byteLength(workerBase64) / 1024).toFixed(1)} KiB base64)`);
console.log(`  embedded fonts: ${(Buffer.byteLength(fonts) / 1024).toFixed(1)} KiB`);
