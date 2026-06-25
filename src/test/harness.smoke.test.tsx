import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/** Trivial component: proves jsdom + the React JSX transform + RTL + jest-dom all wire up. */
function HarnessProbe() {
  return <p>harness online</p>;
}

describe("Zone 3 test harness", () => {
  it("renders a React component into jsdom and matches with jest-dom", () => {
    render(<HarnessProbe />);
    expect(screen.getByText("harness online")).toBeInTheDocument();
  });
});
