/**
 * The nearest town to a point, from a list read once (cities.ts). A plain scan:
 * about 34,000 towns take well under a millisecond, and the list never changes
 * while the server runs.
 */
export interface Towns {
  names: string[];
  regions: string[];
  countries: string[];
  /** Degrees, one entry per town. */
  lat: Float64Array;
  lon: Float64Array;
}

export interface NearestTown {
  name: string;
  region: string;
  country: string;
  /** Great-circle distance from the point. */
  km: number;
}

const EARTH_KM = 6371;
const RAD = Math.PI / 180;

/** Haversine distance in kilometres. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The town nearest `lat, lon`, or null for an empty list. */
export function nearestTown(towns: Towns, lat: number, lon: number): NearestTown | null {
  let best = -1;
  let bestKm = Infinity;
  for (let i = 0; i < towns.lat.length; i++) {
    const km = distanceKm(lat, lon, towns.lat[i], towns.lon[i]);
    if (km < bestKm) {
      bestKm = km;
      best = i;
    }
  }
  if (best < 0) return null;
  return { name: towns.names[best], region: towns.regions[best], country: towns.countries[best], km: bestKm };
}

/** Reads the TSV written by scripts/build-cities.mjs: `#` lines are comments. */
export function parseTowns(text: string): Towns {
  const names: string[] = [];
  const regions: string[] = [];
  const countries: string[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 5) continue;
    const [name, region, country, lat, lon] = fields;
    const la = Number(lat);
    const lo = Number(lon);
    if (!name || !lat || !lon || !Number.isFinite(la) || !Number.isFinite(lo)) continue;
    names.push(name);
    regions.push(region);
    countries.push(country);
    lats.push(la);
    lons.push(lo);
  }
  return { names, regions, countries, lat: Float64Array.from(lats), lon: Float64Array.from(lons) };
}
