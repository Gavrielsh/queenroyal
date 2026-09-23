"use client";

import { memo, useEffect, useRef, useState } from "react";

import { CandyIcon } from "@/components/art/CandyIcon";
import { Confetti } from "@/components/meta/Confetti";
import { MetaOverlay, PreviewBadge } from "@/components/meta/MetaOverlay";
import { formatBalance } from "@/lib/format";
import { compactAmount } from "@/lib/meta/compactAmount";
import type { DailyBonusClaim, DailyBonusStatus, WheelSegment } from "@/lib/meta/types";
import { sliceUnderPointer, wheelTargetRotation } from "@/lib/meta/wheel";
import { playSound } from "@/lib/sound";

/**
 * The Daily Wheel modal. The wheel NEVER picks its own slice: `onClaim` asks the server (or,
 * in preview mode, the demo stand-in) for the draw, and the wheel animates to the slice it
 * returned. The prize panel shows that claim's amounts verbatim. In live mode the grant is
 * already in the ledger when the claim resolves — the caller re-reads the wallet; in preview
 * mode nothing is credited and the panel says so.
 */
export interface DailyWheelProps {
  status: DailyBonusStatus;
  onClaim: () => Promise<DailyBonusClaim>;
  onClose: () => void;
  preview: boolean;
}

const SPIN_MS = 5600;
const RADIUS = 146;
const GC_FILLS = ["#7C3AED", "#9D5CFF", "#FF4FA3"] as const;

function point(angle: number, radius: number): string {
  const t = ((angle - 90) * Math.PI) / 180;
  return `${(radius * Math.cos(t)).toFixed(2)} ${(radius * Math.sin(t)).toFixed(2)}`;
}

function sliceLabel(segment: WheelSegment): { big: string; unit: string } {
  const hasGc = segment.gc !== "0";
  const hasSc = segment.sc !== "0";
  if (hasGc && hasSc) return { big: `${compactAmount(segment.gc)}+${compactAmount(segment.sc)}`, unit: "GC+SC" };
  if (hasSc) return { big: compactAmount(segment.sc), unit: "SC" };
  return { big: compactAmount(segment.gc), unit: "GC" };
}

