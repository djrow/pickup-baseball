#!/usr/bin/env node
/**
 * Transcript Token Profiler & Cohort Scorecard for Antigravity JSONL & Generic Role/Content JSONL logs.
 * Emits aggregated token breakdowns, adoption metrics, and file/tool path stats without printing raw file bodies or secrets.
 *
 * Usage:
 *   node scripts/token-profile.js <path/to/transcript.jsonl> [--json] [--top=15]
 *   node scripts/token-profile.js --cohort [--dir <path>] [--workspace <name> | --all-workspaces] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--split YYYY-MM-DD] [--min-turns 2] [--json]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const READ_FILE_TOOLS = new Set(['read_file', 'view_file']);
const DISCOVERY_TOOLS = new Set([
  'view_file_outline',
  'view_code_item',
  'list_dir',
  'find_by_name',
  'grep_search',
  'read_terminal'
]);
const COMMAND_TOOLS = new Set([
  'run_command',
  'run_shell',
  'bash',
  'command_status',
  'send_command_input'
]);
const WRITE_TOOLS = new Set([
  'edit_file',
  'write_file',
  'replace_file_content',
  'multi_replace_file_content',
  'write_to_file'
]);
const CREATE_FILE_TOOLS = new Set(['write_file', 'write_to_file']);

const QUIET_VERIFY_RE = /(?:^|\s)(?:--quiet|--failures-only|--test-reporter=dot)\b|\b(?:check:quiet|test:quiet|test:workerd:quiet|test:browser:quiet|security:scan:quiet)\b/i;
const VERBOSE_VERIFY_RE = /\bnpm\s+(?:run\s+(?:check|security:scan|test:browser|test:workerd)(?!:quiet)\b|test\b)|scripts\/(?:verify-all|security-scan|browser-smoke)\.js/i;
const MAP_CMD_RE = /\bmap:(?:gen|check)\b|scripts\/gen-agent-map\.js/i;
const MAP_DRIFT_OUT_RE = /AGENT_MAP\.md is stale|out of date/i;
const I18N_SYNC_CMD_RE = /\bi18n:sync\b|scripts\/i18n-sync\.js/i;
const REGISTER_ASSET_CMD_RE = /\basset:register\b|scripts\/register-asset\.js/i;
const TEST_IMPACT_CMD_RE = /\btest:impact\b|scripts\/test-impact\.js/i;
const VERIFY_SUITES_CMD_RE = /\bVERIFY_SUITES=|(?:^|\s)--suite(?:s)?(?:=|\s)/i;
const TOKEN_PROFILE_CMD_RE = /\btokens:(?:profile|scorecard)\b|scripts\/token-profile\.js/i;

function estimateTokens(value) {
  if (value === null || value === undefined) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function unwrapArgValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const looksJsonEncoded = (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
    || trimmed === 'true'
    || trimmed === 'false'
    || trimmed === 'null'
    || /^-?\d+(?:\.\d+)?$/.test(trimmed)
  );
  if (!looksJsonEncoded) return value;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return value;
  }
}

function normalizeArgsObject(rawArgs) {
  let obj = rawArgs;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch (_) {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {};
  }
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    out[key] = unwrapArgValue(val);
  }
  return out;
}

function normalizeToolPath(rawPath) {
  const unwrapped = unwrapArgValue(rawPath);
  if (typeof unwrapped !== 'string') return null;
  const trimmed = unwrapped.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/\\/g, '/')
    .replace(/^([A-Z]):\//, (_m, drive) => `${drive.toLowerCase()}:/`);
}

function extractTargetPath(args) {
  const candidates = [
    args.Path,
    args.path,
    args.file_path,
    args.AbsolutePath,
    args.TargetFile,
    args.file
  ];
  for (const c of candidates) {
    const norm = normalizeToolPath(c);
    if (norm) return norm;
  }
  return null;
}

function extractCommandText(args) {
  const raw = args.CommandLine ?? args.command ?? args.cmd ?? '';
  if (typeof raw !== 'string') return '';
  return raw;
}

function extractRangeLabel(args) {
  const start = args.StartLine ?? args.start_line ?? null;
  const end = args.EndLine ?? args.end_line ?? null;
  const byteOffset = args.ByteOffset ?? args.byte_offset ?? null;
  if (start === null && end === null) return 'full';
  const base = `${start === null || start === '' ? '1' : String(start)}-${end === null || end === '' ? 'eof' : String(end)}`;
  return byteOffset !== null && byteOffset !== '' && Number(byteOffset) > 0
    ? `${base}@${byteOffset}`
    : base;
}

function extractGenericContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') {
      parts.push(block);
    } else if (typeof block.text === 'string') {
      parts.push(block.text);
    } else if (typeof block.thinking === 'string') {
      parts.push(block.thinking);
    } else if (typeof block.content === 'string') {
      parts.push(block.content);
    }
  }
  return parts.join('\n');
}

function extractEntryIsoTimestamp(entry) {
  const raw = entry?.created_at ?? entry?.timestamp ?? null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseDateBound(val, isEnd = false) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? `${s}${isEnd ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`
    : s;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse JSONL text into structured entries while counting malformed lines.
 */
