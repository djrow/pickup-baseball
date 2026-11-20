#!/usr/bin/env node
/**
 * Generate or verify the AST-derived codebase map at docs/AGENT_MAP.md.
 *
 * Usage:
 *   node scripts/gen-agent-map.js                  # Write docs/AGENT_MAP.md
 *   node scripts/gen-agent-map.js --check          # Exit 1 if docs/AGENT_MAP.md is stale
 *   node scripts/gen-agent-map.js --out=path.md    # Write/check custom output path
 */

const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');
const { scanAstRoutes, walkFiles } = require('./security-scan.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = 'docs/AGENT_MAP.md';
const CLIENT_GLOBALS = new Set([
  'window',
  'root',
  'API',
  'ClubhouseStore',
  'ClubhouseCrypto',
  'ClubhouseRTC',
  'WeatherService',
  'PBFDialog'
]);

function toPosixRel(rootDir, filePath) {
  const absRoot = path.resolve(rootDir);
  const absFile = path.resolve(filePath);
  if (absFile === absRoot) return '.';
  if (absFile.startsWith(absRoot + path.sep)) {
    return path.relative(absRoot, absFile).replace(/\\/g, '/');
  }
  return String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

function collectPatternIdentifiers(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'Identifier') {
    out.push(node.name);
  } else if (node.type === 'ObjectPattern') {
    for (const prop of node.properties || []) {
      collectPatternIdentifiers(prop.type === 'RestElement' ? prop.argument : prop.value, out);
    }
  } else if (node.type === 'ArrayPattern') {
    for (const el of node.elements || []) {
      if (el) collectPatternIdentifiers(el, out);
    }
  } else if (node.type === 'AssignmentPattern') {
    collectPatternIdentifiers(node.left, out);
  } else if (node.type === 'RestElement') {
    collectPatternIdentifiers(node.argument, out);
  }
}

function walkAstNodes(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === 'string') {
          walkAstNodes(item, visitor);
        }
      }
    } else if (child && typeof child.type === 'string') {
      walkAstNodes(child, visitor);
    }
  }
}

function splitTopLevelSqlClauses(body) {
  const clauses = [];
  let current = '';
  let depth = 0;
  let inSingleQuote = false;
  let inLineComment = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const next = body[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        current += ' ';
      }
      continue;
    }

    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i++;
      } else if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      clauses.push(current);
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) clauses.push(current);
  return clauses;
}

function parseDdlTables(filePath, dbName) {
  if (!fs.existsSync(filePath)) return [];
  const src = fs.readFileSync(filePath, 'utf8');
  const tables = [];
  const headerRx = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;

  let match;
  while ((match = headerRx.exec(src)) !== null) {
    const tableName = match[1];
    let i = match.index + match[0].length;
    let depth = 1;
    let inSingleQuote = false;

    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (inSingleQuote) {
        if (ch === "'" && src[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (ch === "'") inSingleQuote = false;
      } else {
        if (ch === "'") inSingleQuote = true;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      i++;
    }

    const body = src.slice(match.index + match[0].length, i - 1);
    const columns = [];
    for (const rawClause of splitTopLevelSqlClauses(body)) {
      const clause = rawClause.trim();
      if (!clause) continue;
      if (/^(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(clause)) continue;
      const colMatch = clause.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (colMatch) columns.push(colMatch[1]);
    }
    tables.push({ db: dbName, name: tableName, columns });
  }

  return tables;
}

function extractSchemaTables(rootDir = ROOT) {
  const schemaDir = path.join(rootDir, 'src', 'app', 'schema');
  return [
    ...parseDdlTables(path.join(schemaDir, 'baseball-ddl.js'), 'BASEBALL_DB'),
    ...parseDdlTables(path.join(schemaDir, 'chat-ddl.js'), 'CHAT_DB')
  ];
}

function extractModuleExports(rootDir = ROOT) {
  const roots = [path.join(rootDir, 'src', 'app'), path.join(rootDir, 'workers')];
  const files = roots
    .flatMap((dir) => walkFiles(dir, (name) => name.endsWith('.js')))
    .map((f) => ({ full: f, rel: toPosixRel(rootDir, f) }))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const modules = [];
  for (const file of files) {
    const src = fs.readFileSync(file.full, 'utf8');
    const ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
    const exported = [];
    const pushExport = (name) => {
      if (name && !exported.includes(name)) exported.push(name);
    };

    for (const node of ast.body || []) {
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration) {
          const decl = node.declaration;
          if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) {
            pushExport(decl.id.name);
          } else if (decl.type === 'VariableDeclaration') {
            for (const d of decl.declarations || []) {
              const names = [];
              collectPatternIdentifiers(d.id, names);
              names.forEach(pushExport);
            }
          }
        }
        for (const spec of node.specifiers || []) {
          if (spec.exported) {
            pushExport(spec.exported.name || spec.exported.value);
          }
        }
      } else if (node.type === 'ExportDefaultDeclaration') {
        pushExport('default');
      } else if (node.type === 'ExportAllDeclaration') {
        if (node.exported) {
          pushExport(node.exported.name || node.exported.value);
        } else if (node.source && node.source.value) {
          pushExport(`* from '${node.source.value}'`);
        }
      }
    }

    if (exported.length > 0) {
      modules.push({ file: file.rel, exports: exported });
    }
  }

  return modules;
}

