// The map editor's document: a project of shapes and points, turned into a map by our
// compiler (shared/bspwriter.js). Pure data and functions (no DOM): the editor page, its
// compile worker and the tests share them.
//
// A project (saved as JSON, format 'comicstrike-map' version 2):
//   { name, brushes: [{ id, b: [x0, y0, z0, x1, y1, z1], tex: { top, bottom, side }, kind, keys,
//       shape, yaw, up, sides, step }], points: [{ id, kind, o: [x, y, z] (the feet), yaw }], nextId }
// A brush's shape (SHAPES) fills its box b: a box (turned by `yaw` degrees about its
// center: an angled wall), a ramp rising toward side `up`, a pillar of `sides` faces, stairs
// of `step` high steps rising toward `up`, a ladder against side `up` (its board and the
// climbable volume in front). Its kind is 'world' (solid) or a brush entity class (KINDS);
// each entity brush is an entity of its own. Version 1 files read as boxes. The compiled
// map is closed in a sky box round everything, so it never leaks into the void.

import {
  MapBuilder, box, wedge, turnedBox, prism, brushPlanes, brushPolygons, NONE, CONTENTS_WATER,
} from '../../shared/bspwriter.js';

export const FORMAT = 'comicstrike-map';
export const VERSION = 2;

// Shapes: label; `turns` (takes yaw), `rises` (takes up: the high side).
export const SHAPES = {
  box: { label: 'Box', turns: true },
  ramp: { label: 'Ramp', rises: true },
  pillar: { label: 'Pillar', turns: true },
  stairs: { label: 'Stairs', rises: true },
  ladder: { label: 'Ladder', rises: true },
};
export const UPS = ['px', 'py', 'nx', 'ny']; // east, north, west, south: a quarter turn apart
export const UP_LABELS = { px: 'east', nx: 'west', py: 'north', ny: 'south' };
export const SIDE_COUNTS = [6, 8, 12, 16];
export const MAX_SLOPE = 45; // degrees: steeper ramps cannot be walked up (GoldSrc's 0.7 normal)
export const MAX_STEP = 18; // units: higher steps need a jump

// The textures to paint with: [name, width, height, label]. Names are CS 1.6 textures, so
// the print uses their measured colors and material patterns (client/texturedata.js).
export const TEXTURES = [
  ['-0sand', 128, 128, 'Sand'], ['sandroad', 128, 128, 'Road'], ['-0azdirt', 128, 128, 'Dirt'],
  ['azgrass', 128, 128, 'Grass'], ['asphaltdirty01', 128, 128, 'Asphalt'], ['snow', 128, 128, 'Snow'],
  ['flor_wood_lt_r3', 128, 128, 'Wood floor'], ['tk_pooltile', 64, 64, 'Pool tiles'],
  ['cssandwallbta', 128, 128, 'Sand wall'], ['azwall_a', 128, 128, 'Stone wall'],
  ['crete3_wall02', 128, 128, 'Concrete'], ['crete4_stp01', 64, 64, 'Concrete steps'],
  ['brick13', 128, 128, 'Grey brick'], ['brick07', 128, 128, 'Red brick'],
  ['-0rockcobblest', 128, 128, 'Cobblestone'], ['grouttiles', 64, 64, 'White tiles'],
  ['wdplanks128f', 128, 128, 'Planks'], ['claytile1', 128, 128, 'Roof tiles'],
  ['metal_wall05b', 128, 128, 'Rusty metal'], ['steel', 64, 64, 'Steel'], ['duct_flr01', 64, 64, 'Metal floor'],
  ['sandtrim', 128, 32, 'Sand trim'], ['stripes2', 64, 64, 'Hazard stripes'],
  ['crate08', 64, 64, 'Crate'], ['bcrate02', 64, 64, 'Dark crate'], ['mltrycrtesd', 64, 64, 'Army crate side'],
  ['mltrycrtetp', 64, 64, 'Army crate top'], ['sandwlldoor', 64, 128, 'Sand door'],
  ['fifties_dr2', 64, 128, 'Wooden door'], ['out_w8dr1', 128, 128, 'Garage door'],
  ['lab1_comp3d', 32, 32, 'Button panel'], ['glass_med', 64, 64, 'Glass'], ['!watergreen', 64, 64, 'Water'],
  ['{ladder1', 64, 64, 'Ladder'], ['scroll_conv', 64, 64, 'Conveyor belt'], ['sky', 256, 256, 'Sky'],
];
const TEXTURE_SIZE = new Map(TEXTURES.map(([n, w, h]) => [n, [w, h]]));