const WheelFace = memo(function WheelFace({ segments }: { segments: readonly WheelSegment[] }) {
  const slice = 360 / segments.length;
  let gcIndex = 0;
  return (
    <svg viewBox="-160 -160 320 320" className="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id="qr-wheel-featured" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE08A" />
          <stop offset="1" stopColor="#F2A60C" />
        </linearGradient>
      </defs>
      <circle r="158" fill="#FFC83D" />
      <circle r="152" fill="#E08E0B" />
      <circle r="150" fill="#fff" />
      {segments.map((segment, i) => {
        const fill = segment.featured
          ? "url(#qr-wheel-featured)"
          : segment.sc !== "0" && segment.gc === "0"
            ? "#1FBF7A"
            : (GC_FILLS[gcIndex++ % GC_FILLS.length] ?? "#7C3AED");
        const ink = segment.featured ? "#7A3A00" : "#fff";
        const label = sliceLabel(segment);
        return (
          <g key={segment.id}>
            <path
              d={`M0 0 L${point(i * slice - slice / 2, RADIUS)} A${RADIUS} ${RADIUS} 0 0 1 ${point(i * slice + slice / 2, RADIUS)} Z`}
              fill={fill}
              stroke="#fff"
              strokeWidth="3"
            />
            <g transform={`rotate(${i * slice})`}>
              <text
                y="-100"
                textAnchor="middle"
                fill={ink}
                fontFamily="var(--font-display)"
                fontWeight="600"
                fontSize={label.big.length > 4 ? 16 : 22}
                stroke="rgba(0,0,0,.18)"
                strokeWidth="3"
                paintOrder="stroke"
              >
                {label.big}
              </text>
              <text y="-82" textAnchor="middle" fill={ink} fontWeight="900" fontSize="11" letterSpacing="1">
                {label.unit}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
});

export function DailyWheel({ status, onClaim, onClose, preview }: DailyWheelProps) {
  const [rotation, setRotation] = useState(0);
  const [phase, setPhase] = useState<"ready" | "spinning" | "won" | "failed">("ready");
  const [claim, setClaim] = useState<DailyBonusClaim | null>(null);
  const [tick, setTick] = useState(0);
  const wheelRef = useRef<HTMLDivElement>(null);
  const spinButtonRef = useRef<HTMLButtonElement>(null);
  const collectRef = useRef<HTMLButtonElement>(null);
  const count = status.segments.length;

  useEffect(() => {
    spinButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (phase === "won") collectRef.current?.focus();
  }, [phase]);

  // Pointer ticks: read the live rotation each frame and click once per slice boundary.
  useEffect(() => {
    if (phase !== "spinning") return undefined;
    let frame = 0;
    let last = -1;
    const loop = () => {
      const el = wheelRef.current;
      const matrix = el ? getComputedStyle(el).transform : "none";
      const parts = matrix.startsWith("matrix(") ? matrix.slice(7, -1).split(",").map(Number) : null;
      if (parts && parts.length >= 2) {
        const angle = (Math.atan2(parts[1] ?? 0, parts[0] ?? 1) * 180) / Math.PI;
        const current = sliceUnderPointer(angle, count);
        if (current !== last) {
          if (last !== -1) {
            playSound("tick");
            setTick((t) => t + 1);
          }
          last = current;
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [phase, count]);

  const spin = async () => {
    if (phase !== "ready" || !status.canClaim) return;
    playSound("click");
    setPhase("spinning");
    let result: DailyBonusClaim;
    try {
      result = await onClaim();
    } catch {
      setPhase("failed");
      return;
    }
    const index = status.segments.findIndex((segment) => segment.id === result.segmentId);
    if (index < 0) {
      // A slice this wheel does not show: never animate to a wrong slice — just report it.
      setClaim(result);
      setPhase("won");
      return;
    }
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setRotation((current) => wheelTargetRotation(index, count, current, reduced ? 1 : 7, Math.random() - 0.5));
    setTimeout(
      () => {
        setClaim(result);
        setPhase("won");
        playSound(status.segments[index]?.featured ? "bigWin" : "win");
      },
      reduced ? 50 : SPIN_MS + 80,
    );
  };

  const busy = phase === "spinning";

  return (
    <MetaOverlay labelledBy="daily-wheel-title" onClose={onClose} locked={busy}>
      <div className="relative grid justify-items-center gap-3 rounded-[2rem] border-[3px] border-gc/60 bg-[radial-gradient(circle_at_50%_0%,rgba(255,200,61,0.25),transparent_55%),linear-gradient(180deg,#5b21b6,#2a1458_60%,#14062b)] px-5 pb-5 pt-6 text-center shadow-lift">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-full bg-black/25 text-2xl text-ink transition hover:bg-black/45 disabled:opacity-40"
        >
          ×
        </button>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-black/25 py-1 pl-1.5 pr-3 text-sm font-extrabold">
          <CandyIcon name="fire" className="h-5 w-5" />
          {status.streakDay}-day streak! Keep it going
        </span>
        <h2 id="daily-wheel-title" className="font-display text-4xl font-semibold text-ink">
          Daily Wheel
        </h2>
        {preview && <PreviewBadge />}
        <p className="text-sm font-semibold text-[#e4d9ff]">One free spin every 24 hours. Every slice is a win!</p>

        <div className="relative my-2 aspect-square w-[min(320px,78vw)]">
          <div
            aria-hidden="true"
            className="absolute -inset-4 animate-rays rounded-full bg-[conic-gradient(rgba(255,200,61,0),rgba(255,200,61,.6),rgba(255,79,163,.5),rgba(59,227,155,.5),rgba(255,200,61,0))] blur-[18px]"
          />
          <svg
            key={tick}
            viewBox="0 0 40 50"
            aria-hidden="true"
            className={`absolute -top-3.5 left-1/2 z-10 -ml-5 h-12 w-10 origin-[50%_14px] drop-shadow-[0_4px_6px_rgba(0,0,0,0.5)] ${
              tick > 0 ? "animate-[qr-tick_120ms_ease]" : ""
            }`}
          >
            <path d="M20 49 4 17a16 16 0 1 1 32 0z" fill="#FFC83D" stroke="#fff" strokeWidth="3" />
            <circle cx="20" cy="15" r="6" fill="#FF4FA3" stroke="#fff" strokeWidth="2" />
          </svg>
          <div
            ref={wheelRef}
            data-testid="wheel-face"
            data-rotation={rotation}
            className="absolute inset-0 rounded-full"
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: busy ? `transform ${SPIN_MS}ms cubic-bezier(.12,.72,.14,1)` : undefined,
            }}
          >
            <WheelFace segments={status.segments} />
          </div>
          <button
            ref={spinButtonRef}
            type="button"
            onClick={() => void spin()}
            disabled={phase !== "ready" || !status.canClaim}
            className="absolute left-1/2 top-1/2 z-10 aspect-square w-[31%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_40%_30%,#fff1b8,#ffc83d_50%,#e08e0b)] font-display text-2xl font-bold text-[#3a1400] shadow-[0_0_0_6px_#fff,0_0_0_9px_#7c3aed,0_8px_24px_rgba(0,0,0,.5)] enabled:animate-pulse-glow disabled:cursor-default"
          >
            SPIN!
          </button>
          {phase === "won" && <Confetti />}
        </div>

        {phase === "won" && claim && (
          <div className="grid w-full justify-items-center gap-3 animate-settle-pop">
            <p className="flex flex-wrap items-center justify-center gap-3 font-display text-3xl font-semibold">
              {claim.gc !== "0" && <span className="text-gc">+{formatBalance(claim.gc)} GC</span>}
              {claim.sc !== "0" && <span className="text-sc-unplayed">+{formatBalance(claim.sc)} SC</span>}
            </p>
            <p className="text-sm font-bold text-ink-mute">
              {preview ? "Preview only — nothing was credited." : "Added to your balance."}
            </p>
            <button ref={collectRef} type="button" onClick={onClose} className="btn-candy btn-gold w-full py-3.5 text-lg">
              {preview ? "Nice!" : "Collect"}
            </button>
          </div>
        )}
        {phase === "failed" && (
          <p role="alert" className="text-sm font-bold text-danger">
            The wheel could not be spun right now. Nothing was claimed — try again shortly.
          </p>
        )}
        {!status.canClaim && phase === "ready" && (
          <p className="text-sm font-bold text-ink-mute">Today&apos;s spin is used — come back tomorrow.</p>
        )}
        <p className="text-[11px] font-semibold text-ink-faint">No purchase necessary. See Sweepstakes Rules.</p>
      </div>
    </MetaOverlay>
  );
}
