/* ═══════════════════════════════════════════════════════════════
   WaitLess SPA — app.js   (light theme)
   ═══════════════════════════════════════════════════════════════ */

let map, markers = [], allCarWashes = [], selectedWash = null, radiusCircle = null;
const FAVORITES_KEY = 'waitless_favorites';
const SETTINGS_KEY = 'waitless_settings';

/* ── Cookie helpers ─────────────────────────────────────────── */
function setCookie(name, value, days = 365) {
    const d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
}
function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : null;
}

/* ── Settings helpers ───────────────────────────────────────── */
function getSettings() {
    try { return JSON.parse(getCookie(SETTINGS_KEY) || '{"distanceUnit":"mi"}'); } catch { return { distanceUnit: 'mi' }; }
}
function saveSetting(key, value) {
    const s = getSettings();
    s[key] = value;
    setCookie(SETTINGS_KEY, JSON.stringify(s));
}
function getDistanceUnit() { return getSettings().distanceUnit || 'mi'; }

function updateRadiusLabels() {
    const unit = getDistanceUnit();
    const sel = document.getElementById('filterRadius');
    if (!sel) return;
    Array.from(sel.options).forEach(o => {
        const val = parseInt(o.value);
        o.textContent = val + ' ' + unit;
    });
}

/* ── SPA Router ─────────────────────────────────────────────── */
function navigate(hash) {
    if (!hash || hash === '#') hash = '#map';
    const page = hash.split('/')[0].replace('#', '');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById('page-' + page);
    if (target) {
        target.classList.add('active');
        target.classList.add('active');
        // Update both desktop and mobile navs
        const setActive = (selector) => {
            document.querySelectorAll(selector).forEach(a => {
                a.classList.toggle('active', a.getAttribute('data-page') === page);
            });
        };
        setActive('.navbar nav a');
        setActive('.mobile-nav a');
    }
    if (page === 'favorites') renderFavorites();
    if (page === 'detail') {
        const id = hash.split('/')[1];
        if (id) showDetail(id);
    }
    if (page === 'map' && map) setTimeout(() => map.invalidateSize(), 100);
}
window.addEventListener('hashchange', () => navigate(location.hash));

/* ── Favorites helpers ──────────────────────────────────────── */
function getFavorites() {
    try { return JSON.parse(getCookie(FAVORITES_KEY) || '[]'); } catch { return []; }
}
function isFavorite(id) { return getFavorites().includes(id); }
function toggleFavorite(id) {
    let favs = getFavorites();
    if (favs.includes(id)) favs = favs.filter(f => f !== id);
    else favs.push(id);
    setCookie(FAVORITES_KEY, JSON.stringify(favs));
    return favs.includes(id);
}

/* ── Wait-time helpers ──────────────────────────────────────── */
function getWaitInfo(wash) {
    if (wash._estimateLoading) {
        return { color: '#38bdf8', cls: 'gray', label: 'Checking BestTime', mins: -1, speed: 'Checking BestTime', gradient: ['#38bdf8', '#0ea5e9'], shadow: '56,189,248' };
    }

    const logs = wash.waitTimeLogs || [];
    const recent = logs.length ? logs[logs.length - 1] : null;

    // Handle Closed status directly
    if (recent && recent.isClosed) {
        return { color: '#64748b', cls: 'gray', label: 'Closed', mins: -1, speed: 'Currently Closed', gradient: ['#475569', '#334155'], shadow: '71,85,105' };
    }

    const mins = recent ? recent.estimatedMinutes : -1;
    let color = '#94a3b8', cls = 'gray', label = 'No BestTime data', speed = 'Unavailable';
    // Extended properties for detail view to avoid duplication
    let gradient = ['#94a3b8', '#64748b'];
    let shadow = '96,165,250'; // Default blue-ish shadow for empty state if needed

    if (mins >= 0 && mins < 10) {
        color = '#22c55e'; cls = 'green'; label = mins + ' min'; speed = 'Fast Moving';
        gradient = ['#4ade80', '#22c55e']; shadow = '74,222,128';
    }
    else if (mins >= 10 && mins <= 20) {
        color = '#eab308'; cls = 'yellow'; label = mins + ' min'; speed = 'Moderate';
        gradient = ['#fbbf24', '#f59e0b']; shadow = '251,191,36';
    }
    else if (mins > 20) {
        color = '#ef4444'; cls = 'red'; label = mins + ' min'; speed = 'Slow';
        gradient = ['#f87171', '#ef4444']; shadow = '248,113,113';
    }
    return { color, cls, label, mins, speed, gradient, shadow };
}

