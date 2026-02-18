import axios from "axios";
import dotenv from "dotenv";

dotenv.config({ path: "../.env" });

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
  forecast?: any; // If raw=true
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
  if (!API_KEY) {
    console.warn("⚠️  BESTTIME_API_KEY not set – skipping venue search");
    return [];
  }

  try {
    // 1. Start the search job
    const response = await axios.post(`${BASE_URL}/venues/search`, null, {
      params: {
        api_key_private: API_KEY,
        q: query,
        lat,
        lng,
        radius,
        format: "raw", // Get raw forecast data immediately
        num: 20, // Max 20 per page (1 credit cost)
      },
    });

    const data = response.data;
    if (data.status !== "OK" || !data.job_id) {
      console.log(
        `  ❌ BestTime search init failed: ${data.message || "unknown"}`,
      );
      return [];
    }

    const jobId = data.job_id;
    const collectionId = data.collection_id;
    console.log(
      `  ⏳ BestTime search job started (ID: ${jobId}). Polling for results...`,
    );

    // 2. Poll for results
    // Iterate for max 20 seconds (10 attempts * 2s)
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000)); // wait 2s

      try {
        const progressRes = await axios.get(`${BASE_URL}/venues/progress`, {
          params: {
            job_id: jobId,
            collection_id: collectionId,
            format: "raw",
          },
        });

        const pData = progressRes.data;

        // Check if finished
        if (pData.job_finished) {
          const venues = (pData.venues || []) as any[];
          console.log(
            `  ✅ BestTime search finished. Found ${venues.length} venues.`,
          );

          return venues.map((v: any) => ({
            venue_id: v.venue_id,
            venue_name: v.venue_name,
            venue_address: v.venue_address,
            venue_lat: v.venue_lat,
            venue_lon: v.venue_lon,
            forecast: v.venue_foot_traffic_forecast || null,
          }));
        }

        console.log(`     ... polling attempt ${i + 1}/10`);
      } catch (pollErr) {
        console.warn("     Polling error (retrying):", pollErr);
      }
    }

    console.warn("  ⚠️  BestTime search timed out after 20s.");
    return [];
  } catch (error: any) {
    const msg = error.response?.data?.message
      ? JSON.stringify(error.response.data.message)
      : error.message;
    console.error(`  ❌ BestTime searchVenues error: ${msg}`);
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