function parseTranscriptLines(text) {
  const entries = [];
  let malformedLines = 0;
  const lines = String(text || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        entries.push(parsed);
      } else {
        malformedLines += 1;
      }
    } catch (_) {
      malformedLines += 1;
    }
  }

  return { entries, malformedLines };
}

/**
 * Profile an Antigravity `transcript.jsonl` / `transcript_full.jsonl` or generic `{ role, content }` JSONL file.
 */
function profileTranscript(filePath, options = {}) {
  const topN = Number.isInteger(options.topN) && options.topN > 0 ? options.topN : 15;
  const wsNeedle = typeof options.workspace === 'string' && options.workspace.trim()
    ? options.workspace.trim().replace(/\\/g, '/').toLowerCase()
    : null;

  const absPath = path.resolve(filePath);
  const statMtimeIso = fs.statSync(absPath).mtime.toISOString();
  const rawText = fs.readFileSync(absPath, 'utf8');
  const { entries, malformedLines } = parseTranscriptLines(rawText);

  const categories = {
    reads: 0,
    commandOutput: 0,
    writes: 0,
    reasoning: 0,
    assistantText: 0,
    userAndSystem: 0,
    otherTools: 0
  };

  let userTurns = 0;
  let modelTurns = 0;
  let toolCallCount = 0;

  let reportedTurns = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  const byModel = {};

  let simulatedCumulativeInputTokens = 0;
  let runningPrefixTokens = 0;

  let firstTs = null;
  let lastTs = null;
  let workspaceHintHits = 0;

  const fileReads = new Map(); // normPath -> { readCount, estimatedTokens, ranges: [], seenRanges: Set }
  const editedFiles = new Set();
  const discoverySourceFiles = new Set();
  const sinkCandidates = [];
  let pendingToolQueue = [];

  // Tooling adoption & opportunity telemetry
  let usedQuiet = 0;
  let usedVerbose = 0;
  let readAgentMap = 0;
  let ranMapGen = 0;
  let ranMapCheck = 0;
  let mapDriftHits = 0;
  let usedI18nSync = 0;
  let manualI18nEdits = 0;
  let wroteI18nJs = false;
  let usedRegisterAsset = 0;
  let wroteSwJs = false;
  let createdPublicAsset = false;
  let usedTestImpact = 0;
  let usedVerifySuites = 0;
  let codeEditOpportunity = false;
  let readFrugalityDoc = 0;
  let ranTokenProfile = 0;

  function checkWorkspaceMatch(candidateStr) {
    if (!wsNeedle || !candidateStr) return;
    const norm = String(candidateStr).replace(/\\/g, '/').toLowerCase();
    if (norm.includes(wsNeedle)) {
      workspaceHintHits += 1;
    }
  }

  function recordFileRead(normPath, rangeLabel, tokens) {
    if (!normPath) return;
    let rec = fileReads.get(normPath);
    if (!rec) {
      rec = {
        path: normPath,
        readCount: 0,
        estimatedTokens: 0,
        ranges: [],
        seenRanges: new Set(),
        exactDuplicateCount: 0
      };
      fileReads.set(normPath, rec);
    }
    rec.readCount += 1;
    rec.estimatedTokens += tokens;
    if (rec.seenRanges.has(rangeLabel)) {
      rec.exactDuplicateCount += 1;
    } else {
      rec.seenRanges.add(rangeLabel);
    }
    if (!rec.ranges.includes(rangeLabel)) {
      rec.ranges.push(rangeLabel);
    }
  }

  function recordApiUsage(modelName, inTok, cacheTok, outTok) {
    const hasUsage = (
      Number.isFinite(inTok)
      || Number.isFinite(cacheTok)
      || Number.isFinite(outTok)
    );
    if (!hasUsage) return;

    const i = Number(inTok) || 0;
    const c = Number(cacheTok) || 0;
    const o = Number(outTok) || 0;
    reportedTurns += 1;
    totalInputTokens += i;
    totalCacheReadTokens += c;
    totalOutputTokens += o;

    const key = modelName || 'unknown';
    if (!byModel[key]) {
      byModel[key] = { turns: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
    }
    byModel[key].turns += 1;
    byModel[key].inputTokens += i;
    byModel[key].cacheReadTokens += c;
    byModel[key].outputTokens += o;
  }

  function classifyToolCall(rawCall, stepIndex) {
    const toolName = String(
      rawCall?.name
      || rawCall?.function?.name
      || rawCall?.tool_name
      || 'unknown'
    );
    const args = normalizeArgsObject(rawCall?.args ?? rawCall?.function?.arguments ?? rawCall?.input);
    const targetPath = extractTargetPath(args);
    const cmdText = extractCommandText(args);
    const argsTokens = estimateTokens(args);
    toolCallCount += 1;

    if (targetPath) {
      checkWorkspaceMatch(targetPath);
    }
    if (cmdText) {
      checkWorkspaceMatch(cmdText);
    }

    let watchMapDrift = false;

    if (READ_FILE_TOOLS.has(toolName) && targetPath) {
      const lowerPath = targetPath.toLowerCase();
      if (lowerPath === 'docs/agent_map.md' || lowerPath.endsWith('/docs/agent_map.md')) {
        readAgentMap += 1;
      }
      if (lowerPath === 'docs/agents/frugality.md' || lowerPath.endsWith('/docs/agents/frugality.md')) {
        readFrugalityDoc += 1;
      }
      if (/(?:^|\/)(?:src\/app|workers|public)\//i.test(targetPath)) {
        discoverySourceFiles.add(lowerPath);
      }
    }

    if (COMMAND_TOOLS.has(toolName) && cmdText) {
      const cmdNorm = cmdText.replace(/\\/g, '/');
      if (QUIET_VERIFY_RE.test(cmdNorm)) {
        usedQuiet += 1;
      } else if (VERBOSE_VERIFY_RE.test(cmdNorm)) {
        usedVerbose += 1;
      }
      if (MAP_CMD_RE.test(cmdNorm)) {
        if (/(?:map:check|--check\b)/i.test(cmdNorm)) {
          ranMapCheck += 1;
          watchMapDrift = true;
        } else {
          ranMapGen += 1;
        }
      }
      if (/agent-map\.test\.js/i.test(cmdNorm)) {
        watchMapDrift = true;
      }
      if (I18N_SYNC_CMD_RE.test(cmdNorm)) {
        usedI18nSync += 1;
      }
      if (REGISTER_ASSET_CMD_RE.test(cmdNorm)) {
        usedRegisterAsset += 1;
      }
      if (TEST_IMPACT_CMD_RE.test(cmdNorm)) {
        usedTestImpact += 1;
      }
      if (VERIFY_SUITES_CMD_RE.test(cmdNorm)) {
        usedVerifySuites += 1;
      }
      if (TOKEN_PROFILE_CMD_RE.test(cmdNorm)) {
        ranTokenProfile += 1;
      }
    }

    if (WRITE_TOOLS.has(toolName)) {
      categories.writes += argsTokens;
      if (targetPath) {
        editedFiles.add(targetPath);
        if (/(?:^|\/)public\/i18n\/.*\.json$/i.test(targetPath)) {
          manualI18nEdits += 1;
        }
        if (/(?:^|\/)public\/js\/api\/i18n\.js$/i.test(targetPath)) {
          wroteI18nJs = true;
        }
        if (/(?:^|\/)public\/sw\.js$/i.test(targetPath)) {
          wroteSwJs = true;
        }
        if (CREATE_FILE_TOOLS.has(toolName) && /(?:^|\/)public\/.+\.(?:html|js|css)$/i.test(targetPath)) {
          createdPublicAsset = true;
        }
        if (/(?:^|\/)(?:src|public|workers|scripts)\//i.test(targetPath)) {
          codeEditOpportunity = true;
        }
      }
      sinkCandidates.push({ stepIndex, category: 'writes', toolName, target: targetPath, estimatedTokens: argsTokens });
    } else if (argsTokens > 0) {
      categories.otherTools += argsTokens;
    }

    pendingToolQueue.push({ toolName, args, targetPath, stepIndex, watchMapDrift });
    return argsTokens;
  }

  function classifyToolResponse(matched, toolName, args, targetPath, responseText, stepIndex) {
    const tokens = estimateTokens(responseText);
    if (matched && matched.watchMapDrift && typeof responseText === 'string' && MAP_DRIFT_OUT_RE.test(responseText)) {
      mapDriftHits += 1;
    }

    if (READ_FILE_TOOLS.has(toolName)) {
      categories.reads += tokens;
      const rangeLabel = extractRangeLabel(args);
      recordFileRead(targetPath, rangeLabel, tokens);
      sinkCandidates.push({ stepIndex, category: 'reads', toolName, target: targetPath, estimatedTokens: tokens });
      return tokens;
    }
    if (DISCOVERY_TOOLS.has(toolName)) {
      categories.reads += tokens;
      sinkCandidates.push({ stepIndex, category: 'reads', toolName, target: targetPath || toolName, estimatedTokens: tokens });
      return tokens;
    }
    if (COMMAND_TOOLS.has(toolName)) {
      categories.commandOutput += tokens;
      sinkCandidates.push({ stepIndex, category: 'commandOutput', toolName, target: toolName, estimatedTokens: tokens });
      return tokens;
    }
    if (WRITE_TOOLS.has(toolName)) {
      categories.writes += tokens;
      if (targetPath) editedFiles.add(targetPath);
      sinkCandidates.push({ stepIndex, category: 'writes', toolName, target: targetPath, estimatedTokens: tokens });
      return tokens;
    }
    categories.otherTools += tokens;
    if (tokens > 0) {
      sinkCandidates.push({ stepIndex, category: 'otherTools', toolName, target: targetPath || toolName, estimatedTokens: tokens });
    }
    return tokens;
  }

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    const stepIndex = Number.isInteger(entry.step_index) ? entry.step_index : idx;
    const isoTs = extractEntryIsoTimestamp(entry);
    if (isoTs) {
      if (!firstTs) firstTs = isoTs;
      lastTs = isoTs;
    }

    // 1. Antigravity transcript format
    if (typeof entry.type === 'string') {
      if (entry.type === 'USER_INPUT' || entry.type === 'SYSTEM_MESSAGE') {
        if (entry.type === 'USER_INPUT') {
          userTurns += 1;
          pendingToolQueue = [];
        }
        const tok = estimateTokens(entry.content || '');
        categories.userAndSystem += tok;
        runningPrefixTokens += tok;
        if (tok > 0) {
          sinkCandidates.push({ stepIndex, category: 'userAndSystem', toolName: entry.type, target: null, estimatedTokens: tok });
        }
        continue;
      }

      if (entry.type === 'PLANNER_RESPONSE') {
        modelTurns += 1;
        simulatedCumulativeInputTokens += runningPrefixTokens;
        pendingToolQueue = [];

        recordApiUsage(entry.model, entry.input_tokens, entry.cache_read_tokens, entry.output_tokens);

        const thinkTok = estimateTokens(entry.thinking || '');
        const textTok = estimateTokens(entry.content || '');
        categories.reasoning += thinkTok;
        categories.assistantText += textTok;
        if (thinkTok > 0) {
          sinkCandidates.push({ stepIndex, category: 'reasoning', toolName: entry.model || 'planner', target: null, estimatedTokens: thinkTok });
        }
        if (textTok > 0) {
          sinkCandidates.push({ stepIndex, category: 'assistantText', toolName: entry.model || 'planner', target: null, estimatedTokens: textTok });
        }

        let callTokSum = 0;
        if (Array.isArray(entry.tool_calls)) {
          for (const tc of entry.tool_calls) {
            callTokSum += classifyToolCall(tc, stepIndex);
          }
        }
        runningPrefixTokens += thinkTok + textTok + callTokSum;
        continue;
      }

      if (entry.type === 'GENERIC') {
        const matched = pendingToolQueue.shift() || null;
        const toolName = matched ? matched.toolName : 'generic';
        const args = matched ? matched.args : {};
        const targetPath = matched ? matched.targetPath : null;
        const tok = classifyToolResponse(matched, toolName, args, targetPath, entry.content || '', stepIndex);
        runningPrefixTokens += tok;
        continue;
      }
    }

    // 2. Generic { role, content } JSONL format
    const role = String(entry.role || '').toLowerCase();
    if (role === 'user' || role === 'system') {
      if (role === 'user') {
        userTurns += 1;
        pendingToolQueue = [];
      }
      const text = extractGenericContentText(entry.content);
      const tok = estimateTokens(text);
      categories.userAndSystem += tok;
      runningPrefixTokens += tok;
      continue;
    }

    if (role === 'assistant') {
      modelTurns += 1;
      simulatedCumulativeInputTokens += runningPrefixTokens;
      pendingToolQueue = [];

      const usage = entry.usage && typeof entry.usage === 'object' ? entry.usage : {};
      recordApiUsage(
        entry.model,
        usage.input_tokens ?? entry.input_tokens,
        usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? entry.cache_read_tokens,
        usage.output_tokens ?? entry.output_tokens
      );

      const thinkTok = estimateTokens(entry.reasoning || entry.thinking || '');
      const textTok = estimateTokens(extractGenericContentText(entry.content));
      categories.reasoning += thinkTok;
      categories.assistantText += textTok;
      if (thinkTok > 0) {
        sinkCandidates.push({ stepIndex, category: 'reasoning', toolName: entry.model || 'assistant', target: null, estimatedTokens: thinkTok });
      }

      let callTokSum = 0;
      if (Array.isArray(entry.tool_calls)) {
        for (const tc of entry.tool_calls) {
          callTokSum += classifyToolCall(tc, stepIndex);
        }
      }
      runningPrefixTokens += thinkTok + textTok + callTokSum;
      continue;
    }

    if (role === 'tool') {
      const matched = pendingToolQueue.shift() || null;
      const toolName = String(entry.name || entry.tool_name || (matched ? matched.toolName : 'tool'));
      const args = matched ? matched.args : normalizeArgsObject(entry.args);
      const targetPath = (matched ? matched.targetPath : null) || extractTargetPath(args);
      const text = extractGenericContentText(entry.content);
      const tok = classifyToolResponse(matched, toolName, args, targetPath, text, stepIndex);
      runningPrefixTokens += tok;
    }
  }

  const estimatedTotalTokens = (
    categories.reads
    + categories.commandOutput
    + categories.writes
    + categories.reasoning
    + categories.assistantText
    + categories.userAndSystem
    + categories.otherTools
  );

  const totalContextProcessed = totalInputTokens + totalCacheReadTokens;
  const cumulativeContextTokens = reportedTurns > 0 ? totalContextProcessed : simulatedCumulativeInputTokens;
  const avgContextPerTurn = modelTurns > 0 ? Math.round(cumulativeContextTokens / modelTurns) : 0;
  const quadraticAmplificationRatio = estimatedTotalTokens > 0
    ? Number((cumulativeContextTokens / estimatedTotalTokens).toFixed(2))
    : 0;

  const uneditedFileReads = [...fileReads.values()]
    .filter((rec) => !editedFiles.has(rec.path))
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens || b.readCount - a.readCount || a.path.localeCompare(b.path))
    .slice(0, topN)
    .map(({ path: p, readCount, estimatedTokens, ranges }) => ({ path: p, readCount, estimatedTokens, ranges }));

  const duplicateReads = [...fileReads.values()]
    .filter((rec) => rec.readCount > 1)
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens || b.readCount - a.readCount || a.path.localeCompare(b.path))
    .slice(0, topN)
    .map(({ path: p, readCount, exactDuplicateCount, estimatedTokens, ranges }) => ({
      path: p,
      readCount,
      exactDuplicateCount,
      estimatedTokens,
      ranges
    }));

  const topSinks = sinkCandidates
    .filter((s) => s.estimatedTokens > 0)
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.stepIndex - b.stepIndex)
    .slice(0, 5);

  const sessionStart = firstTs || statMtimeIso;
  const sessionEnd = lastTs || sessionStart;

  return {
    file: path.basename(absPath),
    sessionStart,
    sessionEnd,
    workspaceMatched: wsNeedle ? workspaceHintHits > 0 : true,
    summary: {
      totalSteps: entries.length,
      malformedLines,
      userTurns,
      modelTurns,
      toolCalls: toolCallCount,
      estimatedTotalTokens
    },
    apiUsage: {
      reportedTurns,
      totalInputTokens,
      totalCacheReadTokens,
      totalOutputTokens,
      totalContextProcessed,
      byModel
    },
    amplification: {
      modelTurns,
      uniqueContentTokens: estimatedTotalTokens,
      cumulativeContextTokens,
      quadraticAmplificationRatio,
      avgContextPerTurn
    },
    categories,
    uneditedFileReads,
    duplicateReads,
    topSinks,
    tooling: {
      quietVerification: { usedQuiet, usedVerbose },
      agentMap: {
        readAgentMap,
        ranMapGen,
        ranMapCheck,
        mapDriftHits,
        discoveryOpportunity: discoverySourceFiles.size >= 3
      },
      codemods: {
        usedI18nSync,
        i18nOpportunity: manualI18nEdits > 0 || usedI18nSync > 0 || wroteI18nJs,
        manualI18nEdits,
        usedRegisterAsset,
        assetOpportunity: usedRegisterAsset > 0 || wroteSwJs || createdPublicAsset
      },
      testImpact: {
        usedTestImpact,
        usedVerifySuites,
        codeEditOpportunity
      },
      frugalityDocs: {
        readFrugalityDoc,
        ranTokenProfile
      }
    }
  };
}

