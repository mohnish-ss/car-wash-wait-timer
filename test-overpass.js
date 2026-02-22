const axios = require('axios');

async function testOverpass() {
    const lat = 37.7749;
    const lng = -122.4194;
    const radius = 5000;

    const query = `
    [out:json][timeout:10];
    (
      node["amenity"="car_wash"](around:${radius},${lat},${lng});
      way["amenity"="car_wash"](around:${radius},${lat},${lng});
      relation["amenity"="car_wash"](around:${radius},${lat},${lng});
    );
    out center;
  `;
    try {
        const res = await axios.post("https://overpass-api.de/api/interpreter", `data=${encodeURIComponent(query)}`);
        console.log(`Found ${res.data.elements.length} car washes`);
        console.log(res.data.elements.slice(0, 2).map(e => ({
            id: e.id,
            name: e.tags?.name || 'Unknown',
            lat: e.lat || e.center?.lat,
            lon: e.lon || e.center?.lon,
            address: [e.tags?.['addr:housenumber'], e.tags?.['addr:street'], e.tags?.['addr:city']].filter(Boolean).join(', ')
        })));
    } catch (e) { console.error(e.message); }
}
testOverpass();