function extractFrontendPageMap(rootDir = ROOT) {
  const publicDir = path.join(rootDir, 'public');
  const htmlNames = fs.existsSync(publicDir)
    ? fs.readdirSync(publicDir).filter((name) => name.endsWith('.html')).sort()
    : [];

  const pages = [];
  for (const name of htmlNames) {
    const html = fs.readFileSync(path.join(publicDir, name), 'utf8');
    const css = [];
    const js = [];

    for (const m of html.matchAll(/<link\b[^>]*\bhref=["'](\/css\/[^"']+)["'][^>]*>/gi)) {
      const clean = m[1].replace(/\?v=\d+$/, '').replace(/^\/css\//, '').replace(/\.css$/, '');
      if (!css.includes(clean)) css.push(clean);
    }
    for (const m of html.matchAll(/<script\b[^>]*\bsrc=["'](\/js\/[^"']+)["'][^>]*>/gi)) {
      const clean = m[1].replace(/\?v=\d+$/, '').replace(/^\/js\//, '').replace(/\.js$/, '');
      if (!js.includes(clean)) js.push(clean);
    }

    pages.push({ page: name, css, js });
  }

  const jsDir = path.join(publicDir, 'js');
  const jsFiles = walkFiles(jsDir, (name) => name.endsWith('.js'))
    .map((f) => ({ full: f, rel: toPosixRel(rootDir, f) }))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const clientGlobals = [];
  for (const file of jsFiles) {
    const src = fs.readFileSync(file.full, 'utf8');
    const ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
    const attached = new Set();

    walkAstNodes(ast, (node) => {
      if (
        node.type === 'AssignmentExpression' &&
        node.left &&
        node.left.type === 'MemberExpression' &&
        !node.left.computed &&
        node.left.object &&
        node.left.object.type === 'Identifier' &&
        node.left.property &&
        node.left.property.type === 'Identifier' &&
        CLIENT_GLOBALS.has(node.left.object.name)
      ) {
        attached.add(`${node.left.object.name}.${node.left.property.name}`);
      }
    });

    if (attached.size > 0) {
      clientGlobals.push({
        file: file.rel,
        symbols: Array.from(attached).sort()
      });
    }
  }

  return { pages, clientGlobals };
}

function generateAgentMapMarkdown(rootDir = ROOT) {
  const routes = scanAstRoutes(rootDir);
  const tables = extractSchemaTables(rootDir);
  const modules = extractModuleExports(rootDir);
  const { pages, clientGlobals } = extractFrontendPageMap(rootDir);

  const routesByFile = new Map();
  for (const r of routes) {
    const relFile = toPosixRel(rootDir, r.file);
    if (!routesByFile.has(relFile)) routesByFile.set(relFile, []);
    routesByFile.get(relFile).push(r);
  }
  const sortedRouteFiles = Array.from(routesByFile.keys()).sort();

  const lines = [
    '# Agent Codebase Map (Auto-Generated)',
    '',
    'Generated by `npm run map:gen` — do not edit by hand; verify freshness with `npm run map:check`.',
    `Summary: ${routes.length} mounted routes | ${tables.length} DB tables | ${modules.length} exported modules | ${pages.length} HTML pages`,
    '',
    '## 1. Mounted API Routes (`src/app/`)',
    ''
  ];

  for (const relFile of sortedRouteFiles) {
    lines.push(`### \`${relFile}\``);
    const fileRoutes = routesByFile.get(relFile).slice().sort((a, b) =>
      a.fullPath.localeCompare(b.fullPath) ||
      a.method.localeCompare(b.method) ||
      a.line - b.line
    );
    for (const r of fileRoutes) {
      const guardLabel = r.guards && r.guards.length > 0 ? r.guards.join(', ') : 'public/token';
      lines.push(`- \`${r.method} ${r.fullPath}\` [${guardLabel}] \`:${r.line}\``);
    }
    lines.push('');
  }

  lines.push('## 2. Database Schema (`BASEBALL_DB` & `CHAT_DB`)', '');
  for (const dbName of ['BASEBALL_DB', 'CHAT_DB']) {
    lines.push(`### ${dbName}`);
    for (const table of tables.filter((t) => t.db === dbName)) {
      lines.push(`- \`${table.name}\`: ${table.columns.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## 3. Backend & Worker Exports (`src/app/`, `workers/`)', '');
  for (const mod of modules) {
    lines.push(`- \`${mod.file}\`: ${mod.exports.join(', ')}`);
  }
  lines.push('');

  lines.push('## 4. Frontend Pages & Client Scripts (`public/`)', '');
  lines.push('### HTML Pages');
  for (const page of pages) {
    lines.push(`- \`${page.page}\`: css=[${page.css.join(',')}] js=[${page.js.join(',')}]`);
  }
  lines.push('');

  lines.push('### Client Globals & Namespace Exports');
  for (const entry of clientGlobals) {
    lines.push(`- \`${entry.file}\`: ${entry.symbols.join(', ')}`);
  }

  return {
    markdown: lines.join('\n') + '\n',
    stats: {
      routes: routes.length,
      tables: tables.length,
      modules: modules.length,
      pages: pages.length,
      lines: lines.length + 1
    }
  };
}

function parseCliArgs(argv) {
  let check = false;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      check = true;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg === '--out' && argv[i + 1]) {
      out = argv[++i];
    }
  }
  return { check, out };
}

function runCli() {
  const { check, out } = parseCliArgs(process.argv.slice(2));
  const targetPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
  const displayOut = toPosixRel(ROOT, targetPath);
  const { markdown, stats } = generateAgentMapMarkdown(ROOT);

  if (check) {
    const existing = fs.existsSync(targetPath)
      ? fs.readFileSync(targetPath, 'utf8').replace(/\r\n/g, '\n')
      : null;
    if (existing !== markdown) {
      console.error(`${displayOut} is out of date. Run: npm run map:gen`);
      process.exitCode = 1;
      return;
    }
    console.log(`${displayOut} is up to date.`);
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, markdown, 'utf8');
  console.log(`Wrote ${displayOut} (${stats.routes} routes, ${stats.tables} tables, ${stats.lines} lines).`);
}

if (require.main === module) {
  runCli();
}

module.exports = {
  generateAgentMapMarkdown,
  extractSchemaTables,
  extractModuleExports,
  extractFrontendPageMap
};
