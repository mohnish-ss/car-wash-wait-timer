# WaitLess - Car Wash Wait Times

**Live App:** [https://carwash-wait-time.vercel.app/#map](https://carwash-wait-time.vercel.app/#map)

Real-time car wash wait time estimates powered by [BestTime.app](https://besttime.app) foot traffic forecasts.

## Features

- **Map Search** — Find car washes near any location using an interactive Leaflet map
- **Wait Estimates** — Color-coded markers (green/yellow/red) based on forecasted busyness
- **Brand Detection** — Auto-detects 30+ brands (Shell, Petro-Canada, Costco, etc.)
- **Filters** — Filter by brand and search radius
- **Favorites** — Save locations locally via cookies
- **Geocoding** — Search by address using OpenStreetMap Nominatim

## Tech Stack

- **Server:** Express + TypeScript
- **Frontend:** Vanilla JS + Leaflet + OpenStreetMap
- **Data:** BestTime.app API (venue search + weekly foot traffic forecasts)
- **Caching:** In-memory (no database required)

## Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
BESTTIME_API_KEY=your_key_here
```

Get a free API key at [besttime.app](https://besttime.app).

## Development

```bash
npm run server:dev
```

Open http://localhost:3000.

## Deployment

Deployed on Vercel. The `vercel.json` at the project root handles routing the Express server.
