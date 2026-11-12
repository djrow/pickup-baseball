/**
 * Pickup Baseball Foundation - Community Art Studio Engine
 * Drives:
 *   1. The "r/pbf" Pixel Diamond Mosaic (Cooldown grid)
 *   2. The "Equipment Trunk" Sticker & Stamp Wall (Freeform collage)
 *   3. The "Dugout Chalkboard" Daily Doodle Slate (Textured chalk canvas)
 * Strict ES6 compatible (No ES2020 syntax).
 */

(function(window) {
  'use strict';

  // -------------------------------------------------------------
  // 1. Pixel Diamond Mosaic
  // -------------------------------------------------------------
  const PIXEL_GRID_SIZE = 64; // 64x64 grid
  const PIXEL_PALETTE = [
    { name: 'Oakland Pine', hex: '#003831' },
    { name: 'Athletic Gold', hex: '#EFB21E' },
    { name: 'Infield Clay', hex: '#C16738' },
    { name: 'Chalk White', hex: '#FFFFFF' },
    { name: 'Baseball Navy', hex: '#0C2340' },
    { name: 'Sky Blue', hex: '#7BAFD4' },
    { name: 'Baseball Red', hex: '#BA0C2F' },
    { name: 'Pitch Black', hex: '#1A1A1A' },
    { name: 'Ballpark Grass', hex: '#2D7A4D' },
    { name: 'Ash Wood Bat', hex: '#D7A760' },
    { name: 'Raw Leather', hex: '#8B4513' },
    { name: 'Dugout Slate', hex: '#64748B' },
    { name: 'Sunlit Clay', hex: '#E76F51' },
    { name: 'Pacific Mint', hex: '#2A9D8F' },
    { name: 'Sandstone', hex: '#E9C46A' },
    { name: 'Uniform Gray', hex: '#CBD5E1' }
  ];

  let currentPixelColor = PIXEL_PALETTE[0].hex;
  let pixelGridData = [];
  let pixelCooldownSec = 0;
  let cooldownTimer = null;
  let currentUser = null;
  let isAdmin = false;
  let adminBypassCooldown = false;
  let chalkboardFrozen = false;

  function setUser(user) {
    currentUser = user;
    isAdmin = Boolean(user && (user.isAdmin || user.role === 'admin' || user.canManageEvents));
    updateAdminUi();
    const stage = document.getElementById('trunk-canvas-stage');
    if (stage) renderPlacedStickers(stage);
  }

  function updateAdminUi() {
    const banner = document.getElementById('art-admin-banner');
    if (banner) {
      banner.style.display = isAdmin ? 'flex' : 'none';
    }
    document.querySelectorAll('.art-admin-only').forEach(el => {
      el.style.display = isAdmin ? 'inline-flex' : 'none';
    });
  }

  function initPixelDiamond() {
    const canvas = document.getElementById('pixel-diamond-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Build palette swatches
    const paletteRow = document.getElementById('pixel-palette-row');
    if (paletteRow) {
      paletteRow.innerHTML = PIXEL_PALETTE.map((c, idx) => `
        <button type="button" class="color-swatch-btn ${idx === 0 ? 'selected' : ''}" data-color="${c.hex}" title="${c.name} (${c.hex})" style="background: ${c.hex};" aria-label="${c.name}"></button>
      `).join('');

      paletteRow.querySelectorAll('.color-swatch-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          paletteRow.querySelectorAll('.color-swatch-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          currentPixelColor = btn.getAttribute('data-color');
          const indicator = document.getElementById('pixel-selected-indicator');
          if (indicator) {
            indicator.style.background = currentPixelColor;
          }
        });
      });
    }

    // Load or generate default pixel grid
    const saved = localStorage.getItem('pbf_pixel_diamond_grid');
    if (saved) {
      try {
        pixelGridData = JSON.parse(saved);
      } catch (e) {
        pixelGridData = generateDefaultDiamondGrid();
      }
    } else {
      pixelGridData = generateDefaultDiamondGrid();
    }

    renderPixelCanvas(ctx, canvas);

    // Canvas click & hover handlers
    const coordDisplay = document.getElementById('pixel-coord-display');

    function handlePixelPlacement(e) {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.floor((clientX - rect.left) * scaleX);
      const y = Math.floor((clientY - rect.top) * scaleY);

      if (x >= 0 && x < PIXEL_GRID_SIZE && y >= 0 && y < PIXEL_GRID_SIZE) {
        if (pixelCooldownSec > 0 && !adminBypassCooldown) {
          showToast('⏳ Cooldown active! Wait ' + pixelCooldownSec + 's before placing another tile.');
          return;
        }

        const idx = y * PIXEL_GRID_SIZE + x;
        pixelGridData[idx] = currentPixelColor;
        renderPixelCanvas(ctx, canvas);
        localStorage.setItem('pbf_pixel_diamond_grid', JSON.stringify(pixelGridData));

        if (!adminBypassCooldown) {
          startCooldown(5); // 5-second authentic cooldown
        }
      }
    }

    function handlePixelHover(e) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.floor((e.clientX - rect.left) * scaleX);
      const y = Math.floor((e.clientY - rect.top) * scaleY);

      if (coordDisplay && x >= 0 && x < PIXEL_GRID_SIZE && y >= 0 && y < PIXEL_GRID_SIZE) {
        coordDisplay.textContent = '📍 X: ' + x + ', Y: ' + y;
      }
    }

    canvas.addEventListener('click', handlePixelPlacement);
    canvas.addEventListener('mousemove', handlePixelHover);

    // Touch support for mobile devices
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      handlePixelPlacement(e);
    }, { passive: false });

    // Download snapshot button
    const downloadBtn = document.getElementById('btn-download-pixel-diamond');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        // Render 512x512 crisp scaled image
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = 512;
        exportCanvas.height = 512;
        const eCtx = exportCanvas.getContext('2d');
        eCtx.imageSmoothingEnabled = false;
        eCtx.drawImage(canvas, 0, 0, 512, 512);

        const a = document.createElement('a');
        a.download = 'pbf-pixel-diamond-' + new Date().toISOString().slice(0, 10) + '.png';
        a.href = exportCanvas.toDataURL('image/png');
        a.click();
      });
    }

    // Reset button
    const resetBtn = document.getElementById('btn-reset-pixel-diamond');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (confirm('Reset the Community Diamond to the standard outfield & infield pattern?')) {
          pixelGridData = generateDefaultDiamondGrid();
          renderPixelCanvas(ctx, canvas);
          localStorage.removeItem('pbf_pixel_diamond_grid');
        }
      });
    }

    // Admin No-Cooldown toggle button
    const adminBypassBtn = document.getElementById('btn-admin-bypass-cooldown');
    if (adminBypassBtn) {
      adminBypassBtn.addEventListener('click', () => {
        adminBypassCooldown = !adminBypassCooldown;
        adminBypassBtn.textContent = adminBypassCooldown ? '⚡ No Cooldown: ON' : '⚡ No Cooldown: OFF';
        adminBypassBtn.style.background = adminBypassCooldown ? 'var(--primary)' : '';
        adminBypassBtn.style.color = adminBypassCooldown ? '#fff' : 'var(--primary)';
        showToast(adminBypassCooldown ? '⚡ Admin no-cooldown brush enabled!' : 'Cooldown timer restored.');
      });
    }

    // Admin Force Reset button
    const adminResetBtn = document.getElementById('btn-admin-reset-diamond');
    if (adminResetBtn) {
      adminResetBtn.addEventListener('click', () => {
        if (confirm('Admin: Force reset the Community Diamond to the pristine baseball diamond template?')) {
          pixelGridData = generateDefaultDiamondGrid();
          renderPixelCanvas(ctx, canvas);
          localStorage.removeItem('pbf_pixel_diamond_grid');
          showToast('🛡️ Diamond reset to pristine template by Admin.');
        }
      });
    }
  }

  function startCooldown(seconds) {
    pixelCooldownSec = seconds;
    const cooldownEl = document.getElementById('pixel-cooldown-status');
    const cooldownBar = document.getElementById('pixel-cooldown-bar');
    if (cooldownTimer) clearInterval(cooldownTimer);

    if (cooldownEl) cooldownEl.textContent = '⏳ Cooldown: ' + pixelCooldownSec + 's';
    if (cooldownBar) cooldownBar.style.width = '100%';

    cooldownTimer = setInterval(() => {
      pixelCooldownSec--;
      if (pixelCooldownSec <= 0) {
        clearInterval(cooldownTimer);
        pixelCooldownSec = 0;
        if (cooldownEl) cooldownEl.textContent = '✅ Tile Ready!';
        if (cooldownBar) cooldownBar.style.width = '0%';
      } else {
        if (cooldownEl) cooldownEl.textContent = '⏳ Cooldown: ' + pixelCooldownSec + 's';
        if (cooldownBar) cooldownBar.style.width = ((pixelCooldownSec / seconds) * 100) + '%';
      }
    }, 1000);
  }

  function renderPixelCanvas(ctx, canvas) {
    const imgData = ctx.createImageData(PIXEL_GRID_SIZE, PIXEL_GRID_SIZE);
    const data = imgData.data;

    for (let i = 0; i < pixelGridData.length; i++) {
      const hex = pixelGridData[i] || '#003831';
      const rgb = hexToRgb(hex);
      const offset = i * 4;
      data[offset] = rgb.r;
      data[offset + 1] = rgb.g;
      data[offset + 2] = rgb.b;
      data[offset + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
  }

  function hexToRgb(hex) {
    let clean = hex.replace('#', '');
    if (clean.length === 3) {
      clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
    }
    const num = parseInt(clean, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  }

  function generateDefaultDiamondGrid() {
    const grid = new Array(PIXEL_GRID_SIZE * PIXEL_GRID_SIZE).fill('#003831'); // Outfield green

    // Draw clay infield dirt diamond
    const cx = 32;
    const cy = 40;
    const radius = 22;

    for (let y = 0; y < PIXEL_GRID_SIZE; y++) {
      for (let x = 0; x < PIXEL_GRID_SIZE; x++) {
        const dx = Math.abs(x - cx);
        const dy = Math.abs(y - cy);
        if (dx + dy <= radius) {
          grid[y * PIXEL_GRID_SIZE + x] = '#C16738'; // Infield dirt
        }
      }
    }

    // Infield grass inner diamond
    const innerRadius = 14;
    for (let y = 0; y < PIXEL_GRID_SIZE; y++) {
      for (let x = 0; x < PIXEL_GRID_SIZE; x++) {
        const dx = Math.abs(x - cx);
        const dy = Math.abs(y - cy);
        if (dx + dy <= innerRadius) {
          grid[y * PIXEL_GRID_SIZE + x] = '#2D7A4D'; // Infield grass
        }
      }
    }

    // Pitcher's mound (center)
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dy) <= 3) {
          grid[(cy + dy) * PIXEL_GRID_SIZE + (cx + dx)] = '#A0522D';
        }
      }
    }
    // Pitching rubber
    grid[cy * PIXEL_GRID_SIZE + cx] = '#FFFFFF';
    grid[cy * PIXEL_GRID_SIZE + (cx - 1)] = '#FFFFFF';
    grid[cy * PIXEL_GRID_SIZE + (cx + 1)] = '#FFFFFF';

    // Bases (White)
    // Home plate (bottom apex)
    const homeY = cy + radius - 2;
    grid[homeY * PIXEL_GRID_SIZE + cx] = '#FFFFFF';
    grid[(homeY - 1) * PIXEL_GRID_SIZE + (cx - 1)] = '#FFFFFF';
    grid[(homeY - 1) * PIXEL_GRID_SIZE + (cx + 1)] = '#FFFFFF';

    // 2nd base (top apex)
    const secondY = cy - radius + 2;
    grid[secondY * PIXEL_GRID_SIZE + cx] = '#FFFFFF';
    grid[(secondY + 1) * PIXEL_GRID_SIZE + cx] = '#FFFFFF';

    // 1st base (right apex)
    const firstX = cx + radius - 2;
    grid[cy * PIXEL_GRID_SIZE + firstX] = '#FFFFFF';
    grid[cy * PIXEL_GRID_SIZE + (firstX - 1)] = '#FFFFFF';

    // 3rd base (left apex)
    const thirdX = cx - radius + 2;
    grid[cy * PIXEL_GRID_SIZE + thirdX] = '#FFFFFF';
    grid[cy * PIXEL_GRID_SIZE + (thirdX + 1)] = '#FFFFFF';

    // Foul lines extending from home plate to top edges
    for (let i = 0; i < 28; i++) {
      const rx = cx + i;
      const ry = homeY - i;
      const lx = cx - i;
      const ly = homeY - i;
      if (rx < PIXEL_GRID_SIZE && ry >= 0) grid[ry * PIXEL_GRID_SIZE + rx] = '#FFFFFF';
      if (lx >= 0 && ly >= 0) grid[ly * PIXEL_GRID_SIZE + lx] = '#FFFFFF';
    }

    return grid;
  }

  // -------------------------------------------------------------
  // 2. Equipment Trunk & Dugout Sticker Wall
  // -------------------------------------------------------------
  const STICKER_LIST = [
    // Gear
    { id: 'ball', icon: '⚾', label: 'Official Ball', category: 'gear' },
    { id: 'cap', icon: '🧢', label: 'Green & Gold Cap', category: 'gear' },
    { id: 'bats', icon: '🪵', label: 'Ash Wood Bats', category: 'gear' },
    { id: 'mitt', icon: '🧤', label: 'Catcher Mitt', category: 'gear' },
    { id: 'cleats', icon: '👟', label: 'Molded Cleats', category: 'gear' },
    { id: 'stk_helmet', icon: '🪖', label: 'Batting Helmet', category: 'gear' },
    { id: 'stk_whistle', icon: '📢', label: 'Coach Whistle', category: 'gear' },
    { id: 'stk_diamond', icon: '💎', label: 'The Diamond', category: 'gear' },
    { id: 'stk_shades', icon: '🕶️', label: 'Fielding Shades', category: 'gear' },

    // Awards & Plays
    { id: 'trophy', icon: '🏆', label: 'Pickup MVP', category: 'awards' },
    { id: 'pennant', icon: '🚩', label: 'PBF Pennant', category: 'awards' },
    { id: 'stk_medal', icon: '🥇', label: 'Gold Glove', category: 'awards' },
    { id: 'stk_bomb', icon: '💣', label: 'Grand Slam', category: 'awards' },
    { id: 'stk_k', icon: '🎯', label: 'Punchout Strike', category: 'awards' },
    { id: 'stk_crown', icon: '👑', label: 'Home Run King', category: 'awards' },
    { id: 'stk_star', icon: '⭐', label: 'All-Star Pick', category: 'awards' },
    { id: 'stk_ribbon', icon: '🎗️', label: 'Hustle Award', category: 'awards' },

    // Dugout Refreshments
    { id: 'hotdog', icon: '🌭', label: 'Ballpark Dog', category: 'dugout' },
    { id: 'stk_seeds', icon: '🌻', label: 'Sunflower Seeds', category: 'dugout' },
    { id: 'stk_bubblegum', icon: '🍬', label: 'Bubble Gum', category: 'dugout' },
    { id: 'stk_peanuts', icon: '🥜', label: 'Roasted Peanuts', category: 'dugout' },
    { id: 'stk_drink', icon: '🥤', label: 'Cold Beverage', category: 'dugout' },
    { id: 'stk_pretzel', icon: '🥨', label: 'Warm Pretzel', category: 'dugout' },
    { id: 'stk_sundae', icon: '🍦', label: 'Helmet Sundae', category: 'dugout' },
    { id: 'stk_ice', icon: '🧊', label: 'Gatorade Cooler', category: 'dugout' },
    { id: 'stk_apple', icon: '🍎', label: 'Field Apple', category: 'dugout' },

    // Game Day Vibes & Cheers
    { id: 'flame', icon: '⚡', label: '100mph Heater', category: 'vibes' },
    { id: 'tree', icon: '🌲', label: 'Oakland Tree', category: 'vibes' },
    { id: 'stk_fire', icon: '🔥', label: 'On Fire!', category: 'vibes' },
    { id: 'stk_jay', icon: '🐦', label: 'Bushrod Scrub Jay', category: 'vibes' },
    { id: 'stk_clap', icon: '👏', label: 'Good Hustle', category: 'vibes' },
    { id: 'stk_bump', icon: '👊', label: 'Dugout Bump', category: 'vibes' },
    { id: 'stk_flex', icon: '💪', label: 'No Doubt', category: 'vibes' },
    { id: 'stk_sun', icon: '☀️', label: 'California Sun', category: 'vibes' },
    { id: 'stk_rocket', icon: '🚀', label: 'Moonshot', category: 'vibes' },
    { id: 'stk_heart', icon: '💚', label: 'Oakland Love', category: 'vibes' }
  ];

  let selectedSticker = STICKER_LIST[0];
  let placedStickers = [];
  let currentStickerCategory = 'all';

  function renderStickerShelf(category) {
    const shelf = document.getElementById('sticker-shelf');
    if (!shelf) return;
    const cat = category || currentStickerCategory || 'all';
    const filtered = cat === 'all'
      ? STICKER_LIST
      : STICKER_LIST.filter(s => s.category === cat);

    shelf.innerHTML = filtered.map(s => `
      <button type="button" class="sticker-item-btn ${selectedSticker && selectedSticker.id === s.id ? 'selected' : ''}" data-sticker-id="${s.id}" title="${s.label}">
        <span>${s.icon}</span> <span style="font-size: 0.82rem; font-weight: 700;">${s.label}</span>
      </button>
    `).join('');

    shelf.querySelectorAll('.sticker-item-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        shelf.querySelectorAll('.sticker-item-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const sid = btn.getAttribute('data-sticker-id');
        selectedSticker = STICKER_LIST.find(s => s.id === sid) || STICKER_LIST[0];
      });
    });
  }

  function setupUnifiedBoardControls() {
    const btnChalk = document.getElementById('btn-mode-chalk');
    const btnStickers = document.getElementById('btn-mode-stickers');
    const chalkPanel = document.getElementById('chalk-tools-panel');
    const stickerPanel = document.getElementById('sticker-tools-panel');
    const stage = document.getElementById('trunk-canvas-stage');

    function setMode(mode) {
      if (mode === 'chalk') {
        if (btnChalk) {
          btnChalk.classList.add('btn-primary', 'active');
          btnChalk.classList.remove('btn-outline');
        }
        if (btnStickers) {
          btnStickers.classList.remove('btn-primary', 'active');
          btnStickers.classList.add('btn-outline');
        }
        if (chalkPanel) chalkPanel.style.display = 'flex';
        if (stickerPanel) stickerPanel.style.display = 'none';
        if (stage) stage.style.pointerEvents = 'none';
      } else {
        if (btnStickers) {
          btnStickers.classList.add('btn-primary', 'active');
          btnStickers.classList.remove('btn-outline');
        }
        if (btnChalk) {
          btnChalk.classList.remove('btn-primary', 'active');
          btnChalk.classList.add('btn-outline');
        }
        if (stickerPanel) stickerPanel.style.display = 'block';
        if (chalkPanel) chalkPanel.style.display = 'none';
        if (stage) stage.style.pointerEvents = 'auto';
      }
    }

    if (btnChalk) {
      btnChalk.addEventListener('click', () => setMode('chalk'));
    }
    if (btnStickers) {
      btnStickers.addEventListener('click', () => setMode('stickers'));
    }

    // Default to chalk mode
    setMode('chalk');

    // Category tab filter click handlers
    document.querySelectorAll('.sticker-cat-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.sticker-cat-tab').forEach(t => {
          t.classList.remove('btn-primary', 'active');
          t.classList.add('btn-outline');
        });
        tab.classList.add('btn-primary', 'active');
        tab.classList.remove('btn-outline');
        currentStickerCategory = tab.getAttribute('data-cat') || 'all';
        renderStickerShelf(currentStickerCategory);
      });
    });
  }

  function initEquipmentTrunk() {
    const stage = document.getElementById('trunk-canvas-stage');
    if (!stage) return;

    renderStickerShelf('all');
    setupUnifiedBoardControls();

    // Load saved stickers
    const saved = localStorage.getItem('pbf_trunk_stickers');
    if (saved) {
      try {
        placedStickers = JSON.parse(saved);
      } catch (e) {
        placedStickers = getDefaultTrunkStickers();
      }
    } else {
      placedStickers = getDefaultTrunkStickers();
    }

    renderPlacedStickers(stage);

    // Click on trunk to slap sticker
    stage.addEventListener('click', (e) => {
      // If clicking directly on an existing sticker, handle in sticker click
      if (e.target.classList.contains('placed-trunk-sticker') || e.target.closest('.placed-trunk-sticker')) {
        return;
      }

      const rect = stage.getBoundingClientRect();
      const x = Math.max(20, Math.min(rect.width - 60, e.clientX - rect.left - 20));
      const y = Math.max(20, Math.min(rect.height - 60, e.clientY - rect.top - 20));

      const tagInput = document.getElementById('sticker-tag-input');
      const tagText = tagInput && tagInput.value ? tagInput.value.trim().slice(0, 30) : '';

      const rotation = Math.floor(Math.random() * 30) - 15; // -15 to +15 deg

      const newSticker = {
        id: 'stk_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        icon: selectedSticker.icon,
        label: selectedSticker.label,
        tag: tagText,
        x: Math.round(x),
        y: Math.round(y),
        rotation: rotation,
        placedAt: new Date().toLocaleDateString()
      };

      placedStickers.push(newSticker);
      renderPlacedStickers(stage);
      localStorage.setItem('pbf_trunk_stickers', JSON.stringify(placedStickers));

      if (tagInput) tagInput.value = '';
    });

    // Clear button
    const clearBtn = document.getElementById('btn-clear-trunk');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (confirm('Peel your stickers off the dugout wall?')) {
          placedStickers = [];
          renderPlacedStickers(stage);
          localStorage.removeItem('pbf_trunk_stickers');
        }
      });
    }

    // Admin Peel All Stickers button
    const adminClearBtn = document.getElementById('btn-admin-clear-trunk');
    if (adminClearBtn) {
      adminClearBtn.addEventListener('click', () => {
        if (confirm('Admin: Clear all stickers off the community dugout wall?')) {
          placedStickers = [];
          renderPlacedStickers(stage);
          localStorage.removeItem('pbf_trunk_stickers');
          showToast('🛡️ Dugout wall cleared by Admin.');
        }
      });
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getDefaultTrunkStickers() {
    return [
      { id: 'stk_init_1', icon: '⚾', label: 'Game Ball', tag: 'Opening Day', x: 80, y: 70, rotation: -8, placedAt: 'Nov 2026' },
      { id: 'stk_init_2', icon: '🌲', label: 'Oakland Tree', tag: 'Bushrod Park', x: 260, y: 120, rotation: 6, placedAt: 'Nov 2026' },
      { id: 'stk_init_3', icon: '🧢', label: 'Green & Gold', tag: 'Sunday Noon', x: 170, y: 220, rotation: -12, placedAt: 'Nov 2026' },
      { id: 'stk_init_4', icon: '🪵', label: 'Wood Bats', tag: 'Bring Your Ash!', x: 400, y: 80, rotation: 10, placedAt: 'Nov 2026' }
    ];
  }

  function renderPlacedStickers(stage) {
    stage.innerHTML = placedStickers.map(stk => {
      const safeId = escapeHtml(stk.id);
      const safeIcon = escapeHtml(stk.icon);
      const safeLabel = escapeHtml(stk.label);
      const safeTag = stk.tag ? escapeHtml(stk.tag) : '';
      const safeX = typeof stk.x === 'number' ? stk.x : parseInt(stk.x, 10) || 0;
      const safeY = typeof stk.y === 'number' ? stk.y : parseInt(stk.y, 10) || 0;
      const safeRot = typeof stk.rotation === 'number' ? stk.rotation : parseInt(stk.rotation, 10) || 0;

      return `
        <div class="placed-trunk-sticker" id="${safeId}" data-id="${safeId}" style="left: ${safeX}px; top: ${safeY}px; transform: rotate(${safeRot}deg);" title="${safeLabel}${safeTag ? ': ' + safeTag : ''}">
          <span>${safeIcon}</span>
          ${safeTag ? `<div style="font-size: 0.65rem; background: rgba(0,0,0,0.75); color: #fff; padding: 1px 5px; border-radius: 3px; white-space: nowrap; font-weight: 700; transform: translateY(-4px);">${safeTag}</div>` : ''}
          ${isAdmin ? `<button type="button" class="admin-sticker-delete" data-id="${safeId}" title="Admin: Delete sticker" style="position: absolute; top: -8px; right: -8px; width: 20px; height: 20px; border-radius: 50%; background: #ba0c2f; color: #fff; border: 1.5px solid #fff; font-size: 0.65rem; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;">✖</button>` : ''}
        </div>
      `;
    }).join('');

    stage.querySelectorAll('.placed-trunk-sticker').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.getAttribute('data-id');
        const msg = isAdmin ? 'Admin: Permanently peel this sticker off the dugout wall?' : 'Peel this sticker off the dugout wall?';
        if (confirm(msg)) {
          placedStickers = placedStickers.filter(s => s.id !== id);
          renderPlacedStickers(stage);
          localStorage.setItem('pbf_trunk_stickers', JSON.stringify(placedStickers));
          showToast(isAdmin ? '🛡️ Sticker removed by Admin.' : 'Sticker peeled off.');
        }
      });
    });
  }

  // -------------------------------------------------------------
  // 3. Dugout Chalkboard Doodle Slate
  // -------------------------------------------------------------
  let chalkColor = '#F8F9FA';
  let chalkSize = 4;
  let isDrawing = false;
  let lastX = 0;
  let lastY = 0;
  let chalkHistory = [];

  function initDugoutChalkboard() {
    const canvas = document.getElementById('chalkboard-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Handle high DPI resizing
    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && canvas.width !== rect.width) {
        // Save state before resizing
        const temp = ctx.getImageData(0, 0, canvas.width, canvas.height);
        canvas.width = rect.width;
        canvas.height = 420;
        ctx.putImageData(temp, 0, 0);
      }
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    // Seed default chalkboard layout if blank
    const saved = localStorage.getItem('pbf_chalkboard_data');
    if (saved) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = saved;
    } else {
      drawDefaultChalkboard(ctx, canvas);
    }

    // Save initial state to history for undo
    saveHistoryState(ctx, canvas);

    function startDraw(e) {
      if (chalkboardFrozen) {
        showToast('🔒 The dugout chalkboard is currently locked by organizers.');
        return;
      }
      isDrawing = true;
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      lastX = (clientX - rect.left) * (canvas.width / rect.width);
      lastY = (clientY - rect.top) * (canvas.height / rect.height);
    }

    function moveDraw(e) {
      if (!isDrawing) return;
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const x = (clientX - rect.left) * (canvas.width / rect.width);
      const y = (clientY - rect.top) * (canvas.height / rect.height);

      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(x, y);

      if (chalkColor === 'eraser') {
        ctx.strokeStyle = '#1c2b27'; // chalkboard bg
        ctx.lineWidth = chalkSize * 4;
        ctx.lineCap = 'round';
        ctx.stroke();
      } else {
        // Textured chalk line with slight opacity variation
        ctx.strokeStyle = chalkColor;
        ctx.lineWidth = chalkSize;
        ctx.lineCap = 'round';
        ctx.shadowBlur = 1;
        ctx.shadowColor = chalkColor;
        ctx.stroke();
      }

      lastX = x;
      lastY = y;
    }

    function endDraw() {
      if (!isDrawing) return;
      isDrawing = false;
      saveHistoryState(ctx, canvas);
      localStorage.setItem('pbf_chalkboard_data', canvas.toDataURL());
    }

    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', moveDraw);
    window.addEventListener('mouseup', endDraw);

    // Touch events for mobile phones and tablets
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      startDraw(e);
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      moveDraw(e);
    }, { passive: false });
    canvas.addEventListener('touchend', endDraw);

    // Toolbar controls
    document.querySelectorAll('.chalk-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.chalk-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        chalkColor = btn.getAttribute('data-chalk-color');
      });
    });

    const sizeSelect = document.getElementById('chalk-size-select');
    if (sizeSelect) {
      sizeSelect.addEventListener('change', (e) => {
        chalkSize = parseInt(e.target.value, 10) || 4;
      });
    }

    // Undo button
    const undoBtn = document.getElementById('btn-undo-chalk');
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        if (chalkHistory.length > 1) {
          chalkHistory.pop(); // remove current state
          const prev = chalkHistory[chalkHistory.length - 1];
          const img = new Image();
          img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            localStorage.setItem('pbf_chalkboard_data', canvas.toDataURL());
          };
          img.src = prev;
        }
      });
    }

    // Wipe Board button
    const wipeBtn = document.getElementById('btn-wipe-chalk');
    if (wipeBtn) {
      wipeBtn.addEventListener('click', () => {
        if (confirm('Wipe the chalkboard clean with the felt eraser?')) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          drawChalkDust(ctx, canvas);
          saveHistoryState(ctx, canvas);
          localStorage.removeItem('pbf_chalkboard_data');
        }
      });
    }

    // Download Artwork button (Composites Chalk Doodle + Slapped Stickers)
    const downloadBtn = document.getElementById('btn-download-chalk');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        const offscreen = document.createElement('canvas');
        offscreen.width = canvas.width;
        offscreen.height = canvas.height;
        const offCtx = offscreen.getContext('2d');

        // 1. Draw chalk slate drawing
        offCtx.drawImage(canvas, 0, 0);

        // 2. Draw placed stickers
        placedStickers.forEach(stk => {
          const safeX = typeof stk.x === 'number' ? stk.x : parseInt(stk.x, 10) || 0;
          const safeY = typeof stk.y === 'number' ? stk.y : parseInt(stk.y, 10) || 0;
          const safeRot = typeof stk.rotation === 'number' ? stk.rotation : parseInt(stk.rotation, 10) || 0;

          offCtx.save();
          offCtx.translate(safeX + 24, safeY + 24);
          offCtx.rotate((safeRot * Math.PI) / 180);
          offCtx.font = '32px sans-serif';
          offCtx.textAlign = 'center';
          offCtx.textBaseline = 'middle';
          offCtx.fillText(stk.icon, 0, 0);

          if (stk.tag) {
            offCtx.font = 'bold 11px sans-serif';
            const tagMetrics = offCtx.measureText(stk.tag);
            const padX = 6;
            const padY = 3;
            offCtx.fillStyle = 'rgba(0,0,0,0.85)';
            offCtx.fillRect(-tagMetrics.width / 2 - padX, 18 - padY, tagMetrics.width + (padX * 2), 16 + (padY * 2));
            offCtx.fillStyle = '#FFFFFF';
            offCtx.fillText(stk.tag, 0, 26);
          }
          offCtx.restore();
        });

        const a = document.createElement('a');
        a.download = 'pbf-dugout-wall-' + new Date().toISOString().slice(0, 10) + '.png';
        a.href = offscreen.toDataURL('image/png');
        a.click();
      });
    }

    // Stencil buttons
    document.querySelectorAll('.chalk-stencil-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const stencil = btn.getAttribute('data-stencil');
        applyChalkStencil(ctx, canvas, stencil);
        saveHistoryState(ctx, canvas);
        localStorage.setItem('pbf_chalkboard_data', canvas.toDataURL());
      });
    });

    // Admin Freeze / Lock Board button
    const adminFreezeBtn = document.getElementById('btn-admin-freeze-chalk');
    if (adminFreezeBtn) {
      adminFreezeBtn.addEventListener('click', () => {
        chalkboardFrozen = !chalkboardFrozen;
        adminFreezeBtn.textContent = chalkboardFrozen ? '🔒 Lock Board: ON (Read-Only)' : '🔒 Lock Board: OFF';
        adminFreezeBtn.style.background = chalkboardFrozen ? 'var(--secondary)' : '';
        adminFreezeBtn.style.color = chalkboardFrozen ? '#fff' : 'var(--secondary)';
        showToast(chalkboardFrozen ? '🔒 Chalkboard locked in read-only mode by Admin.' : 'Chalkboard unlocked for all players.');
      });
    }
  }

  function saveHistoryState(ctx, canvas) {
    if (chalkHistory.length > 15) chalkHistory.shift();
    chalkHistory.push(canvas.toDataURL());
  }

  function drawDefaultChalkboard(ctx, canvas) {
    drawChalkDust(ctx, canvas);

    ctx.save();
    ctx.strokeStyle = '#FDE68A'; // Chalk Yellow
    ctx.fillStyle = '#F8F9FA'; // Chalk White
    ctx.lineWidth = 3;
    ctx.font = 'bold 22px monospace';
    ctx.fillText('⚾ PBF DUGOUT STRATEGY BOARD', 30, 45);

    ctx.font = '15px sans-serif';
    ctx.fillStyle = '#A7F3D0'; // Mint
    ctx.fillText('Sunday 12:00 PM @ Bushrod Park Field 1', 30, 75);

    // Draw mini chalk diamond
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(100, 140); // 2nd base
    ctx.lineTo(150, 190); // 1st base
    ctx.lineTo(100, 240); // home plate
    ctx.lineTo(50, 190);  // 3rd base
    ctx.closePath();
    ctx.stroke();

    ctx.font = '12px sans-serif';
    ctx.fillText('Home', 85, 260);
    ctx.fillText('2nd', 90, 130);
    ctx.fillText('1st', 158, 195);
    ctx.fillText('3rd', 20, 195);

    ctx.fillStyle = '#FBCFE8'; // Pink
    ctx.font = 'italic 15px sans-serif';
    ctx.fillText('"Hit it where they ain\'t!"', 240, 180);
    ctx.restore();
  }

  function drawChalkDust(ctx, canvas) {
    ctx.fillStyle = '#1c2b27';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Subtle chalk dust specks
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    for (let i = 0; i < 300; i++) {
      ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 2, 2);
    }
  }

  function applyChalkStencil(ctx, canvas, stencil) {
    ctx.save();
    ctx.strokeStyle = '#FFFFFF';
    ctx.fillStyle = '#FFFFFF';
    ctx.lineWidth = 3;

    if (stencil === 'playball') {
      ctx.font = 'bold 36px cursive, sans-serif';
      ctx.fillText('⚾ Play Ball!', 200, 260);
    } else if (stencil === 'strikezone') {
      const sx = 300;
      const sy = 120;
      ctx.strokeRect(sx, sy, 120, 160);
      // 9 sub-boxes
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx + 40, sy); ctx.lineTo(sx + 40, sy + 160);
      ctx.moveTo(sx + 80, sy); ctx.lineTo(sx + 80, sy + 160);
      ctx.moveTo(sx, sy + 53); ctx.lineTo(sx + 120, sy + 53);
      ctx.moveTo(sx, sy + 106); ctx.lineTo(sx + 120, sy + 106);
      ctx.stroke();
    } else if (stencil === 'noon') {
      ctx.font = 'bold 26px sans-serif';
      ctx.fillStyle = '#FDE68A';
      ctx.fillText('⏰ SUNDAYS @ NOON', 200, 320);
    }
    ctx.restore();
  }

  function showToast(msg) {
    let toast = document.getElementById('art-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'art-toast';
      toast.style.position = 'fixed';
      toast.style.bottom = '20px';
      toast.style.left = '50%';
      toast.style.transform = 'translateX(-50%)';
      toast.style.background = 'var(--secondary)';
      toast.style.color = '#fff';
      toast.style.padding = '10px 20px';
      toast.style.borderRadius = '30px';
      toast.style.fontWeight = '700';
      toast.style.zIndex = '9999';
      toast.style.boxShadow = '0 6px 16px rgba(0,0,0,0.3)';
      toast.style.transition = 'opacity 0.2s';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { toast.style.display = 'none'; }, 200);
    }, 2500);
  }

  // Initialize all three engines when DOM is ready
  document.addEventListener('DOMContentLoaded', async () => {
    initPixelDiamond();
    initEquipmentTrunk();
    initDugoutChalkboard();
    try {
      if (window.API) {
        const cached = API.getCachedUser();
        if (cached) {
          API.renderNav(cached);
          setUser(cached);
        }
        const user = await API.getMe();
        API.renderNav(user);
        setUser(user);
      }
    } catch (e) {}
  });

  // Export to global window object
  window.ArtStudio = {
    setUser: setUser,
    getIsAdmin: function() { return isAdmin; },
    getIsChalkboardFrozen: function() { return chalkboardFrozen; },
    initPixelDiamond: initPixelDiamond,
    initEquipmentTrunk: initEquipmentTrunk,
    initDugoutChalkboard: initDugoutChalkboard
  };

})(window);