/**
 * Discover Antigravity `transcript.jsonl` files or flat `*.jsonl` transcript files in `dirPath`.
 */
function discoverTranscriptFiles(dirPath) {
  const absDir = path.resolve(dirPath);
  if (!fs.existsSync(absDir)) return [];

  const found = [];
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(absDir, ent.name);
    if (ent.isDirectory()) {
      const nestedLog = path.join(full, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(nestedLog)) {
        found.push(nestedLog);
      } else {
        const directLog = path.join(full, 'transcript.jsonl');
        if (fs.existsSync(directLog)) {
          found.push(directLog);
        }
      }
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      if (ent.name === 'transcript_full.jsonl' && fs.existsSync(path.join(absDir, 'transcript.jsonl'))) {
        continue;
      }
      found.push(full);
    }
  }

  return found.sort((a, b) => a.localeCompare(b));
}

function computeMedian(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  const raw = nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return Number(raw.toFixed(2));
}

function computeDeltaPct(beforeVal, afterVal) {
  if (typeof beforeVal !== 'number' || typeof afterVal !== 'number' || beforeVal === 0) {
    return null;
  }
  return Number((((afterVal - beforeVal) / beforeVal) * 100).toFixed(1));
}

function summarizeSessions(sessions) {
  const billableReported = sessions.filter((p) => p.apiUsage.reportedTurns > 0);
  return {
    sessionCount: sessions.length,
    medians: {
      medianModelTurns: computeMedian(sessions.map((p) => p.summary.modelTurns)),
      medianUniqueTokens: computeMedian(sessions.map((p) => p.summary.estimatedTotalTokens)),
      medianReadTokens: computeMedian(sessions.map((p) => p.categories.reads)),
      medianCommandOutputTokens: computeMedian(sessions.map((p) => p.categories.commandOutput)),
      medianUneditedReadTokens: computeMedian(
        sessions.map((p) => p.uneditedFileReads.reduce((sum, item) => sum + item.estimatedTokens, 0))
      ),
      medianDuplicateReadCount: computeMedian(
        sessions.map((p) => p.duplicateReads.reduce((sum, item) => sum + Math.max(0, item.readCount - 1), 0))
      ),
      medianAmplificationRatio: computeMedian(sessions.map((p) => p.amplification.quadraticAmplificationRatio)),
      medianBillableInputOutput: computeMedian(
        billableReported.map((p) => p.apiUsage.totalInputTokens + p.apiUsage.totalOutputTokens)
      ),
      medianCacheReadTokens: computeMedian(
        billableReported.map((p) => p.apiUsage.totalCacheReadTokens)
      )
    }
  };
}

