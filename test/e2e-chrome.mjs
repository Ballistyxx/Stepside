// End-to-end check in Chromium (Playwright): loads dist/chrome unpacked.
//   npm run build && node test/e2e-chrome.mjs [url ...]
// Set CHROME_PATH to a Chromium/Chrome-for-Testing binary if Playwright's
// default isn't installed (branded Chrome no longer loads unpacked extensions
// from the command line).
import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = fileURLToPath(new URL('../dist/chrome', import.meta.url));
const urls = process.argv.slice(2).filter((a) => a.startsWith('http'));
const DEFAULT = [
  'https://github.com/kovacsv/occt-import-js/blob/main/test/testfiles/cax-if/as1_pe_203.stp',
  'https://github.com/mrdoob/three.js/blob/dev/examples/models/ply/binary/Lucy100k.ply',
  'https://github.com/mrdoob/three.js/blob/dev/examples/models/obj/male02/male02.obj',
  'https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/Duck/glTF/Duck.gltf',
];
const outDir = process.env.SHOT_DIR || mkdtempSync(join(tmpdir(), 'stepside-e2e-chrome-'));

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
    const p = join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  return undefined;
}

const profile = mkdtempSync(join(tmpdir(), 'stepside-chrome-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findChromium(),
  headless: true,
  viewport: { width: 1400, height: 1100 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new', '--use-angle=metal'],
});
let failures = 0;
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  for (const [i, url] of (urls.length ? urls : DEFAULT).entries()) {
    const t = Date.now();
    let result;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const handle = await page.waitForSelector('.stepside-host iframe', { timeout: 20000 });
      const frame = await handle.contentFrame();
      result = await frame.waitForFunction(() => {
        const info = document.getElementById('info');
        const st = document.getElementById('status');
        if (info && !info.hidden) return { ok: true, text: info.textContent };
        if (st && st.classList.contains('error')) return { ok: false, text: st.textContent };
        return false;
      }, null, { timeout: 60000, polling: 100 }).then((h) => h.jsonValue());
      await page.waitForTimeout(400);
      writeFileSync(join(outDir, `chrome-${i}.png`), await page.locator('.stepside-host').screenshot());
    } catch (err) {
      result = { ok: false, text: err.message.split('\n')[0] };
    }
    if (!result.ok) failures++;
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${((Date.now() - t) / 1000).toFixed(1)}s ${url.split('/').pop()} — ${result.text.replace(/\s+/g, ' ')}`);
  }
  // Options page UI: toggles persist, cache usage shows, Clear empties it.
  {
    const src = await page.locator('.stepside-host iframe').getAttribute('src').catch(() => null);
    if (src) {
      const base = src.replace(/\/viewer\/.*$/, '');
      const opt = await ctx.newPage();
      await opt.goto(`${base}/options/options.html`);
      const sp = opt.locator('[data-key="sectionPlane"]');
      const before = await sp.isChecked();
      await sp.click();
      await opt.waitForTimeout(300);
      await opt.reload();
      const after = await opt.locator('[data-key="sectionPlane"]').isChecked();
      const usage = await opt.locator('#usage').textContent();
      await opt.screenshot({ path: join(outDir, 'chrome-options.png') });
      await opt.click('#clear');
      await opt.waitForTimeout(300);
      const cleared = await opt.locator('#usage').textContent();
      const okOpt = before === false && after === true && /^0 models/.test(cleared);
      if (!okOpt) failures++;
      console.log(`${okOpt ? 'PASS' : 'FAIL'} options page — section ${before} -> ${after} after reload; cache "${usage}" -> "${cleared}"`);
      await opt.close();
    }
  }
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(`screenshots: ${outDir}`);
process.exit(failures ? 1 : 0);
