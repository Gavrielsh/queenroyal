import { useId, type ReactElement } from "react";

/**
 * The "candy" icon set: small glossy illustrations used on buttons, chips and cards.
 *
 * Pure decoration: every icon is `aria-hidden` unless a `title` is passed, and none of them
 * carries information the adjacent text does not. Gradient ids come from `useId`, so two
 * copies of the same icon on one page never share (or break) each other's gradients.
 */
export type CandyIconName =
  | "crown"
  | "coin"
  | "sc"
  | "trophy"
  | "gift"
  | "stack"
  | "slot"
  | "gem"
  | "wheel"
  | "chest"
  | "fire";

export interface CandyIconProps {
  name: CandyIconName;
  className?: string;
  /** Accessible name. Omit for decorative use (the default). */
  title?: string;
}

type Paint = (id: (suffix: string) => string) => ReactElement;

const GOLD = ["#FFE9A0", "#F2A60C"] as const;

function Linear({ id, from, to }: { id: string; from: string; to: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={from} />
      <stop offset="1" stopColor={to} />
    </linearGradient>
  );
}

const ICONS: Readonly<Record<CandyIconName, Paint>> = {
  crown: (id) => (
    <>
      <defs>
        <Linear id={id("g")} from="#FFE58F" to="#F29F05" />
      </defs>
      <path d="M5 16l8 7 7-13 7 13 8-7-3 19H8z" fill="#C97A04" />
      <path d="M5 14l8 7 7-13 7 13 8-7-3 19H8z" fill={`url(#${id("g")})`} />
      <rect x="8" y="31" width="24" height="5" rx="2.5" fill="#E08E0B" />
      <circle cx="20" cy="24" r="3.2" fill="#FF4FA3" />
      <circle cx="12.5" cy="26" r="2.3" fill="#7C3AED" />
      <circle cx="27.5" cy="26" r="2.3" fill="#3BE39B" />
      <circle cx="5" cy="14" r="2.6" fill="#FFE58F" />
      <circle cx="20" cy="8" r="2.6" fill="#FFE58F" />
      <circle cx="35" cy="14" r="2.6" fill="#FFE58F" />
    </>
  ),
  coin: (id) => (
    <>
      <defs>
        <Linear id={id("g")} from={GOLD[0]} to={GOLD[1]} />
      </defs>
      <circle cx="20" cy="21" r="17" fill="#C77A06" />
      <circle cx="20" cy="19" r="17" fill={`url(#${id("g")})`} />
      <circle cx="20" cy="19" r="12" fill="none" stroke="#C77A06" strokeWidth="2.5" opacity=".6" />
      <path d="M13 22l2-8 5 4 5-4 2 8z" fill="#C77A06" />
      <ellipse cx="13" cy="11" rx="5" ry="2.5" fill="#fff" opacity=".55" transform="rotate(-30 13 11)" />
    </>
  ),
  sc: (id) => (
    <>
      <defs>
        <Linear id={id("g")} from="#A6FFD6" to="#1FBF7A" />
      </defs>
      <circle cx="20" cy="21" r="17" fill="#128A56" />
      <circle cx="20" cy="19" r="17" fill={`url(#${id("g")})`} />
      <circle cx="20" cy="19" r="12" fill="none" stroke="#128A56" strokeWidth="2.5" opacity=".55" />
      <path
        d="M24.5 14.5c-1-1.5-2.8-2.3-4.7-2.3-2.8 0-4.6 1.4-4.6 3.4 0 4.8 9.8 2.6 9.8 7.3 0 2.1-2 3.6-5 3.6-2.2 0-4-.9-5.1-2.4"
        fill="none"
        stroke="#0B5C39"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <ellipse cx="13" cy="11" rx="5" ry="2.5" fill="#fff" opacity=".6" transform="rotate(-30 13 11)" />
    </>
  ),
  trophy: (id) => (
    <>
      <defs>
        <Linear id={id("g")} from="#FFE58F" to="#F29F05" />
      </defs>
      <path d="M11 9H5c0 7 3 10 8 10M29 9h6c0 7-3 10-8 10" fill="none" stroke="#E08E0B" strokeWidth="3" />
      <path d="M10 5h20v8c0 7-4 11-10 11S10 20 10 13z" fill={`url(#${id("g")})`} />
      <rect x="17" y="23" width="6" height="6" fill="#E08E0B" />
      <rect x="11" y="29" width="18" height="7" rx="2" fill="#7C3AED" />
      <rect x="14" y="31" width="12" height="2" rx="1" fill="#C4B5FD" />
      <path d="M20 9l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z" fill="#fff" opacity=".9" />
    </>
  ),
  gift: (id) => (
    <>
      <defs>
        <Linear id={id("box")} from="#FF8CC6" to="#E0247F" />
        <Linear id={id("rib")} from="#FFE58F" to="#F2A60C" />
      </defs>
      <rect x="6" y="17" width="28" height="19" rx="4" fill={`url(#${id("box")})`} />
      <rect x="4" y="12" width="32" height="8" rx="3" fill="#FF5FAE" />
      <rect x="17" y="12" width="6" height="24" fill={`url(#${id("rib")})`} />
      <path
        d="M20 12c-3-7-11-7-10-2 1 3 7 2 10 2zm0 0c3-7 11-7 10-2-1 3-7 2-10 2z"
        fill={`url(#${id("rib")})`}
        stroke="#E08E0B"
      />
    </>
  ),
  stack: (id) => (
    <>
      <defs>
        <Linear id={id("g")} from={GOLD[0]} to={GOLD[1]} />
      </defs>
      {[30, 24, 18, 12].map((y) => (
        <g key={y}>
          <ellipse cx="20" cy={y + 3} rx="13" ry="5" fill="#C77A06" />
          <ellipse cx="20" cy={y} rx="13" ry="5" fill={`url(#${id("g")})`} stroke="#C77A06" />
        </g>
      ))}
      <path d="M33 4l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" fill="#fff" />
    </>
  ),
  slot: (id) => (
    <>
      <defs>
        <Linear id={id("g")} from="#C4B5FD" to="#7C3AED" />
      </defs>
      <rect x="4" y="8" width="28" height="28" rx="6" fill={`url(#${id("g")})`} />
      <rect x="8" y="14" width="20" height="12" rx="3" fill="#fff" />
      <path d="M10.5 17h4l-2.5 6M16 17h4l-2.5 6M21.5 17h4l-2.5 6" fill="none" stroke="#FF4FA3" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M32 22h3V10" stroke="#C4B5FD" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <circle cx="35" cy="8" r="3.5" fill="#FF4FA3" />
      <rect x="10" y="30" width="16" height="3" rx="1.5" fill="#FFC83D" />
    </>
  ),
  gem: (id) => (
    <>
      <defs>
        <Linear id={id("g")} from="#E9D5FF" to="#9333EA" />
      </defs>
      <path d="M10 6h20l7 10-17 20L3 16z" fill={`url(#${id("g")})`} />
      <path
        d="M3 16h34M10 6l5 10 5-10 5 10 5-10M15 16l5 20 5-20"
        fill="none"
        stroke="#fff"
        strokeOpacity=".55"
        strokeWidth="1.5"
      />
    </>
  ),
  wheel: () => (
    <>
      <circle cx="20" cy="21" r="18" fill="#B86A00" />
      <circle cx="20" cy="20" r="18" fill="#FFC83D" />
      {WHEEL_SLICES.map((slice) => (
        <path key={slice.d} d={slice.d} fill={slice.fill} />
      ))}
      <circle cx="20" cy="20" r="4.5" fill="#fff" stroke="#E08E0B" strokeWidth="2" />
      <path d="M20 1l4 6h-8z" fill="#fff" stroke="#E08E0B" strokeWidth="1.2" />
    </>
  ),
  chest: (id) => (
    <>
      <defs>
        <Linear id={id("wood")} from="#B7793F" to="#7A4516" />
        <Linear id={id("gold")} from="#FFE58F" to="#F2A60C" />
      </defs>
      <path d="M5 17c0-8 30-8 30 0z" fill={`url(#${id("wood")})`} />
      <rect x="5" y="17" width="30" height="18" rx="3" fill={`url(#${id("wood")})`} />
      <rect x="5" y="17" width="30" height="4" fill={`url(#${id("gold")})`} />
      <rect x="17" y="19" width="6" height="8" rx="2" fill={`url(#${id("gold")})`} stroke="#B86A00" />
      <rect x="5" y="31" width="30" height="4" rx="2" fill="#5A3210" />
    </>
  ),
  fire: (id) => (
    <>
      <defs>
        <Linear id={id("g")} from="#FFE066" to="#FF4D2E" />
      </defs>
      <path
        d="M20 3c2 7 11 11 11 21a11 11 0 0 1-22 0c0-6 4-9 5-13 2 3 2 5 4 6 1-5 0-9 2-14z"
        fill={`url(#${id("g")})`}
      />
      <path d="M20 20c1 4 6 5 6 10a6 6 0 0 1-12 0c0-3 3-5 3-8 1 1 2 2 3 2z" fill="#FFF3B0" />
    </>
  ),
};

/** Eight alternating slices for the wheel icon, precomputed once. */
const WHEEL_SLICES = ["#FF4FA3", "#FFC83D", "#7C3AED", "#3BE39B"].flatMap((_, i, colors) =>
  [0, 4].map((offset) => {
    const k = i + offset;
    const a0 = ((k * 45 - 90) * Math.PI) / 180;
    const a1 = (((k + 1) * 45 - 90) * Math.PI) / 180;
    const p = (a: number) => `${(20 + 15 * Math.cos(a)).toFixed(2)} ${(20 + 15 * Math.sin(a)).toFixed(2)}`;
    return { d: `M20 20L${p(a0)}A15 15 0 0 1 ${p(a1)}z`, fill: colors[i] ?? "#FFC83D" };
  }),
);

export function CandyIcon({ name, className, title }: CandyIconProps) {
  const base = useId();
  const id = (suffix: string) => `${base}${name}-${suffix}`.replace(/:/g, "");
  const paint = ICONS[name];
  return (
    <svg
      viewBox="0 0 40 40"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {paint(id)}
    </svg>
  );
}
