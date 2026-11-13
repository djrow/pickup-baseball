/**
 * @fileoverview Client-Side Weather Engine & Smart Rainout Assistant.
 * Powered by Open-Meteo (100% free, zero API keys, client-side browser fetch).
 * Evaluates pre-game rainfall drainage decay plus a 5-day pre-game precipitation outlook.
 * Pure vanilla ES6 (no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Bay Area Venue Coordinate Registry & Geocoding Cache (`extractCoordinates`, `resolveCoordsForLocation`)
 * 2. WMO Weather Code Dictionary & Pacific Time Helpers (`getWeatherCodeInfo`, `getPacificDateParts`, `getPacificTodayDateKey`)
 * 3. Open-Meteo Fetch & 5-Day Forecast Aggregator (`fetchForecast`, `buildDailyForecast`, `getForecastForGame`)
 * 4. Smart Rainout Assistant Drainage Heuristic (`calculateFieldDrainage`)
 * 5. Game Detail & Calendar Card UI Renderers (`renderDailyRainTrackHtml`, `renderAssistantWidget`, `populateCardWeatherBadges`)
 *
 * @global WeatherService
 */

(function(window) {
  'use strict';

  // =========================================================================
  // HEURISTIC CONFIGURATION (Easily adjusted parameters)
  // =========================================================================
  var HEURISTIC_CONFIG = {
    // Soil drainage half-decay rate in hours:
    // Water that fell t hours before game time is weighted by exp(-t / DRAINAGE_DECAY_HOURS)
    DRAINAGE_DECAY_HOURS: 8.0,

    // Effective Surface Moisture (ESM) thresholds in inches:
    // ESM = sum_{h=1}^{24} (rain_h * exp(-h / DRAINAGE_DECAY_HOURS))
    THRESHOLDS: {
      DRY_MAX: 0.08,    // Below 0.08": Firm & Dry infield (No puddles)
      DAMP_MAX: 0.22,   // 0.08" - 0.22": Damp / soft dirt (Playable with care)
      ALERT_MAX: 0.45   // 0.22" - 0.45": Puddle Alert (Drying / raking needed)
      // Above 0.45": High Rainout Likelihood (Waterlogged / standing puddles)
    },

    // Minimum dry hours required after heavy rain (>0.30") to drain puddles
    MIN_DRY_HOURS_FOR_HEAVY_RAIN: 5,

    // Client-side cache TTL in milliseconds (30 minutes)
    CACHE_TTL_MS: 30 * 60 * 1000
  };

  // Known field coordinates across the SF Bay Area (Default: Bushrod Park, Oakland)
  var DEFAULT_COORDS = {
    latitude: 37.8427,
    longitude: -122.2699,
    name: 'Bushrod Park, Oakland, CA'
  };

  var FIELD_COORDS_MAP = {
    // Oakland Fields
    'bushrod': { latitude: 37.8427, longitude: -122.2699, name: 'Bushrod Park, Oakland' },
    'raimondi': { latitude: 37.8184, longitude: -122.2965, name: 'Raimondi Park, Oakland' },
    'grove shafter': { latitude: 37.8344, longitude: -122.2655, name: 'Grove Shafter Park, Oakland' },
    'rickey henderson': { latitude: 37.8315, longitude: -122.2678, name: 'Rickey Henderson Field, Oakland' },
    'carter': { latitude: 37.8315, longitude: -122.2678, name: 'Carter Playing Fields, Oakland' },
    'mosswood': { latitude: 37.8252, longitude: -122.2625, name: 'Mosswood Park, Oakland' },
    'laney': { latitude: 37.7941, longitude: -122.2612, name: 'Laney College / Curt Flood Field, Oakland' },
    'curt flood': { latitude: 37.7941, longitude: -122.2612, name: 'Curt Flood Field, Oakland' },
    'greenman': { latitude: 37.7661, longitude: -122.1895, name: 'Greenman Field, Oakland' },
    'lowell': { latitude: 37.8088, longitude: -122.2905, name: 'Lowell Park, Oakland' },

    // Berkeley & Albany & El Cerrito Fields
    'san pablo park': { latitude: 37.8560, longitude: -122.2836, name: 'San Pablo Park, Berkeley' },
    'san pablo': { latitude: 37.8560, longitude: -122.2836, name: 'San Pablo Park, Berkeley' },
    'james kenney': { latitude: 37.8688, longitude: -122.2968, name: 'James Kenney Park, Berkeley' },
    'codornices': { latitude: 37.8894, longitude: -122.2628, name: 'Codornices Park, Berkeley' },
    'live oak': { latitude: 37.8847, longitude: -122.2685, name: 'Live Oak Park, Berkeley' },
    'evans diamond': { latitude: 37.8703, longitude: -122.2646, name: 'Evans Diamond, Berkeley' },
    'maxwell': { latitude: 37.8703, longitude: -122.2646, name: 'Maxwell Family Field, Berkeley' },
    'memorial park': { latitude: 37.8899, longitude: -122.2954, name: 'Memorial Park, Albany' },
    'castro park': { latitude: 37.9152, longitude: -122.3087, name: 'Castro Park, El Cerrito' },

    // Alameda, Emeryville & San Leandro
    'washington park': { latitude: 37.7719, longitude: -122.2745, name: 'Washington Park, Alameda' },
    'krusi': { latitude: 37.7618, longitude: -122.2472, name: 'Krusi Park, Alameda' },
    'rittler': { latitude: 37.7601, longitude: -122.2359, name: 'Rittler Park, Alameda' },
    'leydecker': { latitude: 37.7335, longitude: -122.2482, name: 'Leydecker Field, Alameda' },

    // San Francisco Diamonds & Parks
    'big rec': { latitude: 37.7686, longitude: -122.4674, name: 'Big Rec Field, San Francisco' },
    'nealon': { latitude: 37.7686, longitude: -122.4674, name: 'Nealon Field (Big Rec), SF' },
    'crocker amazon': { latitude: 37.7126, longitude: -122.4385, name: 'Crocker Amazon Park, San Francisco' },
    'balboa': { latitude: 37.7247, longitude: -122.4439, name: 'Balboa Park, San Francisco' },
    'moscone': { latitude: 37.8041, longitude: -122.4357, name: 'Moscone Field, San Francisco' },
    'lang field': { latitude: 37.7844, longitude: -122.4302, name: 'Lang Field, San Francisco' },
    'silver terrace': { latitude: 37.7333, longitude: -122.4042, name: 'Silver Terrace, San Francisco' },
    'jackson park': { latitude: 37.7635, longitude: -122.3986, name: 'Jackson Park, San Francisco' },
    'fort scott': { latitude: 37.8016, longitude: -122.4716, name: 'Fort Scott Field, Presidio SF' },

    // Contra Costa & Richmond
    'nicholl': { latitude: 37.9307, longitude: -122.3488, name: 'Nicholl Park, Richmond' },

    // Peninsula & South Bay
    'central park': { latitude: 37.5614, longitude: -122.3218, name: 'Central Park, San Mateo' },
    'baylands': { latitude: 37.4526, longitude: -122.1197, name: 'Baylands Athletic Center, Palo Alto' },
    'excite ballpark': { latitude: 37.3225, longitude: -121.8656, name: 'Excite Ballpark, San Jose' },
    'municipal stadium': { latitude: 37.3225, longitude: -121.8656, name: 'Municipal Stadium, San Jose' }
  };

  var CITY_COORDS_MAP = {
    // Regional City Fallbacks (checked only if no specific diamond matches)
    'oakland': { latitude: 37.8044, longitude: -122.2711, name: 'Oakland, CA' },
    'berkeley': { latitude: 37.8716, longitude: -122.2727, name: 'Berkeley, CA' },
    'alameda': { latitude: 37.7652, longitude: -122.2416, name: 'Alameda, CA' },
    'emeryville': { latitude: 37.8313, longitude: -122.2852, name: 'Emeryville, CA' },
    'san leandro': { latitude: 37.7249, longitude: -122.1561, name: 'San Leandro, CA' },
    'san francisco': { latitude: 37.7749, longitude: -122.4194, name: 'San Francisco, CA' },
    'richmond': { latitude: 37.9358, longitude: -122.3477, name: 'Richmond, CA' },
    'walnut creek': { latitude: 37.9101, longitude: -122.0652, name: 'Walnut Creek, CA' },
    'san jose': { latitude: 37.3382, longitude: -121.8863, name: 'San Jose, CA' },
    'palo alto': { latitude: 37.4419, longitude: -122.1430, name: 'Palo Alto, CA' },
    'san mateo': { latitude: 37.5630, longitude: -122.3255, name: 'San Mateo, CA' },
    'marin': { latitude: 37.9735, longitude: -122.5311, name: 'Marin County, CA' },
    'san rafael': { latitude: 37.9735, longitude: -122.5311, name: 'San Rafael, CA' }
  };

  /**
   * Parse latitude and longitude directly from coordinates or map links
   * Supports e.g. "37.8560, -122.2836", "@37.8560,-122.2836", or Google Maps query URLs
   */
  function extractCoordinates(str) {
    if (!str) return null;
    var s = String(str);
    var match = s.match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
    if (match) {
      var lat = parseFloat(match[1]);
      var lon = parseFloat(match[2]);
      if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        var cleanName = s.replace(/https?:\/\/\S+/gi, '')
          .replace(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/, '')
          .replace(/[@()#]/g, '')
          .trim();
        return {
          latitude: lat,
          longitude: lon,
          name: cleanName || 'Custom Diamond'
        };
      }
    }
    return null;
  }

  var GEOCODE_CACHE = {};

  /**
   * Live geocode lookup using Open-Meteo Geocoding API (client-side, free, no key required)
   */
  async function geocodeLocation(locationStr) {
    if (!locationStr || typeof fetch !== 'function') return null;
    var rawStr = String(locationStr).slice(0, 100);
    var query = rawStr
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\bfield\s*\d+\b/gi, '')
      .replace(/\bdiamond\s*\d+\b/gi, '')
      .replace(/[#@<>&"']/g, '')
      .trim();
    if (!query || query.length < 2 || !/[a-zA-Z0-9]/.test(query)) return null;

    var cacheKey = query.toLowerCase();
    if (GEOCODE_CACHE[cacheKey]) {
      return GEOCODE_CACHE[cacheKey];
    }

    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        var cached = window.sessionStorage.getItem('pbf_geo_' + cacheKey);
        if (cached) {
          var parsed = JSON.parse(cached);
          if (parsed && typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number') {
            GEOCODE_CACHE[cacheKey] = parsed;
            return parsed;
          }
        }
      } catch (e) {}
    }

    try {
      var url = 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(query) + '&count=1&language=en&format=json';
      var res = await fetch(url);
      if (!res.ok) return null;
      var data = await res.json();
      if (data && data.results && data.results.length > 0) {
        var first = data.results[0];
        var nameStr = first.name + (first.admin1 ? ', ' + first.admin1 : '');
        var result = {
          latitude: first.latitude,
          longitude: first.longitude,
          name: nameStr
        };
        GEOCODE_CACHE[cacheKey] = result;
        if (typeof window !== 'undefined' && window.sessionStorage) {
          try {
            window.sessionStorage.setItem('pbf_geo_' + cacheKey, JSON.stringify(result));
          } catch (e) {}
        }
        return result;
      }
    } catch (err) {
      // Return null on network error to allow fallback
    }
    return null;
  }

  function getCoordsForLocation(locationStr) {
    if (!locationStr) return DEFAULT_COORDS;

    // 1. Direct coordinates regex check
    var directCoords = extractCoordinates(locationStr);
    if (directCoords) return directCoords;

    var lower = String(locationStr).toLowerCase();

    // 2. Specific diamond/field check (longest keys first for specific matches)
    var fieldKeys = Object.keys(FIELD_COORDS_MAP);
    fieldKeys.sort(function(a, b) { return b.length - a.length; });
    for (var i = 0; i < fieldKeys.length; i++) {
      if (lower.indexOf(fieldKeys[i]) !== -1) {
        return FIELD_COORDS_MAP[fieldKeys[i]];
      }
    }

    // 3. Broad city fallbacks (only if no diamond/field matched)
    var cityKeys = Object.keys(CITY_COORDS_MAP);
    cityKeys.sort(function(a, b) { return b.length - a.length; });
    for (var j = 0; j < cityKeys.length; j++) {
      if (lower.indexOf(cityKeys[j]) !== -1) {
        return CITY_COORDS_MAP[cityKeys[j]];
      }
    }

    // 4. In-memory geocode cache check
    var cleanKey = lower.replace(/https?:\/\/\S+/gi, '').replace(/\bfield\s*\d+\b/gi, '').trim();
    if (GEOCODE_CACHE[cleanKey]) {
      return GEOCODE_CACHE[cleanKey];
    }

    return DEFAULT_COORDS;
  }

  async function resolveCoordsForLocation(locationStr) {
    if (!locationStr) return DEFAULT_COORDS;

    var syncResult = getCoordsForLocation(locationStr);
    if (syncResult !== DEFAULT_COORDS) {
      return syncResult;
    }

    // Dynamic geocoding fallback
    try {
      var geocoded = await geocodeLocation(locationStr);
      if (geocoded) return geocoded;
    } catch (e) {}

    return DEFAULT_COORDS;
  }

  // WMO Weather code interpretations (WMO Code -> Emoji + Plain Description)
  function getWeatherCodeInfo(code) {
    var c = parseInt(code, 10);
    if (isNaN(c)) return { emoji: '⛅', condition: 'Fair', isRain: false };

    if (c === 0) return { emoji: '☀️', condition: 'Sunny & Clear', isRain: false };
    if (c === 1) return { emoji: '🌤️', condition: 'Mainly Clear', isRain: false };
    if (c === 2) return { emoji: '⛅', condition: 'Partly Cloudy', isRain: false };
    if (c === 3) return { emoji: '☁️', condition: 'Overcast', isRain: false };
    if (c === 45 || c === 48) return { emoji: '🌫️', condition: 'Foggy', isRain: false };
    if (c >= 51 && c <= 55) return { emoji: '🌦️', condition: 'Light Drizzle', isRain: true };
    if (c === 56 || c === 57) return { emoji: '🌧️', condition: 'Freezing Drizzle', isRain: true };
    if (c === 61) return { emoji: '🌧️', condition: 'Light Rain', isRain: true };
    if (c === 63) return { emoji: '🌧️', condition: 'Moderate Rain', isRain: true };
    if (c === 65) return { emoji: '🌧️', condition: 'Heavy Rain', isRain: true };
    if (c === 66 || c === 67) return { emoji: '🌧️', condition: 'Freezing Rain', isRain: true };
    if (c >= 71 && c <= 77) return { emoji: '🌨️', condition: 'Snow Showers', isRain: true };
    if (c === 80) return { emoji: '🌦️', condition: 'Scattered Showers', isRain: true };
    if (c === 81) return { emoji: '🌧️', condition: 'Moderate Showers', isRain: true };
    if (c === 82) return { emoji: '🌧️', condition: 'Heavy Rain Showers', isRain: true };
    if (c >= 95) return { emoji: '⛈️', condition: 'Thunderstorm', isRain: true };

    return { emoji: '⛅', condition: 'Partly Cloudy', isRain: false };
  }

  // Parse ISO date string to Pacific Time parts (America/Los_Angeles)
  function getPacificDateParts(isoStr) {
    if (!isoStr) return null;
    var str = String(isoStr).trim();
    // Normalize date-only string (e.g. "2026-11-15") to target noon Pacific (20:00 UTC in standard time)
    // so JS Date doesn't parse it as UTC midnight and roll back to the previous calendar day in Pacific
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      str = str + 'T20:00:00.000Z';
    } else if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(str)) {
      str = str.replace(' ', 'T');
      if (str.indexOf('Z') === -1 && str.indexOf('+') === -1 && str.indexOf('-') === -1) {
        str = str + 'Z';
      }
    }
    var d = new Date(str);
    if (isNaN(d.getTime())) return null;
    try {
      var formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      var parts = formatter.formatToParts(d);
      var partMap = {};
      for (var i = 0; i < parts.length; i++) {
        partMap[parts[i].type] = parts[i].value;
      }
      var h = partMap.hour === '24' ? '00' : partMap.hour;
      return {
        year: partMap.year,
        month: partMap.month,
        day: partMap.day,
        hour: h,
        dateKey: partMap.year + '-' + partMap.month + '-' + partMap.day,
        hourKey: partMap.year + '-' + partMap.month + '-' + partMap.day + 'T' + h + ':00'
      };
    } catch (e) {
      // Fallback
      var y = d.getUTCFullYear();
      var m = String(d.getUTCMonth() + 1).padStart(2, '0');
      var day = String(d.getUTCDate()).padStart(2, '0');
      return {
        year: String(y),
        month: m,
        day: day,
        hour: '12',
        dateKey: y + '-' + m + '-' + day,
        hourKey: y + '-' + m + '-' + day + 'T12:00'
      };
    }
  }

  // Fetch forecast from Open-Meteo with client-side cache and in-flight deduplication
  var inMemoryCache = {};
  var inFlightForecasts = {};

  async function fetchForecast(lat, lon) {
    var ver = (window.API && (window.API.APP_VERSION || window.API.CLIENT_VERSION)) ? (window.API.APP_VERSION || window.API.CLIENT_VERSION) : '126';
    var key = 'pbf_weather_v' + ver + '_' + Number(lat).toFixed(4) + '_' + Number(lon).toFixed(4);

    // 1. Check in-memory cache
    var mem = inMemoryCache[key];
    if (mem && (Date.now() - mem.timestamp < HEURISTIC_CONFIG.CACHE_TTL_MS)) {
      return mem.data;
    }

    // 2. Check persistent localStorage, then sessionStorage
    try {
      var rawLocal = (typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null;
      if (rawLocal) {
        var parsedLocal = JSON.parse(rawLocal);
        if (parsedLocal && (Date.now() - parsedLocal.timestamp < HEURISTIC_CONFIG.CACHE_TTL_MS)) {
          inMemoryCache[key] = parsedLocal;
          return parsedLocal.data;
        }
        localStorage.removeItem(key);
      }
    } catch (e) {}

    try {
      var raw = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem(key) : null;
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && (Date.now() - parsed.timestamp < HEURISTIC_CONFIG.CACHE_TTL_MS)) {
          inMemoryCache[key] = parsed;
          return parsed.data;
        }
        sessionStorage.removeItem(key);
      }
    } catch (e) {}

    if (inFlightForecasts[key]) {
      return inFlightForecasts[key];
    }

    var url = 'https://api.open-meteo.com/v1/forecast?' +
      'latitude=' + encodeURIComponent(lat) +
      '&longitude=' + encodeURIComponent(lon) +
      '&hourly=precipitation,weathercode,temperature_2m' +
      '&daily=precipitation_sum,precipitation_probability_max,weathercode,temperature_2m_max,temperature_2m_min' +
      '&temperature_unit=fahrenheit' +
      '&precipitation_unit=inch' +
      '&timezone=America%2FLos_Angeles' +
      '&forecast_days=10' +
      '&past_days=10';

    var reqPromise = (async function() {
      try {
        var res = await fetch(url);
        if (!res.ok) {
          throw new Error('Open-Meteo request failed with HTTP ' + res.status);
        }
        var data = await res.json();

        var cacheEntry = { timestamp: Date.now(), data: data };
        inMemoryCache[key] = cacheEntry;
        var serializedEntry = null;
        try {
          serializedEntry = JSON.stringify(cacheEntry);
        } catch (e) {}
        if (serializedEntry) {
          try {
            if (typeof localStorage !== 'undefined') localStorage.setItem(key, serializedEntry);
          } catch (e) {}
          try {
            if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, serializedEntry);
          } catch (e) {}
        }

        return data;
      } finally {
        delete inFlightForecasts[key];
      }
    })();

    inFlightForecasts[key] = reqPromise;
    return reqPromise;
  }

  /**
   * Helper: Get current date key in America/Los_Angeles timezone (YYYY-MM-DD)
   */
  function getPacificTodayDateKey() {
    try {
      var formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      var parts = formatter.formatToParts(new Date());
      var partMap = {};
      for (var i = 0; i < parts.length; i++) {
        partMap[parts[i].type] = parts[i].value;
      }
      return partMap.year + '-' + partMap.month + '-' + partMap.day;
    } catch (e) {
      var now = new Date();
      var y = now.getFullYear();
      var m = String(now.getMonth() + 1).padStart(2, '0');
      var d = String(now.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }
  }

  /**
   * Helper: Build 5-day daily forecast breakdown for the event day and 4 previous days
   */
  function buildDailyForecast(dailyData, hourlyData, targetDateKey, todayDateKey) {
    var days = [];
    var weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var currentTodayKey = todayDateKey || getPacificTodayDateKey();

    if (dailyData && Array.isArray(dailyData.time) && dailyData.time.length > 0) {
      var targetIdx = -1;
      if (targetDateKey) {
        targetIdx = dailyData.time.indexOf(targetDateKey);
      }
      var endIdx = targetIdx !== -1 ? targetIdx + 1 : dailyData.time.length;
      var startIdx = Math.max(0, endIdx - 5);

      var sliceTimes = dailyData.time.slice(startIdx, endIdx);
      var slicePrecip = dailyData.precipitation_sum ? dailyData.precipitation_sum.slice(startIdx, endIdx) : [];
      var sliceCodes = dailyData.weathercode ? dailyData.weathercode.slice(startIdx, endIdx) : [];
      var sliceProb = dailyData.precipitation_probability_max ? dailyData.precipitation_probability_max.slice(startIdx, endIdx) : [];
      var sliceMax = dailyData.temperature_2m_max ? dailyData.temperature_2m_max.slice(startIdx, endIdx) : [];
      var sliceMin = dailyData.temperature_2m_min ? dailyData.temperature_2m_min.slice(startIdx, endIdx) : [];

      for (var i = 0; i < sliceTimes.length; i++) {
        var dateStr = sliceTimes[i];
        var parts = dateStr.split('-');
        var weekdayShort = '';
        var monthDay = '';
        if (parts.length === 3) {
          var dateObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0);
          weekdayShort = weekdays[dateObj.getDay()] || '';
          monthDay = parseInt(parts[1], 10) + '/' + parseInt(parts[2], 10);
        }
        var rainVal = Math.round((Number(slicePrecip[i]) || 0) * 100) / 100;
        var code = sliceCodes[i] || 0;
        var wInfo = getWeatherCodeInfo(code);
        var isGame = Boolean(targetDateKey && dateStr === targetDateKey);
        var isToday = Boolean(currentTodayKey && dateStr === currentTodayKey);

        days.push({
          date: dateStr,
          dayName: weekdayShort || ('Day ' + (i + 1)),
          dayMonth: monthDay || '',
          rain: rainVal,
          rainFormatted: rainVal.toFixed(2) + '"',
          code: code,
          emoji: wInfo.emoji,
          condition: wInfo.condition,
          prob: sliceProb[i] != null ? Math.round(sliceProb[i]) : null,
          tempMax: sliceMax[i] != null ? Math.round(sliceMax[i]) : null,
          tempMin: sliceMin[i] != null ? Math.round(sliceMin[i]) : null,
          isGameDay: isGame,
          isToday: isToday
        });
      }
    } else if (dailyData && Array.isArray(dailyData.precipitation_sum) && dailyData.precipitation_sum.length > 0) {
      var pSlice = dailyData.precipitation_sum.slice(-5);
      for (var pi = 0; pi < pSlice.length; pi++) {
        var pVal = Math.round((Number(pSlice[pi]) || 0) * 100) / 100;
        var isLast = (pi === pSlice.length - 1);
        days.push({
          date: '',
          dayName: 'Day ' + (pi + 1),
          dayMonth: '',
          rain: pVal,
          rainFormatted: pVal.toFixed(2) + '"',
          code: 0,
          emoji: '☀️',
          condition: 'Clear',
          isGameDay: isLast,
          isToday: false
        });
      }
    } else if (hourlyData && Array.isArray(hourlyData.time) && hourlyData.time.length > 0) {
      var byDate = {};
      var dateOrder = [];
      for (var h = 0; h < hourlyData.time.length; h++) {
        var t = hourlyData.time[h];
        var dKey = t.split('T')[0];
        if (!byDate[dKey]) {
          byDate[dKey] = { precip: 0, code: 0, temps: [] };
          dateOrder.push(dKey);
        }
        var r = Number(hourlyData.precipitation[h]) || 0;
        byDate[dKey].precip += r;
        if (t.indexOf('T12:00') !== -1 || byDate[dKey].code === 0) {
          byDate[dKey].code = hourlyData.weathercode ? (hourlyData.weathercode[h] || 0) : 0;
        }
        if (hourlyData.temperature_2m && hourlyData.temperature_2m[h] != null) {
          byDate[dKey].temps.push(hourlyData.temperature_2m[h]);
        }
      }
      var hTargetIdx = -1;
      if (targetDateKey) {
        hTargetIdx = dateOrder.indexOf(targetDateKey);
      }
      var hEndIdx = hTargetIdx !== -1 ? hTargetIdx + 1 : dateOrder.length;
      var hStartIdx = Math.max(0, hEndIdx - 5);
      var sliceDateKeys = dateOrder.slice(hStartIdx, hEndIdx);

      for (var j = 0; j < sliceDateKeys.length; j++) {
        var dk = sliceDateKeys[j];
        var item = byDate[dk];
        var pParts = dk.split('-');
        var pDateObj = new Date(parseInt(pParts[0], 10), parseInt(pParts[1], 10) - 1, parseInt(pParts[2], 10), 12, 0, 0);
        var pWeekday = weekdays[pDateObj.getDay()] || '';
        var pRain = Math.round(item.precip * 100) / 100;
        var pInfo = getWeatherCodeInfo(item.code);
        var pMax = item.temps.length ? Math.round(Math.max.apply(null, item.temps)) : null;
        var pMin = item.temps.length ? Math.round(Math.min.apply(null, item.temps)) : null;
        var hIsGame = Boolean(targetDateKey && dk === targetDateKey);
        var hIsToday = Boolean(currentTodayKey && dk === currentTodayKey);

        days.push({
          date: dk,
          dayName: pWeekday,
          dayMonth: parseInt(pParts[1], 10) + '/' + parseInt(pParts[2], 10),
          rain: pRain,
          rainFormatted: pRain.toFixed(2) + '"',
          code: item.code,
          emoji: pInfo.emoji,
          condition: pInfo.condition,
          prob: null,
          tempMax: pMax,
          tempMin: pMin,
          isGameDay: hIsGame,
          isToday: hIsToday
        });
      }
    }

    return days;
  }

  /**
   * Run the Field Drainage & Surface Moisture Heuristic
   */
  function calculateFieldDrainage(hourlyData, targetHourKey, dailyData) {
    if (!hourlyData || !hourlyData.time || !Array.isArray(hourlyData.time)) {
      return null;
    }

    var times = hourlyData.time;
    var targetIdx = times.indexOf(targetHourKey);

    // If targetHourKey is not found, attempt closest match on the same date at 12:00
    if (targetIdx === -1 && targetHourKey) {
      var datePrefix = targetHourKey.split('T')[0];
      targetIdx = times.indexOf(datePrefix + 'T12:00');
      if (targetIdx === -1) {
        for (var t = 0; t < times.length; t++) {
          if (times[t].indexOf(datePrefix) === 0) {
            targetIdx = t;
            break;
          }
        }
      }
    }

    if (targetIdx === -1) {
      return {
        available: false,
        reason: 'Outside forecast horizon (10-day weather forecast activates closer to game)',
        message: '10-day forecast activates closer to game'
      };
    }

    // Build 5-day daily breakdown (event day & 4 previous days)
    var targetDateKey = targetHourKey ? targetHourKey.split('T')[0] : null;
    var dailyForecast = buildDailyForecast(dailyData, hourlyData, targetDateKey);

    var total5DayRain = 0;
    var todayForecast = null;
    for (var di = 0; di < dailyForecast.length; di++) {
      total5DayRain += dailyForecast[di].rain;
      if (dailyForecast[di].isToday) {
        todayForecast = dailyForecast[di];
      }
    }
    total5DayRain = Math.round(total5DayRain * 100) / 100;

    var gameTemp = Math.round(hourlyData.temperature_2m[targetIdx]);
    var gameCode = hourlyData.weathercode[targetIdx];
    var gameWeather = getWeatherCodeInfo(gameCode);

    // Slice 24 hours immediately prior to game start (e.g. Sat 12:00 PM -> Sun 12:00 PM)
    // and extend through 6:00 PM on the day of the event (18:00)
    var startIdx = targetIdx - 24;
    if (startIdx < 0) startIdx = 0;

    var target6pmKey = targetDateKey ? (targetDateKey + 'T18:00') : null;
    var idx6pm = target6pmKey ? times.indexOf(target6pmKey) : -1;
    var endIdx = (idx6pm !== -1) ? (idx6pm + 1) : Math.min(times.length, targetIdx + 7);
    if (endIdx < targetIdx) endIdx = targetIdx;

    var hourlyTimes = times.slice(startIdx, endIdx);
    var hourlyPrecip = hourlyData.precipitation.slice(startIdx, endIdx);
    var hourlyTemps = hourlyData.temperature_2m.slice(startIdx, endIdx);
    var hourlyCodes = hourlyData.weathercode.slice(startIdx, endIdx);

    var totalRain24h = 0;
    var gameHoursRain = 0;
    var eventHoursRain = 0;
    var firstEventRainOffset = -1;
    var firstEventRainTime = null;
    var effectiveMoisture = 0;
    var lastPreGameRainIdx = -1;
    var lastGameRainIdx = -1;
    var maxHourlyRain = 0;
    var maxSurfaceWater = 0;
    var runningSurfaceWater = 0;
    var hourlyDecay = Math.exp(-1 / HEURISTIC_CONFIG.DRAINAGE_DECAY_HOURS);
    var hourlyBreakdown = [];

    var preGameCount = Math.max(0, targetIdx - startIdx);
    var count = hourlyPrecip.length;

    for (var i = 0; i < count; i++) {
      var r = hourlyPrecip[i] || 0;
      var actualIdx = startIdx + i;
      var isGameTime = (actualIdx >= targetIdx);

      runningSurfaceWater = (runningSurfaceWater * hourlyDecay) + r;
      if (runningSurfaceWater > maxSurfaceWater) {
        maxSurfaceWater = runningSurfaceWater;
      }

      if (!isGameTime) {
        totalRain24h += r;
        if (r > maxHourlyRain) maxHourlyRain = r;

        // Hours remaining before 12:00 PM warmups:
        // i=preGameCount-1 -> 1h before game (11am-12pm)
        // i=0              -> preGameCount hours before game (Sat 12pm-1pm)
        var hoursBeforeGame = preGameCount - i;

        // Exponential drainage decay:
        var retentionFactor = Math.exp(-hoursBeforeGame / HEURISTIC_CONFIG.DRAINAGE_DECAY_HOURS);
        effectiveMoisture += (r * retentionFactor);

        if (r >= 0.008) {
          lastPreGameRainIdx = i;
        }

        hourlyBreakdown.push({
          time: hourlyTimes[i],
          rain: r,
          surfaceWater: runningSurfaceWater,
          surfaceWaterFormatted: runningSurfaceWater.toFixed(2) + '"',
          hoursBefore: hoursBeforeGame,
          retention: retentionFactor,
          temp: Math.round(hourlyTemps[i]),
          code: hourlyCodes[i],
          isGameTime: false
        });
      } else {
        // Game-time hours (12:00 PM through 6:00 PM); scheduled pickup routine is 12:00 PM - 4:00 PM (offsets 0..3)
        var eventOffset = actualIdx - targetIdx;
        gameHoursRain += r;
        if (eventOffset >= 0 && eventOffset <= 3) {
          eventHoursRain += r;
          if (firstEventRainOffset === -1 && (r >= 0.02 || eventHoursRain >= 0.03)) {
            firstEventRainOffset = eventOffset;
            firstEventRainTime = hourlyTimes[i];
          }
        }
        if (r > maxHourlyRain) maxHourlyRain = r;

        if (r >= 0.008) {
          lastGameRainIdx = i;
        }

        hourlyBreakdown.push({
          time: hourlyTimes[i],
          rain: r,
          surfaceWater: runningSurfaceWater,
          surfaceWaterFormatted: runningSurfaceWater.toFixed(2) + '"',
          hoursBefore: 0,
          retention: 1,
          temp: Math.round(hourlyTemps[i]),
          code: hourlyCodes[i],
          isGameTime: true
        });
      }
    }

    // Determine how long ago rain stopped prior to 12:00 PM warmups
    var hoursSinceRain = 24;
    var rainDryingNote = 'No measurable rain in previous 24 hours';
    if (lastPreGameRainIdx !== -1) {
      hoursSinceRain = preGameCount - (lastPreGameRainIdx + 1);
      if (hoursSinceRain === 0) {
        rainDryingNote = 'Rain active right up to 12:00 PM warmups';
      } else {
        rainDryingNote = 'Rain ended ' + hoursSinceRain + ' hour' + (hoursSinceRain === 1 ? '' : 's') + ' before warmups';
      }
    }

    // Risk classification according to effective surface accumulation
    var status = 'good';
    var statusLabel = 'Field Playable (Dry & Firm)';
    var badgeClass = 'badge-green';
    var statusColor = '#003831';
    var statusBg = '#e6f0ed';
    var statusBorder = '#b8d7cf';
    var statusIcon = '⚾';
    var prognosis = 'No standing puddles. Infield dirt is dry and firm for 12:00 PM warmups, 12:30 PM batting practice, and the 1:30 PM game.';
    var recommendation = 'Play ball! Enjoy a great afternoon on the diamond.';

    if (effectiveMoisture >= HEURISTIC_CONFIG.THRESHOLDS.ALERT_MAX || (hoursSinceRain < 2 && totalRain24h >= 0.20)) {
      status = 'rainout_risk';
      statusLabel = 'High Rainout Likelihood (Waterlogged)';
      badgeClass = 'badge-rainout';
      statusColor = '#dc2626';
      statusBg = '#fee2e2';
      statusBorder = '#fca5a5';
      statusIcon = '🌧️';
      prognosis = 'Heavy surface accumulation with insufficient time to drain. Infield is waterlogged with standing puddles on baselines and swampy turf.';
      recommendation = 'Organizers should evaluate calling a rainout and broadcasting an emergency update.';
    } else if (effectiveMoisture >= HEURISTIC_CONFIG.THRESHOLDS.DAMP_MAX || (hoursSinceRain < 3 && totalRain24h >= 0.12)) {
      status = 'alert';
      statusLabel = 'Puddle Alert (Drying / Raking Needed)';
      badgeClass = 'badge-orange';
      statusColor = '#FD5A1E';
      statusBg = '#fff2ed';
      statusBorder = '#fed3c4';
      statusIcon = '⚠️';
      prognosis = 'Recent rain has saturated the dirt. Standing water expected in low spots, around home plate, and in batter\'s boxes.';
      recommendation = 'Field check recommended by 10:30 AM. Bring rakes or brooms to push puddles off the dirt so it dries in the sun.';
    } else if (effectiveMoisture >= HEURISTIC_CONFIG.THRESHOLDS.DRY_MAX || totalRain24h >= 0.35) {
      status = 'moderate';
      statusLabel = 'Damp Infield (Playable with Care)';
      badgeClass = 'badge-blue';
      statusColor = '#0284c7';
      statusBg = '#e0f2fe';
      statusBorder = '#bae6fd';
      statusIcon = '🌦️';
      prognosis = 'Fallen rain has had sufficient time to drain and absorb. Infield dirt is soft and grass is damp; ground balls may skip.';
      recommendation = 'Playable! Molded rubber cleats recommended for traction; keep gear off the damp grass.';
    }

    // Active rain during event hours (12:00 PM - 4:00 PM) and late afternoon (4:00 PM - 6:00 PM)
    var preGameStatus = status;
    var lateAfternoonRain = Math.max(0, gameHoursRain - eventHoursRain);
    var formatRainStartLabel = function(timeStr, fallbackOffset) {
      if (timeStr && timeStr.indexOf('T') !== -1) {
        var hNum = parseInt(timeStr.split('T')[1].split(':')[0], 10);
        if (!isNaN(hNum)) {
          var h12 = hNum % 12;
          if (h12 === 0) h12 = 12;
          return h12 + ' ' + (hNum >= 12 ? 'PM' : 'AM');
        }
      }
      var estHour = 12 + (fallbackOffset || 0);
      var est12 = estHour % 12;
      if (est12 === 0) est12 = 12;
      return est12 + ' ' + (estHour >= 12 ? 'PM' : 'AM');
    };

    var rainStartLabel = (firstEventRainOffset !== -1) ? formatRainStartLabel(firstEventRainTime, firstEventRainOffset) : '';
    var hasHeavyEventRain = (eventHoursRain >= 0.10 || (eventHoursRain >= 0.04 && gameHoursRain >= 0.10));

    if (hasHeavyEventRain) {
      if (preGameStatus !== 'rainout_risk' && firstEventRainOffset >= 2) {
        status = 'alert';
        statusLabel = 'Cut Short by ' + rainStartLabel + ' Rain';
        badgeClass = 'badge-orange';
        statusColor = '#FD5A1E';
        statusBg = '#fff2ed';
        statusBorder = '#fed3c4';
        statusIcon = '🌦️';
        prognosis = 'Dry early (12 PM – ' + rainStartLabel + '), then ' + eventHoursRain.toFixed(2) + '" of rain forecast during afternoon play. Event likely cut short after ' + rainStartLabel + '.';
        recommendation = 'Start on time at 12:00 PM to play before rain arrives around ' + rainStartLabel + '.';
      } else {
        status = 'rainout_risk';
        statusLabel = 'Rainout Expected (Game-Time Rain)';
        badgeClass = 'badge-rainout';
        statusColor = '#dc2626';
        statusBg = '#fee2e2';
        statusBorder = '#fca5a5';
        statusIcon = '🌧️';
        prognosis = 'Rain forecast during the game window (' + eventHoursRain.toFixed(2) + '" between 12 PM – 4 PM). High likelihood of rainout.';
        recommendation = 'Organizers should monitor radar and broadcast an emergency update if showers persist.';
      }
    } else if (eventHoursRain >= 0.03 && status === 'good') {
      status = 'alert';
      statusLabel = (firstEventRainOffset >= 2 && rainStartLabel)
        ? ('Showers After ' + rainStartLabel)
        : 'Scattered Showers During Game';
      badgeClass = 'badge-orange';
      statusColor = '#FD5A1E';
      statusBg = '#fff2ed';
      statusBorder = '#fed3c4';
      statusIcon = '🌦️';
      prognosis += (firstEventRainOffset >= 2 && rainStartLabel)
        ? (' Light showers forecast starting around ' + rainStartLabel + ' (' + eventHoursRain.toFixed(2) + '" between 12 PM – 4 PM).')
        : (' Scattered showers forecast during afternoon play (' + eventHoursRain.toFixed(2) + '" between 12 PM – 4 PM).');
      recommendation = 'Bring light rain gear or jackets for the bench. Game may experience brief delays.';
    } else if (lateAfternoonRain >= 0.10) {
      prognosis += ' Rain (' + lateAfternoonRain.toFixed(2) + '") arrives after 4:00 PM wrap-up.';
    }

    return {
      available: true,
      targetHourKey: targetHourKey,
      temperature: gameTemp,
      weatherCode: gameCode,
      emoji: gameWeather.emoji,
      condition: gameWeather.condition,
      isRain: gameWeather.isRain,
      totalRain24h: totalRain24h,
      totalRain24hFormatted: totalRain24h.toFixed(2) + '"',
      eventHoursRain: Math.round(eventHoursRain * 100) / 100,
      eventHoursRainFormatted: (Math.round(eventHoursRain * 100) / 100).toFixed(2) + '"',
      rainStartLabel: rainStartLabel || null,
      gameHoursRain: Math.round(gameHoursRain * 100) / 100,
      gameHoursRainFormatted: (Math.round(gameHoursRain * 100) / 100).toFixed(2) + '"',
      rainfall5Day: total5DayRain,
      rainfall5DayFormatted: total5DayRain.toFixed(2) + '"',
      total5DayRain: total5DayRain,
      total5DayRainFormatted: total5DayRain.toFixed(2) + '"',
      todayForecast: todayForecast,
      todayRain: todayForecast ? todayForecast.rain : 0,
      todayRainFormatted: todayForecast ? todayForecast.rainFormatted : '0.00"',
      dailyForecast: dailyForecast,
      effectiveMoisture: effectiveMoisture,
      effectiveMoistureFormatted: effectiveMoisture.toFixed(2) + '"',
      hoursSinceRain: hoursSinceRain,
      rainDryingNote: rainDryingNote,
      maxHourlyRain: maxHourlyRain,
      maxSurfaceWater: maxSurfaceWater,
      status: status,
      statusLabel: statusLabel,
      badgeClass: badgeClass,
      statusColor: statusColor,
      statusBg: statusBg,
      statusBorder: statusBorder,
      statusIcon: statusIcon,
      prognosis: prognosis,
      recommendation: recommendation,
      hourlyBreakdown: hourlyBreakdown
    };
  }

  /**
   * Main entry point to get forecast for a specific game event
   */
  async function getForecastForGame(eventDateIso, locationStr) {
    var parts = getPacificDateParts(eventDateIso);
    if (!parts) return null;

    var coords = await resolveCoordsForLocation(locationStr);
    try {
      var data = await fetchForecast(coords.latitude, coords.longitude);
      var drainage = calculateFieldDrainage(data.hourly, parts.hourKey, data.daily);
      if (drainage && drainage.available) {
        drainage.locationName = coords.name;
        drainage.dateKey = parts.dateKey;
      }
      return drainage;
    } catch (err) {
      console.warn('[Weather] Unable to load forecast:', err.message);
      return {
        available: false,
        error: true,
        message: 'Weather forecast temporarily unavailable'
      };
    }
  }

  /**
   * Render horizontal 5-day rainfall & weather outlook cards across the panel
   */
  function renderDailyRainTrackHtml(dailyList) {
    if (!dailyList || !Array.isArray(dailyList) || dailyList.length === 0) return '';
    var esc = (window.API && window.API.escapeHtml) ? window.API.escapeHtml : function(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };
    var cols = dailyList.map(function(d) {
      var isGame = Boolean(d.isGameDay);
      var isToday = Boolean(d.isToday);
      var hasRain = d.rain > 0;
      var rainClass = hasRain ? 'has-rain' : '';
      var gameClass = isGame ? 'is-game-day' : '';
      var todayClass = isToday ? 'is-today' : '';

      var labels = [];
      if (isToday) labels.push('Today');
      if (isGame) labels.push('Game Day');
      var tagStr = labels.length > 0 ? ' — ' + labels.join(' & ') : '';
      var tempTitle = (d.tempMax != null && d.tempMin != null) ? ' — ' + d.tempMax + '°/' + d.tempMin + '°F' : (d.tempMax != null ? ' — High ' + d.tempMax + '°F' : '');
      var probStr = (d.prob != null && d.prob > 0) ? ' — ' + d.prob + '% rain chance' : '';
      var title = (d.dayName || '') + ' ' + (d.dayMonth || '') + ': ' + d.rainFormatted + tempTitle + ' (' + (d.condition || '') + probStr + ')' + tagStr;

      var pills = [];
      if (isToday) pills.push('<span class="today-pill">Today</span>');
      if (isGame) pills.push('<span class="game-day-pill">Game Day</span>');

      var probHtml = '';
      if (d.prob != null) {
        probHtml = '<span class="day-prob">💧 ' + esc(d.prob) + '%</span>';
      }

      var tempHtml = '';
      if (d.tempMax != null && d.tempMin != null) {
        tempHtml = '<div class="day-temp">' + esc(d.tempMax) + '° / ' + esc(d.tempMin) + '°</div>';
      } else if (d.tempMax != null) {
        tempHtml = '<div class="day-temp">' + esc(d.tempMax) + '°F</div>';
      }

      var condHtml = d.condition ? '<div class="day-condition">' + esc(d.condition) + '</div>' : '';

      var metaItems = [];
      if (probHtml) metaItems.push(probHtml);
      for (var p = 0; p < pills.length; p++) metaItems.push(pills[p]);

      return '<div class="five-day-rain-col ' + gameClass + (todayClass ? ' ' + todayClass : '') + '" title="' + esc(title) + '">' +
        '<div class="day-head">' +
          '<span class="day-title">' + esc(d.dayName || '') + '</span>' +
          (d.dayMonth ? '<span class="day-date">' + esc(d.dayMonth) + '</span>' : '') +
        '</div>' +
        '<div class="day-precip-row">' +
          '<span class="day-emoji">' + esc(d.emoji || '☀️') + '</span>' +
          '<span class="day-rain ' + rainClass + '">' + esc(d.rainFormatted) + '</span>' +
        '</div>' +
        tempHtml +
        condHtml +
        (metaItems.length > 0 ? '<div class="day-tags-row">' + metaItems.join('') + '</div>' : '') +
      '</div>';
    });
    return '<div class="five-day-rain-track">' + cols.join('') + '</div>';
  }

  /**
   * Render mini horizontal 5-day rainfall bar row for calendar cards
   */
  function renderMiniDailyRainRowHtml(dailyList) {
    if (!dailyList || !Array.isArray(dailyList) || dailyList.length === 0) return '';
    var maxRain = 0;
    for (var m = 0; m < dailyList.length; m++) {
      if (dailyList[m].rain > maxRain) maxRain = dailyList[m].rain;
    }
    var bars = dailyList.map(function(d) {
      var isGame = Boolean(d.isGameDay);
      var isToday = Boolean(d.isToday);
      var hasRain = d.rain > 0;
      var hasChance = !hasRain && d.prob != null && d.prob >= 35;
      var heightPx = 3;
      if (hasRain) {
        heightPx = Math.max(5, Math.min(14, Math.round((d.rain / (maxRain || 1)) * 14)));
      } else if (hasChance) {
        heightPx = 5;
      }
      var barColor = isGame ? 'var(--primary)' : (isToday ? 'var(--secondary)' : (hasRain ? '#0284c7' : (hasChance ? '#7dd3fc' : 'var(--border)')));
      var tags = [];
      if (isToday) tags.push('Today');
      if (isGame) tags.push('Game Day');
      var tagSuffix = tags.length > 0 ? ' (' + tags.join(' & ') + ')' : '';
      var probSuffix = (d.prob != null && d.prob > 0) ? ' [' + d.prob + '% rain chance]' : '';
      var title = (d.dayName || '') + ' ' + (d.dayMonth || '') + ': ' + d.rainFormatted + probSuffix + tagSuffix;
      var letter = d.dayName ? d.dayName.charAt(0) : '';
      return '<div class="mini-rain-day' + (isToday ? ' mini-today' : '') + '" title="' + (window.API ? window.API.escapeHtml(title) : title) + '" style="flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 2px;">' +
        '<span class="mini-rain-bar" style="display: block; width: 100%; max-width: 8px; height: ' + heightPx + 'px; background: ' + barColor + '; border-radius: 2px;"></span>' +
        '<span class="mini-rain-label" style="font-size: 0.6rem; line-height: 1; color: ' + (isGame ? 'var(--primary)' : (isToday ? 'var(--secondary)' : 'var(--text-muted)')) + '; font-weight: ' + (isGame || isToday ? '800' : '600') + ';">' + letter + '</span>' +
      '</div>';
    });
    return '<div class="card-5day-rain-row" style="display: flex; gap: 2px; align-items: flex-end; width: 100%; padding-top: 3px; border-top: 1px dashed var(--border); margin-top: 3px;">' + bars.join('') + '</div>';
  }

  /**
   * Render the Smart Rainout Assistant Widget HTML
   */
  function renderAssistantWidget(containerId, forecastResult, options) {
    var container = document.getElementById(containerId);
    if (!container) return;

    if (!forecastResult || !forecastResult.available) {
      var isError = forecastResult && forecastResult.error;
      var subText = isError
        ? 'Weather forecast temporarily unavailable. Please check back shortly.'
        : '10-day weather forecasts and 24-hour rainfall drainage tracking activate 10 days before each scheduled game.';
      container.innerHTML = `
        <div class="card" style="border-left: 4px solid var(--border); padding: 16px 20px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.5rem;">⛅</span>
            <div>
              <div style="font-weight: 700; color: var(--secondary); font-size: 0.95rem;">
                Smart Rainout Assistant &amp; Weather Prediction
              </div>
              <div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 2px;">
                ${subText}
              </div>
            </div>
          </div>
        </div>
      `;
      return;
    }

    var r = forecastResult;
    var fieldName = options && options.locationName ? options.locationName : (r.locationName || 'Bushrod Park Field');

    // Build hourly timeline (extending through 6:00 PM on event day)
    var timelineHtml = '';
    if (r.hourlyBreakdown && r.hourlyBreakdown.length > 0) {
      var startDayName = 'Sat';
      var endDayName = 'Sun';
      if (r.hourlyBreakdown.length > 0) {
        var firstItemDate = r.hourlyBreakdown[0].time.split('T')[0];
        var lastItemDate = r.hourlyBreakdown[r.hourlyBreakdown.length - 1].time.split('T')[0];
        var daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        var d1 = new Date(firstItemDate + 'T12:00:00.000Z');
        var d2 = new Date(lastItemDate + 'T12:00:00.000Z');
        if (!isNaN(d1.getTime())) startDayName = daysOfWeek[d1.getUTCDay()];
        if (!isNaN(d2.getTime())) endDayName = daysOfWeek[d2.getUTCDay()];
      }
      var timelineRangeLabel = startDayName + ' 12 PM → ' + endDayName + ' 6 PM';
      var scaleMax = Math.max(Number(r.maxHourlyRain) || 0, Number(r.maxSurfaceWater) || 0, 0.25);
      var puddleThreshold = HEURISTIC_CONFIG.THRESHOLDS.DAMP_MAX;
      var guideHtml = '';
      if (scaleMax >= puddleThreshold) {
        var guideTopPx = Math.max(19, Math.min(66, Math.round(19 + (1 - (puddleThreshold / scaleMax)) * 48)));
        guideHtml = '<div class="hourly-threshold-guide" style="top: ' + guideTopPx + 'px;" title="Puddle Alert threshold: ' + puddleThreshold.toFixed(2) + '&quot; surface water"></div>';
      }
      var firstGameColMarked = false;

      var timelineItems = r.hourlyBreakdown.map(function(item) {
        var hParts = item.time.split('T')[1].split(':');
        var hourNum = parseInt(hParts[0], 10);
        var hourLabel = (hourNum === 0 || hourNum === 12) ? '12' : (hourNum % 12);
        var ampm = hourNum >= 12 ? 'p' : 'a';
        var shortTime = hourLabel + ampm;
        var rainVal = Number(item.rain) || 0;
        var surfaceVal = Number(item.surfaceWater) || 0;
        var hasRain = rainVal >= 0.005;
        var hasSurface = surfaceVal >= 0.005;
        var rainBarHeight = hasRain ? Math.min(100, Math.max(8, Math.round((rainVal / scaleMax) * 100))) : 3;
        var surfaceBarHeight = hasSurface ? Math.min(100, Math.max(8, Math.round((surfaceVal / scaleMax) * 100))) : 3;
        var isGame = Boolean(item.isGameTime);
        var isWarmupStart = false;
        if (isGame && !firstGameColMarked) {
          isWarmupStart = true;
          firstGameColMarked = true;
        }
        var colClasses = 'drainage-col' + (isGame ? ' is-game-hour' : '') + (isWarmupStart ? ' is-warmup-hour' : '');
        var tooltipText = item.time +
          (isWarmupStart ? ' (Warmups 12 PM)' : (isGame ? ' (Game Window 12-6 PM)' : ' (Pre-Game Drainage)')) +
          ' | Temp: ' + item.temp + '°F' +
          ' | Hourly Rainfall: ' + rainVal.toFixed(2) + ' in/hr' +
          ' | Expected Surface Water: ' + surfaceVal.toFixed(2) + ' in';
        var safeTooltip = window.API ? window.API.escapeHtml(tooltipText) : tooltipText;

        return `
          <div class="${colClasses}" title="${safeTooltip}">
            <div class="drainage-hour-label">${shortTime}</div>
            <div class="drainage-bars-slot">
              <div class="drainage-bar drainage-bar-rain${hasRain ? '' : ' is-empty'}" style="height: ${rainBarHeight}%;"></div>
              <div class="drainage-bar drainage-bar-surface${hasSurface ? '' : ' is-empty'}" style="height: ${surfaceBarHeight}%;"></div>
            </div>
            <div class="drainage-val-row rain${hasRain ? ' has-value' : ''}">
              ${hasRain ? rainVal.toFixed(2) : '0'}
            </div>
            <div class="drainage-val-row surface${hasSurface ? ' has-value' : ''}">
              ${hasSurface ? surfaceVal.toFixed(2) : '0'}
            </div>
          </div>
        `;
      }).join('');

      timelineHtml = `
        <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border);">
          <div class="hourly-drainage-header">
            <span style="font-size: 0.8rem; font-weight: 700; color: var(--secondary);">
              📊 Hourly Rainfall vs. Expected Surface Water (${timelineRangeLabel})
            </span>
            <div class="hourly-drainage-summary-chips">
              <span class="hourly-metric-chip rain">💧 Peak Rain: ${(Number(r.maxHourlyRain) || 0).toFixed(2)}"/hr</span>
              <span class="hourly-metric-chip surface">🌊 Noon Warmup Water: ${r.effectiveMoistureFormatted}</span>
            </div>
          </div>
          <div class="hourly-drainage-legend">
            <span class="hourly-legend-item">
              <span class="hourly-legend-swatch rain"></span>
              <span>Hourly Rainfall (in/hr)</span>
              <span class="hourly-legend-sub">· falling that hour</span>
            </span>
            <span class="hourly-legend-item">
              <span class="hourly-legend-swatch surface"></span>
              <span>Expected Surface Water (in)</span>
              <span class="hourly-legend-sub">· left on field after τ = ${HEURISTIC_CONFIG.DRAINAGE_DECAY_HOURS}h drainage</span>
            </span>
            <span class="hourly-legend-item">
              <span class="hourly-legend-swatch game-window"></span>
              <span>Game Window (12 PM – 6 PM)</span>
            </span>
            ${scaleMax >= puddleThreshold ? `
              <span class="hourly-legend-item">
                <span class="hourly-legend-swatch threshold-line"></span>
                <span>Puddle Alert (${puddleThreshold.toFixed(2)}")</span>
              </span>
            ` : ''}
          </div>
          <div class="hourly-drainage-scroll">
            <div class="hourly-drainage-grid">
              <div class="hourly-axis-col">
                <div class="hourly-axis-hour">Hour</div>
                <div class="hourly-axis-bars">
                  <span>${scaleMax.toFixed(2)}"</span>
                  <span>0.00"</span>
                </div>
                <div class="hourly-axis-val rain">💧 Rain</div>
                <div class="hourly-axis-val surface">🌊 Water</div>
              </div>
              <div class="hourly-cols-track">
                ${guideHtml}
                ${timelineItems}
              </div>
            </div>
          </div>
        </div>
      `;
    }

    var escW = (window.API && window.API.escapeHtml) ? window.API.escapeHtml : function(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    container.innerHTML = `
      <div class="card smart-rainout-card" style="border-top: 4px solid ${escW(r.statusColor)}; margin-bottom: 14px; box-shadow: var(--shadow-sm);">
        <!-- Top Status Bar (Badge + Title + Prognosis + Temp chip aligned cleanly) -->
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">
          <div style="flex: 1 1 360px; min-width: 0;">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <h3 style="color: var(--secondary); font-size: 1.05rem; margin: 0;">
                🌧️ Smart Rainout &amp; Surface Drainage
              </h3>
              <span class="badge ${escW(r.badgeClass)}" style="font-size: 0.74rem; padding: 2px 8px; font-weight: 700;">
                ${escW(r.statusIcon)} ${escW(r.statusLabel)}
              </span>
              <span style="font-size: 0.76rem; color: var(--text-muted); font-weight: 600;">
                📍 ${escW(fieldName)}
              </span>
            </div>
            <p style="font-size: 0.82rem; color: var(--text-main); margin: 4px 0 0 0; line-height: 1.35;">
              ${escW(r.prognosis)}
            </p>
          </div>
          <div style="display: flex; align-items: center; gap: 8px; background: ${escW(r.statusBg)}; border: 1px solid ${escW(r.statusBorder)}; padding: 5px 10px; border-radius: var(--radius-sm); flex-shrink: 0;">
            <span style="font-size: 1.15rem; font-weight: 800; color: ${escW(r.statusColor)}; display: inline-flex; align-items: center; gap: 4px;">
              <span>${escW(r.emoji)}</span> <span>${escW(r.temperature)}°F</span>
            </span>
            <span style="font-size: 0.74rem; color: var(--text-muted); font-weight: 600;">
              ${escW(r.condition)} at Noon
            </span>
          </div>
        </div>

        <!-- Compact Metrics Grid -->
        <div class="weather-kpi-grid">
          <div class="weather-kpi-tile">
            <div class="weather-kpi-label">5-Day Rain</div>
            <div class="weather-kpi-val">🌧️ ${r.rainfall5DayFormatted}</div>
            <div class="weather-kpi-sub">Game &amp; prior 4 days</div>
          </div>

          <div class="weather-kpi-tile">
            <div class="weather-kpi-label">24h Rain Total</div>
            <div class="weather-kpi-val">🌧️ ${r.totalRain24hFormatted}</div>
            <div class="weather-kpi-sub">Sat 12p – Sun 12p</div>
          </div>

          <div class="weather-kpi-tile">
            <div class="weather-kpi-label">Drying Clearance</div>
            <div class="weather-kpi-val">⏱️ ${r.hoursSinceRain >= 24 ? '24h+ Dry' : r.hoursSinceRain + 'h Dry'}</div>
            <div class="weather-kpi-sub">${r.rainDryingNote}</div>
          </div>

          <div class="weather-kpi-tile">
            <div class="weather-kpi-label">Surface Moisture</div>
            <div class="weather-kpi-val" style="color: ${r.statusColor};">🌊 ${r.effectiveMoistureFormatted}</div>
            <div class="weather-kpi-sub">Exponential drainage</div>
          </div>

          <div class="weather-kpi-tile">
            <div class="weather-kpi-label">Recommendation</div>
            <div class="weather-kpi-rec">${r.recommendation}</div>
          </div>
        </div>

        <!-- 5-Day Rainfall Prediction Across the Card (Daily Breakdown) -->
        ${(r.dailyForecast && r.dailyForecast.length > 0) ? `
          <div style="margin-top: 8px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 7px 10px;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; margin-bottom: 4px;">
              <div style="font-size: 0.76rem; font-weight: 700; color: var(--secondary); display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span>🌧️ <strong>5-Day Rainfall Prediction: ${r.rainfall5DayFormatted}</strong></span>
                ${r.todayForecast ? `
                  <span class="badge" style="font-size: 0.68rem; padding: 1px 7px; font-weight: 700; background: rgba(0, 56, 49, 0.09); color: var(--secondary); border: 1px solid var(--secondary); border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;">
                    📍 Today's Rain: <strong>${r.todayForecast.rainFormatted}</strong> (${r.todayForecast.dayName || 'Today'})
                  </span>
                ` : ''}
              </div>
              <div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 600;">
                Event day &amp; 4 previous days
              </div>
            </div>
            ${renderDailyRainTrackHtml(r.dailyForecast)}
          </div>
        ` : ''}

        <!-- 24-Hour Drainage Breakdown Timeline -->
        ${timelineHtml}

        <!-- Heuristic Transparency Note -->
        <div style="margin-top: 8px; font-size: 0.71rem; color: var(--text-muted); line-height: 1.35; background: var(--bg-subtle); padding: 5px 9px; border-radius: var(--radius-sm);">
          💡 <strong>Drainage Model:</strong> Tracks prior 24h rain with &tau; = ${HEURISTIC_CONFIG.DRAINAGE_DECAY_HOURS}h percolation decay; compares hourly rain (blue, in/hr) vs. remaining surface water (amber, in).
        </div>
      </div>
    `;
  }

  /**
   * Automatically populate weather badges across the page
   */
  async function populateCardWeatherBadges() {
    var elements = document.querySelectorAll('[data-weather-date]');
    if (!elements || elements.length === 0) return;

    var groups = {};
    elements.forEach(function(el) {
      var dk = el.getAttribute('data-weather-date');
      var loc = el.getAttribute('data-weather-location') || 'Bushrod Park Field 1';
      if (!dk) return;
      var groupKey = dk + '::' + loc;
      if (!groups[groupKey]) {
        groups[groupKey] = { dateKey: dk, location: loc, elements: [] };
      }
      groups[groupKey].elements.push(el);
    });

    var groupKeys = Object.keys(groups);
    groupKeys.forEach(async function(gk) {
      var grp = groups[gk];
      var iso = grp.dateKey + 'T20:00:00.000Z'; // 12:00 PM Pacific
      try {
        var forecast = await getForecastForGame(iso, grp.location);
      if (forecast && forecast.available) {
        var escBadge = (window.API && window.API.escapeHtml) ? window.API.escapeHtml : function(s) {
          return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        };
        var locPrefix = forecast.locationName ? (escBadge(forecast.locationName) + ' · ') : '';
        var badgeTitle = locPrefix + escBadge(forecast.condition) + ' · Prev 24h Rain: ' + escBadge(forecast.totalRain24hFormatted) + ' (' + escBadge(forecast.statusLabel) + ')';
        grp.elements.forEach(function(el) {
          el.innerHTML =
            '<span class="weather-card-pill ' + escBadge(forecast.badgeClass) + '" title="' + badgeTitle + '">' +
              '<span>' + escBadge(forecast.emoji) + '</span> <span>' + escBadge(forecast.temperature) + '°F</span>' +
            '</span>';
          el.style.display = 'inline-flex';
        });
      }
      } catch (e) {}
    });
  }

  // Export to global window object
  window.WeatherService = {
    HEURISTIC_CONFIG: HEURISTIC_CONFIG,
    extractCoordinates: extractCoordinates,
    getCoordsForLocation: getCoordsForLocation,
    resolveCoordsForLocation: resolveCoordsForLocation,
    getWeatherCodeInfo: getWeatherCodeInfo,
    getPacificDateParts: getPacificDateParts,
    getPacificTodayDateKey: getPacificTodayDateKey,
    fetchForecast: fetchForecast,
    calculateFieldDrainage: calculateFieldDrainage,
    buildDailyForecast: buildDailyForecast,
    renderDailyRainTrackHtml: renderDailyRainTrackHtml,
    renderMiniDailyRainRowHtml: renderMiniDailyRainRowHtml,
    getForecastForGame: getForecastForGame,
    renderAssistantWidget: renderAssistantWidget,
    populateCardWeatherBadges: populateCardWeatherBadges
  };

})(window);
