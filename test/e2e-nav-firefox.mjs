// Soft-navigation + toggle behaviour in Firefox:
//  tree page (dormant) -> click .stp (mount) -> Source/3D toggle ->
//  click another model via history -> back to tree (teardown).
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const work = mkdtempSync(join(tmpdir(), 'stepside-xpi-'));
const xpi = join(work, 'stepside.xpi');
execFileSync('zip', ['-qr', '-X', xpi, '.'], { cwd: new URL('../dist/firefox/', import.meta.url).pathname });
const opts = new firefox.Options();
if (!process.argv.includes('--headful')) opts.addArguments('-headless');
opts.addArguments('-no-remote', '-new-instance');
if (process.platform === 'darwin') opts.setBinary('/Applications/Firefox.app/Contents/MacOS/firefox');
opts.windowSize({ width: 1400, height: 1100 });
const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();

const hostCount = () => driver.executeScript('return document.querySelectorAll(".stepside-host").length');
async function waitRendered() {
  const frame = await driver.wait(until.elementLocated(By.css('.stepside-host iframe')), 20000);
  await driver.switchTo().frame(frame);
  const text = await driver.wait(async () => {
    const el = await driver.findElements(By.id('info'));
    if (el.length && (await el[0].isDisplayed())) return el[0].getText();
    return false;
  }, 60000);
  await driver.switchTo().defaultContent();
  return text;
}
const step = (m) => console.log(`ok - ${m}`);

try {
  await driver.installAddon(xpi, true);
  await driver.get('https://github.com/kovacsv/occt-import-js/tree/main/test/testfiles/cax-if');
  await driver.wait(until.elementLocated(By.css('a[title="as1_pe_203.stp"], a[aria-label*="as1_pe_203.stp"]')), 20000);
  await driver.sleep(1000);
  assert.equal(await hostCount(), 0);
  step('dormant on tree page');

  const link = await driver.findElement(By.css('a[title="as1_pe_203.stp"], a[aria-label*="as1_pe_203.stp"]'));
  await driver.executeScript('arguments[0].click()', link);
  step(`soft-nav into STEP renders: ${await waitRendered()}`);
  assert.equal(await hostCount(), 1);

  // Source toggle shows GitHub's code view; 3D brings the viewer back.
  await driver.findElement(By.css('.stepside-seg button[data-mode="source"]')).click();
  await driver.sleep(300);
  const codeVisible = await driver.executeScript(`
    const s = document.querySelector('section[aria-labelledby*="file-name-id"]');
    const frame = document.querySelector('.stepside-frame');
    const code = [...s.children].find((c) => !c.classList.contains('stepside-host'));
    return !!code && getComputedStyle(code).display !== 'none' && getComputedStyle(frame).display === 'none';`);
  assert.ok(codeVisible, 'source view visible');
  step('Source shows raw text, viewer hidden');
  await driver.findElement(By.css('.stepside-seg button[data-mode="3d"]')).click();
  await driver.sleep(300);
  const viewerBack = await driver.executeScript(`
    const s = document.querySelector('section[aria-labelledby*="file-name-id"]');
    const code = [...s.children].find((c) => !c.classList.contains('stepside-host'));
    return getComputedStyle(document.querySelector('.stepside-frame')).display !== 'none' && (!code || getComputedStyle(code).display === 'none');`);
  assert.ok(viewerBack, '3D view restored');
  step('3D restores viewer');

  await driver.navigate().back();
  await driver.wait(async () => (await hostCount()) === 0, 10000);
  step('back to tree tears down viewer');

  const link2 = await driver.wait(until.elementLocated(By.css('a[title="dm1-id-214.stp"], a[aria-label*="dm1-id-214.stp"]')), 20000);
  await driver.executeScript('arguments[0].click()', link2);
  step(`soft-nav into second STEP renders: ${await waitRendered()}`);
  assert.equal(await hostCount(), 1);
  console.log('all navigation checks passed');
} finally {
  await driver.quit();
  rmSync(work, { recursive: true, force: true });
}
