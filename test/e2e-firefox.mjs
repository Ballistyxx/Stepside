// End-to-end check in real Firefox: installs dist/firefox as a temporary
// add-on, opens GitHub blob pages and waits for each model to render.
//   npm run build && node test/e2e-firefox.mjs [--headful] [url ...]
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const headful = args.includes('--headful');
const urls = args.filter((a) => a.startsWith('http'));
const DEFAULT = [
  'https://github.com/kovacsv/occt-import-js/blob/main/test/testfiles/cax-if/as1_pe_203.stp',
  'https://github.com/kovacsv/occt-import-js/blob/main/test/testfiles/cube-10x10mm/Cube%2010x10.igs',
  'https://github.com/mrdoob/three.js/blob/dev/examples/models/obj/male02/male02.obj',
  'https://github.com/mrdoob/three.js/blob/dev/examples/models/ply/binary/Lucy100k.ply',
  'https://github.com/mrdoob/three.js/blob/dev/examples/models/ply/ascii/dolphins.ply',
  'https://github.com/mrdoob/three.js/blob/dev/examples/models/vrml/house.wrl',
  'https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/Duck/glTF/Duck.gltf',
  'https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/Duck/glTF-Binary/Duck.glb',
];
const outDir = process.env.SHOT_DIR || mkdtempSync(join(tmpdir(), 'stepside-e2e-'));

const work = mkdtempSync(join(tmpdir(), 'stepside-xpi-'));
const xpi = join(work, 'stepside.xpi');
execFileSync('zip', ['-qr', '-X', xpi, '.'], { cwd: new URL('../dist/firefox/', import.meta.url).pathname });

const opts = new firefox.Options();
if (!headful) opts.addArguments('-headless');
opts.addArguments('-no-remote', '-new-instance'); // don't hand off to an already-running Firefox
if (process.platform === 'darwin') opts.setBinary('/Applications/Firefox.app/Contents/MacOS/firefox');
opts.windowSize({ width: 1400, height: 1100 });
opts.setPreference('webgl.force-enabled', true);
const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
let failures = 0;
try {
  await driver.installAddon(xpi, true);
  for (const [i, url] of (urls.length ? urls : DEFAULT).entries()) {
    const t = Date.now();
    await driver.get(url);
    let result;
    try {
      const frame = await driver.wait(until.elementLocated(By.css('.stepside-host iframe')), 20000);
      await driver.switchTo().frame(frame);
      result = await driver.wait(async () => {
        if (!(await driver.findElements(By.id('info'))).length) return false; // frame still loading
        const info = await driver.findElement(By.id('info'));
        if (await info.isDisplayed()) return { ok: true, text: await info.getText() };
        const st = await driver.findElement(By.id('status'));
        const cls = await st.getAttribute('class');
        if (cls && cls.includes('error')) return { ok: false, text: await st.getText() };
        return false;
      }, 60000);
      await driver.sleep(400);
      await driver.switchTo().defaultContent();
      const host = await driver.findElement(By.css('.stepside-host'));
      await driver.executeScript('arguments[0].scrollIntoView({block:"center"})', host);
      await driver.sleep(200);
      writeFileSync(join(outDir, `${i}.png`), await host.takeScreenshot(), 'base64');
    } catch (err) {
      let status = '';
      try { status = await driver.findElement(By.id('status')).getText(); } catch { /* not in frame */ }
      result = { ok: false, text: `timeout/exception: ${err.message.split('\n')[0]} [status: ${status}]` };
      try { await driver.switchTo().defaultContent(); } catch { /* ignore */ }
    }
    if (!result.ok) failures++;
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${((Date.now() - t) / 1000).toFixed(1)}s ${url.split('/').pop()} — ${result.text.replace(/\s+/g, ' ')}`);
  }
} finally {
  await driver.quit();
  rmSync(work, { recursive: true, force: true });
}
console.log(`screenshots: ${outDir}`);
process.exit(failures ? 1 : 0);
