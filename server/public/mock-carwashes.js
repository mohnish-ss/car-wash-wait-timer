// Mock carwash data for UI/UX development
// Use this instead of API calls during development
// 
// To use mock data: Set USE_MOCK_DATA = true below, or add ?mock=true to URL

const USE_MOCK_DATA = true; // Set to false to use real API

// Default center point (you can adjust this to your location)
const DEFAULT_CENTER = {
  lat: 37.7749,  // San Francisco (adjust to your area)
  lng: -122.4194
};

const BRANDS = [
  "Quick Quack", "Mister Car Wash", "Zips Car Wash", "Autobell", 
  "Blue Beacon", "Wash World", "Sparkle Wash", "Classic Car Wash",
  "Super Wash", "Rainbow Car Wash", null, null, null // Some nulls for variety
];

// Generate carwashes in a radius around the center
function generateMockCarwashes(centerLat = DEFAULT_CENTER.lat, centerLng = DEFAULT_CENTER.lng, radiusKm = 10, count = 20) {
  const carwashes = [];
  const names = [
    "Sparkle Auto Wash",
    "Quick Clean Car Wash",
    "Premium Wash & Detail",
    "Express Car Wash",
    "Crystal Clear Wash",
    "Sunshine Car Wash",
    "Ocean View Wash",
    "Downtown Auto Spa",
    "Highway Express Wash",
    "Mountain View Car Wash",
    "Riverside Auto Clean",
    "Golden Gate Wash",
    "Bay Area Car Wash",
    "Pacific Coast Wash",
    "Valley Auto Wash",
    "Elite Car Wash",
    "Supreme Wash Center",
    "Ultra Clean Express",
    "Pro Wash & Wax",
    "Mega Wash Station"
  ];

  const streets = [
    "Main Street", "Oak Avenue", "Park Boulevard", "Market Street",
    "First Street", "Second Street", "Elm Street", "Pine Avenue",
    "Cedar Lane", "Maple Drive", "Washington Street", "Lincoln Avenue",
    "Broadway", "Highway 101", "Coast Highway", "University Avenue"
  ];

  const waitStatuses = ['green', 'yellow', 'red', 'gray'];
  const waitTimes = {
    green: [0, 9],
    yellow: [10, 20],
    red: [21, 45],
    gray: null // closed/no data
  };

  for (let i = 0; i < count; i++) {
    // Generate random coordinates within radius
    const radius = Math.random() * radiusKm; // km
    const angle = Math.random() * 2 * Math.PI;
    const latOffset = (radius / 111) * Math.cos(angle); // ~111km per degree latitude
    const lngOffset = (radius / (111 * Math.cos(centerLat * Math.PI / 180))) * Math.sin(angle);
    
    const lat = centerLat + latOffset;
    const lng = centerLng + lngOffset;

    // Random wait status
    const status = waitStatuses[Math.floor(Math.random() * waitStatuses.length)];
    let waitMinutes = null;
    if (status !== 'gray') {
      const range = waitTimes[status];
      waitMinutes = Math.floor(Math.random() * (range[1] - range[0] + 1)) + range[0];
    }

    // Random street number and name
    const streetNum = Math.floor(Math.random() * 9999) + 1;
    const street = streets[Math.floor(Math.random() * streets.length)];
    const city = "San Francisco"; // Adjust to your area
    const state = "CA";
    const zip = Math.floor(Math.random() * 90000) + 10000;

    // Random brand (some have brands, some don't)
    const brand = BRANDS[Math.floor(Math.random() * BRANDS.length)];

    // Create waitTimeLogs array (matching app.js structure)
    const waitTimeLogs = [];
    if (waitMinutes !== null) {
      waitTimeLogs.push({
        estimatedMinutes: waitMinutes,
        timestamp: new Date(Date.now() - Math.random() * 1800000).toISOString() // Within last 30 min
      });
    }

    const carwash = {
      id: `mock-${i + 1}`,
      name: names[i % names.length],
      address: `${streetNum} ${street}, ${city}, ${state} ${zip}`,
      latitude: parseFloat(lat.toFixed(6)),
      longitude: parseFloat(lng.toFixed(6)),
      waitTimeLogs: waitTimeLogs,
      brand: brand || undefined // Only include if not null
    };

    carwashes.push(carwash);
  }

  return carwashes;
}

// Mock API function that mimics fetchCarWashes behavior
async function mockFetchCarWashes(lat, lng, radiusValue) {
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 200));
  
  // Convert radius to km if needed (assuming miles by default)
  const radiusKm = radiusValue || 10;
  
  // Filter carwashes within radius
  const allCarwashes = generateMockCarwashes(lat, lng, radiusKm, 25);
  
  // Filter by actual distance
  const filtered = allCarwashes.filter(wash => {
    const distance = getDistance(lat, lng, wash.latitude, wash.longitude);
    return distance <= radiusKm;
  });
  
  return filtered.slice(0, 20); // Limit to 20 results
}

// Calculate distance between two lat/lng points in km (Haversine formula)
function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateMockCarwashes, mockFetchCarWashes, DEFAULT_CENTER, USE_MOCK_DATA };
}

// Make available globally for browser use
if (typeof window !== 'undefined') {
  window.MockCarwashes = {
    generate: generateMockCarwashes,
    fetch: mockFetchCarWashes,
    DEFAULT_CENTER: DEFAULT_CENTER,
    USE_MOCK_DATA: USE_MOCK_DATA
  };
}
