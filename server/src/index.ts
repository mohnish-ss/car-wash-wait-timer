import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import NodeCache from "node-cache";
import rateLimit from "express-rate-limit";
import {
  searchVenues,
  generateSyntheticForecast,
  mapBusynessToMinutes,
  identifyVenue,
  getVenueForecast,
  getLiveBusyness,
  fetchGoogleOperatingHours,
} from "./besttime.service";
import { cleanAddress, detectBrandAndType } from "./utils";
import {
  upsertVenue,
  getVenueById,
  getVenuesInBoundingBox,
  isForecastFresh,
  updateCommunityWait,
  DBVenue,
} from "./database";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : false,
}));
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "../public")));

// Live cache: 60 minute TTL
const liveCache = new NodeCache({ stdTTL: 3600 });
const FORECAST_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_RADIUS_METERS = 25000;
const DEFAULT_RADIUS_METERS = 5000;

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

const expensiveApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

app.use("/api", apiLimiter);

function parseLatitude(value: unknown): number | null {
  const lat = typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 ? lat : null;
}

function parseLongitude(value: unknown): number | null {
  const lng = typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(lng) && lng >= -180 && lng <= 180 ? lng : null;
}

function parseRadius(value: unknown): number {
  if (typeof value !== "string") return DEFAULT_RADIUS_METERS;
  const radius = Number.parseInt(value, 10);
  if (!Number.isFinite(radius) || radius <= 0) return DEFAULT_RADIUS_METERS;
  return Math.min(radius, MAX_RADIUS_METERS);
}

function getRouteParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.length > 0 && value.length <= 128) {
    return value;
  }
  return null;
}

interface CarWashResponse {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  brand: string | null;
  washType: string | null;
  waitTimeLogs: Array<{
    id: string;
    carWashId: string;
    timestamp: string;
    busynessScore: number;
    isLive: boolean;
    estimatedMinutes: number;
    isClosed: boolean;
  }>;
  dataSource: "forecast" | "live" | "community";
  verifiedAt?: string | null;
}

function computeCurrentWait(forecast: any): {
  busynessScore: number;
  estimatedMinutes: number;
  isClosed: boolean;
} {
  if (!forecast) {
    return { busynessScore: 0, estimatedMinutes: -1, isClosed: false };
  }
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
    return { busynessScore: 0, estimatedMinutes: -1, isClosed: false };
  }

  const now = new Date();
  const tz = "America/New_York";
  const dayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" });
  const hourFormatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
  const weekdayStr = dayFormatter.format(now);
  const hourStr = hourFormatter.format(now);
  const currentHour = parseInt(hourStr, 10);

  const weekdayMap: Record<string, number> = {
    Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6,
  };
  const btDay = weekdayMap[weekdayStr];
  const dayRawIndex = (currentHour - 6 + 24) % 24;

  const dayData = days.find((d: any) => d.day_info?.day_int === btDay || d.day_int === btDay);

  if (dayData?.day_raw) {
    const openHour = dayData.day_info?.venue_open ?? 0;
    const closeHour = dayData.day_info?.venue_closed ?? 24;
    const venueClosedToday = dayData.day_info?.venue_closed === 0 && dayData.day_info?.venue_open === 0;

    if (venueClosedToday || currentHour < openHour || currentHour >= closeHour) {
      return { busynessScore: 0, estimatedMinutes: 0, isClosed: true };
    }

    const busynessScore: number = dayData.day_raw[dayRawIndex] || 0;
    return {
      busynessScore,
      estimatedMinutes: mapBusynessToMinutes(busynessScore),
      isClosed: false,
    };
  }
  return { busynessScore: 0, estimatedMinutes: -1, isClosed: false };
}

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

function getDistanceFromLatLonInMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function deg2rad(deg: number) {
  return deg * (Math.PI / 180);
}

