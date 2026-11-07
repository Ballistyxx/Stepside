// Viewer feature walkthrough in real Firefox, with screenshots:
// model tree (hide/isolate), view presets + ortho, display options, section
// plane (enabled via the options page), middle-click pivot, progressive load.
//   npm run build && node test/e2e-features-firefox.mjs [--headful]
import { Builder, By, until, Button } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const STEP = 'https://github.com/kovacsv/occt-import-js/blob/main/test/testfiles/cax-if/as1_pe_203.stp';
const BIG = process.env.BIG_URL || 'https://github.com/Ballistyxx/thermal-camera/blob/main/step/FullAssembly.step';
const outDir = process.env.SHOT_DIR || mkdtempSync(join(tmpdir(), 'stepside-features-'));
const work = mkdtempSync(join(tmpdir(), 'stepside-xpi-'));
const xpi = join(work, 'stepside.xpi');
execFileSync('zip', ['-qr', '-X', xpi, '.'], { cwd: new URL('../dist/firefox/', import.meta.url).pathname });
const opts = new firefox.Options();
if (!process.argv.includes('--headful')) opts.addArguments('-headless');
opts.addArguments('-no-remote', '-new-instance');
if (process.platform === 'darwin') opts.setBinary('/Applications/Firefox.app/Contents/MacOS/firefox');
opts.windowSize({ width: 1400, height: 1100 });
const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();

const ok = (m) => console.log(`ok - ${m}`);
let shotN = 0;
async function shot(name) {
  await driver.switchTo().defaultContent();
  const host = await driver.findElement(By.css('.stepside-host'));
  writeFileSync(join(outDir, `${String(++shotN).padStart(2, '0')}-${name}.png`), await host.takeScreenshot(), 'base64');
  await driver.switchTo().frame(await driver.findElement(By.css('.stepside-host iframe')));
}
async function intoViewer() {
  await driver.switchTo().defaultContent();
  const frame = await driver.wait(until.elementLocated(By.css('.stepside-host iframe')), 20000);
  await driver.executeScript('arguments[0].scrollIntoView({block:"center"})', frame);
  await driver.switchTo().frame(frame);
}
async function waitInfo(timeout = 120000) {
  return driver.wait(async () => {
    const el = await driver.findElements(By.id('info'));
    if (el.length && (await el[0].isDisplayed())) return el[0].getText();
    const st = await driver.findElements(By.css('#status.error'));
    if (st.length) throw new Error(`viewer error: ${await st[0].getText()}`);
    return false;
  }, timeout);
}
const click = async (css) => { await driver.findElement(By.css(css)).click(); await driver.sleep(450); };
const visible = async (css) => { const e = await driver.findElements(By.css(css)); return e.length > 0 && e[0].isDisplayed(); };