/* ── Map ────────────────────────────────────────────────────── */
function initMap() {
    map = L.map('map', { zoomControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    // Light tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(map);
    map.setView([37.7749, -122.4194], 14);
}

function createDotIcon(color, selected) {
    const size = selected ? 28 : 18;
    const glow = selected ? `box-shadow:0 0 14px ${color}88;` : '';
    const ring = selected
        ? `border:3px solid rgba(255,255,255,0.9);`
        : `border:2px solid rgba(255,255,255,0.6);`;
    return L.divIcon({
        className: 'dot-marker',
        html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};${ring}${glow}transition:all 0.2s;"></div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
    });
}

function plotMarkers(washes) {
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    washes.forEach(w => {
        const info = getWaitInfo(w);
        const m = L.marker([w.latitude, w.longitude], { icon: createDotIcon(info.color, false) });
        m.carWash = w;
        m.on('click', () => selectMarker(w, m));
        m.addTo(map);
        markers.push(m);
    });
}

async function selectMarker(wash, marker) {
    selectedWash = wash;
    markers.forEach(m => {
        const info = getWaitInfo(m.carWash);
        m.setIcon(createDotIcon(info.color, m === marker));
    });
    showBottomCard(wash);

    // Spend BestTime credits only for the selected venue, and only if the
    // server does not already have a cached SaaS forecast.
    const info = getWaitInfo(wash);
    if (info.mins < 0 && !wash._estimateFetched && !wash._estimateLoading && info.label !== 'Closed') {
        wash._estimateLoading = true;
        showBottomCard(wash);
        try {
            const res = await fetch(`/api/carwashes/${wash.id}/estimate`);
            if (res.ok) {
                const updatedWash = await res.json();
                Object.assign(wash, updatedWash); // update in place
                wash._estimateFetched = true;
            } else {
                console.error("Failed to load BestTime estimate", await res.text());
            }
        } catch (e) {
            console.error(e);
        } finally {
            wash._estimateLoading = false;
            if (selectedWash === wash) {
                markers.forEach(m => {
                    const i = getWaitInfo(m.carWash);
                    m.setIcon(createDotIcon(i.color, m.carWash === wash));
                });
                showBottomCard(wash);
            }
        }
    }
}

function showBottomCard(wash) {
    const info = getWaitInfo(wash);
    document.getElementById('cardName').textContent = wash.name;
    document.getElementById('cardAddr').textContent = wash.address || 'Address unavailable';
    const badges = document.getElementById('cardBadges');
    badges.innerHTML = '';
    const waitB = document.createElement('div');
    waitB.className = 'badge badge-wait ' + info.cls;
    waitB.innerHTML = `<span class="material-symbols-outlined">timelapse</span>${info.mins >= 0 ? info.label + ' forecast' : info.label}`;
    badges.appendChild(waitB);
    if (wash.brand) {
        const b = document.createElement('div');
        b.className = 'badge badge-info';
        b.innerHTML = `<span class="material-symbols-outlined">local_car_wash</span>${wash.brand}`;
        badges.appendChild(b);
    }
    document.getElementById('bottomCard').classList.add('visible');
    const isFav = isFavorite(wash.id);
    document.querySelector('#cardFavBtn .material-symbols-outlined').style.fontVariationSettings = isFav ? "'FILL' 1" : "'FILL' 0";
    map.flyTo([wash.latitude, wash.longitude], 15, { duration: 0.8 });
}

/* ── Data fetching ──────────────────────────────────────────── */
async function fetchCarWashes(lat, lng, radiusValue) {
    const unit = getDistanceUnit();
    const factor = unit === 'km' ? 1000 : 1609.34;
    const radiusMeters = Math.round((radiusValue || 10) * factor);
    const res = await fetch(`/api/carwashes?lat=${lat}&lng=${lng}&radius=${radiusMeters}`);
    return res.json();
}

async function loadFilters() {
    try {
        const res = await fetch('/api/filters');
        const data = await res.json();
        const brandSel = document.getElementById('filterBrand');
        (data.brands || []).forEach(b => { const o = document.createElement('option'); o.value = b; o.textContent = b; brandSel.appendChild(o); });
    } catch (e) { /* optional */ }
}

async function doSearch(lat, lng) {
    const radiusVal = parseFloat(document.getElementById('filterRadius').value) || 10;
    const unit = getDistanceUnit();
    const factor = unit === 'km' ? 1000 : 1609.34;
    const radiusMeters = Math.round(radiusVal * factor);
    const btn = document.getElementById('searchHereBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;animation:spin 0.8s linear infinite">progress_activity</span> Searching…';
    try {
        allCarWashes = await fetchCarWashes(lat, lng, radiusVal);
        plotMarkers(allCarWashes);
        document.getElementById('bottomCard').classList.remove('visible');

        // Draw radius circle
        if (radiusCircle) map.removeLayer(radiusCircle);
        radiusCircle = L.circle([lat, lng], {
            radius: radiusMeters,
            color: '#0ea5e9',
            fillColor: '#0ea5e9',
            fillOpacity: 0.06,
            weight: 1.5,
            dashArray: '6 4'
        }).addTo(map);

        // Fit map to the search radius
        map.fitBounds(radiusCircle.getBounds(), { padding: [10, 10], duration: 0.8 });
    } catch (e) { console.error(e); }
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px">search</span> Search Here';
}

/* ── Map events ─────────────────────────────────────────────── */
function setupMapEvents() {
    document.getElementById('searchInput').addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const q = e.target.value.trim();
        if (!q) return;
        try {
            const res = await fetch(`/api/geocode?address=${encodeURIComponent(q)}`);
            const geo = await res.json();
            if (geo.lat && geo.lng) {
                map.flyTo([geo.lat, geo.lng], 14, { duration: 1 });
                setTimeout(() => doSearch(geo.lat, geo.lng), 1200);
            }
        } catch (e) { console.error(e); }
    });

    document.getElementById('locateBtn').addEventListener('click', () => {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(pos => {
            const { latitude: lat, longitude: lng } = pos.coords;
            map.flyTo([lat, lng], 14, { duration: 1 });
            setTimeout(() => doSearch(lat, lng), 1200);
        });
    });

    document.getElementById('filterToggle').addEventListener('click', () => {
        const bar = document.getElementById('filterBar');
        bar.style.display = bar.style.display === 'none' ? 'flex' : 'none';
    });

    document.getElementById('searchHereBtn').addEventListener('click', async () => {
        const q = document.getElementById('searchInput').value.trim();
        if (q) {
            try {
                const res = await fetch(`/api/geocode?address=${encodeURIComponent(q)}`);
                const geo = await res.json();
                if (geo.lat && geo.lng) {
                    await doSearch(geo.lat, geo.lng);
                    return;
                }
            } catch (e) { console.error(e); }
        }
        const c = map.getCenter();
        doSearch(c.lat, c.lng);
    });

    document.getElementById('cardDetailBtn').addEventListener('click', () => {
        if (selectedWash) location.hash = '#detail/' + selectedWash.id;
    });

    document.getElementById('cardNavBtn').addEventListener('click', () => {
        if (selectedWash) window.open(`https://www.google.com/maps/dir/?api=1&destination=${selectedWash.latitude},${selectedWash.longitude}`);
    });

    document.getElementById('cardFavBtn').addEventListener('click', () => {
        if (!selectedWash) return;
        const nowFav = toggleFavorite(selectedWash.id);
        document.querySelector('#cardFavBtn .material-symbols-outlined').style.fontVariationSettings =
            nowFav ? "'FILL' 1" : "'FILL' 0";
    });



    map.on('click', () => {
        selectedWash = null;
        document.getElementById('bottomCard').classList.remove('visible');
        markers.forEach(m => { m.setIcon(createDotIcon(getWaitInfo(m.carWash).color, false)); });
    });
}

