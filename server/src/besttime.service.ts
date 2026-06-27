import axios from "axios";
import https from "https";
import path from "path";
import dotenv from "dotenv";

// Force HTTP/1.1 for APIs that don't support HTTP/2 (e.g. Overpass)
const http1Agent = new https.Agent({ });

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const API_KEY = process.env.BESTTIME_API_KEY || "";
const BASE_URL = "https://besttime.app/api/v1";
const BESTTIME_TIMEOUT_MS = 8000;

function isTransientBestTimeError(error: any): boolean {
  const status = error.response?.status;
  return (
    !error.response ||
    error.code === "ECONNABORTED" ||
    error.code === "ETIMEDOUT" ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

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
  osm_opening_hours?: string | null;
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
	      timeout: BESTTIME_TIMEOUT_MS,
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
	    if (isTransientBestTimeError(error)) {
	      throw error;
	    }
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
	      timeout: BESTTIME_TIMEOUT_MS,
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
 * Search for car wash venues near a location using Overpass API.
 * Returns results IMMEDIATELY (~1-2s) without blocking on BestTime.
 *
 * Foot-traffic enrichment happens separately via enrichVenuesInBackground().
 */
export async function searchVenues(
  lat: number,
  lng: number,
  radius: number, // meters
  query: string = "car wash",
): Promise<VenueSearchResult[]> {
  let elements: any[] = [];
  try {
    const opQuery = `[out:json][timeout:25];
(
  node["amenity"="car_wash"](around:${radius},${lat},${lng});
  way["amenity"="car_wash"](around:${radius},${lat},${lng});
  relation["amenity"="car_wash"](around:${radius},${lat},${lng});
);
out tags center;`;

    // Overpass API doesn't support HTTP/2 — force HTTP/1.1 via httpsAgent
    const response = await axios.post(
      "https://overpass-api.de/api/interpreter",
      `data=${encodeURIComponent(opQuery)}`,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "CarWashApp/1.0",
        },
        httpsAgent: http1Agent,
        timeout: 30000,
      },
    );

    elements = response.data?.elements || [];
    console.log(
      `  ✅ Overpass found ${elements.length} car wash locations`,
    );
  } catch (error: any) {
    const status = error.response?.status;
    const msg = error.response?.data
      ? (typeof error.response.data === "string"
          ? error.response.data.slice(0, 200)
          : JSON.stringify(error.response.data).slice(0, 200))
      : error.message;
    console.error(`  ❌ Overpass search error (HTTP ${status}): ${msg}`);
    return [];
  }

  const venues: VenueSearchResult[] = elements.map((e: any) => {
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
      venue_id: `op_${e.id}`,
      venue_name: vName,
      venue_address: vAddress,
      venue_lat: vLat,
      venue_lon: vLon,
      forecast: null,
      has_forecast: false,
      osm_opening_hours: e.tags?.opening_hours || null,
    };
  });

  return venues;
}

/**
 * Fetch operating hours from Google Places API if a key is provided.
 */
export async function fetchGoogleOperatingHours(
  venueName: string,
  lat: number,
  lng: number,
): Promise<any | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  try {
    const query = encodeURIComponent(venueName);
    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&location=${lat},${lng}&radius=500&key=${apiKey}`;
    const searchRes = await axios.get(searchUrl);

    if (searchRes.data.results && searchRes.data.results.length > 0) {
      const placeId = searchRes.data.results[0].place_id;
      const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=opening_hours&key=${apiKey}`;
      const detailsRes = await axios.get(detailsUrl);
      
      return detailsRes.data.result?.opening_hours || null;
    }
  } catch (err: any) {
    console.error("  ❌ Google Places API error:", err.message);
  }
  return null;
}

/**
 * Generate a realistic synthetic forecast for car washes without BestTime data.
 * Matches BestTime's forecast format.
 * If googleHours or osmHours is provided, we use the real hours.
 */
