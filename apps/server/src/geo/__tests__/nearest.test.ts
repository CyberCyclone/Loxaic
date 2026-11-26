import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTowns, townsFile } from "../cities.ts";
import { distanceKm, nearestTown, parseTowns } from "../nearest.ts";

describe("the bundled town list", () => {
  it("loads, with the GeoNames attribution its licence asks for", async () => {
    const towns = await loadTowns();
    expect(towns.names.length).toBeGreaterThan(20_000);
    expect(towns.lat.length).toBe(towns.names.length);
    const head = readFileSync(townsFile(), "utf8").slice(0, 400);
    expect(head).toContain("Contains data from GeoNames (https://www.geonames.org), licensed under CC BY 4.0");
  });

  it("is read once, however many ask at the same time", async () => {
    const [a, b] = await Promise.all([loadTowns(), loadTowns()]);
    expect(a).toBe(b);
  });
});

describe("nearestTown", () => {
  it("names the town a point is in", async () => {
    const towns = await loadTowns();
    expect(nearestTown(towns, -27.47, 153.03)).toMatchObject({ name: "Brisbane", region: "Queensland", country: "Australia" });
    expect(nearestTown(towns, 51.51, -0.13)).toMatchObject({ name: "London", country: "United Kingdom" });
    expect(nearestTown(towns, -27.47, 153.03)?.km).toBeLessThan(5);
  });

  it("says how far the nearest is from the middle of an ocean", async () => {
    // Mid-Pacific: nothing within hundreds of kilometres.
    const far = nearestTown(await loadTowns(), 0, -140);
    expect(far?.km).toBeGreaterThan(500);
  });

  it("measures across the antimeridian the short way", () => {
    const towns = parseTowns("# header\nWest\t\tFiji\t-17.0\t179.9\nFar\t\tSomewhere\t-17.0\t0.0\n");
    const near = nearestTown(towns, -17.0, -179.9);
    expect(near?.name).toBe("West");
    expect(near?.km).toBeLessThan(25);
    expect(distanceKm(0, 179.9, 0, -179.9)).toBeCloseTo(22.2, 0);
  });

  it("works at a pole, and gives nothing for an empty list", () => {
    const towns = parseTowns("North\t\t\t89.0\t10.0\nSouth\t\t\t-89.0\t10.0\n");
    expect(nearestTown(towns, 90, -170)?.name).toBe("North");
    expect(nearestTown(parseTowns("# only a comment\n"), 0, 0)).toBeNull();
  });

  it("skips a malformed line rather than misreading it", () => {
    const towns = parseTowns("Good\tR\tC\t1\t2\nBad\tR\tC\tnot-a-number\t2\n\t\t\t3\t4\n");
    expect(towns.names).toEqual(["Good"]);
  });
});
