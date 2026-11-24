"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { Confetti } from "@/components/meta/Confetti";
import { MetaOverlay, PreviewBadge } from "@/components/meta/MetaOverlay";
import { playSound } from "@/lib/sound";

/**
 * Mission-complete treasure chest: idle wobble → tap → shake → lid flies open with a glow and
 * popping coins → the reward label lands. `onOpen` is where the live mode claims the reward
 * from the server; the label shown is whatever that claim returned (display copy, verbatim).
 */
export interface ChestRevealProps {
  onOpen: () => Promise<string>;
  onClose: () => void;
  preview: boolean;
}

const POPS = [
  { x: -60, y: -110, delay: 0.1, fill: "#FFC83D" },
  { x: 55, y: -120, delay: 0.18, fill: "#FFC83D" },
  { x: -20, y: -140, delay: 0.26, fill: "#3BE39B" },
  { x: 25, y: -100, delay: 0.34, fill: "#FFC83D" },
  { x: -85, y: -70, delay: 0.42, fill: "#FF4FA3" },
  { x: 85, y: -75, delay: 0.5, fill: "#A78BFA" },
] as const;

export function ChestReveal({ onOpen, onClose, preview }: ChestRevealProps) {
  const [phase, setPhase] = useState<"closed" | "shaking" | "open" | "failed">("closed");
  const [reward, setReward] = useState<string | null>(null);
  const chestRef = useRef<HTMLButtonElement>(null);
  const collectRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    chestRef.current?.focus();
  }, []);
  useEffect(() => {
    if (reward) collectRef.current?.focus();
  }, [reward]);

  const open = async () => {
    if (phase !== "closed") return;
    setPhase("shaking");
    playSound("creak");
    let label: string;
    try {
      [label] = await Promise.all([onOpen(), new Promise((resolve) => setTimeout(resolve, 600))]);
    } catch {
      setPhase("failed");
      return;
    }
    setPhase("open");
    playSound("open");
    setTimeout(() => setReward(label), 650);
  };

  const isOpen = phase === "open";

  return (
    <MetaOverlay labelledBy="chest-title" onClose={onClose} locked={phase === "shaking"}>
      <div className="relative grid justify-items-center gap-3 text-center">
        <h2 id="chest-title" className="font-display text-4xl font-semibold text-ink">
          Mission <span className="text-gc">complete!</span>
        </h2>
        {preview && <PreviewBadge />}
        <p className="font-semibold text-[#e4d9ff]">
          {isOpen ? "You found a treasure!" : "Tap the chest to open it"}
        </p>

        <button
          ref={chestRef}
          type="button"
          onClick={() => void open()}
          disabled={phase !== "closed"}
          aria-label="Open the treasure chest"
          className={`relative mt-6 aspect-[200/190] w-[min(250px,66vw)] disabled:cursor-default ${
            phase === "closed" ? "animate-[qr-wobble_1.8s_ease-in-out_infinite]" : ""
          } ${phase === "shaking" ? "animate-[qr-shake_.6s_linear]" : ""}`}
        >
          <svg viewBox="0 0 200 190" className="h-full w-full overflow-visible" aria-hidden="true">
            <defs>
              <linearGradient id="qr-chest-wood" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#B7793F" />
                <stop offset="1" stopColor="#7A4516" />
              </linearGradient>
              <linearGradient id="qr-chest-gold" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#FFE58F" />
                <stop offset="1" stopColor="#F2A60C" />
              </linearGradient>
              <radialGradient id="qr-chest-glow">
                <stop offset="0" stopColor="#FFF6CF" />
                <stop offset=".45" stopColor="#FFC83D" stopOpacity=".7" />
                <stop offset="1" stopColor="#FFC83D" stopOpacity="0" />
              </radialGradient>
            </defs>
            <ellipse
              cx="100"
              cy="70"
              rx="100"
              ry="80"
              fill="url(#qr-chest-glow)"
              className="origin-[50%_80%] transition-all delay-75 duration-500 [transform-box:fill-box]"
              style={{ transform: isOpen ? "none" : "scale(0)", opacity: isOpen ? 1 : 0 }}
            />
            {POPS.map((pop) => (
              <circle
                key={`${pop.x}-${pop.y}`}
                cx="100"
                cy="100"
                r="10"
                fill={pop.fill}
                stroke="#fff"
                strokeWidth="2"
                className={isOpen ? "animate-[qr-pop_1s_cubic-bezier(.2,.8,.3,1)_both] [transform-box:fill-box]" : "opacity-0"}
                style={
                  {
                    animationDelay: `${pop.delay}s`,
                    "--qr-x": `${pop.x}px`,
                    "--qr-y": `${pop.y}px`,
                  } as CSSProperties
                }
              />
            ))}
            <rect x="30" y="92" width="140" height="80" rx="10" fill="url(#qr-chest-wood)" />
            <rect x="30" y="92" width="140" height="12" fill="url(#qr-chest-gold)" />
            <rect x="46" y="92" width="12" height="80" fill="url(#qr-chest-gold)" />
            <rect x="142" y="92" width="12" height="80" fill="url(#qr-chest-gold)" />
            <rect x="30" y="162" width="140" height="12" rx="6" fill="#5A3210" />
            <g
              className="origin-[0%_100%] transition-transform duration-500 ease-[cubic-bezier(.3,1.6,.5,1)] [transform-box:fill-box]"
              style={{ transform: isOpen ? "translate(-8%,-22%) rotate(-30deg)" : "none" }}
            >
              <path d="M30 96V70A70 40 0 0 1 170 70V96Z" fill="url(#qr-chest-wood)" />
              <path d="M30 96V84H170V96Z" fill="url(#qr-chest-gold)" />
              <rect x="46" y="41" width="12" height="55" fill="url(#qr-chest-gold)" />
              <rect x="142" y="41" width="12" height="55" fill="url(#qr-chest-gold)" />
            </g>
            <rect x="87" y="98" width="26" height="30" rx="6" fill="url(#qr-chest-gold)" stroke="#B86A00" strokeWidth="2" />
            <circle cx="100" cy="110" r="4" fill="#5A3210" />
          </svg>
          {isOpen && <Confetti />}
        </button>

        {reward && (
          <div className="grid justify-items-center gap-2 animate-settle-pop">
            <p className="font-display text-4xl font-semibold text-gc">{reward}</p>
            <p className="text-sm font-bold text-ink-mute">
              {preview ? "Preview only — nothing was credited." : "Added to your balance."}
            </p>
            <button ref={collectRef} type="button" onClick={onClose} className="btn-candy btn-gold px-10 py-3.5 text-lg">
              {preview ? "Nice!" : "Collect"}
            </button>
          </div>
        )}
        {phase === "failed" && (
          <>
            <p role="alert" className="text-sm font-bold text-danger">
              The chest could not be opened right now. Try again shortly.
            </p>
            <button type="button" onClick={onClose} className="btn-candy btn-violet px-6 py-3">
              Close
            </button>
          </>
        )}
      </div>
    </MetaOverlay>
  );
}
