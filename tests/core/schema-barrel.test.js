/**
 * Schema Barrel Contract Tests (Ticket #27)
 * Ensures `src/app/schema.js` exposes the exact same named exports after splitting into `src/app/schema/*.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT_DIR = path.join(__dirname, '..', '..');
const SCHEMA_BARREL_PATH = path.join(ROOT_DIR, 'src', 'app', 'schema.js');

const EXPECTED_EXPORTS = [
  'ALTER_STATEMENTS',
  'CHAT_ALTER_STATEMENTS',
  'CREATE_CHAT_TABLES_SQL',
  'CREATE_TABLES_SQL',
  'DEFAULT_BASEBALL_DUTIES',
  'DEFAULT_CHAT_CHANNELS',
  'ensureBaseballD1Schema',
  'ensureChatD1Schema',
  'ensureClubhouseOptInBackfill',
  'ensureD1Schema',
  'ensureDualD1Schema',
  'getDefaultDuties',
  'getDisallowZeroLoginMediaSetting',
  'getRequireLoginSetting',
  'pruneEphemeralBaseballRows',
  'pruneEphemeralChatRows'
];

module.exports = function registerSchemaBarrelTests() {
  test('Schema Barrel: src/app/schema.js exports the exact canonical named symbols', async () => {
    const schemaCjs = require(SCHEMA_BARREL_PATH);
    const schemaEsm = await import(pathToFileURL(SCHEMA_BARREL_PATH).href);

    assert.deepEqual(
      Object.keys(schemaCjs).sort(),
      EXPECTED_EXPORTS,
      'CJS require() of src/app/schema.js must expose the exact expected exports'
    );
    assert.deepEqual(
      Object.keys(schemaEsm).sort(),
      EXPECTED_EXPORTS,
      'ESM import() of src/app/schema.js must expose the exact expected exports'
    );

    assert.ok(Array.isArray(schemaEsm.DEFAULT_BASEBALL_DUTIES));
    assert.ok(Array.isArray(schemaEsm.CREATE_TABLES_SQL));
    assert.ok(Array.isArray(schemaEsm.ALTER_STATEMENTS));
    assert.ok(Array.isArray(schemaEsm.DEFAULT_CHAT_CHANNELS));
    assert.ok(Array.isArray(schemaEsm.CREATE_CHAT_TABLES_SQL));
    assert.ok(Array.isArray(schemaEsm.CHAT_ALTER_STATEMENTS));

    assert.equal(typeof schemaEsm.ensureD1Schema, 'function');
    assert.equal(schemaEsm.ensureBaseballD1Schema, schemaEsm.ensureD1Schema);
    assert.equal(typeof schemaEsm.ensureChatD1Schema, 'function');
    assert.equal(typeof schemaEsm.ensureClubhouseOptInBackfill, 'function');
    assert.equal(typeof schemaEsm.ensureDualD1Schema, 'function');
    assert.equal(typeof schemaEsm.pruneEphemeralBaseballRows, 'function');
    assert.equal(typeof schemaEsm.pruneEphemeralChatRows, 'function');
    assert.equal(typeof schemaEsm.getDefaultDuties, 'function');
    assert.equal(typeof schemaEsm.getRequireLoginSetting, 'function');
    assert.equal(typeof schemaEsm.getDisallowZeroLoginMediaSetting, 'function');
  });
};

if (require.main === module) {
  module.exports();
}