/* ── Favorites Page ─────────────────────────────────────────── */
function renderFavorites() {
    const favIds = getFavorites();
    const favWashes = allCarWashes.filter(w => favIds.includes(w.id));
    const grid = document.getElementById('favGrid');
    grid.innerHTML = '';

    const waits = favWashes.map(w => getWaitInfo(w).mins).filter(m => m >= 0);
    const avg = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;
    document.getElementById('favAvgWait').textContent = waits.length ? avg + ' min' : '— min';
    document.getElementById('favOpenCount').textContent = favWashes.length || '0';
    document.getElementById('favSubtitle').textContent =
        `BestTime forecasts for your ${favWashes.length} saved location${favWashes.length !== 1 ? 's' : ''}`;

    favWashes.forEach(w => {
        const info = getWaitInfo(w);
        const card = document.createElement('div');
        card.className = 'fav-card';
        card.innerHTML = `
      <div class="fav-card-img">
        <span class="material-symbols-outlined">local_car_wash</span>
        <div class="overlay"></div>
        <div class="wait-badge ${info.cls || 'gray'}">
          <span class="dot" style="background:${info.color}"></span>
          ${info.label === 'Closed' ? 'CLOSED' : (info.mins >= 0 ? 'BESTTIME: ' + info.label.toUpperCase() : 'NO BESTTIME DATA')}
        </div>
        <button class="fav-heart" data-id="${w.id}">
          <span class="material-symbols-outlined" style="font-size:20px;font-variation-settings:'FILL' 1">favorite</span>
        </button>
      </div>
      <div class="fav-card-body">
        <div class="fav-card-name">${w.name}</div>
        <div class="fav-card-addr">${w.address || ''}</div>
        <div class="fav-card-footer">
          <div class="fav-card-dist">
            <span class="material-symbols-outlined">near_me</span>
            <span>${w.distance ? formatDistance(w.distance) : '—'}</span>
          </div>
          <button class="fav-nav-btn" data-id="${w.id}">
            Navigate <span class="material-symbols-outlined" style="font-size:16px">arrow_forward</span>
          </button>
        </div>
      </div>`;
        card.addEventListener('click', e => {
            if (e.target.closest('.fav-heart')) { toggleFavorite(w.id); renderFavorites(); return; }
            if (e.target.closest('.fav-nav-btn')) { window.open(`https://www.google.com/maps/dir/?api=1&destination=${w.latitude},${w.longitude}`); return; }
            location.hash = '#detail/' + w.id;
        });
        grid.appendChild(card);
    });

    const addCard = document.createElement('div');
    addCard.className = 'fav-add-card';
    addCard.innerHTML = `
    <div class="fav-add-icon"><span class="material-symbols-outlined" style="font-size:32px">add_location_alt</span></div>
    <div style="text-align:center">
      <div style="font-size:16px;font-weight:700;color:#fff">Add New Favorite</div>
      <div style="font-size:13px;color:var(--text-muted)">Find and track another location</div>
    </div>`;
    addCard.addEventListener('click', () => { location.hash = '#map'; });
    grid.appendChild(addCard);
}

