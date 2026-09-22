/**
 * The QueenRoyal mascot: a cheerful crowned queen holding fans of cash while coins and bills
 * rain around her. Hero art for the landing page.
 *
 * Decorative illustration only — it depicts the brand's mood, not an offer or an amount, so
 * nothing in it can be read as a claim about what a player will win. Motion is CSS (see the
 * `.qr-mascot` rules in globals.css) and collapses under prefers-reduced-motion like every
 * other animation in the app.
 */

const BILLS: ReadonlyArray<{ x: number; rot: number; delay: number; dur: number }> = [
  { x: 60, rot: -20, delay: 0, dur: 4.6 },
  { x: 300, rot: 25, delay: 1.4, dur: 5.2 },
  { x: 110, rot: 40, delay: 2.6, dur: 4.2 },
  { x: 250, rot: -35, delay: 0.8, dur: 5.6 },
];

const COINS: ReadonlyArray<{ x: number; y: number; r: number; delay: number }> = [
  { x: 52, y: 210, r: 15, delay: 0 },
  { x: 314, y: 196, r: 13, delay: 0.6 },
  { x: 80, y: 286, r: 11, delay: 1.1 },
  { x: 290, y: 276, r: 16, delay: 0.3 },
  { x: 40, y: 120, r: 9, delay: 1.5 },
  { x: 326, y: 98, r: 10, delay: 0.9 },
];

const SPARKS: ReadonlyArray<{ x: number; y: number; s: number; delay: number }> = [
  { x: 70, y: 60, s: 10, delay: 0 },
  { x: 300, y: 50, s: 8, delay: 0.5 },
  { x: 330, y: 150, s: 7, delay: 1 },
  { x: 26, y: 170, s: 7, delay: 0.3 },
  { x: 250, y: 20, s: 6, delay: 0.8 },
];

const RAYS = Array.from({ length: 16 }, (_, k) => {
  const a = (k * Math.PI) / 8;
  const b = a + 0.12;
  const p = (t: number) => `${(180 + 300 * Math.cos(t)).toFixed(1)} ${(170 + 300 * Math.sin(t)).toFixed(1)}`;
  return `M180 170 L${p(a)} L${p(b)}z`;
});

function Bill() {
  return (
    <>
      <rect x="-17" y="-9" width="34" height="18" rx="3" fill="#2FB866" />
      <rect x="-14" y="-6" width="28" height="12" rx="2" fill="none" stroke="#C9F7D9" strokeWidth="1.4" />
      <circle r="4.5" fill="#C9F7D9" />
    </>
  );
}

function CashFan({ x, y, rot }: { x: number; y: number; rot: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      {[-28, -10, 8, 26].map((a, i) => (
        <g key={a} transform={`rotate(${a})`}>
          <rect x="-9" y="-40" width="18" height="36" rx="3" fill={i % 2 ? "#35C774" : "#2FB866"} stroke="#1C7A43" strokeWidth="1.2" />
          <rect x="-6" y="-37" width="12" height="30" rx="2" fill="none" stroke="#C9F7D9" strokeWidth="1.2" />
          <circle cy="-22" r="3.8" fill="#C9F7D9" />
        </g>
      ))}
    </g>
  );
}

