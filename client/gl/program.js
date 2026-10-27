// Shader compilation helpers.

function compile(gl, type, src) {
  const sh = gl.createShader(type);
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
