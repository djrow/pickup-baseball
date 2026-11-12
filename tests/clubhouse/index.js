/**
 * tests/clubhouse/index.js
 * Master Aggregator for Pickup Baseball Clubhouse Automated Verification Suite
 *
 * Coordinates execution of all 4 test tiers:
 * - Tier 1: Feature Coverage (Section 8 Checks 1–8)
 * - Tier 2: Boundary & Corner Cases (System Limits & Security Guards)
 * - Tier 3: Cross-Feature Combinations (Pairwise Subsystem Suites)
 * - Tier 4: Real-World Application Scenarios (End-to-End User Journeys)
 *
 * Fully integrated with Node.js v22 node:test and verify-all.js
 */

const test = require('node:test');
const { createClubhouseTestContext } = require('../helpers/test-harness');
const runTier1 = require('./tier1-feature-coverage.test');
const runTier2 = require('./tier2-boundary-corner.test');
const runTier3 = require('./tier3-cross-feature.test');
const runTier4 = require('./tier4-application-scenarios.test');
const runTier5 = require('./tier5-moderation-resources.test');

/**
 * Register all Clubhouse tests within a parent test runner
 */
function registerClubhouseTests(options = {}) {
  test('Clubhouse E2E Verification Suite (Tiers 1–5)', async (t) => {
    const ctx = await createClubhouseTestContext(options);
    try {
      await t.test('Tier 1: Feature Coverage', async (t1) => {
        await runTier1(t1, ctx);
      });

      await t.test('Tier 2: Boundary & Corner Cases', async (t2) => {
        await runTier2(t2, ctx);
      });

      await t.test('Tier 3: Cross-Feature Combinations', async (t3) => {
        await runTier3(t3, ctx);
      });

      await t.test('Tier 4: Real-World Scenarios', async (t4) => {
        await runTier4(t4, ctx);
      });

      await t.test('Tier 5: Moderation, Mutes, Boards & Resource Frugality', async (t5) => {
        await runTier5(t5, ctx);
      });
    } finally {
      await ctx.cleanup();
    }
  });
}

// Standalone execution support: node tests/clubhouse/index.js
if (require.main === module) {
  registerClubhouseTests();
}

module.exports = registerClubhouseTests;
