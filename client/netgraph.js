// net_graph 1: frame rate, ping, packet loss, traffic, interpolation and prediction,
// over a bar graph of the gaps between arriving datagrams (64 tick = 15.6 ms; tall
// bars are jitter, red ones are gaps long enough to mean loss). Text updates 4 times a
// second; the graph every frame it is shown.

import { TICK_RATE } from '../shared/constants.js';

const W = 192, H = 48;
const LOSS_GAP_MS = 2.5 * 1000 / TICK_RATE;

export class NetGraph {
  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'netgraph';
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.text = document.createElement('pre');
    this.el.append(this.canvas, this.text);
    document.body.appendChild(this.el);
    this.ctx = this.canvas.getContext('2d');
    this.shown = false;
    this.last = { t: 0, bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0, seq: 0, received: 0 };
    this.loss = 0;
  }

  // info: { fps, rtt, compared, corrected, interpTicks } ; net: NetClient or null.
  update(show, now, net, info) {
    if (show !== this.shown) {
      this.shown = show;
      this.el.style.display = show ? 'block' : 'none';
    }
    if (!show) return;
    this.draw(net);
    const L = this.last;
    if (now - L.t < 250) return;
    const dt = (now - L.t) / 1000;
    let line2 = 'offline', line3 = '';
    if (net) {
      const inRate = (net.bytesIn - L.bytesIn) / dt, outRate = (net.bytesOut - L.bytesOut) / dt;
      const inPps = (net.packetsIn - L.packetsIn) / dt, outPps = (net.packetsOut - L.packetsOut) / dt;
      const expected = net.latestSeq - L.seq, got = net.received - L.received;
      if (L.t && expected > 0) this.loss = Math.max(0, Math.min(1, 1 - got / expected));
      line2 = `in : ${fmtRate(inRate)} ${inPps.toFixed(0)}/s   out: ${fmtRate(outRate)} ${outPps.toFixed(0)}/s`;
      const exact = info.compared ? (100 * (info.compared - info.corrected) / info.compared).toFixed(1) : '-';
      line3 = `loss: ${Math.round(this.loss * 100)}%  lerp: ${(info.interpTicks * 1000 / TICK_RATE).toFixed(1)} ms` +
        `  pred: ${exact}%`;
      Object.assign(L, {
        bytesIn: net.bytesIn, bytesOut: net.bytesOut, packetsIn: net.packetsIn, packetsOut: net.packetsOut,
        seq: net.latestSeq, received: net.received,
      });
    }
    L.t = now;
    this.text.textContent = `fps: ${info.fps.toFixed(0).padStart(4)}  ping: ${net ? info.rtt.toFixed(0) : '-'} ms` +
      `  tick: ${TICK_RATE}\n${line2}${line3 ? `\n${line3}` : ''}`;
  }

  draw(net) {
    const g = this.ctx;
    g.clearRect(0, 0, W, H);
    if (!net) return;
    const scale = H / (4 * 1000 / TICK_RATE); // full height = 4 ticks
    for (let i = 0; i < 128; i++) {
      const k = net.gapCount - 128 + i;
      if (k < 0) continue;
      const ms = net.gaps[k & 127];
      const h = Math.min(H, Math.max(1, ms * scale));
      g.fillStyle = ms > LOSS_GAP_MS ? '#ff5050' : ms > 1500 / TICK_RATE ? '#ffd050' : '#60e060';
      g.fillRect(W - 128 * 1.5 + i * 1.5, H - h, 1, h);
    }
    g.fillStyle = 'rgba(255,255,255,0.35)'; // one tick
    g.fillRect(0, H - Math.round(1000 / TICK_RATE * scale), W, 1);
  }
}

function fmtRate(bytesPerSecond) {
  return bytesPerSecond >= 1024 ? `${(bytesPerSecond / 1024).toFixed(1)} kB/s` : `${bytesPerSecond.toFixed(0)} B/s`;
}