try {
  await driver.installAddon(xpi, true);

  // ---- defaults ----------------------------------------------------------
  await driver.get(STEP);
  await intoViewer();
  ok(`STEP renders: ${await waitInfo()}`);
  await driver.sleep(500);
  assert.ok(await visible('#tree'), 'model tree shown by default');
  assert.ok(await visible('#presets'), 'view presets shown by default');
  assert.ok(await visible('#display'), 'display options shown by default');
  assert.ok(!(await visible('#b-section')), 'section plane off by default');
  const nodes = await driver.findElements(By.css('#tree-list .node'));
  ok(`tree shows ${nodes.length} rows, header "${await driver.findElement(By.css('#tree-count')).getText()}"`);
  assert.ok(nodes.length > 2);
  await shot('defaults');

  // ---- tree: hide a part, isolate, show all ------------------------------
  const rows = await driver.findElements(By.css('#tree-list .node'));
  await rows[1].findElement(By.css('.eye')).click();
  await driver.sleep(300);
  assert.ok((await rows[1].getAttribute('class')).includes('off'));
  await shot('tree-hide-first-child');
  await driver.actions().doubleClick(await rows[4].findElement(By.css('.name'))).perform(); // isolate ROD
  await driver.sleep(500);
  assert.ok((await rows[2].getAttribute('class')).includes('off'), 'others hidden');
  assert.ok(!(await rows[4].getAttribute('class')).includes('off'), 'isolated part visible');
  await shot('tree-isolate-rod');
  await rows[2].findElement(By.css('.name')).click(); // zoom to part
  await driver.sleep(600);
  await shot('tree-zoom-to-part');
  await click('#tree-showall');
  ok('tree hide / isolate / zoom / show all');

  // ---- presets + ortho -----------------------------------------------------
  await click('#presets [data-view="top"]');
  await shot('preset-top');
  await click('#presets [data-view="front"]');
  await click('#b-ortho');
  assert.equal(await driver.findElement(By.css('#b-ortho')).getAttribute('aria-pressed'), 'true');
  await shot('preset-front-ortho');
  await click('#b-ortho');
  await click('#presets [data-view="iso"]');
  ok('view presets and orthographic toggle');

  // ---- display options ---------------------------------------------------
  await click('#b-wire');
  await shot('wireframe');
  await click('#b-wire');
  await click('#b-xray');
  await shot('xray');
  await click('#b-xray');
  await click('#b-edges');
  assert.equal(await driver.findElement(By.css('#b-edges')).getAttribute('aria-pressed'), 'false');
  await click('#b-edges');
  ok('edges / wireframe / x-ray toggles');

  // ---- middle-click pivot --------------------------------------------------
  const canvas = await driver.findElement(By.css('#stage canvas'));
  await driver.actions().move({ origin: canvas, x: 60, y: 40 }).press(Button.MIDDLE).release(Button.MIDDLE).perform();
  await driver.sleep(150);
  await shot('pivot-marker');
  await driver.sleep(600);
  ok('middle-click pivot (see screenshot for the marker)');

  // ---- settings: gear opens the options tab; then enable the section plane --
  // (Marionette can't drive privileged extension tabs, so the setting is
  // flipped through browser.storage from the viewer frame; the options page
  // UI itself is exercised in e2e-chrome.mjs.)
  const mainHandle = await driver.getWindowHandle();
  const before = await driver.getAllWindowHandles();
  await click('#b-settings');
  await driver.wait(async () => (await driver.getAllWindowHandles()).length > before.length, 10000);
  ok('settings gear opens the options page in a new tab');
  await driver.switchTo().window(mainHandle);
  await intoViewer();
  await driver.executeAsyncScript(`const done = arguments[0];
    browser.storage.local.get('settings').then((r) => browser.storage.local.set({ settings: { ...(r.settings || {}), sectionPlane: true } })).then(() => done());`);
  await driver.wait(async () => visible('#b-section'), 5000);
  ok('open viewer applied the setting change live');

  await driver.switchTo().defaultContent();
  await driver.get(STEP);
  await intoViewer();
  await waitInfo();
  await driver.sleep(400);
  assert.ok(await visible('#b-section'));
  await click('#b-section');
  assert.ok(await visible('#section'));
  const slider = await driver.findElement(By.id('section-pos'));
  await driver.executeScript('arguments[0].value = -0.1; arguments[0].dispatchEvent(new Event("input"))', slider);
  await driver.sleep(300);
  await shot('section-x');
  await click('#section [data-axis="y"]');
  await shot('section-y');
  ok('section plane');

  // ---- progressive display on a big assembly -----------------------------
  await driver.get(BIG);
  await intoViewer();
  const tStart = Date.now();
  const firstPreview = await driver.wait(async () => {
    const p = await driver.findElements(By.css('#status.compact'));
    if (p.length) return Date.now() - tStart;
    if ((await driver.findElements(By.css('#info'))).length && (await driver.findElement(By.id('info')).isDisplayed())) return -1;
    return false;
  }, 120000, 'no preview', 100);
  if (firstPreview > 0) {
    await driver.sleep(300);
    await shot('progressive-preview');
  }
  ok(`big file: first preview after ${(firstPreview / 1000).toFixed(1)} s`);
  ok(`big file: final ${await waitInfo(180000)} after ${((Date.now() - tStart) / 1000).toFixed(1)} s`);
  await driver.sleep(400);
  await shot('big-final');
  console.log('all feature checks passed');
} finally {
  await driver.quit();
  rmSync(work, { recursive: true, force: true });
  console.log(`screenshots: ${outDir}`);
}
