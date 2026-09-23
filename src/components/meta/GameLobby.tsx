"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { CandyIcon } from "@/components/art/CandyIcon";
import { SlotSymbol } from "@/components/game/SlotSymbol";
import { PreviewBadge } from "@/components/meta/MetaOverlay";
import type { CatalogGame, GameArt } from "@/lib/meta/types";
import { playSound } from "@/lib/sound";

/**
 * Lobby grid. Clicking a tile grows it into a full-screen game window (the tile's own box
 * animates to the viewport), a branded loader plays, then `renderGame` mounts the game. A
 * non-playable (preview) tile opens an honest "coming soon" card instead of a fake game.
 */
const ART_SYMBOL: Readonly<Record<GameArt, string>> = {
  cherry: "CHERRY",
  seven: "SEVEN",
  diamond: "DIAMOND",
  crown: "CROWN",
  bell: "BELL",
  lemon: "LEMON",
};

const BADGE_CLASS: Readonly<Record<NonNullable<CatalogGame["badge"]>, string>> = {
  HOT: "bg-candy text-white",
  NEW: "bg-sc-unplayed text-[#05361f]",
  JACKPOT: "bg-gc text-[#3a1400]",
};

const LOAD_MS = 1100;

interface Launch {
  game: CatalogGame;
  from: DOMRect;
  tile: HTMLButtonElement;
}

function GameWindow({ launch, onClose, renderGame }: { launch: Launch; onClose: () => void; renderGame: (game: CatalogGame) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const { game, from } = launch;

  useLayoutEffect(() => {
    const el = ref.current;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (el && typeof el.animate === "function" && !reduced) {
      el.animate(
        [
          { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, borderRadius: "24px" },
          { left: "0px", top: "0px", width: `${window.innerWidth}px`, height: `${window.innerHeight}px`, borderRadius: "0px" },
        ],
        { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
    const timer = setTimeout(() => setLoaded(true), reduced ? 0 : LOAD_MS);
    const html = document.documentElement;
    const previous = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      clearTimeout(timer);
      html.style.overflow = previous;
    };
  }, [from]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={game.title}
      className="fixed inset-0 z-[65] overflow-y-auto"
      style={{ background: `radial-gradient(circle at 50% 35%, ${game.palette[0]}, ${game.palette[1]} 80%)` }}
    >
      {!loaded ? (
        <div className="grid h-full place-items-center">
          <div className="grid justify-items-center gap-4 font-display text-xl text-ink">
            <CandyIcon name="crown" className="h-20 w-20 animate-[qr-spin-y_1.1s_linear_infinite]" />
            Loading {game.title}…
            <div className="h-2.5 w-56 overflow-hidden rounded-full bg-black/35">
              <div className="h-full w-full origin-left animate-[qr-load_1.1s_ease_both] rounded-full bg-gradient-to-r from-gc-deep to-gold-hi" />
            </div>
          </div>
        </div>
      ) : (
        <div className="mx-auto grid min-h-full w-full max-w-3xl grid-cols-[minmax(0,1fr)] content-start gap-6 px-4 pb-10 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="flex items-center gap-3">
            <button type="button" onClick={onClose} className="btn-candy btn-violet min-h-11 px-4 text-sm" autoFocus>
              ← Lobby
            </button>
            <h2 className="min-w-0 flex-1 truncate text-center font-display text-2xl font-semibold text-ink">{game.title}</h2>
            <span className="w-[88px]" aria-hidden="true" />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] place-items-center">
            {game.playable ? (
              renderGame(game)
            ) : (
              <div className="grid max-w-sm justify-items-center gap-3 rounded-card border-2 border-white/15 bg-surface-1/80 p-8 text-center">
                <SlotSymbol symbol={ART_SYMBOL[game.art]} className="h-24 w-24" />
                <PreviewBadge />
                <p className="font-display text-2xl font-semibold text-ink">Coming soon</p>
                <p className="text-sm font-semibold text-ink-mute">
                  This game is a lobby preview. It is not playable yet — no wagers can be placed on it.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function GameLobby({
  games,
  renderGame,
  preview,
}: {
  games: readonly CatalogGame[];
  renderGame: (game: CatalogGame) => ReactNode;
  preview: boolean;
}) {
  const [launch, setLaunch] = useState<Launch | null>(null);

  const close = () => {
    playSound("click");
    const tile = launch?.tile;
    setLaunch(null);
    tile?.focus();
  };

  return (
    <section aria-label="Games" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <h2 className="flex items-center gap-2 font-display text-2xl font-semibold text-ink">
        <CandyIcon name="fire" className="h-8 w-8" />
        Hot right now
        {preview && <PreviewBadge />}
      </h2>
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
        {games.map((game) => (
          <button
            key={game.gameId}
            type="button"
            onClick={(event) => {
              playSound("click");
              const tile = event.currentTarget;
              setLaunch({ game, tile, from: tile.getBoundingClientRect() });
            }}
            className="group overflow-hidden rounded-card border-2 border-edge bg-surface-1 text-left transition duration-200 hover:-translate-y-1 hover:-rotate-[0.6deg] hover:border-gc hover:shadow-lift"
          >
            <span
              className="relative grid aspect-square place-items-center overflow-hidden"
              style={{ background: `radial-gradient(circle at 50% 40%, ${game.palette[0]}, ${game.palette[1]} 75%)` }}
            >
              {game.badge && (
                <span className={`absolute left-2.5 top-2.5 z-10 rounded-full px-2.5 py-0.5 text-[11px] font-black tracking-wide ${BADGE_CLASS[game.badge]}`}>
                  {game.badge}
                </span>
              )}
              <SlotSymbol
                symbol={ART_SYMBOL[game.art]}
                className="h-[58%] w-[58%] drop-shadow-[0_8px_10px_rgba(0,0,0,0.3)] transition duration-300 group-hover:-rotate-3 group-hover:scale-110"
              />
              <span className="absolute inset-x-1.5 bottom-2 text-center font-display text-lg font-semibold text-white [text-shadow:0_2px_0_rgba(0,0,0,.35)]">
                {game.title}
              </span>
            </span>
            <span className="flex justify-between gap-2 px-3 py-2 text-xs font-bold text-ink-mute">
              <span>{game.category}</span>
              <span>{game.playable ? "Play now" : "Coming soon"}</span>
            </span>
          </button>
        ))}
      </div>
      {launch && <GameWindow launch={launch} onClose={close} renderGame={renderGame} />}
    </section>
  );
}