function buildCohortScorecard(sessions) {
  const countOppUsed = (oppPred, usedPred) => {
    let opportunities = 0;
    let used = 0;
    for (const s of sessions) {
      if (oppPred(s)) {
        opportunities += 1;
        if (usedPred(s)) used += 1;
      }
    }
    return {
      opportunities,
      used,
      adoptionRate: opportunities > 0 ? Number((used / opportunities).toFixed(2)) : null
    };
  };

  const w1 = countOppUsed(
    (s) => (s.tooling.quietVerification.usedQuiet + s.tooling.quietVerification.usedVerbose) > 0,
    (s) => s.tooling.quietVerification.usedQuiet > 0
  );
  const w1Verdict = w1.opportunities < 3
    ? 'insufficient-data'
    : (w1.adoptionRate >= 0.5 ? 'keep' : (w1.used === 0 ? 'prune-candidate' : 'review'));

  const w2 = countOppUsed(
    (s) => s.tooling.agentMap.discoveryOpportunity || s.tooling.agentMap.readAgentMap > 0,
    (s) => s.tooling.agentMap.readAgentMap > 0
  );
  const totalDriftHits = sessions.reduce((sum, s) => sum + s.tooling.agentMap.mapDriftHits, 0);
  const totalReadMapCalls = sessions.reduce((sum, s) => sum + s.tooling.agentMap.readAgentMap, 0);
  const w2Verdict = w2.opportunities < 3
    ? 'insufficient-data'
    : (w2.used === 0
      ? 'prune-candidate'
      : (totalDriftHits > totalReadMapCalls ? 'review' : (w2.adoptionRate >= 0.3 ? 'keep' : 'review')));

  const w3a = countOppUsed(
    (s) => s.tooling.codemods.i18nOpportunity,
    (s) => s.tooling.codemods.usedI18nSync > 0
  );
  const w3aVerdict = w3a.opportunities < 2
    ? 'insufficient-data'
    : (w3a.used === 0 ? 'prune-candidate' : (w3a.adoptionRate >= 0.5 ? 'keep' : 'review'));

  const w3b = countOppUsed(
    (s) => s.tooling.codemods.assetOpportunity,
    (s) => s.tooling.codemods.usedRegisterAsset > 0
  );
  const w3bVerdict = w3b.opportunities < 2
    ? 'insufficient-data'
    : (w3b.used === 0 ? 'prune-candidate' : (w3b.adoptionRate >= 0.5 ? 'keep' : 'review'));

  const w4 = countOppUsed(
    (s) => s.tooling.testImpact.codeEditOpportunity || s.tooling.testImpact.usedTestImpact > 0 || s.tooling.testImpact.usedVerifySuites > 0,
    (s) => s.tooling.testImpact.usedTestImpact > 0 || s.tooling.testImpact.usedVerifySuites > 0
  );
  const w4Verdict = w4.opportunities < 3
    ? 'insufficient-data'
    : (w4.used === 0 ? 'prune-candidate' : (w4.adoptionRate >= 0.3 ? 'keep' : 'review'));

  const w5Used = sessions.filter(
    (s) => s.tooling.frugalityDocs.readFrugalityDoc > 0 || s.tooling.frugalityDocs.ranTokenProfile > 0
  ).length;
  const w5Opp = sessions.length;
  const w5Verdict = w5Used > 0
    ? 'keep'
    : (w5Opp < 5 ? 'insufficient-data' : 'review');

  return [
    {
      wave: 'Wave 1: Quiet Verification Flags',
      opportunities: w1.opportunities,
      used: w1.used,
      adoptionRate: w1.adoptionRate,
      verdict: w1Verdict,
      notes: 'checks quiet flags vs verbose test/scan runs'
    },
    {
      wave: 'Wave 2: docs/AGENT_MAP.md',
      opportunities: w2.opportunities,
      used: w2.used,
      adoptionRate: w2.adoptionRate,
      verdict: w2Verdict,
      notes: totalDriftHits > 0 ? `mapDriftHits=${totalDriftHits}` : 'discovery sessions (>=3 files read or map read)'
    },
    {
      wave: 'Wave 3a: scripts/i18n-sync.js',
      opportunities: w3a.opportunities,
      used: w3a.used,
      adoptionRate: w3a.adoptionRate,
      verdict: w3aVerdict,
      notes: 'i18n edits via sync script vs manual JSON edits'
    },
    {
      wave: 'Wave 3b: scripts/register-asset.js',
      opportunities: w3b.opportunities,
      used: w3b.used,
      adoptionRate: w3b.adoptionRate,
      verdict: w3bVerdict,
      notes: 'new public assets or sw.js updates'
    },
    {
      wave: 'Wave 4: test-impact / VERIFY_SUITES',
      opportunities: w4.opportunities,
      used: w4.used,
      adoptionRate: w4.adoptionRate,
      verdict: w4Verdict,
      notes: 'sessions editing code using scoped suites'
    },
    {
      wave: 'Wave 5: frugality.md / tokens:profile',
      opportunities: w5Opp,
      used: w5Used,
      adoptionRate: w5Opp > 0 ? Number((w5Used / w5Opp).toFixed(2)) : null,
      verdict: w5Verdict,
      notes: 'workflow doc reads & profiler usage'
    }
  ];
}

