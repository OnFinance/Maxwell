// Parsers that turn harness transcripts into one normalised session-stats object.
//   parseClaudeTranscript(lines[])  — Claude Code ~/.claude/projects/<proj>/<sid>.jsonl (+ subagent files)
//   parseOpencodeExport(json)       — output of `opencode export <sid>`
// Both return: { models: Map<model, {tokens, webSearchRequests, webFetchRequests}>, turns, inferenceCalls,
//   toolCalls: {total, byTool}, permissionDenials[], filesWritten Set, startedAt, endedAt, reportedCostUsd,
//   linesAdded, linesRemoved, apiDurationMs, formatVersion, duplicatesDropped, errors[] }
// The Claude Code format is officially unstable; every field read here is guarded.

const EMPTY_TOKENS = () => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, thinking: 0 });

function ensureModel(stats, model) {
  if (!stats.models.has(model)) stats.models.set(model, { tokens: EMPTY_TOKENS(), webSearchRequests: 0, webFetchRequests: 0 });
  return stats.models.get(model);
}

function newStats() {
  return { models: new Map(), turns: 0, inferenceCalls: 0, toolCalls: { total: 0, byTool: {} }, permissionDenials: [], filesWritten: new Set(), startedAt: null, endedAt: null, reportedCostUsd: null, linesAdded: 0, linesRemoved: 0, apiDurationMs: null, formatVersion: null, duplicatesDropped: 0, errors: [], subagentFiles: 0 };
}

function bump(stats, ts) {
  if (!ts) return;
  if (!stats.startedAt || ts < stats.startedAt) stats.startedAt = ts;
  if (!stats.endedAt || ts > stats.endedAt) stats.endedAt = ts;
}

function totalTokens(u) {
  return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

export function parseClaudeTranscript(lines, stats = newStats()) {
  const byRequest = new Map();
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.version && !stats.formatVersion) stats.formatVersion = rec.version;
    bump(stats, rec.timestamp);
    if (rec.type === 'assistant' && rec.message) {
      const key = rec.requestId || (rec.message && rec.message.id) || rec.uuid;
      const prev = byRequest.get(key);
      const usage = rec.message.usage || {};
      if (!prev || totalTokens(usage) >= totalTokens(prev.message.usage || {})) {
        if (prev) stats.duplicatesDropped += 1;
        byRequest.set(key, rec);
      } else {
        stats.duplicatesDropped += 1;
      }
    } else if (rec.type === 'user' && rec.message && Array.isArray(rec.message.content)) {
      if (rec.toolDenialKind) stats.permissionDenials.push({ toolName: rec.toolDenialTool || 'unknown', reason: String(rec.toolDenialKind) });
    } else if (rec.type === 'cost-state') {
      if (typeof rec.totalCostUSD === 'number') stats.reportedCostUsd = rec.totalCostUSD;
      if (typeof rec.totalLinesAdded === 'number') stats.linesAdded = rec.totalLinesAdded;
      if (typeof rec.totalLinesRemoved === 'number') stats.linesRemoved = rec.totalLinesRemoved;
      if (typeof rec.totalAPIDuration === 'number') stats.apiDurationMs = rec.totalAPIDuration;
    } else if (rec.type === 'system' && rec.subtype === 'error') {
      stats.errors.push({ message: String(rec.content || rec.message || 'error').slice(0, 500) });
    }
  }
  for (const rec of byRequest.values()) {
    const m = rec.message;
    const usage = m.usage || {};
    const model = m.model || 'unknown';
    const entry = ensureModel(stats, model);
    entry.tokens.input += usage.input_tokens || 0;
    entry.tokens.output += usage.output_tokens || 0;
    entry.tokens.cacheRead += usage.cache_read_input_tokens || 0;
    const cc = usage.cache_creation || {};
    if (typeof cc.ephemeral_5m_input_tokens === 'number' || typeof cc.ephemeral_1h_input_tokens === 'number') {
      entry.tokens.cacheWrite5m += cc.ephemeral_5m_input_tokens || 0;
      entry.tokens.cacheWrite1h += cc.ephemeral_1h_input_tokens || 0;
    } else {
      entry.tokens.cacheWrite5m += usage.cache_creation_input_tokens || 0;
    }
    entry.tokens.thinking += (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0;
    const stu = usage.server_tool_use || {};
    entry.webSearchRequests += stu.web_search_requests || 0;
    entry.webFetchRequests += stu.web_fetch_requests || 0;
    stats.inferenceCalls += 1;
    stats.turns += 1;
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block && block.type === 'tool_use') {
        const name = String(block.name || 'unknown');
        stats.toolCalls.total += 1;
        stats.toolCalls.byTool[name] = (stats.toolCalls.byTool[name] || 0) + 1;
        const input = block.input || {};
        const fp = input.file_path || input.path;
        if (fp && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) stats.filesWritten.add(String(fp));
      }
    }
  }
  return stats;
}

// Merges subagent transcripts (isSidechain) into the same stats; each file counts as one subagent session.
export function parseClaudeSubagents(fileContents, stats) {
  for (const lines of fileContents) {
    stats.subagentFiles += 1;
    parseClaudeTranscript(lines, stats);
  }
  return stats;
}

// OpenCode export: shape is not documented, so walk every object and pick assistant messages by role + tokens.
export function parseOpencodeExport(doc, stats = newStats()) {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const role = node.role;
    const tokens = node.tokens;
    const modelObj = node.model || {};
    const modelId = typeof modelObj === 'string' ? modelObj : (modelObj.id || modelObj.modelID || node.modelID);
    const providerId = typeof modelObj === 'object' ? (modelObj.providerID || node.providerID) : undefined;
    if (role === 'assistant' && tokens && typeof tokens === 'object') {
      const model = providerId && modelId ? `${providerId}/${modelId}` : (modelId || 'unknown');
      const entry = ensureModel(stats, model);
      entry.tokens.input += tokens.input || 0;
      entry.tokens.output += tokens.output || 0;
      entry.tokens.thinking += tokens.reasoning || 0;
      entry.tokens.cacheRead += (tokens.cache && tokens.cache.read) || 0;
      entry.tokens.cacheWrite5m += (tokens.cache && tokens.cache.write) || 0;
      stats.inferenceCalls += 1;
      stats.turns += 1;
      const cost = node.cost;
      if (typeof cost === 'number') stats.reportedCostUsd = (stats.reportedCostUsd || 0) + cost;
      const time = node.time || {};
      const toIso = (v) => (typeof v === 'number' ? new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z') : (typeof v === 'string' ? v : null));
      bump(stats, toIso(time.created)); bump(stats, toIso(time.completed));
    }
    if (node.type === 'tool' && (node.tool || node.name)) {
      const name = String(node.tool || node.name);
      stats.toolCalls.total += 1;
      stats.toolCalls.byTool[name] = (stats.toolCalls.byTool[name] || 0) + 1;
      const input = (node.state && node.state.input) || node.input || {};
      const fp = input.filePath || input.path || input.file_path;
      if (fp && /^(write|edit|patch|multiedit)$/i.test(name)) stats.filesWritten.add(String(fp));
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
  };
  visit(doc);
  if (!stats.formatVersion) stats.formatVersion = (doc && (doc.version || (doc.info && doc.info.version))) || null;
  return stats;
}

export { newStats };
