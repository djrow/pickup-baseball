/**
 * weather.js - Client-Side Weather Engine & Smart Rainout Assistant
 * Sunday Pickup Baseball Charity Platform
 * 
 * Powered by Open-Meteo (100% free, zero API keys, client-side browser fetch).
 * Zero Cloudflare Worker bandwidth or function limits used.
 * 
 * Heuristic Model:
 * Evaluates 24-hour rainfall prior to 12:00 PM Sunday warmups and models
 * soil drainage and evaporation decay. Sunday afternoons stay dry; puddles
 * depend on whether fallen rain has had sufficient time to drain.
 * 
 * ES6 Compatible (Standard ECMAScript 2015)
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

  // Known field coordinates in the SF Bay Area (Default: Bushrod Park, Oakland)
  var DEFAULT_COORDS = {
    latitude: 37.8427,
    longitude: -122.2699,
    name: 'Bushrod Park, Oakland, CA'
  };

  var FIELD_COORDS_MAP = {
    'bushrod': { latitude: 37.8427, longitude: -122.2699, name: 'Bushrod Park' },
    'raimondi': { latitude: 37.8184, longitude: -122.2965, name: 'Raimondi Park' },
    'grove shafter': { latitude: 37.8344, longitude: -122.2655, name: 'Grove Shafter Park' },
    'rickey henderson': { latitude: 37.8315, longitude: -122.2678, name: 'Rickey Henderson Field' },
    'mosswood': { latitude: 37.8252, longitude: -122.2625, name: 'Mosswood Park' }
  };

  function getCoordsForLocation(locationStr) {
    if (!locationStr) return DEFAULT_COORDS;
    var lower = String(locationStr).toLowerCase();
    var keys = Object.keys(FIELD_COORDS_MAP);
    for (var i = 0; i < keys.length; i++) {
      if (lower.indexOf(keys[i]) !== -1) {
        return FIELD_COORDS_MAP[keys[i]];
      }
    }
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
    var d = new Date(isoStr);
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

  // Fetch forecast from Open-Meteo with client-side cache
  var inMemoryCache = {};

  async function fetchForecast(lat, lon) {
    var ver = (window.API && window.API.CLIENT_VERSION) ? window.API.CLIENT_VERSION : '49';
    var key = 'pbf_weather_v' + ver + '_' + Number(lat).toFixed(4) + '_' + Number(lon).toFixed(4);

    // 1. Check in-memory cache
    var mem = inMemoryCache[key];
    if (mem && (Date.now() - mem.timestamp < HEURISTIC_CONFIG.CACHE_TTL_MS)) {
      return mem.data;
    }

    // 2. Check sessionStorage
    try {
      var raw = sessionStorage.getItem(key);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && (Date.now() - parsed.timestamp < HEURISTIC_CONFIG.CACHE_TTL_MS)) {
          inMemoryCache[key] = parsed;
          return parsed.data;
        }
      }
    } catch (e) {}

    // 3. Request fresh forecast from Open-Meteo
    var url = 'https://api.open-meteo.com/v1/forecast?' +
      'latitude=' + encodeURIComponent(lat) +
      '&longitude=' + encodeURIComponent(lon) +
      '&hourly=precipitation,weathercode,temperature_2m' +
      '&daily=precipitation_sum,precipitation_probability_max,weathercode,temperature_2m_max,temperature_2m_min' +
      '&temperature_unit=fahrenheit' +
      '&precipitation_unit=inch' +
      '&timezone=America%2FLos_Angeles' +
      '&forecast_days=10' +
      '&past_days=2';

    var res = await fetch(url);
    if (!res.ok) {
      throw new Error('Open-Meteo request failed with HTTP ' + res.status);
    }
    var data = await res.json();

    // Cache the response
    var cacheEntry = { timestamp: Date.now(), data: data };
    inMemoryCache[key] = cacheEntry;
    try {
      sessionStorage.setItem(key, JSON.stringify(cacheEntry));
    } catch (e) {}

    return data;
  }

  /**
   * Helper: Build 10-day daily forecast breakdown from dailyData or hourlyData
   */
  function buildDailyForecast(dailyData, hourlyData, targetDateKey) {
    var days = [];
    var weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    if (dailyData && Array.isArray(dailyData.precipitation_sum) && dailyData.precipitation_sum.length > 0) {
      var slicePrecip = dailyData.precipitation_sum.slice(-10);
      var sliceTimes = (dailyData.time && Array.isArray(dailyData.time)) ? dailyData.time.slice(-10) : [];
      var sliceCodes = (dailyData.weathercode && Array.isArray(dailyData.weathercode)) ? dailyData.weathercode.slice(-10) : [];
      var sliceProb = (dailyData.precipitation_probability_max && Array.isArray(dailyData.precipitation_probability_max)) ? dailyData.precipitation_probability_max.slice(-10) : [];
      var sliceMax = (dailyData.temperature_2m_max && Array.isArray(dailyData.temperature_2m_max)) ? dailyData.temperature_2m_max.slice(-10) : [];
      var sliceMin = (dailyData.temperature_2m_min && Array.isArray(dailyData.temperature_2m_min)) ? dailyData.temperature_2m_min.slice(-10) : [];

      for (var i = 0; i < slicePrecip.length; i++) {
        var dateStr = sliceTimes[i] || '';
        var weekdayShort = '';
        var monthDay = '';
        if (dateStr) {
          var parts = dateStr.split('-');
          if (parts.length === 3) {
            var dateObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0);
            weekdayShort = weekdays[dateObj.getDay()] || '';
            monthDay = parseInt(parts[1], 10) + '/' + parseInt(parts[2], 10);
          }
        }
        var rainVal = Math.round((Number(slicePrecip[i]) || 0) * 100) / 100;
        var code = sliceCodes[i] || 0;
        var wInfo = getWeatherCodeInfo(code);

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
          isGameDay: Boolean(targetDateKey && dateStr && dateStr === targetDateKey)
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
      var sliceDateKeys = dateOrder.slice(-10);
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
          isGameDay: Boolean(targetDateKey && dk === targetDateKey)
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

    // Build 10-day daily breakdown
    var targetDateKey = targetHourKey ? targetHourKey.split('T')[0] : null;
    var dailyForecast = buildDailyForecast(dailyData, hourlyData, targetDateKey);

    var total10DayRain = 0;
    for (var di = 0; di < dailyForecast.length; di++) {
      total10DayRain += dailyForecast[di].rain;
    }
    total10DayRain = Math.round(total10DayRain * 100) / 100;

    var gameTemp = Math.round(hourlyData.temperature_2m[targetIdx]);
    var gameCode = hourlyData.weathercode[targetIdx];
    var gameWeather = getWeatherCodeInfo(gameCode);

    // Slice 24 hours immediately prior to game start (e.g. Sat 12:00 PM -> Sun 12:00 PM)
    var startIdx = targetIdx - 24;
    if (startIdx < 0) startIdx = 0;
    var endIdx = targetIdx;

    var hourlyTimes = times.slice(startIdx, endIdx);
    var hourlyPrecip = hourlyData.precipitation.slice(startIdx, endIdx);
    var hourlyTemps = hourlyData.temperature_2m.slice(startIdx, endIdx);
    var hourlyCodes = hourlyData.weathercode.slice(startIdx, endIdx);

    var totalRain24h = 0;
    var effectiveMoisture = 0;
    var lastRainIdx = -1;
    var maxHourlyRain = 0;
    var hourlyBreakdown = [];

    var count = hourlyPrecip.length;
    for (var i = 0; i < count; i++) {
      var r = hourlyPrecip[i] || 0;
      totalRain24h += r;
      if (r > maxHourlyRain) maxHourlyRain = r;

      // Hours remaining before 12:00 PM warmups:
      // i=23 -> 1h before game (11am-12pm)
      // i=0  -> 24h before game (Sat 12pm-1pm)
      var hoursBeforeGame = count - i;

      // Exponential drainage decay:
      var retentionFactor = Math.exp(-hoursBeforeGame / HEURISTIC_CONFIG.DRAINAGE_DECAY_HOURS);
      effectiveMoisture += (r * retentionFactor);

      if (r >= 0.008) {
        lastRainIdx = i;
      }

      hourlyBreakdown.push({
        time: hourlyTimes[i],
        rain: r,
        hoursBefore: hoursBeforeGame,
        retention: retentionFactor,
        temp: Math.round(hourlyTemps[i]),
        code: hourlyCodes[i]
      });
    }

    // Determine how long ago rain stopped
    var hoursSinceRain = 24;
    var rainDryingNote = 'No measurable rain in previous 24 hours';
    if (lastRainIdx !== -1) {
      hoursSinceRain = count - (lastRainIdx + 1);
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
      rainfall10Day: total10DayRain,
      rainfall10DayFormatted: total10DayRain.toFixed(2) + '"',
      total10DayRain: total10DayRain,
      total10DayRainFormatted: total10DayRain.toFixed(2) + '"',
      dailyForecast: dailyForecast,
      effectiveMoisture: effectiveMoisture,
      effectiveMoistureFormatted: effectiveMoisture.toFixed(2) + '"',
      hoursSinceRain: hoursSinceRain,
      rainDryingNote: rainDryingNote,
      maxHourlyRain: maxHourlyRain,
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

    var coords = getCoordsForLocation(locationStr);
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
   * Render horizontal 10-day rainfall track across the card
   */
  function renderDailyRainTrackHtml(dailyList) {
    if (!dailyList || !Array.isArray(dailyList) || dailyList.length === 0) return '';
    var cols = dailyList.map(function(d) {
      var isGame = Boolean(d.isGameDay);
      var hasRain = d.rain > 0;
      var rainClass = hasRain ? 'has-rain' : '';
      var gameClass = isGame ? 'is-game-day' : '';
      var title = (d.dayName || '') + ' ' + (d.dayMonth || '') + ': ' + d.rainFormatted + ' (' + (d.condition || '') + ')' + (isGame ? ' — Game Day' : '');
      return '<div class="ten-day-rain-col ' + gameClass + '" title="' + (window.API ? window.API.escapeHtml(title) : title) + '">' +
        '<span class="day-title">' + (d.dayName || '') + '</span>' +
        '<span class="day-date">' + (d.dayMonth || '') + '</span>' +
        '<span class="day-emoji">' + (d.emoji || '☀️') + '</span>' +
        '<span class="day-rain ' + rainClass + '">' + d.rainFormatted + '</span>' +
        (isGame ? '<span class="game-day-pill">Game</span>' : '') +
      '</div>';
    });
    return '<div class="ten-day-rain-track">' + cols.join('') + '</div>';
  }

  /**
   * Render mini horizontal 10-day rainfall bar row for calendar cards
   */
  function renderMiniDailyRainRowHtml(dailyList) {
    if (!dailyList || !Array.isArray(dailyList) || dailyList.length === 0) return '';
    var maxRain = 0;
    for (var m = 0; m < dailyList.length; m++) {
      if (dailyList[m].rain > maxRain) maxRain = dailyList[m].rain;
    }
    var bars = dailyList.map(function(d) {
      var isGame = Boolean(d.isGameDay);
      var hasRain = d.rain > 0;
      var heightPx = 3;
      if (hasRain) {
        heightPx = Math.max(5, Math.min(14, Math.round((d.rain / (maxRain || 1)) * 14)));
      }
      var barColor = isGame ? 'var(--primary)' : (hasRain ? '#0284c7' : 'var(--border)');
      var title = (d.dayName || '') + ' ' + (d.dayMonth || '') + ': ' + d.rainFormatted + (isGame ? ' (Game Day)' : '');
      var letter = d.dayName ? d.dayName.charAt(0) : '';
      return '<div class="mini-rain-day" title="' + (window.API ? window.API.escapeHtml(title) : title) + '" style="flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 2px;">' +
        '<span class="mini-rain-bar" style="display: block; width: 100%; max-width: 8px; height: ' + heightPx + 'px; background: ' + barColor + '; border-radius: 2px;"></span>' +
        '<span class="mini-rain-label" style="font-size: 0.6rem; line-height: 1; color: ' + (isGame ? 'var(--primary)' : 'var(--text-muted)') + '; font-weight: ' + (isGame ? '800' : '600') + ';">' + letter + '</span>' +
      '</div>';
    });
    return '<div class="card-10day-rain-row" style="display: flex; gap: 2px; align-items: flex-end; width: 100%; padding-top: 3px; border-top: 1px dashed var(--border); margin-top: 3px;">' + bars.join('') + '</div>';
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

    // Build hourly 24h timeline
    var timelineHtml = '';
    if (r.hourlyBreakdown && r.hourlyBreakdown.length > 0) {
      var timelineItems = r.hourlyBreakdown.map(function(item) {
        var hParts = item.time.split('T')[1].split(':');
        var hourNum = parseInt(hParts[0], 10);
        var hourLabel = (hourNum === 0 || hourNum === 12) ? '12' : (hourNum % 12);
        var ampm = hourNum >= 12 ? 'p' : 'a';
        var shortTime = hourLabel + ampm;
        var hasRain = item.rain >= 0.008;
        var barHeight = hasRain ? Math.min(100, Math.max(25, item.rain * 200)) : 4;
        var barColor = hasRain ? 'var(--primary)' : 'var(--border)';

        return `
          <div class="drainage-col" style="flex: 1; min-width: 18px; display: flex; flex-direction: column; align-items: center; gap: 3px;" title="${item.time}: ${item.rain.toFixed(2)} in/hr (${item.temp}°F)">
            <div style="font-size: 0.65rem; color: var(--text-muted); font-weight: 600;">${shortTime}</div>
            <div style="height: 48px; width: 100%; display: flex; align-items: flex-end; justify-content: center;">
              <div style="width: 80%; height: ${barHeight}%; background: ${barColor}; border-radius: 2px;"></div>
            </div>
            <div style="font-size: 0.6rem; color: ${hasRain ? 'var(--primary)' : 'var(--text-muted)'}; font-weight: 700;">
              ${hasRain ? item.rain.toFixed(2) : '0'}
            </div>
          </div>
        `;
      }).join('');

      timelineHtml = `
        <div style="margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--border);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 0.82rem; font-weight: 700; color: var(--secondary);">
              📊 24-Hour Rainfall Drainage Timeline (Sat 12 PM → Sun 12 PM)
            </span>
            <span style="font-size: 0.74rem; color: var(--text-muted);">
              Rainfall (inches per hour)
            </span>
          </div>
          <div style="display: flex; gap: 2px; overflow-x: auto; padding-bottom: 6px;">
            ${timelineItems}
          </div>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="card smart-rainout-card" style="border-top: 4px solid ${r.statusColor}; margin-bottom: 20px; box-shadow: var(--shadow-sm);">
        <!-- Top Status Bar -->
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; margin-bottom: 12px;">
          <div>
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span class="badge ${r.badgeClass}" style="font-size: 0.85rem; padding: 4px 10px; font-weight: 700;">
                ${r.statusIcon} ${r.statusLabel}
              </span>
              <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;">
                📍 ${fieldName}
              </span>
            </div>
            <h3 style="color: var(--secondary); font-size: 1.15rem; margin: 8px 0 4px 0;">
              🌧️ Smart Rainout Assistant &amp; Surface Drainage Tracker
            </h3>
            <p style="font-size: 0.88rem; color: var(--text-main); margin: 0; line-height: 1.4;">
              ${r.prognosis}
            </p>
          </div>
          <div style="text-align: right; background: ${r.statusBg}; border: 1px solid ${r.statusBorder}; padding: 8px 14px; border-radius: var(--radius-sm);">
            <div style="font-size: 1.35rem; font-weight: 800; color: ${r.statusColor}; display: flex; align-items: center; justify-content: flex-end; gap: 6px;">
              <span>${r.emoji}</span> <span>${r.temperature}°F</span>
            </div>
            <div style="font-size: 0.76rem; color: var(--text-muted); font-weight: 600;">
              ${r.condition} at Noon
            </div>
          </div>
        </div>

        <!-- Metrics Grid -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-top: 10px;">
          <div style="background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px;">
            <div style="font-size: 0.72rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">10-Day Rain Prediction</div>
            <div style="font-size: 1.1rem; font-weight: 800; color: var(--secondary); margin-top: 2px;">
              🌧️ ${r.rainfall10DayFormatted}
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 2px;">10-day forecast accumulation</div>
          </div>

          <div style="background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px;">
            <div style="font-size: 0.72rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">24h Rain Total</div>
            <div style="font-size: 1.1rem; font-weight: 800; color: var(--secondary); margin-top: 2px;">
              🌧️ ${r.totalRain24hFormatted}
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 2px;">Fallen Sat 12p - Sun 12p</div>
          </div>

          <div style="background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px;">
            <div style="font-size: 0.72rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Drying Clearance</div>
            <div style="font-size: 1.1rem; font-weight: 800; color: var(--secondary); margin-top: 2px;">
              ⏱️ ${r.hoursSinceRain >= 24 ? '24h+ Dry' : r.hoursSinceRain + 'h Dry'}
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 2px;">${r.rainDryingNote}</div>
          </div>

          <div style="background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px;">
            <div style="font-size: 0.72rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Surface Moisture</div>
            <div style="font-size: 1.1rem; font-weight: 800; color: ${r.statusColor}; margin-top: 2px;">
              🌊 ${r.effectiveMoistureFormatted}
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 2px;">Exponential drainage model</div>
          </div>

          <div style="background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px;">
            <div style="font-size: 0.72rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Recommendation</div>
            <div style="font-size: 0.82rem; font-weight: 700; color: var(--secondary); margin-top: 4px; line-height: 1.3;">
              ${r.recommendation}
            </div>
          </div>
        </div>

        <!-- 10-Day Rainfall Prediction Across the Card (Daily Breakdown) -->
        ${(r.dailyForecast && r.dailyForecast.length > 0) ? `
          <div style="margin-top: 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px;">
              <div style="font-size: 0.8rem; font-weight: 700; color: var(--secondary); display: inline-flex; align-items: center; gap: 5px;">
                🌧️ <strong>10-Day Rainfall Prediction (Daily Breakdown)</strong>
              </div>
              <div style="font-size: 0.74rem; color: var(--text-muted); font-weight: 600;">
                10-Day Forecast Total: <strong style="color: var(--secondary);">${r.rainfall10DayFormatted}</strong>
              </div>
            </div>
            ${renderDailyRainTrackHtml(r.dailyForecast)}
          </div>
        ` : ''}

        <!-- 24-Hour Drainage Breakdown Timeline -->
        ${timelineHtml}

        <!-- Heuristic Transparency Note -->
        <div style="margin-top: 12px; font-size: 0.74rem; color: var(--text-muted); line-height: 1.4; background: var(--bg-subtle); padding: 8px 12px; border-radius: var(--radius-sm);">
          💡 <strong>How the Drainage Heuristic Works:</strong> Tracks total rainfall in the 24 hours preceding 12:00 PM warmups, applying exponential soil percolation decay (half-life &tau; = ${HEURISTIC_CONFIG.DRAINAGE_DECAY_HOURS} hrs). When rain stops early enough, water clears into the subsurface drainage and the diamond stays playable. Puddle hazards only form when steady or heavy rain falls without sufficient drying hours before warmups.
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

    var dateKeys = new Set();
    elements.forEach(function(el) {
      var dk = el.getAttribute('data-weather-date');
      if (dk) dateKeys.add(dk);
    });

    dateKeys.forEach(async function(dk) {
      var iso = dk + 'T20:00:00.000Z'; // 12:00 PM Pacific
      try {
        var forecast = await getForecastForGame(iso, 'Bushrod Park Field 1');
        if (forecast && forecast.available) {
          var matched = document.querySelectorAll('[data-weather-date="' + dk + '"]');
          matched.forEach(function(el) {
            var miniRow = renderMiniDailyRainRowHtml(forecast.dailyForecast);
            el.innerHTML =
              '<div style="display: inline-flex; align-items: center; gap: 4px; width: 100%; flex-wrap: wrap;">' +
                '<span class="weather-card-pill ' + forecast.badgeClass + '" title="' + forecast.condition + ' · Prev 24h Rain: ' + forecast.totalRain24hFormatted + ' (' + forecast.statusLabel + ')">' +
                  '<span>' + forecast.emoji + '</span> <span>' + forecast.temperature + '°F</span>' +
                '</span>' +
                '<span class="weather-card-pill weather-rain-pill" title="10-Day Rainfall Prediction: ' + forecast.rainfall10DayFormatted + '">' +
                  '<span>🌧️ 10-Day Rain: ' + forecast.rainfall10DayFormatted + '</span>' +
                '</span>' +
              '</div>' +
              miniRow;
            el.style.display = 'block';
          });
        }
      } catch (e) {}
    });
  }

  // Export to global window object
  window.WeatherService = {
    HEURISTIC_CONFIG: HEURISTIC_CONFIG,
    getCoordsForLocation: getCoordsForLocation,
    getWeatherCodeInfo: getWeatherCodeInfo,
    getPacificDateParts: getPacificDateParts,
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