export function generateSyntheticForecast(venueName: string, options?: { googleHours?: any, osmHours?: string | null }): any[] {
  // Simple hash from venue name for per-venue variation (±15%)
  let hash = 0;
  for (let i = 0; i < venueName.length; i++) {
    hash = ((hash << 5) - hash + venueName.charCodeAt(i)) | 0;
  }
  const variation = 0.85 + (Math.abs(hash) % 30) / 100; // 0.85 - 1.15

  const dayNames = [
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
  ];

  // Base hourly patterns (index 0=6am ... 17=11pm, 18-23=midnight-5am)
  // Values are 0-100 busyness percentages
  const weekdayPattern = [
    5, 10, 25, 40, 55, 65, 70, 65, 55, 40, 30, 20, 15, 10, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0,
  ];
  const fridayPattern = [
    5, 15, 30, 50, 65, 75, 80, 75, 60, 45, 30, 20, 15, 10, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0,
  ];
  const saturdayPattern = [
    10, 20, 40, 60, 80, 95, 100, 95, 85, 70, 50, 35, 20, 10, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0,
  ];
  const sundayPattern = [
    5, 10, 25, 45, 60, 70, 75, 70, 55, 40, 25, 15, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ];

  const patterns = [
    weekdayPattern, weekdayPattern, weekdayPattern, weekdayPattern,
    fridayPattern, saturdayPattern, sundayPattern,
  ];

  // Typical car wash operating hours per day
  let openHours = [7, 7, 7, 7, 7, 7, 8]; // Mon-Sat 7am, Sun 8am
  let closeHours = [20, 20, 20, 20, 20, 20, 19]; // Mon-Sat 8pm, Sun 7pm

  // Many major gas station brands and local automated/self-serve washes operate 24/7
  const is24HourBrand = /petro[- ]?canada|shell|esso|mobil|circle[- ]?k|7-eleven|wawa|husky|pioneer|superwash|simoniz|glide wash|self serve|zoom auto spa/i.test(venueName);
  if (is24HourBrand) {
    openHours = [0, 0, 0, 0, 0, 0, 0];
    closeHours = [24, 24, 24, 24, 24, 24, 24];
  }

  // Override with Google Places hours if available
  if (options?.googleHours && options.googleHours.periods) {
    // Reset all to closed initially
    openHours = [0, 0, 0, 0, 0, 0, 0];
    closeHours = [0, 0, 0, 0, 0, 0, 0];
    
    for (const period of options.googleHours.periods) {
      if (!period.close) {
        // Open 24 hours
        openHours = [0, 0, 0, 0, 0, 0, 0];
        closeHours = [24, 24, 24, 24, 24, 24, 24];
        break;
      }
      // Google days: 0 = Sun, 1 = Mon ... 6 = Sat
      // BestTime days: 0 = Mon, 1 = Tue ... 6 = Sun
      let btDay = period.open.day - 1;
      if (btDay < 0) btDay = 6;
      
      const oHour = parseInt(period.open.time.substring(0, 2), 10);
      const cHour = parseInt(period.close.time.substring(0, 2), 10);
      
      openHours[btDay] = oHour;
      closeHours[btDay] = cHour === 0 ? 24 : cHour;
    }
  } else if (options?.osmHours) {
    // Basic OSM opening_hours parsing
    const str = options.osmHours.toLowerCase().trim();
    if (str === "24/7" || str.includes("00:00-24:00")) {
      openHours = [0, 0, 0, 0, 0, 0, 0];
      closeHours = [24, 24, 24, 24, 24, 24, 24];
    } else {
      // Basic regex for HH:MM-HH:MM
      const match = str.match(/(\d{1,2}):\d{2}\s*-\s*(\d{1,2}):\d{2}/);
      if (match) {
        const oHour = parseInt(match[1], 10);
        const cHour = parseInt(match[2], 10);
        openHours = [oHour, oHour, oHour, oHour, oHour, oHour, oHour];
        closeHours = [cHour, cHour, cHour, cHour, cHour, cHour, cHour];
      }
    }
  }

  return patterns.map((pattern, dayInt) => {
    const dayRaw = pattern.map((val) =>
      Math.min(100, Math.max(0, Math.round(val * variation))),
    );
    const dayMax = Math.max(...dayRaw);
    const dayMean = Math.round(dayRaw.reduce((a, b) => a + b, 0) / dayRaw.length);

    return {
      day_info: {
        day_int: dayInt,
        day_text: dayNames[dayInt],
        day_mean: dayMean,
        day_max: dayMax,
        day_rank_max: dayInt === 5 ? 1 : dayInt === 4 ? 2 : dayInt + 3,
        day_rank_mean: dayInt === 5 ? 1 : dayInt === 4 ? 2 : dayInt + 3,
        venue_open: openHours[dayInt],
        venue_closed: closeHours[dayInt],
      },
      day_int: dayInt,
      day_raw: dayRaw,
    };
  });
}

/**
 * GET /forecasts — Fetch the 7-day forecast using an existing venue_id.
 * This is free (costs 0 credits) if the venue has already been identified.
 */
export async function getVenueForecast(venueId: string): Promise<any | null> {
  if (!API_KEY) return null;

  try {
	    const response = await axios.get(`${BASE_URL}/forecasts`, {
	      params: {
	        api_key_private: API_KEY,
	        venue_id: venueId,
	      },
	      timeout: BESTTIME_TIMEOUT_MS,
	    });

    const data = response.data;
    if (data.status !== "OK") {
      console.log(`  ⚠️  Could not get forecast for venue ${venueId}: ${data.message || "unknown"}`);
      return null;
    }

    return data.analysis || null;
	  } catch (error: any) {
	    const msg = error.response?.data?.message
	      ? JSON.stringify(error.response.data.message)
	      : error.message;
	    console.error(`  ❌ BestTime getVenueForecast error for venue ${venueId}: ${msg}`);
	    if (isTransientBestTimeError(error)) {
	      throw error;
	    }
	    return null;
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
