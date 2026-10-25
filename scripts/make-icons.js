const fs = require('fs');
const path = require('path');

const svg = fs.readFileSync(path.join(__dirname, '../public/logo.svg'), 'utf8');
const parts = svg.split('base64,');
if (parts.length > 2) {
  const base64Data = parts[2].split('"')[0];
  const buf = Buffer.from(base64Data, 'base64');
  const iconsDir = path.join(__dirname, '../public/icons');
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }
  fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), buf);
  fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), buf);
  fs.writeFileSync(path.join(iconsDir, 'apple-touch-icon.png'), buf);
  console.log('Successfully created PWA icons in public/icons/: icon-192.png, icon-512.png, apple-touch-icon.png');
} else {
  console.error('Could not find embedded PNG in logo.svg');
}
