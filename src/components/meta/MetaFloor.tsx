"use client";

import { useCallback, useState } from "react";

import { MockGameWindow } from "@/components/MockGameWindow";
import { StoreWindow } from "@/components/StoreWindow";
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
import { formatBalance } from "@/lib/format";
import {
  demoCatalog,
  demoChestReward,
  demoDailyBonus,
  demoDraw,
  demoJackpot,
  demoLevelUp,
  demoMissions,
  demoRecentWins,
  demoTournament,
  demoVip,
} from "@/lib/meta/demo";
import { featureMode, type MetaFeature } from "@/lib/meta/features";
import type { DailyBonusStatus, Mission } from "@/lib/meta/types";

/**
 * The casino floor with the meta-game around it: entrance splash → Daily Wheel, a lobby that
 * launches the real ledger-backed slot, the coin store, and a rail of streak / VIP / missions /
 * tournament cards.
 *
 * Only features whose mode is not "off" render. Today every mode is "off" in production and
 * "demo" in a development build started with NEXT_PUBLIC_META_DEMO=1 (see lib/meta/features).
 * In demo mode the data is lib/meta/demo, every surface wears a Preview badge, and nothing is
 * written to the wallet cache: the balance chips keep showing only what the ledger reported.
 *
 * Going live, per feature: add its gateway client (parse the wire into lib/meta/types), swap
 * the demo value/handler below for it, re-read the wallet after any grant with
 * `invalidateWalletBalances(queryClient, …)`, and list it in LIVE_READY.
 */
export function MetaFloor() {
  const mode = (feature: MetaFeature) => featureMode(feature);
  const on = (feature: MetaFeature) => mode(feature) !== "off";
  const preview = (feature: MetaFeature) => mode(feature) === "demo";

  const [bonus, setBonus] = useState<DailyBonusStatus>(demoDailyBonus);
  const [missions, setMissions] = useState<readonly Mission[]>(demoMissions);
  const [wheelOpen, setWheelOpen] = useState(false);
  const [chestFor, setChestFor] = useState<Mission | null>(null);
  const [levelUpOpen, setLevelUpOpen] = useState(false);

  const openWheelAfterEntrance = useCallback(() => {
    if (featureMode("dailyWheel") !== "off" && demoDailyBonus.canClaim) setWheelOpen(true);
  }, []);

  const claimWheel = async () => {
    const claim = demoDraw();
    setBonus((current) => ({
      ...current,
      canClaim: false,
      streak: current.streak.map((day) => (day.state === "today" ? { ...day, state: "claimed" } : day)),
    }));
    return claim;
  };

  const openChest = async () => {
    const mission = chestFor;
    if (mission) {
      setMissions((current) => current.map((m) => (m.id === mission.id ? { ...m, claimed: true } : m)));
    }
    return `+${formatBalance(demoChestReward.gc)} GC`;
  };

  return (
    <>
      {on("entrance") && <EntranceIntro onDone={openWheelAfterEntrance} />}

      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:py-12">
        <header className="text-center sm:text-left">
          <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">Casino Floor</h1>
          <p className="mt-2 text-sm text-ink-mute">
            Every balance below is read live from the ledger — nothing is computed in your browser.
          </p>
        </header>

        <div className="mt-8 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
            {on("jackpot") && <JackpotBanner jackpot={demoJackpot} preview={preview("jackpot")} />}
            {on("recentWins") && <RecentWinsTicker wins={demoRecentWins} preview={preview("recentWins")} />}
            {on("lobby") ? (
              <GameLobby games={demoCatalog} preview={preview("lobby")} renderGame={() => <MockGameWindow />} />
            ) : (
              <div className="grid grid-cols-[minmax(0,1fr)] place-items-center">
                <MockGameWindow />
              </div>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)] place-items-center">
              <StoreWindow />
            </div>
          </div>

          <aside aria-label="Rewards" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 lg:sticky lg:top-20">
            {on("dailyWheel") && (
              <StreakCard
                streak={bonus.streak}
                streakDay={bonus.streakDay}
                canClaim={bonus.canClaim}
                onSpin={() => setWheelOpen(true)}
                preview={preview("dailyWheel")}
              />
            )}
            {on("vip") && (
              <div className="grid gap-2">
                <VipCard vip={demoVip} preview={preview("vip")} />
                {preview("vip") && (
                  <button
                    type="button"
                    onClick={() => setLevelUpOpen(true)}
                    className="justify-self-end text-xs font-bold text-ink-faint underline hover:text-ink"
                  >
                    Preview the level-up moment
                  </button>
                )}
              </div>
            )}
            {on("missions") && (
              <MissionsCard missions={missions} onClaim={(mission) => setChestFor(mission)} preview={preview("missions")} />
            )}
            {on("tournament") && <TournamentCard tournament={demoTournament} preview={preview("tournament")} />}
          </aside>
        </div>
      </main>

      {wheelOpen && (
        <DailyWheel
          status={bonus}
          onClaim={claimWheel}
          onClose={() => setWheelOpen(false)}
          preview={preview("dailyWheel")}
        />
      )}
      {chestFor && <ChestReveal onOpen={openChest} onClose={() => setChestFor(null)} preview={preview("missions")} />}
      {levelUpOpen && (
        <LevelUpCelebration levelUp={demoLevelUp} onClose={() => setLevelUpOpen(false)} preview={preview("vip")} />
      )}
    </>
  );
}
