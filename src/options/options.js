import { DEFAULTS, loadSettings, saveSettings } from '../common/settings.js';
import { cacheUsage, cacheClear, cacheTrim, setCacheLimit } from '../viewer/cache.js';

const fields = [...document.querySelectorAll('[data-key]')];
const savedEl = document.getElementById('saved');
let settings = await loadSettings();
let savedTimer = 0;

function render() {
  for (const el of fields) {
    const v = settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = String(v);
  }
}

function read(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') {
    const n = Math.round(Number(el.value));
    const min = Number(el.min), max = Number(el.max);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULTS[el.dataset.key];
  }
  return el.value;
}

async function save() {
  settings = await saveSettings(settings);
  setCacheLimit(settings.cacheMB);
  await cacheTrim();
  showUsage();
  savedEl.textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { savedEl.textContent = ''; }, 1500);
}

for (const el of fields) {
  el.addEventListener('change', () => {
    settings[el.dataset.key] = read(el);
    render();
    save();
  });
}

async function showUsage() {
  const { bytes, count } = await cacheUsage();
  const mb = bytes / 1024 / 1024;
  document.getElementById('usage').textContent =
    `${count} model${count === 1 ? '' : 's'}, ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB of ${settings.cacheMB} MB`;
}

document.getElementById('clear').addEventListener('click', async () => {
  await cacheClear();
  showUsage();
});

document.getElementById('reset').addEventListener('click', async () => {
  settings = { ...DEFAULTS };
  render();
  await save();
});

setCacheLimit(settings.cacheMB);
render();
showUsage();
