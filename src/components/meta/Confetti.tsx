import type { CSSProperties } from "react";

/**
 * A one-shot confetti burst from the centre of its (relative) parent. Deterministic particle
 * layout (derived from the index), CSS-only motion; collapses under reduced motion via the
 * global rule in globals.css.
 */
const COLORS = ["#FFC83D", "#FF4FA3", "#3BE39B", "#A78BFA", "#FFFFFF"] as const;

const PIECES = Array.from({ length: 36 }, (_, i) => {
  const angle = (i / 36) * Math.PI * 2 + (i % 3) * 0.2;
  const distance = 120 + ((i * 37) % 120);
  return {
    x: Math.round(Math.cos(angle) * distance),
    y: Math.round(Math.sin(angle) * distance - 40),
    rotate: (i * 47) % 360,
    color: COLORS[i % COLORS.length],
    round: i % 3 === 0,
    delay: (i % 6) * 0.02,
  };
});

export function Confetti() {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 z-10 block">
      {PIECES.map((piece, i) => (
        <span
          key={i}
          className={`absolute block h-2.5 w-2.5 animate-[qr-confetti_1.1s_cubic-bezier(.2,.8,.3,1)_both] ${
            piece.round ? "rounded-full" : "h-1.5 w-3 rounded-sm"
          }`}
          style={
            {
              backgroundColor: piece.color,
              animationDelay: `${piece.delay}s`,
              "--qr-x": `${piece.x}px`,
              "--qr-y": `${piece.y}px`,
              "--qr-r": `${piece.rotate}deg`,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}
