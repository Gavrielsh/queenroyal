import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Make React Testing Library's auto-cleanup explicit: a forgotten unmount in one test can
// never bleed DOM into the next, regardless of the `globals` auto-registration.
afterEach(() => {
  cleanup();
});
