# Community Art Studio Architecture & Re-Implementation Guide

> **Status:** Archived / Retired from primary gallery webapp UI (v77).  
> **Purpose of this note:** If users or organizers request the Pixel Art or Dugout Sticker / Chalkboard spaces in the future, this document contains the complete architectural specifications, DOM templates, state management details, and step-by-step instructions to restore or rewrite the feature in minutes.

---

## 1. Overview & Capabilities

The **Community Art Studio** consisted of three interactive, zero-login collaborative art experiences designed for pickup baseball players and fans:

1. **The "r/pbf" Pixel Diamond Mosaic (`#pixel-diamond-canvas`)**
   - **Canvas:** 64×64 pixel grid canvas scaled smoothly with `image-rendering: pixelated`.
   - **Color Palette:** 16 retro ballpark colors (e.g., outfield green `#15803d`, infield dirt `#92400e`, ball white `#ffffff`, base yellow `#facc15`, dusk red `#dc2626`, etc.).
   - **Cooldown Mechanism:** Configurable placement cooldown (e.g., 30 seconds) stored in `localStorage` (`pbf_pixel_last_placed`) to encourage collaborative pacing, with a live visual cooldown progress bar.
   - **Export:** High-resolution scaled up PNG download (e.g., 512×512 or 1024×1024) with crisp nearest-neighbor sampling.
   - **Organizer Privileges:** Cooldown bypass switch and instant diamond reset.

2. **The Equipment Trunk / Dugout Sticker Wall (`#trunk-canvas-stage`)**
   - **Interactive Stage:** Freeform 2D sticker placement stage overlay with rotation and depth layers.
   - **Sticker Shelf:** Categorized baseball emoji and retro badges:
     - `gear`: ⚾ 🥎 🧢 🧤 👟 🎽 🧦
     - `awards`: 🏆 🥇 🥈 🎖️ ⭐ 🌟 👑
     - `dugout`: 🌭 🍿 🥤 🥜 🍉 🍕 🍔
     - `vibes`: 🔥 ⚡ 🌈 💯 🕶️ 🤘 🚀
   - **Custom Caption Tags:** Optional player name or game note tag attached to placed stickers (e.g., "Bushrod 2026", "Walk-off Single").
   - **Peel & Moderation:** Tap any placed sticker to peel it off; Organizer admin privilege for one-click board peel/wipe.

3. **The Dugout Chalkboard (`#chalkboard-canvas`)**
   - **Canvas:** Dusty slate chalkboard texture (`#1c2b27`) with natural stroke rendering.
   - **Chalk Tools:** 5 chalk colors (White `#F8F9FA`, Yellow `#FDE047`, Pink `#F472B6`, Mint `#86EFAC`, Sky Blue `#7DD3FC`) and Felt Eraser (`#1c2b27`).
   - **Stroke Thickness:** Fine tip (3px), Medium (6px), Broad (12px).
   - **Quick Stencils:** Preset stencils for "⚾ Play Ball!", "🎯 Strike Zone", and "⏰ Noon".
   - **History & Save:** Full multi-stroke undo stack and direct high-resolution PNG export combining chalk drawings and slapped stickers.
   - **Organizer Privileges:** Ability to freeze/lock the chalkboard from incoming edits.

4. **The Unified Dugout Stage (`.unified-dugout-stage`)**
   - Combines the chalkboard canvas as the bottom drawing layer (`z-index: 1`) and the sticker stage overlay as the top interaction layer (`z-index: 2`), allowing users to toggle between "Dusty Chalk Drawing" mode and "Slap Stickers & Emojis" mode on a single shared surface.

---

## 2. Source Code References & Preservation

