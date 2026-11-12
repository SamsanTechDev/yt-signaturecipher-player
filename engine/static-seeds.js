/**
 * engine/static-seeds.js - pure-JS signature programs.
 *
 * Some player builds decipher `s` with a plain array program instead of a VM.
 * Those need no player at all, so they are the cheapest thing to try, and they
 * are also the raw material for the static->dynamic promotion in synth.js.
 */
'use strict';

/** Rotate right by d (d may be negative). */
function rotateRight(a, d) {
  const n = a.length;
  if (!n) return;
  const k = ((d % n) + n) % n;
  if (!k) return;
  const tail = a.splice(n - k, k);
  a.unshift.apply(a, tail);
}

/** Swap a[0] with a[i mod n]. */
function swap0(a, i) {
  const n = a.length;
  if (!n) return;
  const k = ((i % n) + n) % n;
  const t = a[0];
  a[0] = a[k];
  a[k] = t;
}

/** Apply a list of ops to an array, in place. */
function applyOps(a, ops) {
  for (const op of ops) {
    switch (op[0]) {
      case 'swap0': swap0(a, op[1]); break;
      case 'splice': a.splice(op[1], op[2]); break;
      case 'reverse': a.reverse(); break;
      case 'rotateRight': rotateRight(a, op[1]); break;
      case 'remove': {
        const n = a.length;
        if (n) a.splice(((op[1] % n) + n) % n, 1);
        break;
      }
      default: break;
    }
  }
  return a;
}

/** The full static sig transform. */
function staticSig(input, ops) {
  return applyOps(String(input).split(''), ops).join('');
}

// ---------------------------------------------------------------------------
// op vocabulary used when building candidates
// ---------------------------------------------------------------------------

const OPS1 = [
  ['reverse'],
  ['splice', 0, 1],
  ['splice', 0, 2],
];

const OPS2 = [
  ['swap0', 1], ['swap0', 2], ['swap0', 3], ['swap0', 4],
  ['swap0', 5], ['swap0', 6], ['swap0', 7], ['swap0', 8],
  ['swap0', 12], ['swap0', 18], ['swap0', 62],
  ['rotateRight', 1], ['rotateRight', 2], ['rotateRight', 3],
];

module.exports = {
  rotateRight, swap0, applyOps, staticSig, OPS1, OPS2,
};
