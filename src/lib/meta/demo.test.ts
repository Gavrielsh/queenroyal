import { describe, expect, it } from "vitest";

import { demoCatalog, demoDailyBonus, demoDraw } from "./demo";

describe("demo data", () => {
  it("only ever draws a slice the wheel actually shows", () => {
    const ids = new Set(demoDailyBonus.segments.map((segment) => segment.id));
    for (const roll of [0, 0.1, 0.5, 0.9, 0.999999]) {
      expect(ids.has(demoDraw(() => roll).segmentId)).toBe(true);
    }
  });

  it("lists exactly one playable game: the engine's registered classic-3reel", () => {
    const playable = demoCatalog.filter((game) => game.playable);
    expect(playable.map((game) => game.gameId)).toEqual(["classic-3reel"]);
  });
});
