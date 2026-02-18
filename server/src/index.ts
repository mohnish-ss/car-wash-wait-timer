import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { searchVenues, mapBusynessToMinutes } from "./besttime.service";
import { cleanAddress, detectBrandAndType } from "./utils";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.json());

app.use(express.static(path.join(__dirname, "../public")));

// ---------------------------------------------------------------------------
// In-memory cache (replaces the database)
// ---------------------------------------------------------------------------

interface CachedCarWash {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  brand: string | null;
  washType: string | null;
  forecast: any;
  waitTimeLogs: Array<{
    id: string;
    carWashId: string;
    timestamp: string;
    busynessScore: number;
    isLive: boolean;
    estimatedMinutes: number;
  }>;
  cachedAt: number;
}

/**
 * venue_id → CachedCarWash
 * WARNING: In-memory cache is ephemeral on Vercel (serverless). It is wiped on cold starts and not shared between instances.
 * For production, rely on BestTime API's internal caching or a persistent database.
 */
const carWashCache = new Map<string, CachedCarWash>();

/** How long a cache entry is considered fresh (20 minutes) */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the current busyness from a BestTime weekly forecast.
 */
function computeCurrentWait(forecast: any): {
  busynessScore: number;
  estimatedMinutes: number;
} {
  if (!forecast) {
    return { busynessScore: 0, estimatedMinutes: -1 };
  }

  // Normalize forecast structure
  let days: any[] | null = null;
  if (Array.isArray(forecast)) {
    days = forecast;
  } else if (forecast.analysis && Array.isArray(forecast.analysis)) {
    days = forecast.analysis;
  } else if (typeof forecast === "object") {
    for (const key of Object.keys(forecast)) {
      if (Array.isArray(forecast[key])) {
        days = forecast[key];
        break;
      }
    }
  }
  if (!days || days.length === 0) {
    console.log(
      "  ⚠️  Forecast structure unrecognized:",
      JSON.stringify(forecast).slice(0, 300),
    );
    return { busynessScore: 0, estimatedMinutes: -1 };
  }

  // Get current day and hour in America/New_York
  const now = new Date();
  const tz = "America/New_York";
  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
  });
  const hourFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });
  const weekdayStr = dayFormatter.format(now); // e.g., "Monday"
  const hourStr = hourFormatter.format(now); // e.g., "14"
  const currentHour = parseInt(hourStr, 10);

  // BestTime: 0 = Mon, 6 = Sun
  const weekdayMap: Record<string, number> = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };
  const btDay = weekdayMap[weekdayStr];
  // BestTime's day_raw: index 0 = 6am, so offset by 6
  const dayRawIndex = (currentHour - 6 + 24) % 24;

  const dayData = days.find(
    (d: any) => d.day_info?.day_int === btDay || d.day_int === btDay,
  );

  if (dayData?.day_raw) {
    const busynessScore: number = dayData.day_raw[dayRawIndex] || 0;
    return {
      busynessScore,
      estimatedMinutes: mapBusynessToMinutes(busynessScore),
    };
  }

  console.log(
    "  ⚠️  No day_raw found. dayData keys:",
    dayData ? Object.keys(dayData) : "no match",
    "btDay:",
    btDay,
    "sample day:",
    JSON.stringify(days[0]).slice(0, 200),
  );
  return { busynessScore: 0, estimatedMinutes: -1 };
}

/**
 * Convert a radius in meters to rough lat/lng deltas for a bounding-box filter.
 */