// Brush kinds: label, default keys, `trigger` (no faces, no collision: zones and volumes),
// `water` (a water volume: only its top shows).
export const KINDS = {
  world: { label: 'Solid' },
  func_door: { label: 'Sliding door', keys: { angle: '-1', speed: '160', wait: '3', lip: '8', targetname: '' },
    help: 'angle: -1 up, -2 down, else a direction in degrees; a targetname means only a button opens it' },
  func_door_rotating: { label: 'Swinging door', keys: { distance: '90', speed: '120', wait: '3', hinge: 'start' },
    help: 'hinge: start or end of the door\'s long side; distance in degrees (negative: the other way)' },
  func_button: { label: 'Button', keys: { target: '', speed: '40', wait: '1', lip: '2', angle: '0' },
    help: 'target: the targetname of the door it opens; angle: the way it is pushed in' },
  func_breakable: { label: 'Breakable', keys: { material: '1', health: '40' },
    help: 'material: 0 glass, 1 wood, 2 metal, 7 unbreakable' },
  func_conveyor: { label: 'Conveyor', keys: { speed: '160', angles: '0 0 0' },
    help: 'carries what stands on it toward angles (yaw); a Conveyor belt top slides that way' },
  func_water: { label: 'Water', water: true, help: 'a volume of water: only its top shows; sunk in a pit, its top level with the floor' },
  func_ladder: { label: 'Ladder volume', trigger: true, help: 'climbable: put it against a wall with the Ladder texture' },
  func_buyzone: { label: 'Buy zone', keys: { team: '1' }, trigger: true, help: 'team: 1 Terrorists, 2 Counter-Terrorists' },
  func_bomb_target: { label: 'Bomb site', trigger: true, help: 'the first is site A, the second B' },
  func_hostage_rescue: { label: 'Rescue zone', trigger: true },
};

// Point kinds: label, short mark for the 2D views.
export const POINTS = {
  info_player_deathmatch: { label: 'T spawn', mark: 'T' },
  info_player_start: { label: 'CT spawn', mark: 'CT' },
  hostage_entity: { label: 'Hostage', mark: 'H' },
};

export const LIMITS = { coord: 8192, brushes: 3000, points: 256 };
const HULL = [16, 16, 36]; // standing player: half extents (the origin is the hull center)

// A brush with the shape fields filled in.
export function makeBrush(id, b, tex, kind = 'world', keys = {}, shape = {}) {
  return { id, b, tex, kind, keys, shape: 'box', yaw: 0, up: 'px', sides: 8, step: 16, ...shape };
}

