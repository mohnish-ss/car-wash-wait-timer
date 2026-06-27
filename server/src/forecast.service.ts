import axios from "axios";
import https from "https";
import path from "path";
import dotenv from "dotenv";

// Force HTTP/1.1 for APIs that don't support HTTP/2 (e.g. Overpass)
const http1Agent = new https.Agent({ });

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

/**
 * Search for car wash venues near a location using Overpass API.
 * Returns results IMMEDIATELY (~1-2s).
 */
export async function searchVenues(
  lat: number,
  lng: number,
  radius: number, // meters
  query: string = "car wash",
): Promise<VenueSearchResult[]> {
  let elements: any[] = [];
  const opQuery = `[out:json][timeout:25];
(
  node["amenity"="car_wash"](around:${radius},${lat},${lng});
  way["amenity"="car_wash"](around:${radius},${lat},${lng});
  relation["amenity"="car_wash"](around:${radius},${lat},${lng});
);
out tags center;`;

  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter"
  ];

  let success = false;
  for (const endpoint of endpoints) {
    try {
      const response = await axios.post(
        endpoint,
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

      if (typeof response.data === "string" && response.data.includes("<html")) {
         throw new Error("Received HTML error page instead of JSON");
      }

      elements = response.data?.elements || [];
      console.log(`  ✅ Overpass (${endpoint}) found ${elements.length} car wash locations`);
      success = true;
      break;
    } catch (error: any) {
      const status = error.response?.status;
      const msg = error.response?.data
        ? (typeof error.response.data === "string"
            ? error.response.data.slice(0, 200)
            : JSON.stringify(error.response.data).slice(0, 200))
        : error.message;
      console.error(`  ⚠️ Overpass search error with ${endpoint} (HTTP ${status}): ${msg}`);
    }
  }

  if (!success) {
    console.error("  ❌ All Overpass endpoints failed.");
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
import NodeCache from "node-cache";

const weatherCache = new NodeCache({ stdTTL: 3600 });

export async function generateSyntheticForecast(
  venueName: string, 
  lat: number, 
  lng: number, 
  options?: { googleHours?: any, osmHours?: string | null }
): Promise<any[]> {
  // Simple hash from venue name for per-venue variation (±15%)
  let hash = 0;
  for (let i = 0; i < venueName.length; i++) {
    hash = ((hash << 5) - hash + venueName.charCodeAt(i)) | 0;
  }
  const variation = 0.85 + (Math.abs(hash) % 30) / 100; // 0.85 - 1.15

  // Fetch weather from Open-Meteo (with caching based on 1 decimal lat/lng grid)
  let weatherMultipliers = [1, 1, 1, 1, 1, 1, 1]; // Mon-Sun
  const cacheKey = `weather_${lat.toFixed(1)}_${lng.toFixed(1)}`;
  let cachedMultipliers = weatherCache.get<number[]>(cacheKey);

  if (cachedMultipliers) {
    weatherMultipliers = cachedMultipliers;
  } else {
    try {
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=weathercode&timezone=auto`;
      const res = await axios.get(weatherUrl, { timeout: 5000 });
      
      if (res.data?.daily?.weathercode) {
        const dailyCodes = res.data.daily.weathercode;
        const dailyTime = res.data.daily.time; 
        
        let wasRaining = false;
        for (let i = 0; i < Math.min(dailyCodes.length, 7); i++) {
          const code = dailyCodes[i];
          const dateStr = dailyTime[i];
          const dateObj = new Date(dateStr + "T12:00:00"); // Avoid timezone shift
          
          let btDay = dateObj.getDay() - 1;
          if (btDay < 0) btDay = 6;
          
          const isRaining = (code >= 51 && code <= 99);
          
          let multiplier = 1;
          if (isRaining) {
            multiplier = 0.2; // 80% drop in customers
          } else if (wasRaining) {
            multiplier = 1.4; // 40% surge on sunny day after rain
          }
          
          wasRaining = isRaining;
          weatherMultipliers[btDay] = multiplier;
        }
      }
    } catch (e) {
      console.error(`  ⚠️ Weather API error for ${venueName}: ${(e as Error).message}`);
    } finally {
      // Cache the result (even if it's the fallback all-1s) to prevent cascading timeouts
      weatherCache.set(cacheKey, weatherMultipliers);
    }
  }

  const dayNames = [
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
  ];

  // Base hourly patterns (index 0=6am ... 17=11pm, 18-23=midnight-5am)
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

  let openHours = [7, 7, 7, 7, 7, 7, 8]; 
  let closeHours = [20, 20, 20, 20, 20, 20, 19]; 

  const is24HourBrand = /petro[- ]?canada|shell|esso|mobil|circle[- ]?k|7-eleven|wawa|husky|pioneer|superwash|simoniz|glide wash|self serve|zoom auto spa/i.test(venueName);
  if (is24HourBrand) {
    openHours = [0, 0, 0, 0, 0, 0, 0];
    closeHours = [24, 24, 24, 24, 24, 24, 24];
  }

  if (options?.googleHours && options.googleHours.periods) {
    openHours = [0, 0, 0, 0, 0, 0, 0];
    closeHours = [0, 0, 0, 0, 0, 0, 0];
    
    for (const period of options.googleHours.periods) {
      if (!period.close) {
        openHours = [0, 0, 0, 0, 0, 0, 0];
        closeHours = [24, 24, 24, 24, 24, 24, 24];
        break;
      }
      let btDay = period.open.day - 1;
      if (btDay < 0) btDay = 6;
      
      const oHour = parseInt(period.open.time.substring(0, 2), 10);
      const cHour = parseInt(period.close.time.substring(0, 2), 10);
      
      openHours[btDay] = oHour;
      closeHours[btDay] = cHour === 0 ? 24 : cHour;
    }
  } else if (options?.osmHours) {
    const str = options.osmHours.toLowerCase().trim();
    if (str === "24/7" || str.includes("00:00-24:00")) {
      openHours = [0, 0, 0, 0, 0, 0, 0];
      closeHours = [24, 24, 24, 24, 24, 24, 24];
    } else {
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
    const weatherMult = weatherMultipliers[dayInt];
    const dayRaw = pattern.map((val) =>
      Math.min(100, Math.max(0, Math.round(val * variation * weatherMult))),
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
