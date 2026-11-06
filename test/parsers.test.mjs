// Parser + pipeline tests (node --test). OCCT is exercised via its node build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseObj } from '../src/worker/parsers/obj.js';
import { parsePly } from '../src/worker/parsers/ply.js';
import { parseOff } from '../src/worker/parsers/off.js';
import { parseVrml } from '../src/worker/parsers/vrml.js';
import { finalize, featureEdges } from '../src/worker/mesh.js';
import { Scanner } from '../src/worker/scanner.js';
import { parseCad } from '../src/worker/parsers/cad.js';

const fx = (n) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const fxText = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

function run(parts, edges = true) {
  const { mesh, edgeInput } = finalize(parts);
  const e = edges && edgeInput ? featureEdges(edgeInput) : null;
  return { mesh, edges: e };
}

test('scanner numbers', () => {
  const s = new Scanner(new TextEncoder().encode('1 -2.5 3e2 .5 -1.25E-3 +7 0.000001 123456789012345678'));
  const out = [];
  while (!s.eof()) { s.skipWs(); out.push(s.readNumber()); }
  assert.deepEqual(out.slice(0, 7), [1, -2.5, 300, 0.5, -0.00125, 7, 0.000001]);
  assert.ok(Math.abs(out[7] / 123456789012345678 - 1) < 1e-15);
});

test('obj cube edges', async () => {
  const { mesh, edges } = run(await parseObj(fx('cube.obj'), {}));
  assert.equal(mesh.triangles, 12);
  assert.equal(edges.length / 6, 12);
  // normals are axis aligned (flat): every Int16 normal has one component at ±32767
  for (let i = 0; i < mesh.normal.length; i += 3) {
    const m = Math.max(Math.abs(mesh.normal[i]), Math.abs(mesh.normal[i + 1]), Math.abs(mesh.normal[i + 2]));
    assert.equal(m, 32767);
  }
});

test('obj with normals + mtl', async () => {
  const mtl = fxText('male.mtl');
  const parts = await parseObj(fx('male.obj'), { fetchText: async () => mtl });
  const { mesh } = run(parts, false);
  assert.ok(mesh.triangles === 5004, `tris ${mesh.triangles}`);
  assert.ok(mesh.color || mesh.uniformColor);
});

test('ply ascii dolphins', () => {
  const { mesh } = run(parsePly(fx('dolphins.ply')));
  assert.equal(mesh.triangles, 1689);
});

test('ply ascii vertex colours + quad', () => {
  const { mesh } = run(parsePly(fx('quad.ply')));
  assert.equal(mesh.triangles, 2);
  assert.ok(mesh.color);
});

test('ply binary lucy', () => {
  const t = performance.now();
  const { mesh, edges } = run(parsePly(fx('lucy.ply')));
  assert.equal(mesh.triangles, 100000);
  console.log(`  lucy: ${(performance.now() - t).toFixed(0)} ms, ${edges.length / 6} edges`);
});

test('off coloured cube', () => {
  const { mesh, edges } = run(parseOff(fx('cube.off')));
  assert.equal(mesh.triangles, 12);
  assert.ok(mesh.color);
  assert.equal(edges.length / 6, 12);
});

test('vrml house (V2)', () => {
  const { mesh } = run(parseVrml(fx('house.wrl')));
  assert.ok(mesh.triangles > 100, `tris ${mesh.triangles}`);
});

test('vrml creaseAngle', () => {
  const { mesh } = run(parseVrml(fx('creaseAngle.wrl')));
  assert.ok(mesh.triangles > 0);
});

test('vrml KiCad-style DEF/USE, transform, Box', () => {
  const parts = parseVrml(fx('kicad_like.wrl'));
  assert.equal(parts.length, 2);
  const { mesh } = run(parts);
  assert.equal(mesh.triangles, 2 + 12);
  // rotated 90° about Z, translated z+1: quad spans x in [-1,0]
  assert.ok(Math.abs(mesh.size[0] - 2) < 1e-4 || Math.abs(mesh.size[1] - 2) < 1e-4);
});

test('vrml V1 separator/material binding/cube', () => {
  const parts = parseVrml(fx('cube_v1.wrl'));
  assert.equal(parts.length, 2);
  assert.ok(parts[0].faceColor);
  assert.deepEqual([...parts[0].faceColor.subarray(0, 6)], [255, 0, 0, 0, 255, 0]);
});

const require = createRequire(import.meta.url);
// Stepside's own OpenCascade build (vendor/, produced by native/build.sh).
const occtFactory = require('../vendor/stepside-occt.js');
const occtP = occtFactory({ print() {}, printErr() {} });
for (const [file, fmt] of [['cube.stp', 'step'], ['as1.stp', 'step'], ['dm1.stp', 'step'], ['io1.stp', 'step'], ['cube.igs', 'iges'], ['as1.brep', 'brep']]) {
  test(`occt ${file}`, async () => {
    const occt = await occtP;
    const t = performance.now();
    let last = -1, monotonic = true;
    const parts = await parseCad(fmt, fx(file), {
      occt,
      progress(_phase, v) { if (v < last - 1e-9) monotonic = false; last = v; },
    });
    assert.ok(monotonic, 'progress never goes backwards');
    assert.ok(last > 0.99, `progress reaches 100% (got ${last})`);
    const t1 = performance.now();
    const { mesh, edges } = run(parts);
    console.log(`  ${file}: occt+convert ${(t1 - t).toFixed(0)} ms, finalize+edges ${(performance.now() - t1).toFixed(0)} ms, ${mesh.triangles} tris, ${edges.length / 6} edges, size ${mesh.size.map((v) => v.toFixed(1))}`);
    assert.ok(mesh.triangles > 0);
    if (file === 'cube.stp') assert.equal(edges.length / 6 >= 12, true);
  });
}

