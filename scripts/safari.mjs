// Wraps dist/safari in the Xcode app Safari needs to load a web extension.
//   npm run safari            build, then generate dist/safari-xcode/Stepside
// macOS + Xcode only. The project references dist/safari rather than copying
// it, so later `npm run build` runs show up on the next Xcode build.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'dist/safari');
if (process.platform !== 'darwin') {
  console.error('Safari extensions are packaged with Xcode; run this on macOS.');
  process.exit(1);
}
if (!existsSync(join(ext, 'manifest.json'))) {
  console.error('dist/safari is missing; run `npm run build` first.');
  process.exit(1);
}
execFileSync('xcrun', [
  'safari-web-extension-converter', ext,
  '--project-location', join(root, 'dist/safari-xcode'),
  '--app-name', 'Stepside',
  '--bundle-identifier', 'dev.stepside.Stepside',
  '--swift', '--no-open', '--no-prompt', '--force',
], { stdio: 'inherit' });
console.log('Open dist/safari-xcode/Stepside/Stepside.xcodeproj, pick the macOS (or iOS) scheme and Run.');
