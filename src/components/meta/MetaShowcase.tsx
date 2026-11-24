"use client";

import { useState } from "react";

import { WinCelebration } from "@/components/game/WinCelebration";
import { ChestReveal } from "@/components/meta/ChestReveal";
import { DailyWheel } from "@/components/meta/DailyWheel";
import { EntranceIntro } from "@/components/meta/EntranceIntro";
import { GameLobby } from "@/components/meta/GameLobby";
import { LevelUpCelebration } from "@/components/meta/LevelUpCelebration";
import {
  JackpotBanner,
  MissionsCard,
  RecentWinsTicker,
  StreakCard,
  TournamentCard,
  VipCard,
} from "@/components/meta/MetaCards";
import { PreviewBadge } from "@/components/meta/MetaOverlay";
import {
  demoCatalog,
  demoDailyBonus,
  demoDraw,
  demoJackpot,
  demoLevelUp,
  demoMissions,
  demoRecentWins,
  demoTournament,
  demoVip,
} from "@/lib/meta/demo";
import type { WinTier } from "@/lib/winTier";

/**
 * Design review surface for every meta-game piece, driven by demo data. Mounted only at
 * /dev/meta, which 404s unless the build is non-production with NEXT_PUBLIC_META_DEMO=1.
 * It needs no gateway: the lobby's playable tile shows a stand-in card here, not the slot.
 */
export function MetaShowcase() {
  const [overlay, setOverlay] = useState<"wheel" | "chest" | "level" | WinTier | null>(null);
  const [entranceKey, setEntranceKey] = useState<number | null>(null);

  const triggers: ReadonlyArray<{ label: string; run: () => void }> = [
    { label: "Daily Wheel", run: () => setOverlay("wheel") },
    { label: "Mission chest", run: () => setOverlay("chest") },
    { label: "VIP level-up", run: () => setOverlay("level") },
    { label: "Big win", run: () => setOverlay("big") },
    { label: "Mega win", run: () => setOverlay("mega") },
    { label: "Epic win", run: () => setOverlay("epic") },
    {
      label: "Entrance splash",
      run: () => {
        try {
          window.sessionStorage.removeItem("qr-entrance-seen");
        } catch {
          // ignore
        }
        setEntranceKey(Date.now());
      },
    },
  ];

  return (
    <main className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] gap-8 px-4 py-10">
      <header className="grid gap-2">
        <h1 className="flex flex-wrap items-center gap-3 text-4xl font-semibold text-ink">
          Meta-game showcase <PreviewBadge />
        </h1>
        <p className="max-w-2xl text-sm font-semibold text-ink-mute">
          Every component below renders demo data and credits nothing. Development builds only. Each moment
          can be replayed from the buttons.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {triggers.map((trigger) => (
            <button key={trigger.label} type="button" onClick={trigger.run} className="btn-candy btn-violet min-h-11 px-4 text-sm">
              {trigger.label}
            </button>
          ))}
        </div>
      </header>

      <JackpotBanner jackpot={demoJackpot} preview />
      <RecentWinsTicker wins={demoRecentWins} preview />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <GameLobby
          games={demoCatalog}
          preview
          renderGame={(game) => (
            <div className="rounded-card border-2 border-white/15 bg-surface-1/80 p-8 text-center font-semibold text-ink">
              On the casino floor this opens the live, ledger-backed slot ({game.gameId}).
            </div>
          )}
        />
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          <StreakCard
            streak={demoDailyBonus.streak}
            streakDay={demoDailyBonus.streakDay}
            canClaim
            onSpin={() => setOverlay("wheel")}
            preview
          />
          <VipCard vip={demoVip} preview />
          <MissionsCard missions={demoMissions} onClaim={() => setOverlay("chest")} preview />
          <TournamentCard tournament={demoTournament} preview />
        </div>
      </div>

      {overlay === "wheel" && (
        <DailyWheel status={demoDailyBonus} onClaim={async () => demoDraw()} onClose={() => setOverlay(null)} preview />
      )}
      {overlay === "chest" && <ChestReveal onOpen={async () => "+5,000 GC"} onClose={() => setOverlay(null)} preview />}
      {overlay === "level" && <LevelUpCelebration levelUp={demoLevelUp} onClose={() => setOverlay(null)} preview />}
      {(overlay === "big" || overlay === "mega" || overlay === "epic") && (
        <WinCelebration tier={overlay} amount="400.0000" family="GC" onClose={() => setOverlay(null)} />
      )}
      {entranceKey !== null && <EntranceIntro key={entranceKey} onDone={() => setEntranceKey(null)} />}
    </main>
  );
}
