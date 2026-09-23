import { describe, expect, it } from "vitest";

import { sliceUnderPointer, wheelTargetRotation } from "./wheel";

describe("wheel geometry", () => {
  it("always stops the server's slice under the pointer, from any start and with any jitter", () => {
    const count = 10;
    for (const start of [0, 37, 725, -90, 3600.5]) {
      for (let index = 0; index < count; index++) {
        for (const jitter of [-0.49, -0.2, 0, 0.2, 0.49]) {
          const target = wheelTargetRotation(index, count, start, 7, jitter);
          expect(sliceUnderPointer(target, count)).toBe(index);
          expect(target - start).toBeGreaterThanOrEqual(360 * 5); // always a real spin, never a nudge
        }
      }
    }
  });
});
