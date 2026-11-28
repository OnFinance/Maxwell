// Normalise and filter LLM-proposed findings into a trusted internal shape.
import { normaliseCategory, normaliseSeverity, severityRank } from './taxonomy.mjs';

function text(v, max = 4000) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function toInt(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

/** Resolve a model-reported path to one of the reviewed files (exact, then unique suffix match). */
export function resolveFile(raw, files) {
  if (typeof raw !== 'string') return undefined;
  const p = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const exact = files.find((f) => f.path === p);
  if (exact) return exact;
  const suffix = files.filter((f) => f.path.endsWith(`/${p}`) || p.endsWith(`/${f.path}`));
  return suffix.length === 1 ? suffix[0] : undefined;
}

/**
 * Turn raw reviewer output into candidate findings. Drops anything that does not point at a real file and line
 * range, maps categories onto the chain taxonomy and clamps line numbers.
 */
export function normaliseFindings(chain, raw, files) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== 'object') continue;
    const file = resolveFile(r.file, files);
    if (!file) continue;
    let start = toInt(r.startLine);
    let end = toInt(r.endLine);
    if (!Number.isFinite(start) || start < 1 || start > file.lines) continue;
    if (!Number.isFinite(end) || end < start) end = start;
    end = Math.min(end, file.lines);
    const title = text(r.title, 200);
    const description = text(r.description);
    if (!title && !description) continue;
    out.push({
      file: file.path,
      startLine: start,
      endLine: end,
      category: normaliseCategory(chain, r.category),
      severity: normaliseSeverity(r.severity),
      title: title || description.slice(0, 120),
      description: description || title,
      exploitScenario: text(r.exploitScenario) || description || title,
      remediation: text(r.remediation) || 'Review and fix the flagged code.',
      confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
    });
  }
  return out;
}

/** Collapse findings that share file and category and overlap (or sit within 3 lines); keep the most severe. */
export function dedupeFindings(findings) {
  const sorted = [...findings].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || b.confidence - a.confidence,
  );
  const kept = [];
  for (const f of sorted) {
    const dup = kept.find(
      (k) => k.file === f.file && k.category === f.category &&
        f.startLine <= k.endLine + 3 && k.startLine <= f.endLine + 3,
    );
    if (!dup) kept.push(f);
  }
  return kept.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
}

/**
 * Apply refuter verdicts. A candidate survives only with an explicit `confirmed` verdict at or above
 * `minConfidence`; the refuter may correct severity, category and the line range.
 */
export function applyVerdicts(chain, candidates, verdicts, files, { minConfidence = 0.6 } = {}) {
  const byId = new Map();
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    if (v && typeof v === 'object' && Number.isInteger(v.id)) byId.set(v.id, v);
  }
  const out = [];
  candidates.forEach((c, id) => {
    const v = byId.get(id);
    if (!v || v.verdict !== 'confirmed') return;
    const confidence = Math.max(0, Math.min(1, Number(v.confidence) || 0));
    if (confidence < minConfidence) return;
    const f = { ...c, confidence };
    if (v.severity) f.severity = normaliseSeverity(v.severity);
    if (v.category) f.category = normaliseCategory(chain, v.category);
    const file = files.find((x) => x.path === f.file);
    const s = toInt(v.startLine);
    const e = toInt(v.endLine);
    if (file && Number.isFinite(s) && s >= 1 && s <= file.lines) {
      f.startLine = s;
      f.endLine = Number.isFinite(e) && e >= s ? Math.min(e, file.lines) : s;
    }
    if (text(v.reason)) f.refutation = text(v.reason, 1000);
    out.push(f);
  });
  return out;
}
