/**
 * Zero-Build ESLint Enforcement & Empty-Catch Hygiene Tests (Ticket #21)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('eslint');

const ROOT_DIR = path.join(__dirname, '..', '..');

function ruleIds(results) {
  return results.flatMap((r) => r.messages.map((m) => m.ruleId));
}

module.exports = function registerLintTests() {
  test('T12: Zero-build ESLint configuration & safety rules', async (t12) => {
    await t12.test('T12.1: package.json lint script, devDependencies, and .gitignore .eslintcache entry exist', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
      assert.equal(
        pkg.scripts && pkg.scripts.lint,
        'eslint . --cache --cache-location .eslintcache',
        'package.json must define the cached eslint lint script'
      );
      assert.ok(pkg.devDependencies && pkg.devDependencies.eslint, 'eslint must be in devDependencies');
      assert.ok(pkg.devDependencies['@eslint/js'], '@eslint/js must be in devDependencies');
      assert.ok(pkg.devDependencies.globals, 'globals must be in devDependencies');

      const gitignore = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
      assert.ok(
        gitignore.split(/\r?\n/).some((line) => line.trim() === '.eslintcache'),
        '.gitignore must ignore .eslintcache'
      );
      assert.ok(fs.existsSync(path.join(ROOT_DIR, 'eslint.config.js')), 'eslint.config.js must exist');
    });

    await t12.test('T12.2: ESLint rejects ?., ??, eval, new Function, no-undef, no-empty, and IIFE no-implicit-globals', async () => {
      const eslint = new ESLint({
        cwd: ROOT_DIR,
        overrideConfigFile: path.join(ROOT_DIR, 'eslint.config.js')
      });

      const clientTarget = path.join(ROOT_DIR, 'public', 'js', 'app.js');
      const swTarget = path.join(ROOT_DIR, 'public', 'sw.js');
      const iifeTarget = path.join(ROOT_DIR, 'public', 'js', 'weather.js');
      const backendTarget = path.join(ROOT_DIR, 'src', 'app', 'errors.js');

      const optChainRes = await eslint.lintText('var x = window.API ? window.API.foo?.bar : 1;\nvoid x;\n', { filePath: clientTarget });
      assert.ok(ruleIds(optChainRes).includes('no-restricted-syntax'), 'client JS must reject optional chaining (?.)');

      const nullishRes = await eslint.lintText('var x = window.API ?? {};\nvoid x;\n', { filePath: clientTarget });
      assert.ok(ruleIds(nullishRes).includes('no-restricted-syntax'), 'client JS must reject nullish coalescing (??)');

      const swOptChainRes = await eslint.lintText('var x = self.caches?.default ?? null;\nvoid x;\n', { filePath: swTarget });
      assert.equal(
        ruleIds(swOptChainRes).filter((id) => id === 'no-restricted-syntax').length,
        2,
        'sw.js must reject both ?. and ??'
      );

      const cspRes = await eslint.lintText('eval("1");\nnew Function("return 1")();\nunknownGlobalSymbol();\n', { filePath: clientTarget });
      const cspRules = ruleIds(cspRes);
      assert.ok(cspRules.includes('no-eval'), 'client JS must reject eval()');
      assert.ok(cspRules.includes('no-new-func'), 'client JS must reject new Function()');
      assert.ok(cspRules.includes('no-undef'), 'client JS must reject undeclared identifiers');

      const emptyCatchClient = await eslint.lintText('try { window.focus(); } catch (e) {}\n', { filePath: clientTarget });
      assert.ok(ruleIds(emptyCatchClient).includes('no-empty'), 'client JS must reject empty catch blocks');

      const emptyCatchBackend = await eslint.lintText('try { Math.random(); } catch (e) {}\n', { filePath: backendTarget });
      assert.ok(ruleIds(emptyCatchBackend).includes('no-empty'), 'backend ESM must reject empty catch blocks');

      const iifeGlobalRes = await eslint.lintText('var leakedGlobal = 1;\nvoid leakedGlobal;\n', { filePath: iifeTarget });
      assert.ok(ruleIds(iifeGlobalRes).includes('no-implicit-globals'), 'IIFE client modules must reject top-level globals');
    });
  });
};