// A starter map: a sand yard walled in, crates, both spawns with buy zones.
export function newProject(name = 'my_map') {
  const p = { format: FORMAT, version: VERSION, name, brushes: [], points: [], nextId: 1 };
  const add = (b, tex, kind = 'world', keys = {}) => p.brushes.push(makeBrush(p.nextId++, b, tex, kind, keys));
  const wall = { top: 'cssandwallbta', bottom: 'cssandwallbta', side: 'cssandwallbta' };
  add([-1024, -768, -32, 1024, 768, 0], { top: '-0sand', bottom: 'azwall_a', side: 'azwall_a' });
  add([-1056, -800, -32, -1024, 800, 192], wall);
  add([1024, -800, -32, 1056, 800, 192], wall);
  add([-1024, -800, -32, 1024, -768, 192], wall);
  add([-1024, 768, -32, 1024, 800, 192], wall);
  const crate = { top: 'crate08', bottom: 'crate08', side: 'crate08' };
  add([-96, -96, 0, -32, -32, 64], crate);
  add([-32, -96, 0, 32, -32, 64], crate);
  add([-64, -96, 64, 0, -32, 128], crate);
  add([160, 200, 0, 256, 296, 96], crate);
  add([-960, -704, 0, -640, 704, 128], { ...NONE }, 'func_buyzone', { team: '1' });
  add([640, -704, 0, 960, 704, 128], { ...NONE }, 'func_buyzone', { team: '2' });
  for (let k = 0; k < 5; k++) {
    p.points.push({ id: p.nextId++, kind: 'info_player_deathmatch', o: [-864, -256 + k * 128, 0], yaw: 0 });
    p.points.push({ id: p.nextId++, kind: 'info_player_start', o: [864, -256 + k * 128, 0], yaw: 180 });
  }
  return p;
}

