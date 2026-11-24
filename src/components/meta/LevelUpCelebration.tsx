"use client";

import { useEffect, useRef } from "react";

import { CandyIcon } from "@/components/art/CandyIcon";
import { Confetti } from "@/components/meta/Confetti";
import { MetaOverlay, PreviewBadge } from "@/components/meta/MetaOverlay";
import type { VipLevelUp } from "@/lib/meta/types";
import { playSound } from "@/lib/sound";

/**
 * VIP tier-up ceremony: the old crest spins away in a flash, the crown drops in, then the new
 * tier's perks rise one by one. Content (tier names, perks) comes from the server's level-up
 * record; this component only stages it.
 */
export function LevelUpCelebration({
  levelUp,
  onClose,
  preview,
}: {
  levelUp: VipLevelUp;
  onClose: () => void;
  preview: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      playSound("levelUp");
      buttonRef.current?.focus();
    }, 950);
    return () => clearTimeout(timer);
  }, []);

  const rise = (delay: number) => ({
    className: "animate-[qr-rise_.5s_ease_both]",
    style: { animationDelay: `${delay}s` },
  });

  return (
    <MetaOverlay labelledBy="level-up-title" onClose={onClose}>
      <div className="relative grid justify-items-center gap-3 text-center">
        <p className="text-[13px] font-black tracking-[0.24em] text-gc">VIP LEVEL UP</p>
        {preview && <PreviewBadge />}
        <div className="relative h-40 w-40">
          <CandyIcon
            name="gem"
            className="absolute inset-0 h-full w-full animate-[qr-crest-out_1s_ease_both] drop-shadow-[0_10px_20px_rgba(0,0,0,0.4)]"
          />
          <span
            aria-hidden="true"
            className="absolute -inset-[45%] rounded-full bg-[radial-gradient(circle,#fff_0,rgba(255,240,190,.8)_20%,transparent_60%)] opacity-0 animate-[qr-flash_.7s_.85s_ease-out_both]"
          />
          <CandyIcon
            name="crown"
            className="absolute inset-0 h-full w-full opacity-0 animate-[qr-crest-in_.8s_1s_cubic-bezier(.3,1.7,.5,1)_both] drop-shadow-[0_10px_20px_rgba(0,0,0,0.4)]"
          />
          <Confetti />
        </div>
        <h2 id="level-up-title" {...rise(1.35)} className={`font-display text-4xl font-semibold text-ink ${rise(1.35).className}`}>
          You&apos;re now a <span className="text-gc">{levelUp.toTier}</span>!
        </h2>
        <p {...rise(1.5)} className={`font-semibold text-[#e4d9ff] ${rise(1.5).className}`}>
          VIP {levelUp.level} unlocked. Here&apos;s what&apos;s new:
        </p>
        <ul className="grid w-full gap-2">
          {levelUp.perks.map((perk, i) => (
            <li
              key={perk}
              style={rise(1.65 + i * 0.15).style}
              className={`flex items-center gap-3 rounded-2xl border border-white/15 bg-white/[0.07] px-3.5 py-2.5 text-left font-extrabold ${rise(0).className}`}
            >
              <CandyIcon name={i === 0 ? "wheel" : i === 1 ? "sc" : "gift"} className="h-7 w-7 shrink-0" />
              {perk}
            </li>
          ))}
        </ul>
        <button
          ref={buttonRef}
          type="button"
          onClick={onClose}
          style={rise(2.1).style}
          className={`btn-candy btn-gold mt-1 px-8 py-3.5 text-lg ${rise(0).className}`}
        >
          Long live the {levelUp.toTier}!
        </button>
      </div>
    </MetaOverlay>
  );
}