/* ── Detail Page ────────────────────────────────────────────── */
function showDetail(id) {
    const wash = allCarWashes.find(w => w.id === id);
    if (!wash) { location.hash = '#map'; return; }
    selectedWash = wash;
    const info = getWaitInfo(wash);

    document.getElementById('detailName').textContent = wash.name;
    document.getElementById('detailAddr').textContent = wash.address || '';
    
    if (info.label === 'Closed') {
        document.getElementById('detailOpen').textContent = 'Closed';
        document.getElementById('detailOpen').style.color = '#ef4444';
    } else {
        document.getElementById('detailOpen').textContent = 'Open';
        document.getElementById('detailOpen').style.color = '#22c55e';
    }

    const carsEst = info.mins >= 0 ? Math.max(1, Math.round(info.mins / 3)) : '—';
    document.getElementById('liveCars').textContent = (carsEst === '—' ? '—' : carsEst + ' Cars');
    document.getElementById('liveSpeed').textContent = info.speed;
    document.getElementById('liveWait').textContent = info.mins >= 0 ? '~' + info.mins + ' min' : '— min';

    const pct = info.mins >= 0 ? Math.min(100, (info.mins / 40) * 100) : 0;
    const fill = document.getElementById('liveProgressFill');
    fill.style.width = pct + '%';

    // Use centralized colors
    if (info.gradient) {
        fill.style.background = `linear-gradient(90deg,${info.gradient[0]},${info.gradient[1]})`;
        fill.style.boxShadow = `0 0 10px rgba(${info.shadow},0.5)`;
    }

    const pill = document.getElementById('liveSpeedPill');
    // Map cls to pill styles
    const pillStyles = {
        red: { bg: 'rgba(239,68,68,0.1)', color: '#f87171' },
        yellow: { bg: 'rgba(234,179,8,0.1)', color: '#fbbf24' },
        green: { bg: 'rgba(34,197,94,0.1)', color: '#4ade80' },
        gray: { bg: 'rgba(148,163,184,0.1)', color: '#94a3b8' }
    };
    const style = pillStyles[info.cls] || pillStyles.gray;

    pill.style.background = style.bg;
    pill.style.borderColor = style.bg.replace('0.1)', '0.2)');
    pill.querySelectorAll('span').forEach(s => s.style.color = style.color);

    const verifiedDiv = document.getElementById('liveVerified');
    if (wash.dataSource === 'forecast' && wash.verifiedAt) {
        verifiedDiv.style.display = 'flex';
        verifiedDiv.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px; margin-right:4px;">query_stats</span> BestTime forecast cached ${new Date(wash.verifiedAt).toLocaleDateString()}`;
    } else {
        verifiedDiv.style.display = 'none';
    }

    document.getElementById('detailDirBtn').onclick = () => window.open(`https://www.google.com/maps/dir/?api=1&destination=${wash.latitude},${wash.longitude}`);
    document.getElementById('detailShareBtn').onclick = () => { if (navigator.share) navigator.share({ title: wash.name, url: location.href }); };
    document.getElementById('detailBack').onclick = () => { location.hash = '#map'; };
}

