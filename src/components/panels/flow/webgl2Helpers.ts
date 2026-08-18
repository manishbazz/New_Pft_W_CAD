"use client";

/**
 * Shared WebGL2 plumbing for the flow-sim and convection-sim GPU backends:
 * shader compile/link, and ping-pong render targets. Pulled out once a
 * second GPU pipeline (natural convection) needed the same boilerplate.
 */

export type GLProgram = {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  aPosLoc: number;
};

export type GLTarget = {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
};

export type GLDoubleTarget = {
  read: GLTarget;
  write: GLTarget;
  swap: () => void;
};

export const FULLSCREEN_VERT_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Shader compile error:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function createGLProgram(
  gl: WebGL2RenderingContext,
  fragSrc: string,
  uniformNames: string[],
  vertSrc: string = FULLSCREEN_VERT_SRC,
): GLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Program link error:", gl.getProgramInfoLog(program));
    return null;
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniformNames) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms, aPosLoc: gl.getAttribLocation(program, "aPos") };
}

export function createGLTarget(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  internalFormat: number,
  format: number,
): GLTarget | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  if (!fbo) return null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, fbo };
}

export function createGLDoubleTarget(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  internalFormat: number,
  format: number,
): GLDoubleTarget | null {
  const a = createGLTarget(gl, w, h, internalFormat, format);
  const b = createGLTarget(gl, w, h, internalFormat, format);
  if (!a || !b) return null;
  const state: GLDoubleTarget = {
    read: a,
    write: b,
    swap() {
      const tmp = state.read;
      state.read = state.write;
      state.write = tmp;
    },
  };
  return state;
}

export function deleteGLTarget(gl: WebGL2RenderingContext, t: GLTarget | null) {
  if (!t) return;
  gl.deleteTexture(t.texture);
  gl.deleteFramebuffer(t.fbo);
}

export function deleteGLDoubleTarget(gl: WebGL2RenderingContext, t: GLDoubleTarget | null) {
  if (!t) return;
  deleteGLTarget(gl, t.read);
  deleteGLTarget(gl, t.write);
}