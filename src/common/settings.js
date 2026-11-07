// User settings (browser.storage.local), shared by the content script, the
// viewer and the options page.
import browser from 'webextension-polyfill';

export const DEFAULTS = {
  // Viewer features
  modelTree: true,
  sectionPlane: false,
  viewPresets: true,
  displayOptions: true,
  orbitPoint: true,
  // Rendering
  quality: 'standard', // draft | low | standard | fine (CAD tessellation)
  edges: 'auto', // auto | on | off
  upAxis: 'auto', // auto | y | z
  // Loading
  fastFirstLook: true,
  progressive: true,
  autoLoadMB: 64,
  cacheMB: 512,
};

export async function loadSettings() {
  try {
    const stored = await browser.storage.local.get('settings');
    return { ...DEFAULTS, ...(stored && stored.settings) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(settings) {
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) clean[k] = k in settings ? settings[k] : DEFAULTS[k];
  await browser.storage.local.set({ settings: clean });
  return clean;
}

/** Calls `fn(settings)` whenever settings change (from the options page). */
export function onSettingsChanged(fn) {
  const listener = (changes, area) => {
    if (area === 'local' && changes.settings) fn({ ...DEFAULTS, ...changes.settings.newValue });
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
