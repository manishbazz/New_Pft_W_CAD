"use client";

import { useEffect, useRef } from "react";

type Particle = {
  x: number; // normalized 0..1
  y: number;
  vx: number;
  vy: number;
  size: number;
  baseAlpha: number;
  phase: number;
};

const PARTICLE_COUNT = 46;
const PARTICLE_RGB = "143, 163, 176"; // matches --accent

function createParticles(): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, () => ({
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * 0.0035,
    vy: -0.002 - Math.random() * 0.003, // gentle upward drift
    size: 0.6 + Math.random() * 1.8,
    baseAlpha: 0.15 + Math.random() * 0.35,
    phase: Math.random() * Math.PI * 2,
  }));
}

export function HomeParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const particles = createParticles();
    let rafId = 0;
    let start = performance.now();

    const render = (now: number) => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, width, height);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        // wrap around edges
        if (p.x < -0.05) p.x = 1.05;
        if (p.x > 1.05) p.x = -0.05;
        if (p.y < -0.05) p.y = 1.05;
        if (p.y > 1.05) p.y = -0.05;

        const pulse = 0.75 + 0.25 * Math.sin(elapsed / 1400 + p.phase);
        const alpha = p.baseAlpha * pulse;

        ctx.beginPath();
        ctx.fillStyle = `rgba(${PARTICLE_RGB}, ${alpha})`;
        ctx.arc(p.x * width, p.y * height, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      rafId = requestAnimationFrame(render);
    };
    rafId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="animate-particles-fade-in pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
