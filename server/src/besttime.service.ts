import axios from "axios";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const API_KEY = process.env.BESTTIME_API_KEY || "";
const BASE_URL = "https://besttime.app/api/v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VenueIdentification {
  venueId: string;
  forecast: any; // raw 7-day forecast JSON
}

export interface LiveBusyness {
  liveScore: number; // 0-100
  forecastedScore: number; // what it usually is at this time
  isLive: boolean;
}

export interface VenueSearchResult {
  venue_id: string;
  venue_name: string;
  venue_address: string;
  venue_lat: number;
  venue_lon: number;
  forecast: any | null;
  has_forecast: boolean;
}

// ---------------------------------------------------------------------------
// BestTime API Service
// ---------------------------------------------------------------------------

/**
 * POST /forecasts — Identify a venue and get its 7-day forecast.
 * BestTime uses QUERY PARAMS, not JSON body.
 * Returns the venue_id (needed for future live calls) + the raw forecast.
 * Costs 1 credit per new venue.
 */
export async function identifyVenue(
  name: string,
  address: string,
): Promise<VenueIdentification | null> {
  if (!API_KEY) {
    console.warn(
      "⚠️  BESTTIME_API_KEY not set – skipping venue identification",
    );
    return null;
  }

  try {
    const response = await axios.post(`${BASE_URL}/forecasts`, null, {
      params: {
        api_key_private: API_KEY,
        venue_name: name,
        venue_address: address,
      },
    });

    const data = response.data;

    if (data.status !== "OK" || !data.venue_info?.venue_id) {
      console.log(
        `  ❌ BestTime could not identify "${name}" at "${address}": ${data.message || "unknown"}`,
      );
      return null;
    }

    const venueId = data.venue_info.venue_id;
    const forecast = data.analysis || null;

    console.log(`  ✅ Identified "${name}" → venue_id: ${venueId}`);
    return { venueId, forecast };
  } catch (error: any) {
    const msg = error.response?.data?.message
      ? JSON.stringify(error.response.data.message)
      : error.message;
    console.error(`  ❌ BestTime identifyVenue error for "${name}": ${msg}`);
    return null;
  }
}

/**
 * POST /forecasts/live — Get real-time busyness for a venue.
 * Can use venue_id (recommended) or name+address.
 * Costs 1 credit per call.
 */
export async function getLiveBusyness(
  venueId: string,
): Promise<LiveBusyness | null> {
  if (!API_KEY) {
    console.warn("⚠️  BESTTIME_API_KEY not set – skipping live busyness");
    return null;
  }

  try {
    const response = await axios.post(`${BASE_URL}/forecasts/live`, null, {
      params: {
        api_key_private: API_KEY,
        venue_id: venueId,
      },
    });

    const data = response.data;

    if (data.status !== "OK") {
      console.log(
        `  ⚠️  No live data for venue ${venueId}: ${data.message || "unknown"}`,
      );
      return null;
    }

    const analysis = data.analysis || {};
    const liveScore = Math.max(
      0,
      Math.min(100, analysis.venue_live_busyness ?? 0),
    );
    const forecastedScore = Math.max(
      0,
      Math.min(100, analysis.venue_forecasted_busyness ?? 0),
    );

    return {
      liveScore,
      forecastedScore,
      isLive: analysis.venue_live_busyness_available === true,
    };
  } catch (error: any) {
    const msg = error.response?.data?.message
      ? JSON.stringify(error.response.data.message)
      : error.message;
    console.error(`  ❌ BestTime live error for venue ${venueId}: ${msg}`);
    return null;
  }
}

/**
 * POST /venues/search — Find venues directly via BestTime.
 * Matches best against "car wash" query + lat/lng/radius.
 * This is an ASYNC job. We must poll /venues/progress to get results.
 * Returns list of venues, potentially with forecast data if we ask for it (Cost: 1 credit per 20 results).
 */
export async function searchVenues(
  lat: number,
  lng: number,
  radius: number, // meters
  query: string = "car wash",
): Promise<VenueSearchResult[]> {
  try {
    const opQuery = `[out:json][timeout:10];(node["amenity"="car_wash"](around:${radius},${lat},${lng});way["amenity"="car_wash"](around:${radius},${lat},${lng});relation["amenity"="car_wash"](around:${radius},${lat},${lng}););out center;`;

    const response = await axios.post(
      "https://overpass-api.de/api/interpreter",
      `data=${encodeURIComponent(opQuery)}`,
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );

    const elements = response.data?.elements || [];
    console.log(
      `  ✅ Overpass search finished. Found ${elements.length} venues.`,
    );

    return elements.map((e: any) => {
      const vLat = e.lat || e.center?.lat;
      const vLon = e.lon || e.center?.lon;
      const vName = e.tags?.name || "Car Wash";
      const vAddress =
        [
          e.tags?.["addr:housenumber"],
          e.tags?.["addr:street"],
          e.tags?.["addr:city"],
        ]
          .filter(Boolean)
          .join(", ") || "";
      return {
        venue_id: `op_${e.id}`, // Custom pseudo ID
        venue_name: vName,
        venue_address: vAddress,
        venue_lat: vLat,
        venue_lon: vLon,
        forecast: null,
        has_forecast: false,
      };
    });
  } catch (error: any) {
    console.error("Overpass search error:", error.message);
    return [];
  }
}

/**
 * Convert a 0-100 busyness score to estimated wait minutes.
 * Model: busyness % maps to estimated cars in queue, each taking ~4.5 min.
 * 0-15%  = 0 cars (empty)
 * 16-40% = 1-2 cars
 * 41-70% = 3-5 cars
 * 71-100% = 6-8 cars
 */
export function mapBusynessToMinutes(score: number): number {
  const MINUTES_PER_CAR = 4.5;
  let estimatedCars: number;

  if (score <= 15) estimatedCars = 0;
  else if (score <= 40)
    estimatedCars = 1 + (score - 16) / 24; // ~1-2 cars
  else if (score <= 70)
    estimatedCars = 2 + (score - 40) / 10; // ~2-5 cars
  else estimatedCars = 5 + (score - 70) / 10; // ~5-8 cars

  return Math.round(estimatedCars * MINUTES_PER_CAR);
}
