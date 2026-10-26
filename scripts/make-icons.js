const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 implementation for PNG generation
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1);
    else c = c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function makeChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(12 + len);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  const crcVal = crc32(chunk.slice(4, 8 + len));
  chunk.writeUInt32BE(crcVal, 8 + len);
  return chunk;
}

function unfilterScanlines(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc(width * height * bytesPerPixel);
  let srcPos = 0;
  let dstPos = 0;

  for (let y = 0; y < height; y++) {
    const filterType = raw[srcPos++];
    const lineStart = dstPos;

    for (let x = 0; x < stride; x++) {
      const xByte = raw[srcPos++];
      const a = (x >= bytesPerPixel) ? out[lineStart + x - bytesPerPixel] : 0;
      const b = (y > 0) ? out[lineStart - stride + x] : 0;
      const c = (y > 0 && x >= bytesPerPixel) ? out[lineStart - stride + x - bytesPerPixel] : 0;

      let val = 0;
      switch (filterType) {
        case 0: val = xByte; break;
        case 1: val = (xByte + a) & 0xff; break;
        case 2: val = (xByte + b) & 0xff; break;
        case 3: val = (xByte + Math.floor((a + b) / 2)) & 0xff; break;
        case 4:
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          let pr = c;
          if (pa <= pb && pa <= pc) pr = a;
          else if (pb <= pc) pr = b;
          val = (xByte + pr) & 0xff;
          break;
        default:
          throw new Error('Unknown filter type ' + filterType);
      }
      out[dstPos++] = val;
    }
  }
  return out;
}

