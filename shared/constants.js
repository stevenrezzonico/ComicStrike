// Values shared by client and server.

export const TICK_RATE = 64;
export const TICK_DT = 1 / TICK_RATE;

// Button bits (GoldSrc/Source in_buttons layout).
export const IN_ATTACK = 1 << 0;
export const IN_JUMP = 1 << 1;
export const IN_DUCK = 1 << 2;
export const IN_FORWARD = 1 << 3;
export const IN_BACK = 1 << 4;
export const IN_USE = 1 << 5;
export const IN_MOVELEFT = 1 << 9;
export const IN_MOVERIGHT = 1 << 10;
export const IN_ATTACK2 = 1 << 11;
export const IN_RELOAD = 1 << 13;
export const IN_SCORE = 1 << 15;
export const IN_SPEED = 1 << 17; // walk (shift)