function formatResponse(venue: DBVenue): CarWashResponse {
  let forecast = null;
  try {
    if (venue.forecast_json) {
      forecast = JSON.parse(venue.forecast_json);
    }
  } catch (e) {}

  const { busynessScore, estimatedMinutes, isClosed } = computeCurrentWait(forecast);
  const nowIso = new Date().toISOString();

  let finalMins = estimatedMinutes;
  let finalBusyness = busynessScore;
  let dataSource: "forecast" | "live" | "community" = "forecast";
  let verifiedAt: string | null = null;
  
  if (venue.community_wait_updated_at && venue.community_wait_minutes !== null) {
      if (Date.now() - venue.community_wait_updated_at < 2 * 60 * 60 * 1000) {
          finalMins = venue.community_wait_minutes;
          finalBusyness = Math.min(100, Math.round(finalMins * 4));
          dataSource = "community";
          verifiedAt = new Date(venue.community_wait_updated_at).toISOString();
      }
  }

  return {
    id: venue.id,
    name: venue.name,
    address: venue.address,
    latitude: venue.latitude,
    longitude: venue.longitude,
    brand: venue.brand,
    washType: venue.wash_type,
    waitTimeLogs: finalMins >= 0 ? [{
      id: `log_${venue.id}`,
      carWashId: venue.id,
      timestamp: verifiedAt || nowIso,
      busynessScore: finalBusyness,
      isLive: dataSource !== "forecast",
      estimatedMinutes: finalMins,
      isClosed,
    }] : [],
    dataSource,
    verifiedAt,
  };
}

app.get("/api/carwashes", expensiveApiLimiter, async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    const lat = parseLatitude(req.query.lat);
    const lng = parseLongitude(req.query.lng);
    const radius = parseRadius(req.query.radius);
    const brand = req.query.brand as string | undefined;
    const washType = req.query.washType as string | undefined;

    if (lat === null || lng === null) {
      return res.status(400).json({ error: "Valid lat and lng query params are required" });
    }

    const bb = radiusToBoundingBox(lat, lng, radius);
    let dbVenues = getVenuesInBoundingBox(bb.minLat, bb.maxLat, bb.minLng, bb.maxLng);
    
    // Check if we have fresh data for the area
    const hasFreshCache = dbVenues.length > 0 && dbVenues.some(v => isForecastFresh(v, FORECAST_TTL_MS));
    
    if (!hasFreshCache) {
      // Fetch from Overpass
      try {
        const venues = await searchVenues(lat, lng, radius, "car wash");
        
        // Immediately upsert to DB with synthetic forecasts to return fast
        for (const v of venues) {
          const { brand: b, washType: wt } = detectBrandAndType(v.venue_name, v.venue_address);
          const synthetic = generateSyntheticForecast(v.venue_name, { osmHours: v.osm_opening_hours });
          upsertVenue({
            id: v.venue_id,
            name: v.venue_name,
            address: v.venue_address,
            latitude: v.venue_lat,
            longitude: v.venue_lon,
            brand: b,
            wash_type: wt,
            forecast_json: JSON.stringify(synthetic),
            forecast_updated_at: Date.now() - FORECAST_TTL_MS - 1000, // Mark as stale so we fetch real data later
          });
        }
        
        // Background: Fetch real forecasts and Google hours
        (async () => {
          for (const v of venues) {
            try {
              let forecast = null;
              
              // 1. Try BestTime
              const ident = await identifyVenue(v.venue_name, v.venue_address || `${v.venue_lat},${v.venue_lon}`);
              if (ident && ident.forecast) {
                forecast = ident.forecast;
              } else {
                // 2. If BestTime fails, try Google Places for accurate synthetic hours
                const googleHours = await fetchGoogleOperatingHours(v.venue_name, v.venue_lat, v.venue_lon);
                forecast = generateSyntheticForecast(v.venue_name, { googleHours, osmHours: v.osm_opening_hours });
              }
              
              upsertVenue({
                id: v.venue_id,
                besttime_venue_id: ident?.venueId || null,
                forecast_json: JSON.stringify(forecast),
                forecast_updated_at: Date.now(),
              });
            } catch (err) {}
          }
        })();
        
        // Re-fetch from DB
        dbVenues = getVenuesInBoundingBox(bb.minLat, bb.maxLat, bb.minLng, bb.maxLng);
      } catch (err) {
        console.error("Venue search failed:", err);
      }
    }

    let results = dbVenues.map(formatResponse);

    results = results.filter((cw) => {
      const dist = getDistanceFromLatLonInMeters(lat, lng, cw.latitude, cw.longitude);
      return dist <= radius;
    });

    let filtered = results.filter((cw) => {
      const t = (cw.washType || "").toLowerCase();
      return t !== "hand-wash";
    });

    if (brand) filtered = filtered.filter((cw) => cw.brand === brand);
    if (washType) filtered = filtered.filter((cw) => cw.washType === washType);

    res.json(filtered);
  } catch (error) {
    console.error("Error fetching car washes:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/filters", (_req, res) => {
  // Simplification for now, we could query DB
  // For the sake of speed, we'll return fixed list or query all unique brands
  res.json({
    brands: ["Shell", "Petro-Canada", "Esso", "Mobil", "Canadian Tire", "Husky"],
    washTypes: ["automatic", "touchless", "self-serve"]
  });
});

app.get("/api/carwashes/:id", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  const id = getRouteParam(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid car wash id" });
  }
  const venue = getVenueById(id);
  if (!venue) {
    return res.status(404).json({ error: "Car wash not found" });
  }
  res.json(formatResponse(venue));
});

