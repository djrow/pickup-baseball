const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'baseball_charity.db');
if (!fs.existsSync(dbPath)) {
  console.error('Database file not found at:', dbPath);
  process.exit(1);
}

const db = new Database(dbPath);

const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
console.log('Found tables:', tables.map(t => t.name).join(', '));

let dumpSql = '-- Sunday Pickup Baseball D1 Schema & Seed\n\n';

const OMIT_DATA_TABLES = new Set(['sessions', 'auth_codes']);
const EXCLUDED_SETTING_KEYS = new Set(['waiver_provenance_secret', 'appscript_upload_url']);

for (const t of tables) {
  dumpSql += `${t.sql};\n\n`;
  if (OMIT_DATA_TABLES.has(t.name)) continue;
  let rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
  if (t.name === 'app_settings') {
    rows = rows.filter(r => !EXCLUDED_SETTING_KEYS.has(r.key));
  }
  if (rows.length > 0) {
    for (const row of rows) {
      const cols = Object.keys(row).map(c => `"${c}"`).join(', ');
      const vals = Object.values(row).map(v => {
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number') return v;
        return `'${String(v).replace(/'/g, "''")}'`;
      }).join(', ');
      dumpSql += `INSERT OR IGNORE INTO "${t.name}" (${cols}) VALUES (${vals});\n`;
    }
    dumpSql += '\n';
  }
}

const indices = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
for (const idx of indices) {
  dumpSql += `${idx.sql};\n`;
}

const outPath = path.join(__dirname, '..', 'data', 'd1_dump.sql');
fs.writeFileSync(outPath, dumpSql);
console.log('Dumped schema and data to:', outPath);
