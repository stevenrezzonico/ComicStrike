// The frame's clock, set by main once a frame (draw) and read by the modules that animate
// by it: a double handed to a function the optimizer does not inline is a new heap number
// at every call (see CLAUDE.md, Performance, The garbage); a field is written in place.
export const clock = {
  t: -0, // seconds (performance.now() / 1000); -0: a double from the start
};
