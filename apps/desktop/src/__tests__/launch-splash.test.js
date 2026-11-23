import { describe, it, expect } from "vitest";
import { launchSplashPageUrl, SPLASH_BACKGROUND } from "../launch-splash.js";

const page = () => decodeURIComponent(launchSplashPageUrl().replace(/^data:text\/html;charset=utf-8,/, ""));

describe("launchSplashPageUrl", () => {
  it("is a self-contained data: URL", () => {
    expect(launchSplashPageUrl()).toMatch(/^data:text\/html;charset=utf-8,/);
  });

  it("draws the mark on the design system's dark background", () => {
    expect(SPLASH_BACKGROUND).toBe("#13161a");
    expect(page()).toContain(`background:${SPLASH_BACKGROUND}`);
    expect(page()).toMatch(/<svg viewBox="0 0 64 64"[^>]*><path fill="#a3e635" d="M36 59 /);
  });

  it("loads nothing from anywhere (no script, no remote resource)", () => {
    expect(page()).toContain("default-src 'none'");
    expect(page()).not.toMatch(/<script|src=|href=/i);
  });

  it("says what is happening", () => {
    expect(page()).toContain("Starting Loxaic…");
  });
});
