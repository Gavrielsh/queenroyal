"use client";

import type { ReactNode } from "react";

import { CandyIcon, type CandyIconName } from "@/components/art/CandyIcon";
import { PreviewBadge } from "@/components/meta/MetaOverlay";
import { formatBalance } from "@/lib/format";
import type { JackpotSnapshot, Mission, RecentWin, StreakDay, Tournament, VipStatus } from "@/lib/meta/types";

/**
 * The meta-game rail cards and banners. Each is a pure renderer of its server record — no
 * fetching, no local state beyond presentation. Money arrives as strings and is only ever
 * formatted with the string-only `formatBalance` (G2); points and progress are plain numbers.
 */

function Card({
  icon,
  title,
  aside,
  preview,
  children,
}: {
  icon: CandyIconName;
  title: string;
  aside?: string;
  preview: boolean;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 rounded-card border-2 border-edge bg-surface-1/90 p-4">
      <h3 className="flex items-center justify-between gap-2 font-display text-lg font-semibold text-ink">
        <span className="flex items-center gap-2">
          <CandyIcon name={icon} className="h-8 w-8" />
          {title}
        </span>
        <span className="flex items-center gap-2">
          {preview && <PreviewBadge />}
          {aside && <span className="font-sans text-xs font-extrabold text-ink-faint">{aside}</span>}
        </span>
      </h3>
      {children}
    </section>
  );
}