The core logic remains fully preserved in strict ES6 (no `?.` or `??`) inside:
- [`public/js/art.js`](file:///c:/Users/david/Documents/antigravity/lucid-maxwell/public/js/art.js): Implements `window.ArtStudio` with:
  - `ArtStudio.initPixelDiamond()`
  - `ArtStudio.initEquipmentTrunk()`
  - `ArtStudio.initDugoutChalkboard()`
  - `ArtStudio.initUnifiedDugout()`
  - `ArtStudio.setUser(currentUser)`
- [`public/css/style.css`](file:///c:/Users/david/Documents/antigravity/lucid-maxwell/public/css/style.css): Defines styling for:
  - `.pixel-board-container`, `.pixel-canvas-frame`, `.pixel-palette-row`, `.pixel-color-swatch`
  - `.trunk-outer-box`, `.dugout-wall-outer-box`, `.trunk-canvas-stage`, `.sticker-shelf`, `.sticker-item`
  - `.chalkboard-frame`, `.unified-dugout-stage`, `.chalk-btn`, `.chalk-toolbar`

---

## 3. How to Re-Implement / Restore into the Webapp

To restore the Community Art Studio to [`public/gallery.html`](file:///c:/Users/david/Documents/antigravity/lucid-maxwell/public/gallery.html) or a dedicated [`public/art.html`](file:///c:/Users/david/Documents/antigravity/lucid-maxwell/public/art.html):

### Step 1: Add the Quick Jump Navigation Pill (if placing on gallery page)
```html
<a href="#community-art-section" class="btn btn-outline btn-xs" style="font-weight: 700; color: var(--secondary);">🎨 Community Art Studio</a>
```

### Step 2: Insert the Section HTML Markup
```html
<section id="community-art-section" class="card" style="margin-top: 36px; margin-bottom: 40px; padding: 24px; border-top: 5px solid var(--secondary); background: var(--bg-card);">
  <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; margin-bottom: 20px;">
    <div>
      <span class="badge badge-green" style="font-size: 0.75rem; text-transform: uppercase; font-weight: 800;">🎨 Community Art Studio</span>
      <h2 style="color: var(--secondary); font-size: 1.45rem; margin: 6px 0 4px 0;">Shared Ballpark Art Spaces</h2>
      <p style="font-size: 0.9rem; color: var(--text-muted); margin: 0;">
        Leave your mark on Sunday baseball! Paint tiles on the Pixel Diamond, slap retro stickers on the Dugout Wall, or sketch plays on the Dugout Chalkboard.
      </p>
    </div>
    <div class="art-nav-pill-row" style="margin: 0; display: flex; gap: 6px; flex-wrap: wrap;">
      <a href="#section-pixel-diamond" class="btn btn-outline btn-xs">⚾ Pixel Diamond</a>
      <a href="#section-dugout-wall" class="btn btn-outline btn-xs">🧱 Dugout Wall</a>
    </div>
  </div>

  <!-- Admin Moderation Bar -->
  <div id="art-admin-banner" class="alert alert-info" style="display: none; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 24px;">
    <div style="display: flex; align-items: center; gap: 10px;">
      <span style="font-size: 1.3rem;">🛡️</span>
      <div>
        <strong style="color: var(--secondary);">Art Admin Moderation Active:</strong>
        <span style="font-size: 0.86rem;"> One-click sticker peel, no-cooldown tile editing, and board reset privileges active.</span>
      </div>
    </div>
    <span class="badge badge-yellow">Organizer Controls</span>
  </div>

  <!-- Card 1: Pixel Diamond Mosaic -->
  <div id="section-pixel-diamond" class="art-card" style="border-top: 5px solid var(--primary); margin-bottom: 32px; padding: 18px; border-radius: var(--radius-md); background: var(--bg-subtle);">
    <div class="flex-between">
      <div>
        <h3 style="color: var(--secondary); font-size: 1.3rem; margin: 6px 0 2px 0;">⚾ Pixel Diamond Mosaic</h3>
        <p style="font-size: 0.88rem; color: var(--text-muted); margin: 0;">A shared 64×64 pixel grid modeled after stadium scoreboards.</p>
      </div>
      <span id="pixel-coord-display" class="badge badge-gray" style="font-size: 0.82rem; font-family: monospace;">📍 X: --, Y: --</span>
    </div>
    <div class="pixel-board-container" style="margin-top: 14px;">
      <div class="pixel-canvas-frame">
        <canvas id="pixel-diamond-canvas" width="64" height="64"></canvas>
      </div>
      <div style="width: 100%; max-width: 384px;">
        <div class="flex-between" style="font-size: 0.78rem; font-weight: 700; margin-bottom: 4px;">
          <span id="pixel-cooldown-status" style="color: var(--primary);">✅ Tile Ready!</span>
          <span style="color: var(--text-muted); font-size: 0.74rem;">Select color &bull; Click to place</span>
        </div>
        <div style="width: 100%; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden;">
          <div id="pixel-cooldown-bar" style="width: 0%; height: 100%; background: var(--primary); transition: width 0.3s ease;"></div>
        </div>
      </div>
      <div id="pixel-palette-row" class="pixel-palette-row"></div>
      <div class="flex-row-wrap" style="justify-content: center; margin-top: 6px; gap: 6px;">
        <button type="button" id="btn-download-pixel-diamond" class="btn btn-outline btn-sm">📸 Download PNG</button>
        <button type="button" id="btn-reset-pixel-diamond" class="btn btn-outline btn-sm">🔄 Reset Diamond</button>
        <button type="button" id="btn-admin-bypass-cooldown" class="btn btn-outline btn-sm art-admin-only" style="display: none;">⚡ No Cooldown: OFF</button>
        <button type="button" id="btn-admin-reset-diamond" class="btn btn-outline btn-sm art-admin-only" style="display: none;">🛡️ Admin Reset</button>
      </div>
    </div>
  </div>

  <!-- Card 2: Dugout Chalkboard & Sticker Wall -->
  <div id="section-dugout-wall" class="art-card" style="border-top: 5px solid var(--secondary); margin-bottom: 32px; padding: 18px; border-radius: var(--radius-md); background: var(--bg-subtle);">
    <a id="section-equipment-trunk" style="display: block; position: relative; top: -20px; visibility: hidden;"></a>
    <a id="section-chalkboard" style="display: block; position: relative; top: -20px; visibility: hidden;"></a>
    <h3 style="color: var(--secondary); font-size: 1.3rem; margin: 6px 0 2px 0;">📋 The Dugout Chalkboard &amp; Sticker Wall</h3>
    <div class="chalkboard-frame trunk-outer-box dugout-wall-outer-box" style="margin-top: 14px; position: relative; padding: 12px;">
      <div class="unified-dugout-stage" style="position: relative; width: 100%; height: 420px; overflow: hidden; border-radius: 6px; background: #1c2b27;">
        <canvas id="chalkboard-canvas" height="420" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: block;"></canvas>
        <div id="trunk-canvas-stage" class="trunk-canvas-stage dugout-wall-stage" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: transparent; z-index: 2;"></div>
      </div>
    </div>
    <!-- Mode switch and controls -->
    <div style="display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; align-items: center; justify-content: space-between;">
      <div style="display: flex; gap: 8px;">
        <button type="button" id="btn-mode-chalk" class="btn btn-primary btn-sm active">✏️ Dusty Chalk</button>
        <button type="button" id="btn-mode-stickers" class="btn btn-outline btn-sm">🏷️ Slap Stickers</button>
      </div>
      <div class="flex-row-wrap" style="gap: 6px;">
        <button type="button" id="btn-undo-chalk" class="btn btn-outline btn-sm">↩️ Undo Chalk</button>
        <button type="button" id="btn-clear-trunk" class="btn btn-outline btn-sm">🧹 Peel Stickers</button>
        <button type="button" id="btn-wipe-chalk" class="btn btn-outline btn-sm">🧽 Wipe Chalk</button>
        <button type="button" id="btn-download-chalk" class="btn btn-primary btn-sm">📸 Save Artwork</button>
      </div>
    </div>
    <!-- Chalk Toolbar -->
    <div id="chalk-tools-panel" class="chalk-toolbar" style="margin-top: 12px;">
      <div class="flex-row-wrap" style="gap: 8px;">
        <button type="button" class="chalk-btn selected" data-chalk-color="#F8F9FA" style="background: #F8F9FA;"></button>
        <button type="button" class="chalk-btn" data-chalk-color="#FDE047" style="background: #FDE047;"></button>
        <button type="button" class="chalk-btn" data-chalk-color="#F472B6" style="background: #F472B6;"></button>
        <button type="button" class="chalk-btn" data-chalk-color="#86EFAC" style="background: #86EFAC;"></button>
        <button type="button" class="chalk-btn" data-chalk-color="#7DD3FC" style="background: #7DD3FC;"></button>
        <button type="button" class="chalk-btn" data-chalk-color="eraser" style="background: #1c2b27; border: 2px dashed #94a3b8; display: flex; align-items: center; justify-content: center;">🧽</button>
        <select id="chalk-size-select" style="padding: 4px 8px; font-size: 0.8rem; border-radius: 4px;">
          <option value="3">Fine Tip (3px)</option>
          <option value="6" selected>Medium Chalk (6px)</option>
          <option value="12">Broad Chalk (12px)</option>
        </select>
      </div>
      <div class="flex-row-wrap" style="gap: 6px; margin-top: 8px;">
        <button type="button" class="btn btn-outline btn-sm chalk-stencil-btn" data-stencil="playball">⚾ Play Ball!</button>
        <button type="button" class="btn btn-outline btn-sm chalk-stencil-btn" data-stencil="strikezone">🎯 Strike Zone</button>
        <button type="button" class="btn btn-outline btn-sm chalk-stencil-btn" data-stencil="noon">⏰ Noon</button>
      </div>
    </div>
    <!-- Sticker Shelf Panel -->
    <div id="sticker-tools-panel" style="display: none; margin-top: 14px;">
      <div id="sticker-shelf" class="sticker-shelf" style="max-height: 180px; overflow-y: auto;"></div>
      <div style="margin-top: 10px;">
        <input type="text" id="sticker-tag-input" maxlength="28" placeholder="Optional caption / name..." style="padding: 7px 12px; font-size: 0.88rem; width: 100%;">
      </div>
    </div>
  </div>
</section>
```

### Step 3: Script Inclusion
Ensure `/js/art.js` is loaded at the bottom of the page:
```html
<script src="/js/art.js?v=77"></script>
```
When `art.js` loads, it automatically mounts `window.ArtStudio` and self-initializes all canvases and event listeners found in the DOM.
