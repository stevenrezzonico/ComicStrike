// A one-way queue of datagrams in shared memory (a SharedArrayBuffer): one side puts, the
// other takes, and no message passes between them. Practice uses two, one each way between
// the page (client/net.js) and the server's worker (client/localserver.js), once the page is
// cross-origin isolated (the server's COOP and COEP headers): a postMessage every tick woke
// the worker's thread, ~37 µs of the page's each time, 40 % of a tick. Nothing allocated.

import { MAX_DATAGRAM } from '../shared/protocol.js';

export const SLOT = 2 + MAX_DATAGRAM; // a datagram's length (u16, little-endian), then its bytes
export const TO_WORKER_SLOTS = 64; // the page's commands: a second of them
export const TO_PAGE_SLOTS = 512; // the server's datagrams: 2 s for a hidden page, drained once a second
export const ringBytes = (slots) => (8 + slots * SLOT + 7) & ~7;

export class Ring {
  // In `sab` from byte `offset` (a multiple of 4): the next slot to write and the next to
  // read (Int32), then the slots.
  constructor(sab, offset, slots) {
    this.at = new Int32Array(sab, offset, 2);
    this.slot = Array.from({ length: slots }, (_, k) => new Uint8Array(sab, offset + 8 + k * SLOT, SLOT));
    this.slots = slots;
  }

  // Puts a datagram; false when the ring is full (it is dropped, as a network would) or the
  // datagram is too big.
  put(bytes) {
    const w = Atomics.load(this.at, 0), next = w + 1 === this.slots ? 0 : w + 1;
    if (next === Atomics.load(this.at, 1) || bytes.length > MAX_DATAGRAM) return false;
    const s = this.slot[w], n = bytes.length;
    s[0] = n & 255;
    s[1] = n >> 8;
    s.set(bytes, 2);
    Atomics.store(this.at, 0, next); // (the bytes written before it are seen with it)
    return true;
  }

  // The next datagram's slot copied into `out` at `off` (its length, then the datagram at
  // off + 2): returns the length, or -1 when there is none. The slot is free again after.
  // A copy, not a view: text cannot be decoded out of shared memory, and the writer reuses
  // the slot.
  take(out, off) {
    const r = Atomics.load(this.at, 1);
    if (r === Atomics.load(this.at, 0)) return -1;
    const s = this.slot[r];
    out.set(s, off);
    Atomics.store(this.at, 1, r + 1 === this.slots ? 0 : r + 1);
    return out[off] | out[off + 1] << 8;
  }
}
