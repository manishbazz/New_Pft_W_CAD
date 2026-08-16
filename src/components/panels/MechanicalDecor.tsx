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

/** Floating gears + faint CFD equations, purely decorative background texture. */
export function MechanicalDecor() {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden text-[var(--border)]"
      aria-hidden
    >
      <Gear
        size={180}
        teeth={12}
        className="animate-spin-slow absolute -top-10 -right-10 opacity-25"
      />
      <Gear
        size={110}
        teeth={8}
        className="animate-spin-slow-reverse absolute top-24 -right-2 opacity-20"
      />
      <Gear
        size={140}
        teeth={10}
        className="animate-spin-slow-reverse absolute -bottom-8 -left-10 opacity-20"
      />
      <Gear
        size={70}
        teeth={8}
        className="animate-spin-slow absolute bottom-32 left-16 opacity-15"
      />

      <p className="absolute top-1/3 left-1/2 hidden -translate-x-1/2 rotate-[-6deg] font-mono text-sm tracking-wide text-[var(--border)] opacity-30 sm:block">
        ∂u/∂t + (u·∇)u = −∇p/ρ + ν∇²u
      </p>
      <p className="absolute bottom-20 left-1/2 hidden -translate-x-1/2 rotate-[4deg] font-mono text-xs tracking-wide text-[var(--border)] opacity-25 sm:block">
        ∇·u = 0
      </p>
    </div>
  );
}
