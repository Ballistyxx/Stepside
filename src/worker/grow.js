// Growable typed arrays. `trim()` returns a right-sized copy only when the
// slack is significant, otherwise a view (avoids a copy for big buffers).

function make(Ctor) {
  return class {
    constructor(cap = 1024) {
      this.a = new Ctor(Math.max(16, cap));
      this.n = 0;
    }
    grow(need) {
      let cap = this.a.length * 2;
      while (cap < need) cap *= 2;
      const a = new Ctor(cap);
      a.set(this.a.subarray(0, this.n));
      this.a = a;
    }
    push(x) {
      if (this.n >= this.a.length) this.grow(this.n + 1);
      this.a[this.n++] = x;
    }
    push3(x, y, z) {
      if (this.n + 3 > this.a.length) this.grow(this.n + 3);
      const a = this.a, n = this.n;
      a[n] = x; a[n + 1] = y; a[n + 2] = z;
      this.n = n + 3;
    }
    trim() {
      if (this.n < this.a.length * 0.75) return this.a.slice(0, this.n);
      return this.a.subarray(0, this.n);
    }
  };
}

export const GrowF32 = make(Float32Array);
export const GrowF64 = make(Float64Array);
export const GrowI32 = make(Int32Array);
export const GrowU32 = make(Uint32Array);
export const GrowU8 = make(Uint8Array);
export const GrowU16 = make(Uint16Array);
