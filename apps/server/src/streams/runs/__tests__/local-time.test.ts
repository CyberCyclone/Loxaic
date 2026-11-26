import { describe, expect, it } from "vitest";
import { deviceLocalTime, normalizeClientLocalTime } from "@loxaic/types";
import { formatLocalTime, localTimeBlock, withoutOthersLocalTime } from "../local-time.ts";

// 2026-11-23T23:15:00Z: Tuesday 24 November in Brisbane (UTC+10, no DST).
const NOW = new Date("2026-11-23T23:15:00Z");

describe("formatLocalTime", () => {
  it("shows the sender's wall clock and zone", () => {
    expect(formatLocalTime(NOW, { tz: "Australia/Brisbane" })).toEqual({
      at: "2026-11-24T09:15+10:00",
      tz: "Australia/Brisbane",
      date: "Tuesday 24 November 2026",
      time: "09:15",
      zone: "Australia/Brisbane, UTC+10:00",
    });
  });

  it("follows daylight saving from the zone, not a stale offset", () => {
    // Sydney is UTC+11 in November; the client's offset claims +10.
    expect(formatLocalTime(NOW, { tz: "Australia/Sydney", utc_offset_min: 600 })).toMatchObject({
      at: "2026-11-24T10:15+11:00",
      zone: "Australia/Sydney, UTC+11:00",
    });
    // New York in summer and winter.
    expect(formatLocalTime(new Date("2026-07-01T16:00:00Z"), { tz: "America/New_York" })?.zone).toBe(
      "America/New_York, UTC-04:00",
    );
    expect(formatLocalTime(new Date("2026-12-01T16:00:00Z"), { tz: "America/New_York" })?.zone).toBe(
      "America/New_York, UTC-05:00",
    );
  });

  it("handles part-hour and far-east zones", () => {
    expect(formatLocalTime(NOW, { tz: "Asia/Kolkata" })).toMatchObject({ time: "04:45", zone: "Asia/Kolkata, UTC+05:30" });
    // Chatham is UTC+13:45 in summer: already Tuesday, 13:00.
    expect(formatLocalTime(NOW, { tz: "Pacific/Chatham" })).toMatchObject({
      date: "Tuesday 24 November 2026",
      time: "13:00",
      zone: "Pacific/Chatham, UTC+13:45",
    });
  });

  it("crosses the date line backwards for a negative offset", () => {
    // Honolulu, UTC-10: still Monday evening.
    expect(formatLocalTime(NOW, { tz: "Pacific/Honolulu" })).toMatchObject({
      at: "2026-11-23T13:15-10:00",
      date: "Monday 23 November 2026",
    });
  });

  it("falls back to the offset for a zone the server does not know", () => {
    expect(formatLocalTime(NOW, { tz: "Mars/Olympus_Mons", utc_offset_min: 330 })).toEqual({
      at: "2026-11-24T04:45+05:30",
      date: "Tuesday 24 November 2026",
      time: "04:45",
      zone: "UTC+05:30",
    });
    expect(formatLocalTime(NOW, { utc_offset_min: -180 })?.zone).toBe("UTC-03:00");
    expect(formatLocalTime(NOW, { utc_offset_min: 0 })?.zone).toBe("UTC+00:00");
  });

  it("gives nothing when neither the zone nor the offset is usable", () => {
    expect(formatLocalTime(NOW, { tz: "Mars/Olympus_Mons" })).toBeNull();
    expect(formatLocalTime(NOW, {})).toBeNull();
  });
});

describe("localTimeBlock", () => {
  it("words a device's send, a schedule's, and a schedule on the server's clock", () => {
    expect(localTimeBlock(NOW, { tz: "Australia/Brisbane" }, "device")).toEqual({
      kind: "local_time",
      at: "2026-11-24T09:15+10:00",
      tz: "Australia/Brisbane",
      source: "device",
      text: "<local-time>The user sent this message on Tuesday 24 November 2026 at 09:15, their local time (Australia/Brisbane, UTC+10:00).</local-time>",
    });
    expect(localTimeBlock(NOW, { tz: "Australia/Brisbane" }, "schedule")?.text).toBe(
      "<local-time>A schedule sent this message on Tuesday 24 November 2026 at 09:15, the user's local time (Australia/Brisbane, UTC+10:00).</local-time>",
    );
    expect(localTimeBlock(NOW, { tz: "Australia/Brisbane" }, "schedule", "server")?.text).toContain("the server's local time");
  });

  it("is absent with no zone, as for an older client", () => {
    expect(localTimeBlock(NOW, null, "device")).toBeNull();
    expect(localTimeBlock(NOW, { tz: "Nowhere/Special" }, "device")).toBeNull();
  });
});

describe("normalizeClientLocalTime", () => {
  it("keeps a well-formed zone and offset", () => {
    expect(normalizeClientLocalTime({ tz: "America/Argentina/Buenos_Aires", utc_offset_min: -180 })).toEqual({
      tz: "America/Argentina/Buenos_Aires",
      utc_offset_min: -180,
    });
    expect(normalizeClientLocalTime({ tz: "Etc/GMT+10" })).toEqual({ tz: "Etc/GMT+10" });
  });

  it("drops what is malformed, and gives null when nothing is left", () => {
    for (const bad of [null, undefined, "UTC", [], 42, {}, { tz: "" }, { tz: "a b" }, { tz: "../etc" }, { tz: "x".repeat(65) }]) {
      expect(normalizeClientLocalTime(bad)).toBeNull();
    }
    for (const offset of [NaN, 1.5, 841, -841, "600", Infinity]) {
      expect(normalizeClientLocalTime({ utc_offset_min: offset })).toBeNull();
    }
    expect(normalizeClientLocalTime({ tz: "bad zone", utc_offset_min: 600 })).toEqual({ utc_offset_min: 600 });
  });
});

describe("deviceLocalTime", () => {
  it("sends the runtime's zone and the offset at that moment", () => {
    const got = deviceLocalTime(NOW);
    expect(got.utc_offset_min).toBe(-NOW.getTimezoneOffset());
    expect(got.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("localTimeBlock for a private zone", () => {
  it("dates the message in UTC, names no zone, and says why", () => {
    const block = localTimeBlock(NOW, { utc_offset_min: 0 }, "device", "private");
    expect(block).toEqual({
      kind: "local_time",
      at: "2026-11-23T23:15+00:00",
      source: "device",
      text: "<local-time>The user sent this message on Monday 23 November 2026 at 23:15, in UTC; the user keeps their time zone private (UTC+00:00).</local-time>",
    });
  });
});

describe("withoutOthersLocalTime", () => {
  const content = [
    { kind: "text", text: "hi" },
    { kind: "local_time", at: "2026-11-24T09:15+10:00", tz: "Australia/Brisbane", source: "device", text: "x" },
  ];

  it("keeps a sender's own block", () => {
    expect(withoutOthersLocalTime(content, "a", "a")).toBe(content);
  });

  it("leaves the block out for anyone else, and for a row with no author", () => {
    expect(withoutOthersLocalTime(content, "a", "b")).toEqual([content[0]]);
    expect(withoutOthersLocalTime(content, null, "b")).toEqual([content[0]]);
  });

  it("returns content with no block, or not a list, as it was", () => {
    const plain = [content[0]];
    expect(withoutOthersLocalTime(plain, "a", "b")).toBe(plain);
    expect(withoutOthersLocalTime("text", "a", "b")).toBe("text");
  });
});