/* ── Init ───────────────────────────────────────────────────── */
function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}

async function loadCarWashes(lat, lng) {
    try {
        allCarWashes = await fetchCarWashes(lat, lng, 10);
        plotMarkers(allCarWashes);
    } catch (e) { console.error('Failed to load car washes:', e); }
}

async function init() {
    initMap();
    loadFilters();
    setupMapEvents();
    setupSettings();

    // Just center the map — car washes load only on explicit search
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            pos => {
                const { latitude: lat, longitude: lng } = pos.coords;
                map.setView([lat, lng], 14);
                hideLoading();
            },
            () => {
                hideLoading();
                map.setView([37.7749, -122.4194], 14);
            },
            { timeout: 2000 }
        );
    } else {
        hideLoading();
    }

    // Failsafe: always hide loading after 0.9s max
    setTimeout(hideLoading, 900);

    navigate(location.hash || '#map');
}

document.addEventListener('DOMContentLoaded', init);

/* ── Settings Page ──────────────────────────────────────────── */
function formatDistance(distMiles) {
    const unit = getDistanceUnit();
    if (unit === 'km') return (distMiles * 1.60934).toFixed(1) + ' km';
    return distMiles.toFixed(1) + ' mi';
}

function setupSettings() {
    updateRadiusLabels();
    const unit = getDistanceUnit();
    document.querySelectorAll('#distanceUnitGroup .settings-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.unit === unit);
        btn.addEventListener('click', () => {
            const newUnit = btn.dataset.unit;
            saveSetting('distanceUnit', newUnit);
            document.querySelectorAll('#distanceUnitGroup .settings-option').forEach(b => {
                b.classList.toggle('active', b.dataset.unit === newUnit);
            });
            updateRadiusLabels();
        });
    });
}
