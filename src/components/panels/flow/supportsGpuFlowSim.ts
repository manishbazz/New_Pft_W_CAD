"use client";

/**
 * Checks whether this browser can actually run the WebGL2 flow sim backend
 * — done on a disposable, never-attached canvas. Important: once
 * getContext('webgl2') is called on a canvas element, that element can
 * NEVER get a 2D context afterward. So we must never test on the real
 * canvas — only commit to WebGL2 on it once we already know it'll work.
 */
export function supportsGpuFlowSim(): boolean {
  if (typeof document === "undefined") return false;

  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    if (!gl) return false;

    // Rendering to floating-point color attachments (our ping-pong sim
    // textures) needs this — without it we can create float textures but
    // can't use them as framebuffer targets.
    const ext = gl.getExtension("EXT_color_buffer_float");
    if (!ext) return false;

    // Confirm a representative format is actually framebuffer-complete
    // before trusting it, rather than just assuming the extension implies
    // every format works everywhere.
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG16F,
      4,
      4,
      0,
      gl.RG,
      gl.HALF_FLOAT,
      null,
    );
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);

    return status === gl.FRAMEBUFFER_COMPLETE;
  } catch {
    return false;
  }
}
