// Weapons lying on the ground (dropped with G, on death, or when a purchase replaces
// them), as flat preallocated arrays. The server owns them (server/game.js) and sends
// the list in S2C_ITEMS; the client draws them (client/gl/playermodels.js). The C4 is
// not an item: it has its own bomb state (shared/bomb.js).

export const MAX_ITEMS = 48; // the oldest goes when a new one needs room

export class Items {
  constructor() {
    this.count = 0;
    this.id = new Uint16Array(MAX_ITEMS); // unique per drop (wraps), for clients to track
    this.weapon = new Uint8Array(MAX_ITEMS);
    this.clip = new Uint16Array(MAX_ITEMS);
    this.reserve = new Uint16Array(MAX_ITEMS);
    this.x = new Float32Array(MAX_ITEMS);
    this.y = new Float32Array(MAX_ITEMS);
    this.z = new Float32Array(MAX_ITEMS); // the floor under it
    this.yaw = new Float32Array(MAX_ITEMS); // degrees
    this.pickupTick = new Int32Array(MAX_ITEMS); // no pickup before this server tick
    this.nextId = 1;
  }

  clear() {
    this.count = 0;
  }

  // Adds a weapon; returns its index.
  add(weapon, clip, reserve, x, y, z, yaw, pickupTick = 0) {
    if (this.count === MAX_ITEMS) this.remove(0);
    const i = this.count++;
    this.id[i] = this.nextId;
    this.nextId = (this.nextId + 1) & 0xffff || 1;
    this.weapon[i] = weapon;
    this.clip[i] = clip;
    this.reserve[i] = reserve;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.yaw[i] = yaw;
    this.pickupTick[i] = pickupTick;
    return i;
  }

  // Removes item i, keeping the rest in drop order (oldest first).
  remove(i) {
    for (const a of [this.id, this.weapon, this.clip, this.reserve, this.x, this.y, this.z, this.yaw, this.pickupTick]) {
      a.copyWithin(i, i + 1, this.count);
    }
    this.count--;
  }
}
