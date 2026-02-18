// Mock API Integration
// Include this AFTER mock-carwashes.js and BEFORE app.js in index.html
// This intercepts fetch calls to use mock data when enabled

(function () {
  'use strict';

  // Check if mock mode is enabled (via URL param or global flag)
  const urlParams = new URLSearchParams(window.location.search);
  const useMock = urlParams.get('mock') === 'true' ||
    (typeof window.MockCarwashes !== 'undefined' && window.MockCarwashes.USE_MOCK_DATA);

  if (!useMock || typeof window.MockCarwashes === 'undefined') {
    return; // Don't intercept if mock is disabled or not loaded
  }

  console.log('🎨 Mock API mode enabled - using test carwash data');

  // Store original fetch function
  const originalFetch = window.fetch;

  // Override fetch to intercept API calls
  window.fetch = function (url, options) {
    // Only intercept carwash API calls
    if (typeof url === 'string' && url.includes('/api/carwashes')) {
      const urlObj = new URL(url, window.location.origin);
      const lat = parseFloat(urlObj.searchParams.get('lat'));
      const lng = parseFloat(urlObj.searchParams.get('lng'));
      const radiusMeters = parseFloat(urlObj.searchParams.get('radius')) || 10000;
      const radiusKm = radiusMeters / 1000; // Convert meters to km

      if (!isNaN(lat) && !isNaN(lng)) {
        console.log(`📍 Mock: Fetching carwashes near (${lat}, ${lng}) within ${radiusKm}km`);
        return window.MockCarwashes.fetch(lat, lng, radiusKm)
          .then(data => {
            return new Response(JSON.stringify(data), {
              status: 200,
              statusText: 'OK',
              headers: { 'Content-Type': 'application/json' }
            });
          });
      }
    }

    // Intercept filters API
    if (typeof url === 'string' && url.includes('/api/filters')) {
      console.log('🎨 Mock: Fetching filters');
      // Extract unique brands from the mock generator's constant if available, or use hardcoded list
      // We can access BRANDS if we expose it or just use a hardcoded list here for simplicity matching mock-carwashes.js
      const brands = [
        "Quick Quack", "Mister Car Wash", "Zips Car Wash", "Autobell",
        "Blue Beacon", "Wash World", "Sparkle Wash", "Classic Car Wash"
      ];

      return Promise.resolve(new Response(JSON.stringify({ brands }), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    // Intercept report API
    if (typeof url === 'string' && url.includes('/report') && (options && options.method === 'POST')) {
      console.log('🎨 Mock: Submitting wait time report');
      try {
        const body = JSON.parse(options.body);
        console.log('   Report data:', body);
      } catch (e) { /* ignore */ }

      return Promise.resolve(new Response(JSON.stringify({ success: true }), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    // For all other requests, use original fetch
    return originalFetch.apply(this, arguments);
  };

  // Also provide a way to toggle mock mode programmatically
  window.toggleMockMode = function (enabled) {
    if (enabled) {
      window.location.search = '?mock=true';
    } else {
      const url = new URL(window.location);
      url.searchParams.delete('mock');
      window.location.search = url.search;
    }
  };

  // Auto-center on San Francisco and trigger search when mock mode is enabled
  function autoCenterOnSanFrancisco() {
    const sfLat = 37.7749;
    const sfLng = -122.4194;

    // Wait for app initialization to complete
    // Check for map and doSearch function availability
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds max wait

    const checkAndSearch = setInterval(() => {
      attempts++;

      // Check if map exists and doSearch function is available
      // We'll access them from the global scope after app.js loads
      try {
        // Try to access map and doSearch from window or global scope
        const mapAvailable = typeof map !== 'undefined' && map !== null;
        const doSearchAvailable = typeof doSearch === 'function';

        if (mapAvailable && doSearchAvailable) {
          clearInterval(checkAndSearch);

          // Center map on San Francisco
          map.flyTo([sfLat, sfLng], 14, { duration: 1 });

          // Trigger search after map animation completes
          setTimeout(() => {
            console.log('🎨 Auto-searching San Francisco area with mock data');
            doSearch(sfLat, sfLng);
          }, 1200);
        } else if (attempts >= maxAttempts) {
          clearInterval(checkAndSearch);
          console.warn('⚠️ Mock mode: Could not find map or doSearch function');
        }
      } catch (e) {
        // Variables might not be in scope yet, keep trying
        if (attempts >= maxAttempts) {
          clearInterval(checkAndSearch);
          console.warn('⚠️ Mock mode: Error accessing map functions:', e);
        }
      }
    }, 100);
  }

  // Run auto-center after a short delay to ensure app.js has loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(autoCenterOnSanFrancisco, 500);
    });
  } else {
    setTimeout(autoCenterOnSanFrancisco, 500);
  }

})();
