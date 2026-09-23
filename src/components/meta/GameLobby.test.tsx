import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoCatalog } from "@/lib/meta/demo";

import { GameLobby } from "./GameLobby";

afterEach(() => {
  vi.useRealTimers();
});

describe("GameLobby", () => {
  it("launches a playable game into its window after the loader", async () => {
    vi.useFakeTimers();
    render(<GameLobby games={demoCatalog} preview renderGame={(game) => <p>running {game.gameId}</p>} />);

    fireEvent.click(screen.getByRole("button", { name: /Queen Royal Classic/ }));
    expect(screen.getByRole("dialog", { name: "Queen Royal Classic" })).toHaveTextContent("Loading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(screen.getByText("running classic-3reel")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "← Lobby" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never fakes a game: a preview tile opens a 'coming soon' card, not a playable window", async () => {
    vi.useFakeTimers();
    const renderGame = vi.fn(() => <p>should not render</p>);
    render(<GameLobby games={demoCatalog} preview renderGame={renderGame} />);

    fireEvent.click(screen.getByRole("button", { name: /Lucky Cherries/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });

    expect(screen.getByText("Coming soon", { selector: "p" })).toBeInTheDocument();
    expect(renderGame).not.toHaveBeenCalled();
  });
});