app.get("/api/carwashes/:id/live", expensiveApiLimiter, async (req, res) => {
  try {
    const id = getRouteParam(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid car wash id" });
    }
    const venue = getVenueById(id);
    if (!venue) return res.status(404).json({ error: "Not found" });

    const baseResponse = formatResponse(venue);
    baseResponse.dataSource = "live";

    // 1. Check NodeCache
    const cacheKey = `live_${venue.id}`;
    const cachedLive = liveCache.get(cacheKey) as any;
    if (cachedLive) {
      if (baseResponse.waitTimeLogs.length > 0) {
        baseResponse.waitTimeLogs[0].isLive = true;
        baseResponse.waitTimeLogs[0].busynessScore = cachedLive.busynessScore;
        baseResponse.waitTimeLogs[0].estimatedMinutes = cachedLive.estimatedMinutes;
      }
      return res.json(baseResponse);
    }

    // 2. Need BestTime venue ID
    let btId = venue.besttime_venue_id;
    if (!btId) {
      const ident = await identifyVenue(venue.name, venue.address || `${venue.latitude},${venue.longitude}`);
      if (ident) {
        btId = ident.venueId;
        upsertVenue({
          id: venue.id,
          besttime_venue_id: btId,
          forecast_json: ident.forecast ? JSON.stringify(ident.forecast) : venue.forecast_json,
          forecast_updated_at: ident.forecast ? Date.now() : venue.forecast_updated_at
        });
      }
    }

    if (btId) {
      const liveData = await getLiveBusyness(btId);
      if (liveData && liveData.isLive) {
        const estMins = mapBusynessToMinutes(liveData.liveScore);
        if (baseResponse.waitTimeLogs.length > 0) {
          baseResponse.waitTimeLogs[0].isLive = true;
          baseResponse.waitTimeLogs[0].busynessScore = liveData.liveScore;
          baseResponse.waitTimeLogs[0].estimatedMinutes = estMins;
        }
        
        // Save to cache
        liveCache.set(cacheKey, {
          busynessScore: liveData.liveScore,
          estimatedMinutes: estMins
        });
      }
    }

    return res.json(baseResponse);
  } catch (error) {
    console.error("Live fetch error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/carwashes/:id/report", reportLimiter, (req, res) => {
  const id = getRouteParam(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid car wash id" });
  }
  const venue = getVenueById(id);
  if (!venue) {
    return res.status(404).json({ error: "Car wash not found" });
  }

  const { estimatedMinutes } = req.body;
  if (!Number.isInteger(estimatedMinutes) || estimatedMinutes < 0 || estimatedMinutes > 120) {
    return res.status(400).json({ error: "estimatedMinutes must be an integer from 0 to 120" });
  }

  const busynessScore = Math.min(100, Math.round(estimatedMinutes * 4));
  
  updateCommunityWait(venue.id, estimatedMinutes);
  
  // Update live cache
  const cacheKey = `live_${venue.id}`;
  liveCache.set(cacheKey, {
    busynessScore,
    estimatedMinutes
  });

  res.json({ success: true, estimatedMinutes, busynessScore });
});

app.get("/api/geocode", expensiveApiLimiter, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, max-age=0");
    const address = req.query.address as string;
    if (!address || address.length > 200) {
      return res.status(400).json({ error: "address query param is required" });
    }

    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;
    const response = await fetch(url, { headers: { "User-Agent": "CarWashWaitTime/1.0" } });
    const results = (await response.json()) as Array<any>;

    if (!results || results.length === 0) {
      return res.status(404).json({ error: "Address not found" });
    }

    res.json({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon), displayName: results[0].display_name });
  } catch (error) {
    res.status(500).json({ error: "Geocoding failed" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

export default app;
