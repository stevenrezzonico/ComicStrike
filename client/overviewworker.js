// The radar's overview (shared/overview.js) built off the page's thread: on cs_polaris it
// was 2 of the 2.4 s a map took to load (de_dust2 0.6 of 0.7), the page frozen meanwhile.
// In: { id, buffer (the map's bytes, transferred), untrusted }. Out: { id, data } (what
// Overview.from takes; the level images' pixels transferred) or { id, error }.

import { parseBSP, parseUntrustedBSP } from '../shared/bsp.js';
import { CollisionWorld } from '../shared/trace.js';
import { Overview } from '../shared/overview.js';

onmessage = (e) => {
  const { id, buffer, untrusted } = e.data;
  try {
    const bsp = untrusted ? parseUntrustedBSP(buffer) : parseBSP(buffer);
    const data = new Overview(bsp, CollisionWorld.fromBSP(bsp)).data();
    const pixels = [...new Set(data.levels.map((l) => l.rgba.buffer))];
    postMessage({ id, data }, pixels);
  } catch (err) {
    postMessage({ id, error: String(err.message || err) });
  }
};
