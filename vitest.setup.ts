import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Make React Testing Library's auto-cleanup explicit: a forgotten unmount in one test can
// never bleed DOM into the next, regardless of the `globals` auto-registration.
afterEach(() => {
  cleanup();
});

/**
 * Silence the audio stack in jsdom.
 *
 * jsdom implements no media, so any component that celebrates a win logs
 * "Not implemented: HTMLMediaElement's play() method". The noise is harmless but
 * it teaches people to skim test output, and the Gate C suite is precisely the
 * one whose output should be trusted line by line.
 *
 * Whether audio actually plays is a browser concern and is covered end to end in
 * e2e/ldw.spec.ts, which traps the real constructor. What the unit suites assert
 * is whether a celebration was TRIGGERED, which celebration.ts reports
 * independently of any device.
 */
class SilentAudio {
  volume = 0;
  play(): Promise<void> {
    return Promise.resolve();
  }
}
Object.defineProperty(globalThis, "Audio", { value: SilentAudio, writable: true });