function parsePng(buf) {
  let pos = 8;
  let ihdr = null;
  const idats = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12]
      };
    } else if (type === 'IDAT') {
      idats.push(data);
    }
  }

  const decompressed = zlib.inflateSync(Buffer.concat(idats));
  const bpp = ihdr.colorType === 0 ? 1 : (ihdr.colorType === 2 ? 3 : 4);
  const rawPixels = unfilterScanlines(decompressed, ihdr.width, ihdr.height, bpp);

  const rgba = Buffer.alloc(ihdr.width * ihdr.height * 4);
  for (let i = 0; i < ihdr.width * ihdr.height; i++) {
    if (ihdr.colorType === 0) {
      const v = rawPixels[i];
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    } else if (ihdr.colorType === 2) {
      rgba[i * 4] = rawPixels[i * 3];
      rgba[i * 4 + 1] = rawPixels[i * 3 + 1];
      rgba[i * 4 + 2] = rawPixels[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    } else if (ihdr.colorType === 6) {
      rgba[i * 4] = rawPixels[i * 4];
      rgba[i * 4 + 1] = rawPixels[i * 4 + 1];
      rgba[i * 4 + 2] = rawPixels[i * 4 + 2];
      rgba[i * 4 + 3] = rawPixels[i * 4 + 3];
    }
  }

  return { width: ihdr.width, height: ihdr.height, rgba };
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  const stride = width * 4;
  const rawScanlines = Buffer.alloc(height * (stride + 1));
  let srcPos = 0;
  let dstPos = 0;
  for (let y = 0; y < height; y++) {
    rawScanlines[dstPos++] = 0; // Filter: None
    rgba.copy(rawScanlines, dstPos, srcPos, srcPos + stride);
    dstPos += stride;
    srcPos += stride;
  }

  const compressed = zlib.deflateSync(rawScanlines, { level: 9 });
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

function resampleAndCenter(srcImg, targetSize, scaleFactor = 0.88, offsetYRatio = 0.48) {
  const srcW = srcImg.width;
  const srcH = srcImg.height;

  let minX = srcW, maxX = 0, minY = srcH, maxY = 0;
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      if (srcImg.rgba[(y * srcW + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;

  const maxDim = targetSize * scaleFactor;
  const scale = Math.min(maxDim / bboxW, maxDim / bboxH);

  const dstW = Math.round(bboxW * scale);
  const dstH = Math.round(bboxH * scale);

  const offsetX = Math.round((targetSize - dstW) / 2);
  const offsetY = Math.round((targetSize - dstH) * offsetYRatio);

  const outRgba = Buffer.alloc(targetSize * targetSize * 4);

  for (let dy = 0; dy < dstH; dy++) {
    const targetY = offsetY + dy;
    if (targetY < 0 || targetY >= targetSize) continue;

    const sy0 = minY + (dy / scale);
    const sy1 = minY + ((dy + 1) / scale);

    for (let dx = 0; dx < dstW; dx++) {
      const targetX = offsetX + dx;
      if (targetX < 0 || targetX >= targetSize) continue;

      const sx0 = minX + (dx / scale);
      const sx1 = minX + ((dx + 1) / scale);

      let sumR = 0, sumG = 0, sumB = 0, sumA = 0, totalWeight = 0;

      const yStart = Math.max(0, Math.floor(sy0));
      const yEnd = Math.min(srcH - 1, Math.floor(sy1));
      const xStart = Math.max(0, Math.floor(sx0));
      const xEnd = Math.min(srcW - 1, Math.floor(sx1));

      for (let sy = yStart; sy <= yEnd; sy++) {
        const yWeight = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (yWeight <= 0) continue;

        for (let sx = xStart; sx <= xEnd; sx++) {
          const xWeight = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (xWeight <= 0) continue;

          const w = xWeight * yWeight;
          totalWeight += w;

          const idx = (sy * srcW + sx) * 4;
          const a = srcImg.rgba[idx + 3] / 255;
          const r = srcImg.rgba[idx] * a;
          const g = srcImg.rgba[idx + 1] * a;
          const b = srcImg.rgba[idx + 2] * a;

          sumR += r * w;
          sumG += g * w;
          sumB += b * w;
          sumA += a * w;
        }
      }

      if (totalWeight > 0 && sumA > 0) {
        const avgA = sumA / totalWeight;
        const avgR = (sumR / totalWeight) / avgA;
        const avgG = (sumG / totalWeight) / avgA;
        const avgB = (sumB / totalWeight) / avgA;

        const outIdx = (targetY * targetSize + targetX) * 4;
        outRgba[outIdx] = Math.min(255, Math.max(0, Math.round(avgR)));
        outRgba[outIdx + 1] = Math.min(255, Math.max(0, Math.round(avgG)));
        outRgba[outIdx + 2] = Math.min(255, Math.max(0, Math.round(avgB)));
        outRgba[outIdx + 3] = Math.min(255, Math.max(0, Math.round(avgA * 255)));
      }
    }
  }

  return { targetSize, outRgba };
}

function createMaskable(srcImg, targetSize, bgColor = { r: 0x00, g: 0x38, b: 0x31 }) {
  // Safe zone for maskable icon is the inner 80% circle
  const res = resampleAndCenter(srcImg, targetSize, 0.68, 0.48);
  const outRgba = Buffer.alloc(targetSize * targetSize * 4);

  for (let i = 0; i < targetSize * targetSize; i++) {
    const fgA = res.outRgba[i * 4 + 3] / 255;
    if (fgA > 0) {
      const fgR = res.outRgba[i * 4];
      const fgG = res.outRgba[i * 4 + 1];
      const fgB = res.outRgba[i * 4 + 2];
      outRgba[i * 4] = Math.round(fgR * fgA + bgColor.r * (1 - fgA));
      outRgba[i * 4 + 1] = Math.round(fgG * fgA + bgColor.g * (1 - fgA));
      outRgba[i * 4 + 2] = Math.round(fgB * fgA + bgColor.b * (1 - fgA));
      outRgba[i * 4 + 3] = 255;
    } else {
      outRgba[i * 4] = bgColor.r;
      outRgba[i * 4 + 1] = bgColor.g;
      outRgba[i * 4 + 2] = bgColor.b;
      outRgba[i * 4 + 3] = 255;
    }
  }

  return outRgba;
}

function makeIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerLen = 6;
  const dirEntryLen = 16;
  const dirSize = count * dirEntryLen;
  let offset = headerLen + dirSize;

  const header = Buffer.alloc(headerLen);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = ICO
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  for (const item of pngBuffers) {
    const entry = Buffer.alloc(dirEntryLen);
    entry[0] = item.width >= 256 ? 0 : item.width;
    entry[1] = item.height >= 256 ? 0 : item.height;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(item.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += item.buffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers.map(p => p.buffer)]);
}

function main() {
  const svgPath = path.join(__dirname, '../public/logo.svg');
  const svg = fs.readFileSync(svgPath, 'utf8');
  const parts = svg.split('base64,');

  if (parts.length <= 2) {
    console.error('Could not find embedded PNG and mask in logo.svg');
    process.exit(1);
  }

  // Part 1: Grayscale Alpha Mask (from <mask id="...">)
  const maskB64 = parts[1].split('"')[0];
  const maskPng = parsePng(Buffer.from(maskB64, 'base64'));

  // Part 2: RGB Color Image
  const rgbB64 = parts[2].split('"')[0];
  const rgbPng = parsePng(Buffer.from(rgbB64, 'base64'));

  // Recombine into true transparent RGBA
  const w = rgbPng.width;
  const h = rgbPng.height;
  const transparentRgba = Buffer.alloc(w * h * 4);

  for (let i = 0; i < w * h; i++) {
    const alpha = maskPng.rgba[i * 4];
    transparentRgba[i * 4] = rgbPng.rgba[i * 4];
    transparentRgba[i * 4 + 1] = rgbPng.rgba[i * 4 + 1];
    transparentRgba[i * 4 + 2] = rgbPng.rgba[i * 4 + 2];
    transparentRgba[i * 4 + 3] = alpha;
  }

  const srcImg = { width: w, height: h, rgba: transparentRgba };
  const iconsDir = path.join(__dirname, '../public/icons');
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  // 1. Transparent Desktop PWA Icons (purpose: "any")
  const res512 = resampleAndCenter(srcImg, 512, 0.88, 0.48);
  const icon512Png = encodePng(res512.outRgba, 512, 512);
  fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), icon512Png);

  const res192 = resampleAndCenter(srcImg, 192, 0.88, 0.48);
  const icon192Png = encodePng(res192.outRgba, 192, 192);
  fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), icon192Png);

  // 2. Maskable Icons with brand Forest Green background for adaptive shapes (purpose: "maskable")
  const maskable512Rgba = createMaskable(srcImg, 512);
  const maskable512Png = encodePng(maskable512Rgba, 512, 512);
  fs.writeFileSync(path.join(iconsDir, 'icon-maskable-512.png'), maskable512Png);

  const maskable192Rgba = createMaskable(srcImg, 192);
  const maskable192Png = encodePng(maskable192Rgba, 192, 192);
  fs.writeFileSync(path.join(iconsDir, 'icon-maskable-192.png'), maskable192Png);

  // 3. Apple Touch Icon (180x180, Forest Green background)
  const resApple = resampleAndCenter(srcImg, 180, 0.75, 0.48);
  const appleRgba = Buffer.alloc(180 * 180 * 4);
  const bgR = 0x00, bgG = 0x38, bgB = 0x31;
  for (let i = 0; i < 180 * 180; i++) {
    const fgA = resApple.outRgba[i * 4 + 3] / 255;
    if (fgA > 0) {
      const fgR = resApple.outRgba[i * 4];
      const fgG = resApple.outRgba[i * 4 + 1];
      const fgB = resApple.outRgba[i * 4 + 2];
      appleRgba[i * 4] = Math.round(fgR * fgA + bgR * (1 - fgA));
      appleRgba[i * 4 + 1] = Math.round(fgG * fgA + bgG * (1 - fgA));
      appleRgba[i * 4 + 2] = Math.round(fgB * fgA + bgB * (1 - fgA));
      appleRgba[i * 4 + 3] = 255;
    } else {
      appleRgba[i * 4] = bgR;
      appleRgba[i * 4 + 1] = bgG;
      appleRgba[i * 4 + 2] = bgB;
      appleRgba[i * 4 + 3] = 255;
    }
  }
  const appleIconPng = encodePng(appleRgba, 180, 180);
  fs.writeFileSync(path.join(iconsDir, 'apple-touch-icon.png'), appleIconPng);

  // 4. Favicon icons (32x32, 16x16, 48x48, and multi-res favicon.ico)
  const res48 = resampleAndCenter(srcImg, 48, 0.90, 0.48);
  const png48 = encodePng(res48.outRgba, 48, 48);

  const res32 = resampleAndCenter(srcImg, 32, 0.90, 0.48);
  const png32 = encodePng(res32.outRgba, 32, 32);
  fs.writeFileSync(path.join(iconsDir, 'favicon-32x32.png'), png32);

  const res16 = resampleAndCenter(srcImg, 16, 0.90, 0.48);
  const png16 = encodePng(res16.outRgba, 16, 16);
  fs.writeFileSync(path.join(iconsDir, 'favicon-16x16.png'), png16);

  const icoBuf = makeIco([
    { width: 16, height: 16, buffer: png16 },
    { width: 32, height: 32, buffer: png32 },
    { width: 48, height: 48, buffer: png48 }
  ]);
  fs.writeFileSync(path.join(__dirname, '../public/favicon.ico'), icoBuf);

  console.log('Successfully generated transparent PWA icons, maskable icons, and favicons:');
  console.log('- public/icons/icon-512.png (512x512, transparent, purpose "any")');
  console.log('- public/icons/icon-192.png (192x192, transparent, purpose "any")');
  console.log('- public/icons/icon-maskable-512.png (512x512, forest green, purpose "maskable")');
  console.log('- public/icons/icon-maskable-192.png (192x192, forest green, purpose "maskable")');
  console.log('- public/icons/apple-touch-icon.png (180x180, forest green)');
  console.log('- public/icons/favicon-32x32.png, favicon-16x16.png, public/favicon.ico');
}

main();