/**
 * Aggregate multiple transcript sessions into Before/After medians and tool adoption verdicts.
 */
function profileCohort(options = {}) {
  const dir = options.dir
    ? path.resolve(options.dir)
    : path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const workspace = typeof options.workspace === 'string' && options.workspace.trim()
    ? options.workspace.trim()
    : null;
  const minTurns = Number.isInteger(options.minTurns) && options.minTurns >= 0 ? options.minTurns : 2;
  const sinceMs = parseDateBound(options.since, false);
  const untilMs = parseDateBound(options.until, true);
  const splitMs = parseDateBound(options.split, false);

  const files = discoverTranscriptFiles(dir);
  let skippedLowTurns = 0;
  let skippedWorkspace = 0;
  const matched = [];

  for (const file of files) {
    if (sinceMs !== null) {
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (mtimeMs < sinceMs - 86400000) {
        continue;
      }
    }

    const prof = profileTranscript(file, { workspace, topN: 15 });
    const startMs = Date.parse(prof.sessionStart);
    const endMs = Date.parse(prof.sessionEnd);

    if (sinceMs !== null && Number.isFinite(endMs) && endMs < sinceMs) {
      continue;
    }
    if (untilMs !== null && Number.isFinite(startMs) && startMs > untilMs) {
      continue;
    }
    if (!prof.workspaceMatched) {
      skippedWorkspace += 1;
      continue;
    }
    if (prof.summary.modelTurns < minTurns) {
      skippedLowTurns += 1;
      continue;
    }

    matched.push(prof);
  }

  const overall = summarizeSessions(matched);

  let before = null;
  let after = null;
  let deltasPct = null;
  let scorecardSessions = matched;

  if (splitMs !== null) {
    const beforeList = [];
    const afterList = [];
    for (const s of matched) {
      const ms = Date.parse(s.sessionStart);
      if (Number.isFinite(ms) && ms < splitMs) {
        beforeList.push(s);
      } else {
        afterList.push(s);
      }
    }
    before = summarizeSessions(beforeList);
    after = summarizeSessions(afterList);
    deltasPct = {};
    for (const key of Object.keys(before.medians)) {
      deltasPct[key] = computeDeltaPct(before.medians[key], after.medians[key]);
    }
    scorecardSessions = afterList;
  }

  const scorecard = buildCohortScorecard(scorecardSessions);

  return {
    dir,
    workspace,
    since: options.since || null,
    until: options.until || null,
    split: options.split || null,
    minTurns,
    scannedFiles: files.length,
    matchedSessions: matched.length,
    skippedLowTurns,
    skippedWorkspace,
    overall,
    before,
    after,
    deltasPct,
    scorecard
  };
}

