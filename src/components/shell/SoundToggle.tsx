"use client";

import { useSyncExternalStore } from "react";

import { isSoundMuted, playSound, setSoundMuted, subscribeSound } from "@/lib/sound";

/** Header mute switch. Server render assumes "sound on"; the client value takes over on hydrate. */
export function SoundToggle() {
  const muted = useSyncExternalStore(subscribeSound, isSoundMuted, () => false);

  return (
    <button
      type="button"
      aria-pressed={!muted}
      aria-label={muted ? "Sound off" : "Sound on"}
      onClick={() => {
        setSoundMuted(!muted);
        if (muted) playSound("click");
      }}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-edge bg-surface-1 transition hover:border-edge-strong ${
        muted ? "text-gc" : "text-ink-mute hover:text-ink"
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
        {muted ? (
          <path d="M3 9v6h4l5 5V4L7 9zm18.6 1.4-1.4-1.4L18 11.2 15.8 9l-1.4 1.4 2.2 2.2-2.2 2.2 1.4 1.4 2.2-2.2 2.2 2.2 1.4-1.4-2.2-2.2z" />
        ) : (
          <path d="M3 9v6h4l5 5V4L7 9zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" />
        )}
      </svg>
    </button>
  );
}
