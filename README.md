# Stepside

A Manifest V3 WebExtension (Firefox first, Chrome too) that renders 3D model
files on GitHub in place of the raw-text blob view. GitHub previews `.stl`
natively; Stepside covers the rest:

| Format | Extensions | Engine |
| --- | --- | --- |
| STEP | `.step` `.stp` `.p21` | OpenCascade 8 (own WASM build, see `native/`) — colours + true B-rep edges |
| IGES | `.iges` `.igs` | OpenCascade |
| BREP | `.brep` `.brp` | OpenCascade |
| OBJ | `.obj` | custom parser — `vn`, vertex colours, polygons, `mtllib` `Kd` colours |
| PLY | `.ply` | custom parser — ASCII and binary, vertex/face colours, point clouds |
| OFF | `.off` | custom parser — OFF/COFF/NOFF/STOFF, vertex/face colours |
| VRML | `.wrl` `.vrml` | custom parser — VRML97 and 1.0: transforms, DEF/USE, IndexedFaceSet, primitives |
| glTF | `.gltf` `.glb` | three.js GLTFLoader (+ meshopt); external buffers/textures fetched from the repo |

A **3D / Source** switch sits above the viewer to get the original line-by-line
view back. Viewer controls: drag to orbit, right-drag/shift to pan, wheel to
zoom (towards the cursor). Keys: `F` reset view, `E` edges, `U` swap Y/Z up.

## Install (development)

```sh
npm install
npm run build            # -> dist/firefox, dist/chrome
```

- **Firefox**: `npm run start:firefox` (web-ext, temporary profile), or
  `about:debugging` → This Firefox → Load Temporary Add-on → `dist/firefox/manifest.json`.
  Needs Firefox 140+.
- **Chrome**: `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`.
- `npm run package` writes zips to `dist/` for store submission.

## Performance design

- **Dormant until needed.** The only always-on code is a 17 KB content script on
  `github.com` that tests the URL against a regex when GitHub navigates (Turbo /
  React soft-nav events + a `<title>` observer — no polling, no page-wide DOM
  observers). Nothing else loads on non-model pages.
- **Isolated, disposable viewer.** On a model page, an extension-origin iframe is
  injected over the code view. Leaving the page removes it, and with it the
  WebGL context, workers and all memory.
- **Download starts first.** The file is fetched by the content script (so
  private repos and LFS use your GitHub session) while the viewer boots, and
  the bytes are *transferred*, not copied, to the viewer and on to the worker.
  For CAD formats the OCCT WASM is compiled in parallel with the download.
- **Off-main-thread parsing.** All parsing, normal generation and feature-edge
  extraction happen in a worker. Text formats are parsed straight from bytes
  (no string splitting). The worker posts the mesh before computing edges so
  the first frame isn't delayed, then is terminated, freeing the OCCT heap.
- **One draw call.** Everything is merged into a single indexed geometry with
  Int16 normals and Uint8 colours; CPU-side copies are dropped once uploaded to
  the GPU.
- **Render on demand.** No animation loop: frames are drawn only while the
  camera moves (including damping), then rendering stops — 0 frames when idle.
- **Content-addressed cache.** Results that took >200 ms are cached in
  IndexedDB by the SHA-256 of the file (LRU, 512 MB cap). Re-opening the same
  file — on any branch or commit — skips parsing (e.g. a 13.5 MB STEP goes from
  ~9 s to ~0.1 s).

## Layout

```
src/content/content.js     URL detection, iframe injection, downloads, 3D/Source toggle
src/viewer/                iframe page: three.js renderer, controls, glTF path, cache
src/worker/                parse worker: scanner, mesh pipeline, parsers/*
scripts/build.mjs          esbuild -> dist/{firefox,chrome} with per-browser manifests
native/                    OpenCascade -> WASM importer (C++) and its build script
vendor/                    prebuilt stepside-occt.{js,wasm} (output of native/build.sh)
scripts/icons.mjs          generates icons
test/                      unit tests (node --test) and real-browser E2E tests
```

## CAD engine (`native/`)

STEP/IGES/BREP go through Stepside's own OpenCascade 8.0.1 WASM build rather
than occt-import-js (which is `-Oz`, does a document-wide label search per face
for colours, and returns every number through a separate JS call — ~5× slower,
and it has no progress reporting). The importer (`native/src/stepside_occt.cpp`):

- is `-O3` + SIMD with native WASM exceptions and mimalloc;
- skips XDE data a viewer never uses (names, layers, GD&T, materials, …);
- uses a *viewer healing profile*: OCCT's normal shape fixing minus the
  self-intersection/notch repairs, which only matter for modelling (identical
  output on every test file, ~20% faster on large assemblies);
- meshes each unique part once at its origin; instances reuse the triangulation
  (meshing the assembled compound re-meshes every instance and can exhaust the
  4 GB WASM heap);
- resolves colours with XCAFPrs styles and writes one merged mesh straight into
  typed arrays;
- reports progress per phase (bytes lexed, B-rep transfer, faces meshed), which
  the viewer maps to a time-proportional bar;
- makes a null `occ::handle` dereference throw `Standard_NullObject` (patched in
  by `build.sh`) so OCCT's own per-edge/per-face error recovery works in WASM,
  and skips (and reports) any assembly part that still fails to export.

Rebuilding is only needed when changing the C++: `native/build.sh setup` once
(emsdk 4.0.10 + OCCT sources + static libs, ~5 min on 15 cores, all under the
gitignored `native/.deps`), then `native/build.sh` to relink in seconds.

## Tests

```sh
npm test                       # parsers + mesh pipeline + OCCT (node)
npm run build
npm run e2e:firefox            # real Firefox (selenium/geckodriver), live GitHub pages
npm run e2e:firefox:nav        # soft-navigation, Source/3D toggle, teardown
npm run e2e:chrome             # Chromium via Playwright (set CHROME_PATH if needed)
```

## Known limitations

- STEP import is bounded by OpenCascade's single-threaded reader (threads
  would need cross-origin isolation, which an iframe inside github.com can't
  get). A 34 MB Onshape assembly takes ~7 s, a 75 MB one ~14 s.
- Draco-compressed glTF (`KHR_draco_mesh_compression`) and KTX2 textures are
  not supported yet.
- VRML: PROTO instances, Inline, Extrusion, ElevationGrid and line/point sets
  are skipped.
- Files over 64 MB ask before rendering.
- Non-convex polygons in OBJ/OFF/PLY/VRML are fan-triangulated.