function formatMetricVal(val) {
  return val === null || val === undefined ? 'n/a' : String(val);
}

function formatDeltaStr(pct) {
  if (pct === null || pct === undefined) return 'n/a';
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function formatCohortReport(cohort) {
  const lines = [
    `Cohort Token Scorecard (workspace=${cohort.workspace || 'all'}, minTurns=${cohort.minTurns})`,
    `Scanned: ${cohort.scannedFiles} | Matched: ${cohort.matchedSessions} | Skipped(lowTurns=${cohort.skippedLowTurns}, otherWs=${cohort.skippedWorkspace})`
  ];

  if (cohort.split && cohort.before && cohort.after) {
    lines.push(
      `Split @ ${cohort.split}: Before=${cohort.before.sessionCount} sessions | After=${cohort.after.sessionCount} sessions`
    );
    const metrics = [
      ['Billable in+out', 'medianBillableInputOutput'],
      ['Cache read', 'medianCacheReadTokens'],
      ['Unique tokens', 'medianUniqueTokens'],
      ['Read tokens', 'medianReadTokens'],
      ['Cmd output', 'medianCommandOutputTokens'],
      ['Unedited reads', 'medianUneditedReadTokens'],
      ['Dup reads', 'medianDuplicateReadCount'],
      ['Amplification', 'medianAmplificationRatio'],
      ['Model turns', 'medianModelTurns']
    ];
    for (const [label, key] of metrics) {
      lines.push(
        `  - ${label}: before=${formatMetricVal(cohort.before.medians[key])} -> after=${formatMetricVal(cohort.after.medians[key])} (${formatDeltaStr(cohort.deltasPct[key])})`
      );
    }
  } else {
    const m = cohort.overall.medians;
    lines.push(
      `Medians (${cohort.overall.sessionCount} sessions): unique=${formatMetricVal(m.medianUniqueTokens)}, reads=${formatMetricVal(m.medianReadTokens)}, cmd=${formatMetricVal(m.medianCommandOutputTokens)}, unedited=${formatMetricVal(m.medianUneditedReadTokens)}, ratio=${formatMetricVal(m.medianAmplificationRatio)}x, billable=${formatMetricVal(m.medianBillableInputOutput)}`
    );
  }

  lines.push('Tool Adoption Scorecard:');
  for (const row of cohort.scorecard) {
    const pct = row.adoptionRate === null ? 'n/a' : `${Math.round(row.adoptionRate * 100)}%`;
    lines.push(`  - [${row.verdict}] ${row.wave}: used=${row.used}/${row.opportunities} (${pct}) — ${row.notes}`);
  }

  return lines.join('\n');
}

function formatProfileReport(profile) {
  const s = profile.summary;
  const a = profile.apiUsage;
  const amp = profile.amplification;
  const c = profile.categories;

  const lines = [
    `Token Profile: ${profile.file}`,
    `Steps: ${s.totalSteps} (user=${s.userTurns}, model=${s.modelTurns}, tools=${s.toolCalls}, malformed=${s.malformedLines})`,
    `Estimated Unique Content Tokens: ${s.estimatedTotalTokens} (reads=${c.reads}, cmd=${c.commandOutput}, writes=${c.writes}, reasoning=${c.reasoning}, assistant=${c.assistantText}, user/sys=${c.userAndSystem}, other=${c.otherTools})`,
    `Amplification: ratio=${amp.quadraticAmplificationRatio}x (cumulative=${amp.cumulativeContextTokens}, avg/turn=${amp.avgContextPerTurn})`
  ];

  if (a.reportedTurns > 0) {
    lines.push(
      `API Reported (${a.reportedTurns} turns): input=${a.totalInputTokens}, cache_read=${a.totalCacheReadTokens}, output=${a.totalOutputTokens}`
    );
  }

  lines.push(`Unedited File Reads (${profile.uneditedFileReads.length}):`);
  for (const item of profile.uneditedFileReads.slice(0, 10)) {
    lines.push(`  - ${item.path} | reads=${item.readCount} | est=${item.estimatedTokens} | ranges=${item.ranges.join(',')}`);
  }

  lines.push(`Duplicate File Reads (${profile.duplicateReads.length}):`);
  for (const item of profile.duplicateReads.slice(0, 10)) {
    lines.push(`  - ${item.path} | reads=${item.readCount} (exactDup=${item.exactDuplicateCount}) | est=${item.estimatedTokens}`);
  }

  lines.push(`Top Sinks (${profile.topSinks.length}):`);
  for (const sink of profile.topSinks) {
    lines.push(`  - step#${sink.stepIndex} [${sink.category}] ${sink.toolName}${sink.target ? ` (${sink.target})` : ''} ~${sink.estimatedTokens} tok`);
  }

  return lines.join('\n');
}

function parseCliArgs(argv) {
  let filePath = null;
  let json = false;
  let help = false;
  let topN = 15;
  let cohort = false;
  let dir = null;
  let workspace = null;
  let allWorkspaces = false;
  let since = null;
  let until = null;
  let split = null;
  let minTurns = 2;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--cohort' || arg === '--scorecard') {
      cohort = true;
    } else if (arg === '--all-workspaces') {
      allWorkspaces = true;
    } else if (arg.startsWith('--top=')) {
      const n = Number.parseInt(arg.slice('--top='.length), 10);
      if (Number.isInteger(n) && n > 0) topN = n;
    } else if (arg === '--top' && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isInteger(n) && n > 0) topN = n;
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length) || null;
    } else if (arg === '--dir' && argv[i + 1]) {
      dir = argv[++i] || null;
    } else if (arg.startsWith('--workspace=')) {
      workspace = arg.slice('--workspace='.length) || null;
    } else if (arg === '--workspace' && argv[i + 1]) {
      workspace = argv[++i] || null;
    } else if (arg.startsWith('--since=')) {
      since = arg.slice('--since='.length) || null;
    } else if (arg === '--since' && argv[i + 1]) {
      since = argv[++i] || null;
    } else if (arg.startsWith('--until=')) {
      until = arg.slice('--until='.length) || null;
    } else if (arg === '--until' && argv[i + 1]) {
      until = argv[++i] || null;
    } else if (arg.startsWith('--split=')) {
      split = arg.slice('--split='.length) || null;
    } else if (arg === '--split' && argv[i + 1]) {
      split = argv[++i] || null;
    } else if (arg.startsWith('--min-turns=')) {
      const n = Number.parseInt(arg.slice('--min-turns='.length), 10);
      if (Number.isInteger(n) && n >= 0) minTurns = n;
    } else if (arg === '--min-turns' && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isInteger(n) && n >= 0) minTurns = n;
    } else if (!arg.startsWith('-') && !filePath) {
      filePath = arg;
    }
  }

  return {
    filePath,
    json,
    help,
    topN,
    cohort,
    dir,
    workspace,
    allWorkspaces,
    since,
    until,
    split,
    minTurns
  };
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      'Usage:',
      '  node scripts/token-profile.js <path/to/transcript.jsonl> [--json] [--top=15]',
      '  node scripts/token-profile.js --cohort [--dir <path>] [--workspace <name> | --all-workspaces] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--split YYYY-MM-DD] [--min-turns 2] [--json]'
    ].join('\n'));
    return;
  }

  if (opts.cohort) {
    const cohortResult = profileCohort({
      dir: opts.dir || path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
      workspace: opts.allWorkspaces ? null : (opts.workspace || path.basename(process.cwd())),
      since: opts.since,
      until: opts.until,
      split: opts.split,
      minTurns: opts.minTurns
    });
    if (opts.json) {
      console.log(JSON.stringify(cohortResult, null, 2));
    } else {
      console.log(formatCohortReport(cohortResult));
    }
    return;
  }

  if (!opts.filePath || !fs.existsSync(path.resolve(opts.filePath))) {
    console.error('Error: Provide a valid path to a .jsonl transcript file (or pass --cohort).');
    process.exitCode = 1;
    return;
  }

  const profile = profileTranscript(opts.filePath, { topN: opts.topN });
  if (opts.json) {
    console.log(JSON.stringify(profile, null, 2));
  } else {
    console.log(formatProfileReport(profile));
  }
}

module.exports = {
  profileTranscript,
  parseTranscriptLines,
  formatProfileReport,
  profileCohort,
  formatCohortReport,
  discoverTranscriptFiles,
  normalizeToolPath,
  unwrapArgValue
};

if (require.main === module) {
  main();
}
