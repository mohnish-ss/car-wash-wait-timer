import Database from "better-sqlite3";
import path from "path";

// Define the shape of our Venue record
export interface DBVenue {
  id: string; // overpass ID (op_1234) or besttime ID (ven_5678)
  besttime_venue_id: string | null;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  brand: string | null;
  wash_type: string | null;
  forecast_json: string | null; // stored as JSON string
  forecast_updated_at: number | null; // Unix timestamp
  community_wait_minutes: number | null;
  community_wait_updated_at: number | null;
  created_at: number; // Unix timestamp
}

const isVercel = process.env.VERCEL === "1";
const dbPath = isVercel 
  ? path.join("/tmp", "venues.db")
  : path.resolve(__dirname, "../../venues.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

/**
 * Initialize the database schema
 */
export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS venues (
      id TEXT PRIMARY KEY,
      besttime_venue_id TEXT,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      brand TEXT,
      wash_type TEXT,
      forecast_json TEXT,
      forecast_updated_at INTEGER,
      community_wait_minutes INTEGER,
      community_wait_updated_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_venues_lat_lng ON venues(latitude, longitude);
  `);
  
  try { db.exec("ALTER TABLE venues ADD COLUMN community_wait_minutes INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE venues ADD COLUMN community_wait_updated_at INTEGER"); } catch(e) {}
}

/**
 * Insert or update a venue record.
 */
export function upsertVenue(venue: Partial<DBVenue> & { id: string }): void {
  const existing = getVenueById(venue.id);
  const now = Date.now();

  if (existing) {
    const updateStmt = db.prepare(`
      UPDATE venues SET
        besttime_venue_id = coalesce(?, besttime_venue_id),
        name = coalesce(?, name),
        address = coalesce(?, address),
        latitude = coalesce(?, latitude),
        longitude = coalesce(?, longitude),
        brand = coalesce(?, brand),
        wash_type = coalesce(?, wash_type),
        forecast_json = coalesce(?, forecast_json),
        forecast_updated_at = coalesce(?, forecast_updated_at)
      WHERE id = ?
    `);
    
    updateStmt.run(
      venue.besttime_venue_id ?? null,
      venue.name ?? null,
      venue.address ?? null,
      venue.latitude ?? null,
      venue.longitude ?? null,
      venue.brand ?? null,
      venue.wash_type ?? null,
      venue.forecast_json ?? null,
      venue.forecast_updated_at ?? null,
      venue.id
    );
  } else {
    const insertStmt = db.prepare(`
      INSERT INTO venues (
        id, besttime_venue_id, name, address, latitude, longitude, 
        brand, wash_type, forecast_json, forecast_updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      venue.id,
      venue.besttime_venue_id ?? null,
      venue.name ?? "Unknown",
      venue.address ?? "",
      venue.latitude ?? 0,
      venue.longitude ?? 0,
      venue.brand ?? null,
      venue.wash_type ?? null,
      venue.forecast_json ?? null,
      venue.forecast_updated_at ?? null,
      now
    );
  }
}

/**
 * Get a single venue by its ID.
 */
export function getVenueById(id: string): DBVenue | null {
  const stmt = db.prepare("SELECT * FROM venues WHERE id = ?");
  const result = stmt.get(id) as DBVenue | undefined;
  return result || null;
}

/**
 * Find venues within a bounding box.
 */
export function getVenuesInBoundingBox(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number
): DBVenue[] {
  const stmt = db.prepare(`
    SELECT * FROM venues 
    WHERE latitude >= ? AND latitude <= ? 
      AND longitude >= ? AND longitude <= ?
  `);
  
  return stmt.all(minLat, maxLat, minLng, maxLng) as DBVenue[];
}

/**
 * Check if a venue's forecast is fresh based on a TTL in milliseconds.
 */
export function isForecastFresh(venue: DBVenue | null, ttlMs: number): boolean {
  if (!venue || !venue.forecast_updated_at || !venue.forecast_json) {
    return false;
  }
  return (Date.now() - venue.forecast_updated_at) < ttlMs;
}

/**
 * Update the community reported wait time for a venue.
 */
export function updateCommunityWait(id: string, mins: number): void {
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE venues SET 
      community_wait_minutes = ?, 
      community_wait_updated_at = ? 
    WHERE id = ?
  `);
  stmt.run(mins, now, id);
}

// Initialize tables on import
initDatabase();
