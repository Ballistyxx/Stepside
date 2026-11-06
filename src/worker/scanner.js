// Byte-level ASCII scanner. Parsing numbers straight out of a Uint8Array is
// several times faster than TextDecoder + split + parseFloat, and allocates
// nothing per token.

const POW10 = new Float64Array(309);
for (let i = 0; i < 309; i++) POW10[i] = Number('1e' + i);

export class Scanner {
  constructor(bytes, start = 0) {
    this.b = bytes;
    this.p = start;
    this.n = bytes.length;
  }

  eof() {
    return this.p >= this.n;
  }

  /** Skip spaces/tabs/CR (not newlines). */
  skipSpaces() {
    const b = this.b, n = this.n;
    let p = this.p;
    while (p < n) {
      const c = b[p];
      if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12) p++;
      else break;
    }
    this.p = p;
  }

  /** Skip all whitespace including newlines. */
  skipWs() {
    const b = this.b, n = this.n;
    let p = this.p;
    while (p < n && b[p] <= 32) p++;
    this.p = p;
  }

  skipLine() {
    const i = this.b.indexOf(10, this.p);
    this.p = i < 0 ? this.n : i + 1;
  }

  /** True if at end of line (call after skipSpaces). Treats '#' as EOL. */
  atEol() {
    const p = this.p;
    return p >= this.n || this.b[p] === 10 || this.b[p] === 35;
  }

  /** Read a non-whitespace word as a string. */
  readWord() {
    const b = this.b, n = this.n, s = this.p;
    let p = s;
    while (p < n && b[p] > 32) p++;
    this.p = p;
    return latin1(b, s, p);
  }

  /**
   * Parse a decimal number at the cursor. Returns NaN (and skips the token)
   * if the cursor isn't on a number.
   */
  readNumber() {
    const b = this.b, n = this.n;
    let p = this.p;
    let c = b[p];
    let neg = false;
    if (c === 45) { neg = true; c = b[++p]; } else if (c === 43) c = b[++p];
    let mant = 0, exp = 0, digits = 0, any = false;
    while (c >= 48 && c <= 57) {
      if (digits < 17) { mant = mant * 10 + (c - 48); if (mant) digits++; } else exp++;
      any = true;
      c = b[++p];
    }
    if (c === 46) {
      c = b[++p];
      while (c >= 48 && c <= 57) {
        if (digits < 17) { mant = mant * 10 + (c - 48); if (mant) digits++; exp--; }
        any = true;
        c = b[++p];
      }
    }
    if (!any) {
      // nan / inf / garbage: skip the token
      while (p < n && b[p] > 32 && b[p] !== 44 && b[p] !== 93 && b[p] !== 125) p++;
      this.p = p === this.p ? p + 1 : p;
      return NaN;
    }
    if (c === 101 || c === 69) {
      let q = p + 1, ec = b[q], eneg = false;
      if (ec === 45) { eneg = true; ec = b[++q]; } else if (ec === 43) ec = b[++q];
      if (ec >= 48 && ec <= 57) {
        let e = 0;
        while (ec >= 48 && ec <= 57) { if (e < 10000) e = e * 10 + (ec - 48); ec = b[++q]; }
        exp += eneg ? -e : e;
        p = q;
      }
    }
    this.p = p;
    let v;
    if (exp === 0 || mant === 0) v = mant;
    else if (exp > 0) v = exp > 308 ? Infinity : mant * POW10[exp];
    else if (exp >= -308) v = mant / POW10[-exp];
    else v = exp < -616 ? 0 : mant / POW10[308] / POW10[-exp - 308];
    return neg ? -v : v;
  }

  /** Parse an integer (fast path; stops at '/' etc.). */
  readInt() {
    const b = this.b;
    let p = this.p;
    let c = b[p];
    let neg = false;
    if (c === 45) { neg = true; c = b[++p]; } else if (c === 43) c = b[++p];
    let v = 0;
    const s = p;
    while (c >= 48 && c <= 57) { v = v * 10 + (c - 48); c = b[++p]; }
    this.p = p;
    if (p === s) return NaN;
    return neg ? -v : v;
  }
}

export function latin1(b, s, e) {
  let out = '';
  for (let i = s; i < e; i += 4096) {
    out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 4096)));
  }
  return out;
}

export function isNumStart(c) {
  return (c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46;
}
