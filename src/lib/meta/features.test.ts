import { describe, expect, it } from "vitest";

import { META_FEATURES, anyMetaFeatureOn, featureMode } from "./features";

describe("featureMode", () => {
  it("is off by default in development", () => {
    const env = { nodeEnv: "development", metaDemo: undefined };
    for (const feature of META_FEATURES) expect(featureMode(feature, env)).toBe("off");
    expect(anyMetaFeatureOn(env)).toBe(false);
  });

  it("turns every feature to demo in development when NEXT_PUBLIC_META_DEMO=1", () => {
    const env = { nodeEnv: "development", metaDemo: "1" };
    for (const feature of META_FEATURES) expect(featureMode(feature, env)).toBe("demo");
    expect(anyMetaFeatureOn(env)).toBe(true);
  });

  it("can NEVER reach demo in a production build, whatever the flag says", () => {
    const env = { nodeEnv: "production", metaDemo: "1" };
    for (const feature of META_FEATURES) expect(featureMode(feature, env)).toBe("off");
    expect(anyMetaFeatureOn(env)).toBe(false);
  });

  it("goes live only for a live-capable feature the operator switched on — in any build", () => {
    const env = { nodeEnv: "production", metaDemo: undefined, metaLive: "dailyWheel, streak,jackpot" };
    expect(featureMode("dailyWheel", env)).toBe("live");
    expect(featureMode("streak", env)).toBe("live");
    // Listed, but no endpoint exists: it stays off rather than rendering invented data.
    expect(featureMode("jackpot", env)).toBe("off");
    expect(featureMode("vip", env)).toBe("off");
  });

  it("prefers live over demo for a switched-on feature in development", () => {
    const env = { nodeEnv: "development", metaDemo: "1", metaLive: "dailyWheel" };
    expect(featureMode("dailyWheel", env)).toBe("live");
    expect(featureMode("missions", env)).toBe("demo");
  });
});
