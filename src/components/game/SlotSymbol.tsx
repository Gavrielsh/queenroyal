import type { CSSProperties, ReactElement } from "react";

/**
 * Reel art for the engine's symbol ids. The id is the audit record (it is written into the
 * ledger transaction's metadata); the drawing is pure decoration. An unmapped id renders a
 * neutral "?" token rather than throwing — a new symbol shipped by the engine must never
 * break the window that has to display it.
 */
const ART: Readonly<Record<string, ReactElement>> = {
  CHERRY: (
    <>
      <path d="M36 60C40 38 52 22 72 14M64 62C62 44 64 28 72 14" stroke="#2F9E4F" strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M72 14c8-6 20-2 22 6-10 4-18 2-22-6z" fill="#3BE39B" />
      <circle cx="34" cy="70" r="20" fill="#E0114F" />
      <circle cx="66" cy="72" r="20" fill="#FF2E63" />
      <ellipse cx="27" cy="62" rx="6" ry="4" fill="#fff" opacity=".6" />
      <ellipse cx="59" cy="64" rx="6" ry="4" fill="#fff" opacity=".6" />
    </>
  ),
  LEMON: (
    <>
      <ellipse cx="50" cy="54" rx="36" ry="28" fill="#FFD43B" stroke="#E0A800" strokeWidth="3" transform="rotate(-20 50 54)" />
      <path d="M14 66l-6 4M86 42l6-4" stroke="#E0A800" strokeWidth="5" strokeLinecap="round" />
      <path d="M72 22c6-8 16-8 20-2-6 5-14 6-20 2z" fill="#3BE39B" />
      <ellipse cx="38" cy="44" rx="10" ry="5" fill="#fff" opacity=".55" transform="rotate(-20 38 44)" />
    </>
  ),
  BELL: (
    <>
      <path d="M50 12c-18 0-28 14-28 34 0 14-6 22-12 28h80c-6-6-12-14-12-28 0-20-10-34-28-34z" fill="#FFC83D" stroke="#E08E0B" strokeWidth="3" />
      <circle cx="50" cy="82" r="9" fill="#E08E0B" />
      <rect x="44" y="4" width="12" height="10" rx="4" fill="#E08E0B" />
      <path d="M34 34c0-8 4-12 10-14" stroke="#fff" strokeWidth="5" fill="none" strokeLinecap="round" opacity=".7" />
    </>
  ),
  DIAMOND: (
    <>
      <path d="M26 18h48l20 26-44 46L6 44z" fill="#67E8F9" />
      <path d="M6 44h88L50 90z" fill="#22D3EE" />
      <path d="M26 18l12 26 12-26 12 26 12-26M38 44l12 46 12-46" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth="2" />
      <path d="M28 24l6 12" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
    </>
  ),
  SEVEN: (
    <path
      d="M22 14h58v14L50 88H33l28-58H22z"
      fill="#FF2E63"
      stroke="#fff"
      strokeWidth="5"
      strokeLinejoin="round"
      paintOrder="stroke"
    />
  ),
  CROWN: (
    <>
      <path d="M12 38l20 18 18-32 18 32 20-18-8 50H20z" fill="#E08E0B" />
      <path d="M12 34l20 18 18-32 18 32 20-18-8 50H20z" fill="#FFC83D" />
      <rect x="18" y="78" width="64" height="12" rx="6" fill="#F2A60C" />
      <circle cx="50" cy="62" r="8" fill="#FF4FA3" stroke="#fff" strokeWidth="2" />
      <circle cx="30" cy="66" r="5" fill="#7C3AED" />
      <circle cx="70" cy="66" r="5" fill="#3BE39B" />
    </>
  ),
};

const UNKNOWN: ReactElement = (
  <>
    <circle cx="50" cy="50" r="38" fill="#3a1c72" stroke="#a08cd0" strokeWidth="4" />
    <path d="M38 40a12 12 0 1 1 18 10c-4 2-6 5-6 9" fill="none" stroke="#f7f3ff" strokeWidth="7" strokeLinecap="round" />
    <circle cx="50" cy="72" r="4.5" fill="#f7f3ff" />
  </>
);

export function SlotSymbol({
  symbol,
  className,
  style,
}: {
  symbol: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg viewBox="0 0 100 100" className={className} style={style} aria-hidden="true" focusable="false">
      {ART[symbol] ?? UNKNOWN}
    </svg>
  );
}
