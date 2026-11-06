#!/usr/bin/env bash
# Builds Stepside's OpenCascade importer (native/src/stepside_occt.cpp) to
# WebAssembly: vendor/stepside-occt.{js,wasm}.
#
# One-time setup (≈15 min on a 15-core M-series Mac; everything lives in the
# gitignored native/.deps):
#   native/build.sh setup     # emsdk + OCCT 8.0.1 sources + static WASM libs
#   native/build.sh           # (re)link the importer — a few seconds
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD
DEPS=$ROOT/.deps
OCCT_TAG=V8_0_1
EMSDK_VERSION=4.0.10
JOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc)
TOOLKITS="TKernel TKMath TKG2d TKG3d TKGeomBase TKBRep TKGeomAlgo TKTopAlgo TKPrim TKBO TKBool TKHLR
  TKShHealing TKMesh TKService TKV3d TKCDF TKLCAF TKCAF TKVCAF TKDE TKXSBase TKDESTEP TKDEIGES TKXCAF TKRWMesh"
# -include mutex: OCCT 8.0.1 relies on a transitive <mutex> that newer libc++ dropped.
# -UOCC_CONVERT_SIGNALS: no signals to convert in WASM, and its setjmp+try mix breaks wasm-opt.
CXXFLAGS="-O3 -msimd128 -fwasm-exceptions -UOCC_CONVERT_SIGNALS -include mutex"

setup() {
  mkdir -p "$DEPS"
  if [ ! -d "$DEPS/emsdk" ]; then
    git clone -q --depth 1 https://github.com/emscripten-core/emsdk.git "$DEPS/emsdk"
    (cd "$DEPS/emsdk" && ./emsdk install $EMSDK_VERSION && ./emsdk activate $EMSDK_VERSION)
  fi
  [ -d "$DEPS/occt" ] || git clone -q --depth 1 --branch $OCCT_TAG https://github.com/Open-Cascade-SAS/OCCT.git "$DEPS/occt"
  source "$DEPS/emsdk/emsdk_env.sh" >/dev/null
  emcmake cmake -G Ninja -S "$DEPS/occt" -B "$DEPS/occt-build" -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_LIBRARY_TYPE=Static -DBUILD_MODULE_Draw=OFF -DBUILD_USE_PCH=OFF \
    -DUSE_FREETYPE=OFF -DUSE_OPENGL=OFF -DUSE_GLES2=OFF -DUSE_RAPIDJSON=OFF -DUSE_DRACO=OFF \
    -DUSE_TK=OFF -DUSE_TCL=OFF -DUSE_FREEIMAGE=OFF -DUSE_FFMPEG=OFF -DUSE_OPENVR=OFF -DUSE_TBB=OFF \
    -DUSE_VTK=OFF -DUSE_XLIB=OFF -DUSE_EIGEN=OFF \
    "-DCMAKE_CXX_FLAGS=$CXXFLAGS" "-DCMAKE_C_FLAGS=-O3 -msimd128" "-DCMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG"
  # shellcheck disable=SC2086
  ninja -C "$DEPS/occt-build" -j"$JOBS" $TOOLKITS
}

link() {
  source "$DEPS/emsdk/emsdk_env.sh" >/dev/null
  local B=$DEPS/occt-build
  local LIBS
  LIBS=$(find "$B" -name 'libTK*.a' | sort)
  mkdir -p "$ROOT/out"
  # shellcheck disable=SC2086
  em++ $CXXFLAGS -std=c++17 -I"$B/include/opencascade" "$ROOT/src/stepside_occt.cpp" $LIBS \
    -o "$ROOT/out/stepside-occt.js" \
    --bind -sMODULARIZE=1 -sEXPORT_NAME=stepsideOcct -sENVIRONMENT=worker,node \
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=64MB -sSTACK_SIZE=8MB \
    -sDYNAMIC_EXECUTION=0 -sINCOMING_MODULE_JS_API=locateFile,instantiateWasm,print,printErr \
    -sMALLOC=mimalloc -fwasm-exceptions -O3 ${EXTRA_LDFLAGS:-}
  mkdir -p "$ROOT/../vendor"
  cp "$ROOT/out/stepside-occt.js" "$ROOT/out/stepside-occt.wasm" "$ROOT/../vendor/"
  ls -l "$ROOT/../vendor"
}

case "${1:-link}" in
  setup) setup; link ;;
  link) link ;;
  *) echo "usage: $0 [setup|link]"; exit 1 ;;
esac
