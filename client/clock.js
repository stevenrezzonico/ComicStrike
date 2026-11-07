// The frame's clock, set by main once a frame (draw) and read by the modules that animate
// by it: a double handed to a function the optimizer does not inline is a new heap number
// at every call (see CLAUDE.md, Performance, The garbage); a field is written in place.
export const clock = {
  t: -0, // seconds (performance.now() / 1000); -0: a double from the start
  // The effects' clock (seconds): the explosions, debris and the bomb's victims run on it,
  // `rate` times as fast as real time (slowed for the bomb: client/bombfx.js).
  fx: -0,
  rate: -0, // (set by draw before anything reads it; -0: a double field)
};
