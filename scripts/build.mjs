// Builds dist/firefox and dist/chrome from one source tree.
//   node scripts/build.mjs            production build (minified)
//   node scripts/build.mjs --watch    rebuild on change (unminified, sourcemaps)
//   node scripts/build.mjs --package  build + zip into dist/*.zip
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const packageZip = process.argv.includes('--package');
const targets = ['firefox', 'chrome'];

function manifest(target) {
  const m = {
    manifest_version: 3,
    name: 'Stepside',
    version: pkg.version,
    description: pkg.description,
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 96: 'icons/icon-96.png', 128: 'icons/icon-128.png' },
    content_scripts: [{
      matches: ['https://github.com/*'],
      js: ['content.js'],
      run_at: 'document_idle',
    }],
    web_accessible_resources: [{
      resources: ['viewer/viewer.html'],
      matches: ['https://github.com/*'],
    }],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  };
  if (target === 'firefox') {
    m.browser_specific_settings = {
      gecko: {
        id: 'stepside@stepside.dev',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    };
  } else {
    m.minimum_chrome_version = '120';
  }
  return m;
}

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'linked' : false,
  legalComments: 'none',
  logLevel: 'info',
  target: ['firefox128', 'chrome116'],
};

function copyStatic(out) {
  mkdirSync(join(out, 'viewer'), { recursive: true });
  mkdirSync(join(out, 'worker/vendor'), { recursive: true });
  cpSync(join(root, 'src/viewer/viewer.html'), join(out, 'viewer/viewer.html'));
  cpSync(join(root, 'src/viewer/viewer.css'), join(out, 'viewer/viewer.css'));
  // Prebuilt by native/build.sh (OpenCascade 8 -> WASM); committed in vendor/.
  for (const f of ['stepside-occt.js', 'stepside-occt.wasm', 'LICENSE-OCCT-LGPL-2.1.txt', 'LICENSE-OCCT-EXCEPTION.txt']) {
    cpSync(join(root, 'vendor', f), join(out, 'worker/vendor', f));
  }
  if (!existsSync(join(root, 'icons/icon-128.png'))) execFileSync('node', [join(root, 'scripts/icons.mjs')], { stdio: 'inherit' });
  cpSync(join(root, 'icons'), join(out, 'icons'), { recursive: true, filter: (p) => !p.endsWith('.svg') });
  cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
}

async function buildTarget(target) {
  const out = join(root, 'dist', target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyStatic(out);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2));
  const define = { 'process.env.NODE_ENV': '"production"' };
  const builds = [
    { ...common, define, entryPoints: [join(root, 'src/content/content.js')], outfile: join(out, 'content.js'), format: 'iife' },
    {
      ...common, define, entryPoints: [join(root, 'src/viewer/viewer.js')], outdir: join(out, 'viewer'),
      format: 'esm', splitting: true, chunkNames: 'chunks/[name]-[hash]',
    },
    { ...common, define, entryPoints: [join(root, 'src/worker/worker.js')], outfile: join(out, 'worker/worker.js'), format: 'iife' },
  ];
  if (watch) {
    for (const b of builds) await (await esbuild.context(b)).watch();
  } else {
    await Promise.all(builds.map((b) => esbuild.build(b)));
  }
  if (packageZip) {
    const zip = join(root, 'dist', `stepside-${target}-${pkg.version}.zip`);
    rmSync(zip, { force: true });
    execFileSync('zip', ['-qr', '-X', zip, '.'], { cwd: out });
    console.log(`packaged ${zip}`);
  }
}

for (const t of targets) await buildTarget(t);
