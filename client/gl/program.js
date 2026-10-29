// Shader compilation helpers.

// Lines put after every shader's #version (the G-buffer's DEPTH_PACKED, where half-float
// targets are missing; set by GBuffer before any scene shader compiles).
export const shaderDefines = { prefix: '' };

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  if (shaderDefines.prefix) src = src.replace('#version 300 es\n', `#version 300 es\n${shaderDefines.prefix}`);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed:\n${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

export function program(gl, vs, fs, uniforms) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed:\n${gl.getProgramInfoLog(p)}`);
  }
  const loc = {};
  for (const u of uniforms) loc[u] = gl.getUniformLocation(p, u);
  return { p, loc };
}