function Bar({ value, max, tone }: { value: number; max: number; tone: "gold" | "green" | "brand" }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const fill =
    tone === "gold"
      ? "from-gc-deep to-gold-hi"
      : tone === "green"
        ? "from-sc-unplayed-deep to-sc-unplayed"
        : "from-brand to-candy";
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-2.5 overflow-hidden rounded-full bg-surface-0"
    >
      <div className={`h-full rounded-full bg-gradient-to-r ${fill} transition-[width] duration-700`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Daily wheel + streak ────────────────────────────────────────────────────────────────────

export function StreakCard({
  streak,
  streakDay,
  canClaim,
  onSpin,
  preview,
}: {
  streak: readonly StreakDay[];
  streakDay: number;
  canClaim: boolean;
  onSpin: () => void;
  preview: boolean;
}) {
  return (
    <Card icon="wheel" title="Daily Wheel" aside={`Day ${streakDay} of ${streak.length}`} preview={preview}>
      <ol className="grid grid-cols-7 gap-1">
        {streak.map((day) => (
          <li
            key={day.day}
            className={`grid justify-items-center gap-0.5 rounded-xl border-2 px-0.5 py-1.5 text-center text-[10.5px] font-bold ${
              day.state === "claimed"
                ? "border-sc-unplayed/55 bg-sc-unplayed/10 text-sc-unplayed"
                : day.state === "today"
                  ? "border-gc bg-surface-2 text-ink shadow-glow-gc"
                  : "border-edge bg-surface-0/60 text-ink-faint"
            }`}
          >
            <span className="text-[11px] font-black">{day.state === "claimed" ? "✓" : `Day ${day.day}`}</span>
            <CandyIcon name={day.icon} className="h-5 w-5" />
            <span className="truncate">{day.label}</span>
          </li>
        ))}
      </ol>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-bold text-ink-mute">
          {canClaim ? "Your free spin is ready" : "Come back tomorrow"}
        </span>
        <button type="button" onClick={onSpin} disabled={!canClaim} className="btn-candy btn-gold min-h-11 px-5 text-base">
          Spin
        </button>
      </div>
    </Card>
  );
}

// ── VIP ─────────────────────────────────────────────────────────────────────────────────────

export function VipCard({ vip, preview }: { vip: VipStatus; preview: boolean }) {
  return (
    <section className="flex items-center gap-3 rounded-card border-2 border-edge bg-surface-1/90 p-4">
      <CandyIcon name={vip.level >= 5 ? "crown" : "gem"} className="h-14 w-14 shrink-0" />
      <div className="grid flex-1 gap-1.5">
        <p className="flex items-center justify-between gap-2 font-display text-lg font-semibold text-ink">
          {vip.tier} · VIP {vip.level}
          {preview && <PreviewBadge />}
        </p>
        {vip.nextTierPoints !== null && vip.nextTier !== null ? (
          <>
            <Bar value={vip.points} max={vip.nextTierPoints} tone="brand" />
            <p className="text-xs font-bold text-ink-mute">
              {vip.points.toLocaleString("en-US")} / {vip.nextTierPoints.toLocaleString("en-US")} points to{" "}
              <span className="text-ink">{vip.nextTier}</span>
            </p>
          </>
        ) : (
          <p className="text-xs font-bold text-ink-mute">Top tier reached</p>
        )}
      </div>
    </section>
  );
}

// ── Missions ────────────────────────────────────────────────────────────────────────────────

export function MissionsCard({
  missions,
  onClaim,
  preview,
}: {
  missions: readonly Mission[];
  onClaim: (mission: Mission) => void;
  preview: boolean;
}) {
  return (
    <Card icon="chest" title="Daily missions" aside="Resets 00:00 ET" preview={preview}>
      <ul className="grid gap-3">
        {missions.map((mission) => (
          <li key={mission.id} className="grid gap-1.5">
            <div className="flex justify-between gap-2 text-sm font-bold">
              <span className="text-ink">
                {mission.title}{" "}
                <span className="font-mono text-xs text-ink-faint">
                  {mission.claimed ? "done ✓" : `${Math.min(mission.progress, mission.goal)}/${mission.goal}`}
                </span>
              </span>
              <span
                className={`shrink-0 font-black ${mission.rewardFamily === "sc" ? "text-sc-unplayed" : "text-gc"}`}
              >
                {mission.rewardLabel}
              </span>
            </div>
            <Bar value={mission.progress} max={mission.goal} tone={mission.rewardFamily === "sc" ? "green" : "gold"} />
            {mission.claimable && !mission.claimed && (
              <button
                type="button"
                onClick={() => onClaim(mission)}
                className="btn-candy btn-green min-h-11 justify-self-start px-4 text-sm motion-safe:animate-pulse-glow"
              >
                {mission.rewardFamily === "chest" ? "Open chest" : "Claim reward"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Tournament ──────────────────────────────────────────────────────────────────────────────

const MEDAL = ["#FFC83D", "#E5E7EB", "#F0A56B"] as const;

export function TournamentCard({ tournament, preview }: { tournament: Tournament; preview: boolean }) {
  return (
    <Card icon="trophy" title={tournament.name} preview={preview}>
      <ol className="grid gap-1.5 text-sm">
        {tournament.rows.map((row) => (
          <li
            key={`${row.rank}-${row.name}`}
            className={`grid grid-cols-[28px_1fr_auto] items-center gap-2 rounded-xl bg-surface-0/70 px-2.5 py-1.5 font-bold ${
              row.isYou ? "outline outline-2 outline-gc" : ""
            }`}
          >
            <span
              className="grid h-6 w-6 place-items-center rounded-full font-mono text-[11px] font-black text-[#3a1400]"
              style={{ backgroundColor: MEDAL[row.rank - 1] ?? "#a08cd0" }}
            >
              {row.rank}
            </span>
            <span className="truncate text-ink">{row.name}</span>
            <span className="font-mono text-xs text-sc-unplayed">{row.prizeLabel}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ── Jackpot banner ──────────────────────────────────────────────────────────────────────────

export function JackpotBanner({ jackpot, preview }: { jackpot: JackpotSnapshot; preview: boolean }) {
  return (
    <section
      aria-label="Royal Jackpot"
      className="flex flex-wrap items-center justify-between gap-3 rounded-card border-2 border-gc/45 bg-gradient-to-r from-brand-deep via-surface-2 to-brand-deep px-5 py-4"
    >
      <span className="flex items-center gap-2 font-display text-lg font-semibold text-gc">
        <CandyIcon name="stack" className="h-9 w-9" />
        Royal Jackpot
        {preview && <PreviewBadge />}
      </span>
      <span className="font-mono text-2xl font-bold tabular-nums text-sc-unplayed drop-shadow-[0_0_14px_rgba(59,227,155,0.45)] sm:text-3xl">
        {jackpot.family} {formatBalance(jackpot.pool)}
      </span>
      <span className="flex flex-wrap gap-3 text-xs font-bold text-ink-mute">
        {jackpot.tiers.map((tier) => (
          <span key={tier.name}>
            {tier.name} <span className="font-mono text-ink">{formatBalance(tier.amount)}</span>
          </span>
        ))}
      </span>
    </section>
  );
}

// ── Recent wins marquee ─────────────────────────────────────────────────────────────────────

export function RecentWinsTicker({ wins, preview }: { wins: readonly RecentWin[]; preview: boolean }) {
  const items = wins.map((win) => (
    <span key={win.id} className="flex items-center gap-1.5 whitespace-nowrap text-[13px] font-bold text-ink-mute">
      <CandyIcon name={win.family === "GC" ? "coin" : "sc"} className="h-5 w-5" />
      <span className="text-ink">{win.player}</span> won{" "}
      <span className={win.family === "GC" ? "text-gc" : "text-sc-unplayed"}>
        {formatBalance(win.amount)} {win.family}
      </span>{" "}
      on {win.game}
    </span>
  ));
  return (
    <section aria-label="Recent wins" className="flex items-center gap-3">
      {preview && <PreviewBadge className="shrink-0" />}
      <div className="min-w-0 flex-1 overflow-hidden rounded-full border border-edge bg-surface-1 [mask-image:linear-gradient(90deg,transparent,#000_6%,#000_94%,transparent)]">
        <div className="flex w-max gap-8 py-2 motion-safe:animate-[qr-marquee_40s_linear_infinite]">
          {items}
          <span aria-hidden="true" className="flex gap-8">
            {items}
          </span>
        </div>
      </div>
    </section>
  );
}