// A project read from JSON: checked and normalized, or throws why not.
export function readProject(text) {
  const p = typeof text === 'string' ? JSON.parse(text) : text;
  if (!p || p.format !== FORMAT) throw new Error('not a ComicStrike map project');
  if (p.version > VERSION) throw new Error('made by a newer editor');
  const num = (x) => (Number.isFinite(+x) ? Math.round(+x) : 0);
  const out = { format: FORMAT, version: VERSION, name: String(p.name || 'my_map').replace(/[^\w-]/g, '_').slice(0, 31) || 'my_map',
    brushes: [], points: [], nextId: 1 };
  for (const b of Array.isArray(p.brushes) ? p.brushes : []) {
    const kind = KINDS[b.kind] ? b.kind : 'world';
    const tex = {};
    for (const s of ['top', 'bottom', 'side']) tex[s] = b.tex && TEXTURE_SIZE.has(b.tex[s]) ? b.tex[s] : null;
    const keys = {};
    for (const [k, v] of Object.entries(b.keys || {})) if (/^\w{1,32}$/.test(k)) keys[k] = String(v).replace(/"/g, "'").slice(0, 128);
    out.brushes.push(makeBrush(out.nextId++, (b.b || []).slice(0, 6).map(num), tex, kind, keys, {
      shape: SHAPES[b.shape] ? b.shape : 'box', yaw: num(b.yaw) % 360, up: UPS.includes(b.up) ? b.up : 'px',
      sides: SIDE_COUNTS.includes(+b.sides) ? +b.sides : 8, step: Math.max(4, Math.min(64, num(b.step) || 16)),
    }));
  }
  for (const q of Array.isArray(p.points) ? p.points : []) {
    if (!POINTS[q.kind]) continue;
    out.points.push({ id: out.nextId++, kind: q.kind, o: (q.o || []).slice(0, 3).map(num), yaw: num(q.yaw) % 360 });
  }
  return out;
}

// The brushes a project brush compiles to: [{ brush (shared/bspwriter.js), kind, keys }].
// Zones and volumes stay boxes; a ladder is its board (world) and its climbable volume.
export function piecesOf(br) {
  const kind = KINDS[br.kind];
  const keys = br.keys;
  const [x0, y0, z0, x1, y1, z1] = br.b;
  if (kind.trigger) return [{ brush: box(...br.b, { ...NONE }), kind: br.kind, keys }];
  const tex = kind.water ? { top: br.tex.top || '!watergreen', bottom: null, side: null } : br.tex;
  const one = (brush) => [{ brush, kind: br.kind, keys }];
  const up = br.up || 'px', yaw = br.yaw || 0;
  const along = up === 'px' || up === 'nx' ? 0 : 1, high = up[0] === 'p'; // the axis it rises along
  switch (br.shape) {
    case 'ramp':
      return one(wedge(br.b, up, tex));
    case 'pillar':
      return one(prism(br.b, br.sides || 8, yaw, tex));
    case 'stairs': {
      // Each step reaches from its front edge to the high end (overlaps compile away).
      const n = Math.max(1, Math.round((z1 - z0) / (br.step || 16))), lo = br.b[along], hi = br.b[along + 3];
      const out = [];
      for (let i = 0; i < n; i++) {
        const b = br.b.slice();
        if (high) b[along] = Math.round(lo + (hi - lo) * i / n);
        else b[along + 3] = Math.round(lo + (hi - lo) * (n - i) / n);
        b[5] = Math.round(z0 + (z1 - z0) * (i + 1) / n);
        out.push({ brush: box(...b, tex), kind: br.kind, keys });
      }
      return out;
    }
    case 'ladder': {
      // The board: 4 thick against the wall on side `up`, the ladder texture facing the room;
      // the volume: the rest in front of it, 16 higher than the board (to climb off the top).
      const board = br.b.slice(), vol = br.b.slice();
      if (high) {
        board[along] = br.b[along + 3] - 4;
        vol[along + 3] = board[along];
      } else {
        board[along + 3] = br.b[along] + 4;
        vol[along] = board[along + 3];
      }
      vol[5] += 16;
      const face = { top: null, bottom: null, side: '{ladder1', [up]: null };
      return [{ brush: box(...board, face), kind: 'world', keys: {} },
        { brush: box(...vol, { ...NONE }), kind: 'func_ladder', keys: {} }];
    }
    default:
      return one(yaw % 360 ? turnedBox(br.b, yaw, tex) : box(x0, y0, z0, x1, y1, z1, tex));
  }
}

// A piece's corners (for the views, bounds and checks).
export const cornersOf = (piece) => brushPolygons(brushPlanes(piece.brush)).flat();

// A ramp's slope in degrees.
export function slopeOf(br) {
  const along = br.up === 'px' || br.up === 'nx' ? 0 : 1;
  return Math.atan2(br.b[5] - br.b[2], br.b[along + 3] - br.b[along]) * 180 / Math.PI;
}

// Is a standing player's hull with its center at c inside the piece? (The brush grown by
// the hull, with axial bevels: as the compiler does it for collision.)
function hullInside(piece, c) {
  const ps = brushPlanes(piece.brush), corners = cornersOf(piece);
  if (!corners.length) return false;
  const reach = (n) => HULL[0] * Math.abs(n[0]) + HULL[1] * Math.abs(n[1]) + HULL[2] * Math.abs(n[2]);
  for (const p of ps) if (p.n[0] * c[0] + p.n[1] * c[1] + p.n[2] * c[2] >= p.d + reach(p.n) - 0.5) return false;
  for (let k = 0; k < 3; k++) {
    let lo = Infinity, hi = -Infinity;
    for (const v of corners) {
      lo = Math.min(lo, v[k]);
      hi = Math.max(hi, v[k]);
    }
    if (c[k] <= lo - HULL[k] + 0.5 || c[k] >= hi + HULL[k] - 0.5) return false;
  }
  return true;
}

// Problems that keep the map from compiling or playing: { errors, warnings } of
// { text, id? } (id: the brush or point at fault).
export function checkProject(p) {
  const errors = [], warnings = [];
  if (!p.brushes.some((b) => b.kind === 'world')) errors.push({ text: 'The map has no solid shapes.' });
  if (p.brushes.length > LIMITS.brushes) errors.push({ text: `Too many shapes (${LIMITS.brushes} at most).` });
  if (p.points.length > LIMITS.points) errors.push({ text: `Too many points (${LIMITS.points} at most).` });
  const valid = [];
  for (const b of p.brushes) {
    const [x0, y0, z0, x1, y1, z1] = b.b;
    if (b.b.length !== 6 || !(x1 > x0 && y1 > y0 && z1 > z0)) errors.push({ text: 'A shape has no volume.', id: b.id });
    else if (b.b.some((v) => Math.abs(v) > LIMITS.coord)) errors.push({ text: `A shape is beyond ±${LIMITS.coord}.`, id: b.id });
    else {
      valid.push(b);
      if (b.shape === 'ramp' && slopeOf(b) > MAX_SLOPE + 0.5) {
        warnings.push({ text: `A ramp is ${Math.round(slopeOf(b))}° steep: players slide off above ${MAX_SLOPE}°.`, id: b.id });
      } else if (b.shape === 'stairs') {
        const n = Math.max(1, Math.round((z1 - z0) / b.step)), h = Math.round((z1 - z0) / n);
        if (h > MAX_STEP) warnings.push({ text: `Stairs with ${h} high steps need a jump (${MAX_STEP} at most).`, id: b.id });
      }
    }
  }
  const t = p.points.filter((q) => q.kind === 'info_player_deathmatch').length;
  const ct = p.points.filter((q) => q.kind === 'info_player_start').length;
  if (!t) errors.push({ text: 'No T spawn: add one with the T spawn tool.' });
  if (!ct) errors.push({ text: 'No CT spawn: add one with the CT spawn tool.' });
  if (t && t < 5) warnings.push({ text: `Only ${t} T spawn${t > 1 ? 's' : ''}: a full team needs 5.` });
  if (ct && ct < 5) warnings.push({ text: `Only ${ct} CT spawn${ct > 1 ? 's' : ''}: a full team needs 5.` });
  const solids = valid.filter((b) => !KINDS[b.kind].water).flatMap(piecesOf).filter((pc) => !KINDS[pc.kind].trigger);
  for (const q of p.points) {
    const [x, y, z] = q.o;
    if (q.o.some((v) => Math.abs(v) > LIMITS.coord)) {
      errors.push({ text: `A ${POINTS[q.kind].label} is beyond ±${LIMITS.coord}.`, id: q.id });
      continue;
    }
    if (q.kind === 'hostage_entity') continue;
    // The standing hull (center 37 over the feet) must be free, and a floor within 64 under it.
    if (solids.some((pc) => hullInside(pc, [x, y, z + 37]))) {
      errors.push({ text: `A ${POINTS[q.kind].label} is inside a shape.`, id: q.id });
    } else if (![8, 16, 32, 48, 64].some((dz) => solids.some((pc) => hullInside(pc, [x, y, z + 37 - dz])))) {
      warnings.push({ text: `A ${POINTS[q.kind].label} has no floor under it: players fall at spawn.`, id: q.id });
    }
  }
  const sites = p.brushes.filter((b) => b.kind === 'func_bomb_target').length;
  if (sites > 2) warnings.push({ text: 'More than two bomb sites: only A and B have names.' });
  for (const b of p.brushes) {
    if (b.kind === 'func_button' && b.keys.target && !p.brushes.some((d) => d.keys.targetname === b.keys.target)) {
      warnings.push({ text: `A button targets "${b.keys.target}", which no door is named.`, id: b.id });
    }
  }
  return { errors, warnings };
}

// The bounds of everything in the project (turned shapes by their corners):
// [x0, y0, z0, x1, y1, z1].
export function bounds(p) {
  const c = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const grow = (x, y, z) => {
    c[0] = Math.min(c[0], x);
    c[1] = Math.min(c[1], y);
    c[2] = Math.min(c[2], z);
    c[3] = Math.max(c[3], x);
    c[4] = Math.max(c[4], y);
    c[5] = Math.max(c[5], z);
  };
  for (const b of p.brushes) {
    grow(b.b[0], b.b[1], b.b[2]);
    grow(b.b[3], b.b[4], b.b[5]);
    if (b.yaw % 360 && SHAPES[b.shape]?.turns) for (const pc of piecesOf(b)) for (const v of cornersOf(pc)) grow(...v);
  }
  for (const q of p.points) {
    grow(q.o[0] - 16, q.o[1] - 16, q.o[2]);
    grow(q.o[0] + 16, q.o[1] + 16, q.o[2] + 72);
  }
  return c[0] === Infinity ? [0, 0, 0, 0, 0, 0] : c.map((v, k) => (k < 3 ? Math.floor(v) : Math.ceil(v)));
}

// The project as a map for the compiler (a MapBuilder), closed in a sky box.
export function projectToBuilder(p) {
  const used = new Set(['sky', '{ladder1']);
  for (const b of p.brushes) for (const s of ['top', 'bottom', 'side']) if (b.tex[s]) used.add(b.tex[s]);
  const textures = {};
  for (const [name, w, h] of TEXTURES) if (used.has(name)) textures[name] = [w, h];
  const map = new MapBuilder(textures, { wad: '', mapversion: '220', skyname: 'desert', message: p.name });

  // The sky box: 32 thick, 64 out from everything, 256 over the highest point.
  const [x0, y0, z0, x1, y1, z1] = bounds(p);
  const X0 = x0 - 64, Y0 = y0 - 64, Z0 = z0 - 64, X1 = x1 + 64, Y1 = y1 + 64, Z1 = z1 + 256, T = 32;
  map.world.push(
    box(X0 - T, Y0 - T, Z0 - T, X1 + T, Y1 + T, Z0, 'sky'), box(X0 - T, Y0 - T, Z1, X1 + T, Y1 + T, Z1 + T, 'sky'),
    box(X0 - T, Y0 - T, Z0, X0, Y1 + T, Z1, 'sky'), box(X1, Y0 - T, Z0, X1 + T, Y1 + T, Z1, 'sky'),
    box(X0, Y0 - T, Z0, X1, Y0, Z1, 'sky'), box(X0, Y1, Z0, X1, Y1 + T, Z1, 'sky'),
  );

  for (const b of p.brushes) {
    const pieces = piecesOf(b);
    for (const pc of pieces) if (pc.kind === 'world') map.world.push(pc.brush);
    // An entity shape is one entity (stairs that are a breakable break as one).
    const byKind = new Map();
    for (const pc of pieces) {
      if (pc.kind === 'world') continue;
      if (!byKind.has(pc.kind)) byKind.set(pc.kind, []);
      byKind.get(pc.kind).push(pc);
    }
    for (const [cls, list] of byKind) {
      const keys = { classname: cls };
      for (const [k, v] of Object.entries(list[0].keys)) if (v !== '' && k !== 'hinge') keys[k] = v;
      if (cls === 'func_door_rotating') keys.origin = hingeOf(b).join(' ');
      if (cls === 'func_water') Object.assign(keys, { skin: '-3', WaveHeight: '0' });
      map.brushEntity(keys, list.map((pc) => pc.brush), KINDS[cls].water ? { contents: CONTENTS_WATER } : {});
    }
  }
  for (const q of p.points) {
    const [x, y, z] = q.o;
    // Spawns are hull centers a unit over the floor; hostages stand on their feet.
    const oz = q.kind === 'hostage_entity' ? z : z + 37;
    map.point({ classname: q.kind, origin: `${x} ${y} ${oz}`, angles: `0 ${q.yaw} 0` });
  }
  return map;
}

// A swinging door's hinge: at one end of its long side, mid-thickness, mid-height.
export function hingeOf(b) {
  const [x0, y0, z0, x1, y1, z1] = b.b;
  const end = b.keys.hinge === 'end';
  const zc = (z0 + z1) / 2;
  if (x1 - x0 >= y1 - y0) return [end ? x1 : x0, (y0 + y1) / 2, zc];
  return [(x0 + x1) / 2, end ? y1 : y0, zc];
}

// The compiled map: { bytes, stats } (throws when the project has errors).
export function compileProject(p, light = 'full') {
  const { errors } = checkProject(p);
  if (errors.length) throw new Error(errors[0].text);
  return projectToBuilder(p).compile({ light });
}
