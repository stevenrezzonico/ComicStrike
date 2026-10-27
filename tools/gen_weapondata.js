// Regenerates shared/weapondata.js from CS:GO's items_game.txt (weapon prefabs).
// deno run --allow-net=raw.githubusercontent.com --allow-write=shared/weapondata.js tools/gen_weapondata.js

// Final CS:GO build (1568), mirrored by SteamTracking before the CS2 switch.
const COMMIT = '64b7772ba263a87083c3979c769c5919aae78337';
const SOURCE = `https://raw.githubusercontent.com/SteamTracking/GameTracking-CS2/${COMMIT}/csgo/scripts/items/items_game.txt`;

const GUNS = [
  'glock', 'hkp2000', 'usp_silencer', 'p250', 'elite', 'fiveseven', 'tec9', 'cz75a', 'deagle', 'revolver',
  'mac10', 'mp9', 'mp7', 'mp5sd', 'ump45', 'p90', 'bizon',
  'galilar', 'famas', 'ak47', 'm4a1', 'm4a1_silencer', 'sg556', 'aug', 'ssg08', 'awp', 'g3sg1', 'scar20',
  'nova', 'xm1014', 'sawedoff', 'mag7', 'm249', 'negev',
];

const KEYS = [
  'cycletime', 'cycletime alt', 'cycletime when in burst mode', 'time between burst shots', 'damage', 'armor ratio',
  'penetration', 'range', 'range modifier', 'headshot multiplier', 'max player speed', 'max player speed alt',
  'primary clip size', 'primary reserve ammo max', 'in game price', 'kill award', 'bullets', 'is full auto',
  'has silencer', 'has burst mode', 'is revolver', 'zoom levels', 'zoom fov 1', 'zoom fov 2', 'spread', 'spread alt',
  'inaccuracy crouch', 'inaccuracy crouch alt', 'inaccuracy stand', 'inaccuracy stand alt', 'inaccuracy move',
  'inaccuracy move alt', 'inaccuracy jump', 'inaccuracy jump alt', 'inaccuracy jump initial', 'inaccuracy jump apex',
  'inaccuracy ladder', 'inaccuracy ladder alt', 'inaccuracy land', 'inaccuracy land alt', 'inaccuracy fire',
  'inaccuracy fire alt', 'recovery time crouch', 'recovery time crouch final', 'recovery time stand',
  'recovery time stand final', 'recovery transition start bullet', 'recovery transition end bullet', 'recoil angle',
  'recoil angle alt', 'recoil angle variance', 'recoil angle variance alt', 'recoil magnitude', 'recoil magnitude alt',
  'recoil magnitude variance', 'recoil magnitude variance alt', 'recoil seed', 'spread seed',
  'flinch velocity modifier large', 'flinch velocity modifier small',
];

// Minimal KeyValues parser. Duplicate keys merge (blocks) or overwrite (values),
// and platform conditionals like [$WIN32] are skipped.
function parseKV(src, start) {
  let i = start;
  const WS = new Set([' ', '\t', '\n', '\r']);
  const BREAK = /[\s{}"]/g;
  function tok() {
    for (;;) {
      while (i < src.length && WS.has(src[i])) i++;
      if (src[i] === '/' && src[i + 1] === '/') {
        i = src.indexOf('\n', i);
        continue;
      }
      break;
    }
    const c = src[i];
    if (c === '{' || c === '}') {
      i++;
      return c;
    }
    if (c === '"') {
      const e = src.indexOf('"', i + 1);
      const s = src.slice(i + 1, e);
      i = e + 1;
      return { s };
    }
    BREAK.lastIndex = i;
    const end = BREAK.exec(src).index;
    const s = src.slice(i, end);
    i = end;
    return { s };
  }
  function block() {
    const o = {};
    for (;;) {
      const k = tok();
      if (k === '}' || k === undefined) return o;
      const t = tok();
      const v = t === '{' ? block() : t.s;
      if (typeof o[k.s] === 'object' && typeof v === 'object') Object.assign(o[k.s], v);
      else o[k.s] = v;
      while (src[i] === ' ' || src[i] === '\t') i++;
      if (src[i] === '[') i = src.indexOf(']', i) + 1;
    }
  }
  tok(); // key
  tok(); // {
  return block();
}

const src = await (await fetch(SOURCE)).text();
const prefabs = parseKV(src, src.indexOf('\n\t"prefabs"'));

function resolve(name, seen = new Set()) {
  const p = prefabs[name];
  if (!p || seen.has(name)) return {};
  seen.add(name);
  const attrs = {};
  if (p.prefab) for (const parent of p.prefab.split(/\s+/)) Object.assign(attrs, resolve(parent, seen));
  return Object.assign(attrs, p.attributes || {});
}

// Teams that can buy it: bit 1 = terrorists, bit 2 = counter-terrorists.
function teams(name, seen = new Set()) {
  const p = prefabs[name];
  if (!p || seen.has(name)) return 0;
  seen.add(name);
  if (p.used_by_classes) {
    return (p.used_by_classes.terrorists === '1' ? 1 : 0) | (p.used_by_classes['counter-terrorists'] === '1' ? 2 : 0);
  }
  for (const parent of (p.prefab || '').split(/\s+/)) {
    const t = teams(parent, seen);
    if (t) return t;
  }
  return 0;
}

// Joins items into indented lines of at most 120 columns.
function wrap(items) {
  const lines = [];
  let line = ' ';
  for (const it of items) {
    if (line.length + it.length + 2 > 120) {
      lines.push(line.trimEnd());
      line = ' ';
    }
    line += ` ${it},`;
  }
  lines.push(line);
  return lines.join('\n');
}

const camel = (k) => k.replace(/ (\w)/g, (_, c) => c.toUpperCase());
const fields = [...KEYS.map(camel), 'teams'];
const rows = GUNS.map((g) => {
  const a = resolve(`weapon_${g}_prefab`);
  if (!a['recoil seed']) throw new Error(`no data for ${g}`);
  const values = KEYS.map((k) => (a[k] === undefined ? 'null' : String(+a[k])));
  return `  ${g}: [${[...values, teams(`weapon_${g}_prefab`)].join(', ')}],`;
});

const out = `// GENERATED by tools/gen_weapondata.js from CS:GO's scripts/items/items_game.txt
// (final CS:GO build 1568, SteamTracking/GameTracking-CS2@${COMMIT.slice(0, 7)}). Do not edit by hand.
// Units as in the game files: cycle times in seconds, spread and inaccuracies in milliradians
// (except "land", a scale), recoil angles/magnitudes in degrees. "Alt" = secondary weapon mode
// (scoped, burst, or silencer attached). teams: who can buy it (1 = T, 2 = CT, 3 = both).

const FIELDS = [
${wrap(fields.map((f) => `'${f}'`))}
];

// deno-fmt-ignore
const ROWS = {
${rows.join('\n')}
};

export const CSGO_WEAPONS = Object.fromEntries(
  Object.entries(ROWS).map(([name, row]) => [name, Object.fromEntries(FIELDS.map((f, i) => [f, row[i]]))]),
);
`;
await Deno.writeTextFile(new URL('../shared/weapondata.js', import.meta.url), out);
console.log(`wrote ${GUNS.length} weapons`);