export function QueenMascot({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 360 320"
      className={`qr-mascot ${className ?? ""}`}
      role="img"
      aria-label="Illustration: a smiling crowned queen holding fans of cash as coins rain down"
    >
      <g className="qr-rays">
        {RAYS.map((d) => (
          <path key={d} d={d} fill="#fff" opacity=".07" />
        ))}
      </g>
      <ellipse cx="180" cy="316" rx="120" ry="14" fill="#14062b" opacity=".45" />

      {BILLS.map((b) => (
        <g key={b.x} className="qr-bill" style={{ animationDelay: `${b.delay}s`, animationDuration: `${b.dur}s` }}>
          <g transform={`translate(${b.x} 0) rotate(${b.rot})`}>
            <Bill />
          </g>
        </g>
      ))}

      <g className="qr-body">
        {/* Dress */}
        <path d="M112 320c4-58 30-100 68-100s64 42 68 100z" fill="#FF4FA3" />
        <path d="M140 320c3-40 18-78 40-78s37 38 40 78z" fill="#FF7AB8" />
        <path d="M150 232c10 10 50 10 60 0" stroke="#FFC83D" strokeWidth="6" fill="none" strokeLinecap="round" />
        <circle cx="180" cy="248" r="6" fill="#FFC83D" />
        <circle cx="180" cy="248" r="3" fill="#7C3AED" />

        {/* Arms raised, each with a fan of bills */}
        <g className="qr-arm-l">
          <path d="M146 214 C126 196 112 170 104 140" stroke="#FF4FA3" strokeWidth="24" fill="none" strokeLinecap="round" />
          <path d="M118 176 C112 162 106 150 104 140" stroke="#F5C19E" strokeWidth="20" fill="none" strokeLinecap="round" />
          <CashFan x={102} y={132} rot={-18} />
          <circle cx="103" cy="137" r="12" fill="#F5C19E" />
        </g>
        <g className="qr-arm-r">
          <path d="M214 214 C234 196 248 170 256 140" stroke="#FF4FA3" strokeWidth="24" fill="none" strokeLinecap="round" />
          <path d="M242 176 C248 162 254 150 256 140" stroke="#F5C19E" strokeWidth="20" fill="none" strokeLinecap="round" />
          <CashFan x={258} y={132} rot={18} />
          <circle cx="257" cy="137" r="12" fill="#F5C19E" />
        </g>

        {/* Neck, hair, face */}
        <rect x="170" y="190" width="20" height="26" rx="8" fill="#E8AE88" />
        <path d="M122 150c0-46 26-72 58-72s58 26 58 72c0 30-12 52-22 62h-72c-10-10-22-32-22-62z" fill="#4B1E6E" />
        <circle cx="180" cy="152" r="44" fill="#F5C19E" />
        <path d="M136 146c4-30 24-44 44-44s40 14 44 44c-12-12-26-18-44-18s-32 6-44 18z" fill="#5B2A86" />
        <path d="M156 118c8 8 20 12 34 10" stroke="#7B45A8" strokeWidth="4" fill="none" strokeLinecap="round" />
        <path d="M157 150q7-9 14 0" stroke="#3B1F4A" strokeWidth="4" fill="none" strokeLinecap="round" />
        <path d="M189 150q7-9 14 0" stroke="#3B1F4A" strokeWidth="4" fill="none" strokeLinecap="round" />
        <ellipse cx="152" cy="166" rx="9" ry="6" fill="#FF8FB1" opacity=".75" />
        <ellipse cx="208" cy="166" rx="9" ry="6" fill="#FF8FB1" opacity=".75" />
        <path d="M163 168q17 22 34 0z" fill="#8A1C44" />
        <path d="M170 176q10 6 20 0q-3 7-10 7t-10-7z" fill="#FF7A9A" />
        <path d="M165 168h30" stroke="#fff" strokeWidth="3" strokeLinecap="round" />

        {/* Crown */}
        <g transform="translate(180 100)">
          <path d="M-34 6l-6-34 20 16 20-30 20 30 20-16-6 34z" fill="#E08E0B" />
          <path d="M-34 2l-6-34 20 16 20-30 20 30 20-16-6 34z" fill="#FFC83D" />
          <rect x="-35" y="-2" width="70" height="10" rx="5" fill="#F2A60C" />
          <circle cx="0" cy="-8" r="6" fill="#FF4FA3" stroke="#fff" strokeWidth="1.5" />
          <circle cx="-20" cy="-4" r="4" fill="#7C3AED" />
          <circle cx="20" cy="-4" r="4" fill="#3BE39B" />
          <circle cx="-40" cy="-32" r="4" fill="#FFE08A" />
          <circle cx="0" cy="-46" r="4" fill="#FFE08A" />
          <circle cx="40" cy="-32" r="4" fill="#FFE08A" />
        </g>
      </g>

      {COINS.map((c) => (
        <g key={`${c.x}-${c.y}`} className="qr-bob" style={{ animationDelay: `${c.delay}s` }}>
          <circle cx={c.x} cy={c.y + 2} r={c.r} fill="#C77A06" />
          <circle cx={c.x} cy={c.y} r={c.r} fill="#FFC83D" stroke="#E08E0B" strokeWidth="1.5" />
          <circle cx={c.x} cy={c.y} r={c.r * 0.62} fill="none" stroke="#E08E0B" strokeWidth="1.5" />
        </g>
      ))}

      {SPARKS.map((p) => (
        <path
          key={`${p.x}-${p.y}`}
          className="qr-twinkle"
          style={{ animationDelay: `${p.delay}s` }}
          d={`M${p.x} ${p.y - p.s}Q${p.x} ${p.y} ${p.x + p.s} ${p.y}Q${p.x} ${p.y} ${p.x} ${p.y + p.s}Q${p.x} ${p.y} ${p.x - p.s} ${p.y}Q${p.x} ${p.y} ${p.x} ${p.y - p.s}z`}
          fill="#FFF3B0"
        />
      ))}
    </svg>
  );
}
