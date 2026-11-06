// Radio commands and pings (server/game.js radio / ping, server/bots.js orders): a radio
// line reaches the speaker's team only, flagged CHAT_RADIO; a ping marks what the view
// meets for the team; "Follow me." sends the team's bots after the speaker. On
// de_playground, so no Valve map is needed.
import assert from 'node:assert/strict';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import { PHASE_LIVE } from '../shared/economy.js';
import {
  Writer, Reader, writeCommand, readChat, readPing, writePing, S2C_CHAT, S2C_PING,
  CHAT_RADIO, CHAT_TEAM, RADIO, RADIO_MENUS, radioIndex,
} from '../shared/protocol.js';
import { WS_SLOTS, SLOT_C4 } from '../shared/weapons.js';
import { Host } from '../server/host.js';
import { loadMap, joinClient, sendCmd } from './harness.js';

const bsp = loadMap('de_playground');

function setup() {
  const host = new Host({ loadMap: () => bsp, listMaps: () => ['de_playground'], readCfg: () => null, print: () => {}, defer: (fn) => fn() });
  host.start('de_playground');
  host.con.exec('mp_warmuptime 0; mp_freezetime 0');
  const w = new Writer(), humans = [];
  const join = (name, team) => {
    const sent = [];
    const c = joinClient(host.game, w, name, team, { send: (b) => sent.push(b.slice()), close: () => {}, closed: false });
    Object.assign(c, { sent, commands: 0 });
    c.of = (type) => sent.filter((b) => b[0] === type).map((b) => {
      const r = new Reader().set(b);
      r.u8v();
      return r;
    });
    c.say = (text) => host.game.receive(c, writeCommand(w, ++c.commands, text).slice());
    humans.push(c);
    return c;
  };
  const run = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      for (const c of humans) sendCmd(host.game, w, c);
      host.game.step();
    }
  };
  return { host, game: host.game, join, run };
}

Deno.test('radio: the menus hold every line; a ping round-trips', () => {
  assert.equal(RADIO_MENUS.at(-1)[1], RADIO.length);
  assert.equal(RADIO[radioIndex('enemyspot')][1], 'Enemy spotted.');
  const r = new Reader().set(writePing(new Writer(), 3, 100.4, -2000, 70000).slice());
  assert.equal(r.u8v(), S2C_PING);
  assert.deepEqual(readPing(r), { sender: 3, x: 100, y: -2000, z: 32767 });
});

Deno.test('radio: a line reaches the team only, and a ping marks what the view meets', () => {
  const { game, join, run } = setup();
  const a = join('alice', TEAM_T), b = join('bob', TEAM_T), e = join('eve', TEAM_CT);
  run(8);
  assert.equal(game.phase, PHASE_LIVE);
  a.say('followme');
  run(1);
  const heard = (c) => c.of(S2C_CHAT).map((r) => readChat(r)).filter((m) => m.flags & CHAT_RADIO);
  assert.deepEqual(heard(b), [{ sender: a.id, flags: CHAT_RADIO | CHAT_TEAM, text: 'Follow me.' }]);
  assert.equal(heard(a).length, 1, 'the speaker hears it too');
  assert.equal(heard(e).length, 0, 'not the other team');
  a.say('roger'); // within the flood gap: dropped
  run(1);
  assert.equal(heard(b).length, 1);
  a.say('player_ping');
  run(1);
  const pings = (c) => c.of(S2C_PING).map((r) => readPing(r));
  assert.equal(pings(b).length, 1);
  assert.equal(pings(e).length, 0);
  const f = a.player.ps.f, p = pings(b)[0];
  assert.ok(Math.hypot(p.x - f[PS_ORIGIN], p.y - f[PS_ORIGIN + 1]) > 16, 'somewhere along the view');
  a.say('player_ping'); // within a second: dropped
  run(1);
  assert.equal(pings(b).length, 1);
});

Deno.test('radio: "Follow me." sends the team bots after the speaker', () => {
  const { host, game, join, run } = setup();
  const a = join('alice', TEAM_T);
  join('eve', TEAM_CT);
  host.con.exec('bot_add t normal; bot_dont_shoot 1');
  run(8);
  const bot = game.bots.list[0], bf = bot.c.player.ps.f, af = a.player.ps.f;
  bot.c.player.ws.f[WS_SLOTS + SLOT_C4 * 3] = 0; // a bomb carrier keeps to its site whatever it hears
  // the bot a way off across the open yard
  const nav = game.bots.nav;
  let far = -1;
  for (let k = 0; k < nav.count && far < 0; k++) {
    const d = Math.hypot(nav.x[k] - af[PS_ORIGIN], nav.y[k] - af[PS_ORIGIN + 1]);
    if (d > 600 && d < 1000 && Math.abs(nav.z[k] - (af[PS_ORIGIN + 2] - 36)) < 8) far = k;
  }
  assert.ok(far >= 0);
  bf[PS_ORIGIN] = nav.x[far];
  bf[PS_ORIGIN + 1] = nav.y[far];
  bf[PS_ORIGIN + 2] = nav.z[far] + 36;
  const dist = () => Math.hypot(bf[PS_ORIGIN] - af[PS_ORIGIN], bf[PS_ORIGIN + 1] - af[PS_ORIGIN + 1]);
  const before = dist();
  a.say('followme');
  run(64 * 6);
  assert.equal(bot.order?.kind, 'follow');
  assert.ok(dist() < Math.min(before - 300, 400), `came along: ${before.toFixed(0)} -> ${dist().toFixed(0)}`);
  // An order is from a teammate, for one life: not after he changed sides, nor after the bot respawned.
  a.say('followme');
  run(2);
  a.player.team = TEAM_CT; // as a switch in freeze time leaves him: alive, on the other side
  run(2);
  assert.equal(bot.order?.kind, undefined, 'not after a side switch'); // (the order itself holds the game: a failure printing it took 15 GB)
  a.player.team = TEAM_T;
  run(64); // past the chat's flood check
  a.say('followme');
  run(2);
  assert.equal(bot.order?.kind, 'follow');
  bot.c.life++; // a new life (the round restarting)
  run(2);
  assert.equal(bot.order?.kind, undefined, 'not after a respawn');
});
