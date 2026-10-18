import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobBeaconLogo } from "./JobBeaconLogo";
import { CopilotIcon } from "./CopilotIcon";

// vitest.config.ts does not enable globals, so RTL's automatic cleanup never registers.
afterEach(cleanup);

describe("JobBeaconLogo", () => {
  it("exposes the brand as a single labelled image", () => {
    render(<JobBeaconLogo />);

    expect(screen.getByRole("img", { name: "JobBeacon" })).toBeInTheDocument();
  });

  it("splits the wordmark so each half can carry its own colour", () => {
    const { container } = render(<JobBeaconLogo />);

    expect(container.querySelector(".jb-wordmark-primary")?.textContent).toBe("Job");
    expect(container.querySelector(".jb-wordmark-accent")?.textContent).toBe("Beacon");
  });

  it("shows the tagline only when asked, because the sidebar has no room for it", () => {
    const { container, rerender } = render(<JobBeaconLogo />);
    expect(container.textContent).not.toContain("ILLUMINATE YOUR CAREER");

    rerender(<JobBeaconLogo showTagline />);
    expect(container.textContent).toContain("ILLUMINATE YOUR CAREER");
  });

  it("gives each instance its own gradient id, so two logos cannot collide", () => {
    const { container } = render(
      <>
        <JobBeaconLogo />
        <JobBeaconLogo showTagline />
      </>,
    );

    const ids = Array.from(container.querySelectorAll("linearGradient")).map((node) => node.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("CopilotIcon", () => {
  it("exposes the assistant as a labelled image", () => {
    render(<CopilotIcon />);

    expect(screen.getByRole("img", { name: "Career Copilot" })).toBeInTheDocument();
  });

  it("draws the plane as separate facets plus its speed particles", () => {
    const { container } = render(<CopilotIcon />);

    // Three facet polygons and two trailing shards; dots are circles.
    expect(container.querySelectorAll("polygon")).toHaveLength(5);
    expect(container.querySelectorAll("circle").length).toBeGreaterThanOrEqual(3);
    expect(container.querySelectorAll("linearGradient")).toHaveLength(3);
  });
});
