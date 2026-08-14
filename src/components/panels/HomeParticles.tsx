"use client";

import { useEffect, useRef, type RefObject } from "react";

type Particle = {
  x: number; // px, relative to canvas
  y: number;
  vx: number;
  vy: number;
  size: number;
  baseAlpha: number;
  phase: number;
};

const PARTICLE_COUNT = 60;
const PARTICLE_RGB = "143, 163, 176"; // matches --accent
const MARGIN = 46; // how far particles can drift past the text's edges

type Bounds = { x: number; y: number; width: number; height: number };

type HomeParticlesProps = {
  /** Element the particle field should hug (e.g. the name/heading). */
  boundsRef?: RefObject<HTMLElement | null>;
};

function spawnParticle(bounds: Bounds): Particle {
  return {
    x: bounds.x + Math.random() * bounds.width,
    y: bounds.y + Math.random() * bounds.height,
    vx: (Math.random() - 0.5) * 0.045,
    vy: -0.02 - Math.random() * 0.035,
    size: 0.6 + Math.random() * 1.8,
    baseAlpha: 0.18 + Math.random() * 0.4,
    phase: Math.random() * Math.PI * 2,
  };
}

export function HomeParticles({ boundsRef }: HomeParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };

    const measureBounds = () => {
      const target = boundsRef?.current;
      const canvasRect = canvas.getBoundingClientRect();
      if (target) {
        const r = target.getBoundingClientRect();
        bounds = {
          x: r.left - canvasRect.left - MARGIN,
          y: r.top - canvasRect.top - MARGIN,
          width: r.width + MARGIN * 2,
          height: r.height + MARGIN * 2,
        };
      } else {
        bounds = { x: 0, y: 0, width, height };
      }
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      measureBounds();
    };
    resize();
    window.addEventListener("resize", resize);
    // Re-measure shortly after mount too — web fonts loading can shift the
    // text's layout size after the very first measurement.
    const refit = window.setTimeout(measureBounds, 250);

    let particles = Array.from({ length: PARTICLE_COUNT }, () =>
      spawnParticle(bounds),
    );

    let rafId = 0;
    let start = performance.now();

    const render = (now: number) => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, width, height);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;

        const left = bounds.x;
        const right = bounds.x + bounds.width;
        const top = bounds.y;
        const bottom = bounds.y + bounds.height;

        if (p.x < left || p.x > right || p.y < top - 10) {
          Object.assign(p, spawnParticle(bounds), { y: bottom });
        }

        const pulse = 0.75 + 0.25 * Math.sin(elapsed / 1400 + p.phase);
        const alpha = p.baseAlpha * pulse;

        ctx.beginPath();
        ctx.fillStyle = `rgba(${PARTICLE_RGB}, ${alpha})`;
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      rafId = requestAnimationFrame(render);
    };
    rafId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(refit);
      window.removeEventListener("resize", resize);
    };
  }, [boundsRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="animate-particles-fade-in pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
