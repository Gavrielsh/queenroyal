import { afterEach, describe, expect, it, vi } from "vitest";

import { isSoundMuted, playSound, setSoundMuted, subscribeSound } from "./sound";

afterEach(() => {
  setSoundMuted(false);
  window.localStorage.clear();
});

describe("sound", () => {
  it("is a silent no-op where Web Audio does not exist (jsdom, SSR)", () => {
    expect("AudioContext" in window).toBe(false);
    expect(() => playSound("bigWin")).not.toThrow();
  });

  it("persists the mute preference and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSound(listener);

    setSoundMuted(true);
    expect(isSoundMuted()).toBe(true);
    expect(window.localStorage.getItem("qr-sound-muted")).toBe("1");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setSoundMuted(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
