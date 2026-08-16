"use client";

import type { CSSProperties } from "react";

type GearProps = {
  size: number;
  teeth?: number;
  className?: string;
  style?: CSSProperties;
};

/** Simple line-art gear: outer teeth as rotated rects, two concentric rings. */
function Gear({ size, teeth = 10, className, style }: GearProps) {
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.42;
  const toothLen = size * 0.09;
  const toothW = size * 0.07;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      style={style}
      aria-hidden
    >
      <g fill="none" stroke="currentColor" strokeWidth={Math.max(1, size * 0.012)}>
        <circle cx={cx} cy={cy} r={outerR} />
        <circle cx={cx} cy={cy} r={outerR * 0.45} />
        <circle cx={cx} cy={cy} r={outerR * 0.12} />
        {Array.from({ length: teeth }, (_, i) => {
          const angle = (360 / teeth) * i;
          return (
            <rect
              key={i}
              x={cx - toothW / 2}
              y={cy - outerR - toothLen}
              width={toothW}
              height={toothLen}
              transform={`rotate(${angle} ${cx} ${cy})`}
            />
          );
        })}
      </g>
    </svg>
  );
}

/**
 * Floating gears + CFD equations, purely decorative background texture.
 * Gears stay pinned to two opposite corners (kept well apart from each
 * other and clipped mostly off-canvas) so they never overlap; equations
 * sit in the untouched vertical center band, clear of both corners.
 */
export function MechanicalDecor() {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden text-[var(--border)]"
      aria-hidden
    >
      <Gear
        size={220}
        teeth={12}
        className="animate-spin-slow absolute -top-16 -right-16 opacity-20"
      />
      <Gear
        size={170}
        teeth={10}
        className="animate-spin-slow-reverse absolute -bottom-14 -left-14 opacity-20"
      />

      <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col items-center gap-4 px-4">
        <p className="rotate-[-3deg] text-center font-mono text-xl tracking-wide text-[var(--border)] opacity-45 sm:text-2xl">
          ∂u/∂t + (u·∇)u = −∇p/ρ + ν∇²u
        </p>
        <p className="rotate-[2deg] text-center font-mono text-lg tracking-wide text-[var(--border)] opacity-40 sm:text-xl">
          ∇·u = 0
        </p>
      </div>
    </div>
  );
}