function radiusToBoundingBox(lat: number, lng: number, radiusMeters: number) {
  const latDelta = radiusMeters / 111_320;
  const lngDelta = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

/**
 * Build a car wash response object from a BestTime venue, using the cache.
 */
function venueToCarWash(
  venueId: string,
  name: string,
  address: string,
  lat: number,
  lon: number,
  forecast: any,
): CachedCarWash {
  const { brand, washType } = detectBrandAndType(name, address);
  const { busynessScore, estimatedMinutes } = computeCurrentWait(forecast);
  const now = new Date().toISOString();

  return {
    id: venueId,
    name,
    address: cleanAddress(address),
    latitude: lat,
    longitude: lon,
    brand,
    washType,
    forecast,
    waitTimeLogs:
      estimatedMinutes >= 0
        ? [
            {
              id: `log_${venueId}`,
              carWashId: venueId,
              timestamp: now,
              busynessScore,
              isLive: false,
              estimatedMinutes,
            },
          ]
        : [],
    cachedAt: Date.now(),
  };
}

/**
 * Calculate distance between two points in meters using Haversine formula.
 */
function getDistanceFromLatLonInMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
) {
  const R = 6371e3; // Radius of the earth in meters
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function deg2rad(deg: number) {
  return deg * (Math.PI / 180);
}

// ---------------------------------------------------------------------------
// Routes
/**
 * GET /api/debug/carwashes?lat=...&lng=...&radius=...
 * Returns raw BestTime API results and cache state for debugging.
 */
app.get("/api/debug/carwashes", async (req, res) => {
  try {
    const lat = req.query.lat ? parseFloat(req.query.lat as string) : undefined;
    const lng = req.query.lng ? parseFloat(req.query.lng as string) : undefined;
    const radius = req.query.radius
      ? parseInt(req.query.radius as string, 10)
      : 5000;
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: "lat/lng required" });
    }

    // Fetch fresh data from BestTime
    const venues = await searchVenues(lat, lng, radius, "car wash");

    // Get cache state for this area
    const bb = radiusToBoundingBox(lat, lng, radius);
    const now = Date.now();
    const cachedInArea = Array.from(carWashCache.values()).filter(
      (cw) =>
        cw.latitude >= bb.minLat &&
        cw.latitude <= bb.maxLat &&
        cw.longitude >= bb.minLng &&
        cw.longitude <= bb.maxLng,
    );

    res.json({
      venues,
      cachedInArea,
      cacheSize: carWashCache.size,
      now: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Debug endpoint error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
// ---------------------------------------------------------------------------

/**
 * GET /api/carwashes?lat=40.71&lng=-74.00&radius=5000&brand=X&washType=Y
 *
 * 1. Search BestTime for car washes near lat/lng (or return cached results)
 * 2. Compute current wait time from forecast data
 * 3. Filter by brand/washType if requested
 * 4. Return results
 */
app.get("/api/carwashes", async (req, res) => {
  try {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    const lat = req.query.lat ? parseFloat(req.query.lat as string) : undefined;
    const lng = req.query.lng ? parseFloat(req.query.lng as string) : undefined;
    const radius = req.query.radius
      ? parseInt(req.query.radius as string, 10)
      : 5000;
    const brand = req.query.brand as string | undefined;
    const washType = req.query.washType as string | undefined;

    if (lat === undefined || lng === undefined) {
      return res.json([]);
    }

    // ── Check if we have fresh cached results for this area ──────
    const bb = radiusToBoundingBox(lat, lng, radius);
    const now = Date.now();
    let results: CachedCarWash[] = [];

    // Collect cached results that are in the bounding box and still fresh
    const cachedInArea: CachedCarWash[] = [];
    let hasFreshCache = false;

    for (const cw of carWashCache.values()) {
      if (
        cw.latitude >= bb.minLat &&
        cw.latitude <= bb.maxLat &&
        cw.longitude >= bb.minLng &&
        cw.longitude <= bb.maxLng
      ) {
        cachedInArea.push(cw);
        if (now - cw.cachedAt < CACHE_TTL_MS) {
          hasFreshCache = true;
        }
      }
    }

    if (hasFreshCache && cachedInArea.length > 0) {
      // Refresh wait time computations (forecast changes by hour)
      results = cachedInArea.map((cw) => {
        const { busynessScore, estimatedMinutes } = computeCurrentWait(
          cw.forecast,
        );
        const nowIso = new Date().toISOString();
        return {
          ...cw,
          waitTimeLogs:
            estimatedMinutes >= 0
              ? [
                  {
                    id: `log_${cw.id}`,
                    carWashId: cw.id,
                    timestamp: nowIso,
                    busynessScore,
                    isLive: false,
                    estimatedMinutes,
                  },
                ]
              : [],
        };
      });
    } else {
      // ── Fetch fresh data from BestTime ──────────────────────────
      try {
        // Venue Search with format=raw automatically forecasts each venue.
        // venue_foot_traffic_forecast contains day_raw arrays when available.
        const venues = await searchVenues(lat, lng, radius, "car wash");

        for (const v of venues) {
          const cw = venueToCarWash(
            v.venue_id,
            v.venue_name,
            v.venue_address,
            v.venue_lat,
            v.venue_lon,
            v.forecast,
          );
          carWashCache.set(v.venue_id, cw);
          results.push(cw);
        }

        const withData = venues.filter((v) => v.has_forecast).length;
        console.log(
          `  📊 ${withData}/${venues.length} venues have foot traffic data`,
        );
      } catch (err) {
        console.error("BestTime search failed:", err);
        // Fall back to any stale cache we have
        results = cachedInArea;
      }
    }

    // ── Strict Radius Filtering ──────────────────────────────────
    // Bounding box (used above) is square, so corners are > radius.
    // We filter strictly by distance here.
    results = results.filter((cw) => {
      const dist = getDistanceFromLatLonInMeters(
        lat,
        lng,
        cw.latitude,
        cw.longitude,
      );
      return dist <= radius;
    });

    // ── Filter out hand-wash / detailers ──────────────────────────
    let filtered = results.filter((cw) => {
      const t = (cw.washType || "").toLowerCase();
      return t !== "hand-wash";
    });

    if (brand) filtered = filtered.filter((cw) => cw.brand === brand);
    if (washType) filtered = filtered.filter((cw) => cw.washType === washType);

    // Strip internal fields before sending to client
    const response = filtered.map(({ forecast, cachedAt, ...rest }) => rest);
    res.json(response);
  } catch (error) {
    console.error("Error fetching car washes:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/filters — returns distinct brand and washType values from the cache
 */
app.get("/api/filters", (_req, res) => {
  const brands = new Set<string>();
  const washTypes = new Set<string>();

  for (const cw of carWashCache.values()) {
    if (cw.brand) brands.add(cw.brand);
    if (cw.washType) washTypes.add(cw.washType);
  }

  res.json({
    brands: [...brands].sort(),
    washTypes: [...washTypes].sort(),
  });
});

/**
 * GET /api/carwashes/:id
 *
 * Returns a single car wash from cache with current wait time.
 */
app.get("/api/carwashes/:id", (req, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  const cw = carWashCache.get(req.params.id);
  if (!cw) {
    return res.status(404).json({ error: "Car wash not found" });
  }

  // Recompute wait time
  const { busynessScore, estimatedMinutes } = computeCurrentWait(cw.forecast);
  const nowIso = new Date().toISOString();

  const { forecast, cachedAt, ...rest } = cw;
  res.json({
    ...rest,
    waitTimeLogs:
      estimatedMinutes >= 0
        ? [
            {
              id: `log_${cw.id}`,
              carWashId: cw.id,
              timestamp: nowIso,
              busynessScore,
              isLive: false,
              estimatedMinutes,
            },
          ]
        : [],
  });
});

/**
 * POST /api/carwashes/:id/report
 *
 * User-reported wait time. Updates the in-memory cache with the reported value.
 */
app.post("/api/carwashes/:id/report", (req, res) => {
  const cw = carWashCache.get(req.params.id);
  if (!cw) {
    return res.status(404).json({ error: "Car wash not found" });
  }

  const { estimatedMinutes } = req.body;
  if (typeof estimatedMinutes !== "number" || estimatedMinutes < 0) {
    return res
      .status(400)
      .json({ error: "estimatedMinutes is required (number >= 0)" });
  }

  const busynessScore = Math.min(100, Math.round(estimatedMinutes * 4));
  const nowIso = new Date().toISOString();

  // Update cache with user-reported data
  cw.waitTimeLogs = [
    {
      id: `report_${cw.id}_${Date.now()}`,
      carWashId: cw.id,
      timestamp: nowIso,
      busynessScore,
      isLive: false,
      estimatedMinutes,
    },
  ];
  cw.cachedAt = Date.now(); // Keep it fresh

  res.json({ success: true, estimatedMinutes, busynessScore });
});

/**
 * GET /api/geocode?address=123+Main+St,+New+York
 *
 * Geocode an address to lat/lng using OpenStreetMap Nominatim (free, no key).
 */
app.get("/api/geocode", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, max-age=0");
    const address = req.query.address as string;
    if (!address) {
      return res.status(400).json({ error: "address query param is required" });
    }

    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;
    const response = await fetch(url, {
      headers: { "User-Agent": "CarWashWaitTime/1.0" },
    });
    const results = (await response.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
    }>;

    if (!results || results.length === 0) {
      return res.status(404).json({ error: "Address not found" });
    }

    res.json({
      lat: parseFloat(results[0].lat),
      lng: parseFloat(results[0].lon),
      displayName: results[0].display_name,
    });
  } catch (error) {
    console.error("Geocode error:", error);
    res.status(500).json({ error: "Geocoding failed" });
  }
});

/**
 * Health check
 */
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    cachedVenues: carWashCache.size,
  });
});

// ---------------------------------------------------------------------------
// Start server (only when run directly, not when imported by Vercel)
// ---------------------------------------------------------------------------

if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

export default app;
