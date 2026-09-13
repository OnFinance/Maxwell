#!/usr/bin/env node
// Computes the six Maxwell KPIs from session summaries and workspace state, appending validated datapoints to
// kpis/data/<kpi_id>/series.jsonl and one run record to kpis/measurement/runs.jsonl.
// Usage: compute.mjs [--company <id>] [--since <RFC3339|date>] [--until <RFC3339|date>] [--kpi <id>]...
import { readFileSync, existsSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildAjv, getValidator, formatErrors } from '../lib/schemas.mjs';

const argv = process.argv.slice(2);
const opts = (f) => argv.flatMap((a, i) => (a === f ? [argv[i + 1]] : []));
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const nowIso = iso(Date.now());
const untilArg = opts('--until')[0];
const sinceArg = opts('--since')[0];
const periodEnd = untilArg ? iso(untilArg) : nowIso;
const periodStart = sinceArg ? iso(sinceArg) : iso(Date.parse(periodEnd) - 30 * 86400000);
const onlyKpis = opts('--kpi');
const onlyCompany = opts('--company')[0];
const t0 = Date.now();

const registry = JSON.parse(readFileSync('kpis/metrics.json', 'utf8'));
const { ajv } = buildAjv();
const validateDp = getValidator(ajv, 'https://maxwell.onfinance.ai/schemas/v1/kpi/datapoint.schema.json');
const validateRun = getValidator(ajv, 'https://maxwell.onfinance.ai/schemas/v1/kpi/run.schema.json');
const gitCommit = (() => { const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : undefined; })();
const inPeriod = (ts) => ts && ts >= periodStart && ts <= periodEnd;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const listDir = (d) => (existsSync(d) ? readdirSync(d) : []);
const companies = listDir('company-profile').filter((c) => c !== '.gitkeep' && (!onlyCompany || c === onlyCompany));

// ---- inputs ----------------------------------------------------------------------------------------------
const summaries = []; const metas = [];
for (const h of listDir('kpis/data/raw/sessions')) {
  const d = `kpis/data/raw/sessions/${h}`;
  if (!existsSync(d) || !readdirSync(d)) continue;
  for (const f of listDir(d)) {
    if (f.endsWith('.summary.json')) summaries.push({ file: `${d}/${f}`, ...readJson(`${d}/${f}`) });
    if (f.endsWith('.meta.json')) metas.push(readJson(`${d}/${f}`));
  }
}
function ledger(company) {
  const p = `company-profile/${company}/soc/main.jsonl`;
  if (!existsSync(p)) return [];
  const latest = new Map();
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    latest.set(r.id, r);
    if (r.supersedes) latest.delete(r.supersedes);
  }
  return [...latest.values()];
}
const cm = (company) => (existsSync(`company-profile/${company}/change_management/master.json`) ? readJson(`company-profile/${company}/change_management/master.json`) : { initiatives: [] });
const sug = (company) => (existsSync(`company-profile/${company}/suggestions/master.json`) ? readJson(`company-profile/${company}/suggestions/master.json`) : { suggestions: [] });
const tasksOf = (company, initId) => { const d = `company-profile/${company}/change_management/initiatives/${initId}/tasks`; return listDir(d).filter((f) => f.endsWith('.json')).map((f) => readJson(`${d}/${f}`)); };
const appsAll = listDir('applications').filter((a) => a !== '.gitkeep');
const envPairs = appsAll.flatMap((a) => listDir(`applications/${a}/env`).filter((f) => f.endsWith('.json')).map((f) => `${a}/${f.replace(/\.json$/, '')}`));

// ---- datapoint helpers -------------------------------------------------------------------------------------
const outputs = new Set(); const errors = []; let written = 0;
function emit(dp) {
  const full = { schemaVersion: '1', kind: 'maxwell.kpi.datapoint', periodStart, periodEnd, computedAt: nowIso, methodVersion: (registry.kpis.find((k) => k.kpiId === dp.kpiId) || {}).methodVersion || '1.0.0', ...dp, provenance: { harness: 'script', generatedAt: nowIso, workflow: 'kpis', agent: '.claude/scripts/kpis/compute.mjs', ...(gitCommit ? { gitCommit } : {}) } };
  if (!full.inputsRef) full.inputsRef = {};
  if (!validateDp(full)) { errors.push(`${dp.kpiId}/${dp.series}: ${formatErrors(validateDp.errors, 5).replace(/\n/g, ' ')}`); return; }
  const file = `kpis/data/${dp.kpiId}/series.jsonl`;
  mkdirSync(`kpis/data/${dp.kpiId}`, { recursive: true });
  appendFileSync(file, JSON.stringify(full) + '\n');
  outputs.add(file); written += 1;
}
const wants = (k) => onlyKpis.length === 0 || onlyKpis.includes(k);
const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const hashOf = (parts) => createHash('sha256').update(parts.join('|')).digest('hex');

// ---- 1. cost_of_audit (per run, per workflow) ----------------------------------------------------------------
let sessionsConsidered = 0; let sessionsSampled = 0;
if (wants('cost_of_audit')) {
  const runs = new Map();
  for (const m of metas) {
    if (!inPeriod(m.endedAt || m.startedAt)) continue;
    if (onlyCompany && m.companyId && m.companyId !== onlyCompany) continue;
    const key = m.runId || `norun:${(m.startedAt || '').slice(0, 10)}`;
    if (!runs.has(key)) runs.set(key, { considered: 0, sampled: 0, metas: [] });
    const r = runs.get(key); r.considered += 1; if (m.sampled) r.sampled += 1; r.metas.push(m);
  }
  for (const [key, r] of runs) {
    sessionsConsidered += r.considered; sessionsSampled += r.sampled;
    const sums = summaries.filter((s) => (s.runId || `norun:${(s.startedAt || '').slice(0, 10)}`) === key);
    if (!sums.length) continue;
    const scale = r.sampled ? r.considered / r.sampled : 1;
    const byWf = new Map();
    for (const s of sums) { const w = s.workflow || 'manual'; if (!byWf.has(w)) byWf.set(w, []); byWf.get(w).push(s); }
    const runId = key.startsWith('norun:') ? undefined : key;
    const companyId = (sums.find((s) => s.companyId) || {}).companyId;
    const controlsObserved = companyId ? new Set(ledger(companyId).filter((x) => x.kind === 'observation' && x.provenance && runId && x.provenance.runId === runId).flatMap((x) => x.controlIds || [])).size : 0;
    const appsInScope = new Set(r.metas.flatMap((m) => (m.args && m.args.appIds) || [])).size || appsAll.length;
    let runTotal = 0;
    for (const [wf, list] of byWf) {
      const measured = list.reduce((a, s) => a + (s.costUsd.computed || 0), 0);
      const value = round(measured * scale, 4);
      runTotal += value;
      const dims = { ...(companyId ? { companyId } : {}), ...(runId ? { runId } : {}), workflow: wf, harness: list[0].harness };
      const base = { kpiId: 'cost_of_audit', unit: 'usd', dimensions: dims, sampleSize: list.length, sampling: { mode: registry.sampling.mode, sessionsConsidered: r.considered, sessionsSampled: r.sampled, scaleFactor: round(scale, 4) }, inputsRef: { sessionIds: list.map((s) => s.sessionId), ...(runId ? { runIds: [runId] } : {}), files: list.map((s) => s.file) } };
      emit({ ...base, series: 'raw', value, notes: `${list.length} sampled session(s) scaled by ${round(scale, 4)}; reported delta pct: ${list.map((s) => s.costUsd.deltaPct).join(',')}` });
    }
    const dimsRun = { ...(companyId ? { companyId } : {}), ...(runId ? { runId } : {}), harness: sums[0].harness };
    const baseRun = { kpiId: 'cost_of_audit', dimensions: dimsRun, sampleSize: sums.length, sampling: { mode: registry.sampling.mode, sessionsConsidered: r.considered, sessionsSampled: r.sampled, scaleFactor: round(scale, 4) }, inputsRef: { sessionIds: sums.map((s) => s.sessionId), ...(runId ? { runIds: [runId] } : {}), files: sums.map((s) => s.file) } };
    if (controlsObserved > 0) emit({ ...baseRun, series: 'usd-per-control-observed', unit: 'usd-per-control', value: round(runTotal / controlsObserved, 4), numerator: round(runTotal, 4), denominator: controlsObserved });
    if (appsInScope > 0) emit({ ...baseRun, series: 'usd-per-application', unit: 'usd-per-application', value: round(runTotal / appsInScope, 4), numerator: round(runTotal, 4), denominator: appsInScope });
  }
}

// ---- 2-6. workspace-state KPIs per company -----------------------------------------------------------------
for (const company of companies) {
  const recs = ledger(company);
  const master = cm(company);
  const suggestions = sug(company);
  const files = [`company-profile/${company}/soc/main.jsonl`, `company-profile/${company}/change_management/master.json`, `company-profile/${company}/suggestions/master.json`];
  const dims = { companyId: company };

  if (wants('cm_actionability')) {
    const inits = (master.initiatives || []).filter((i) => inPeriod(i.createdAt));
    let ok = 0; const failed = {};
    for (const i of inits) {
      const tasks = tasksOf(company, i.initiativeId);
      const checks = {
        owner: !!i.owner, dueAt: !!i.dueAt, regulatoryRef: (i.regulatoryRefs || []).length > 0,
        linked: (i.findingIds || []).length + (i.controlIds || []).length > 0,
        tasks: tasks.length > 0 && tasks.every((t) => t.owner && (t.acceptanceCriteria || []).length > 0 && t.verificationMethod && t.rootCause),
      };
      if (Object.values(checks).every(Boolean)) ok += 1; else for (const [k, v] of Object.entries(checks)) if (!v) failed[k] = (failed[k] || 0) + 1;
    }
    emit({ kpiId: 'cm_actionability', series: 'raw', unit: 'ratio', dimensions: dims, value: inits.length ? round(ok / inits.length) : 0, numerator: ok, denominator: inits.length, sampleSize: inits.length, inputsRef: { files }, notes: inits.length ? `failed criteria: ${JSON.stringify(failed)}` : 'no initiatives created in period' });
  }

  if (wants('cm_coverage')) {
    const controls = recs.filter((r) => r.kind === 'control' && r.implementationStatus !== 'not-applicable');
    const observed = new Set(recs.filter((r) => r.kind === 'observation' && inPeriod(r.collectedAt || r.recordedAt)).flatMap((r) => r.controlIds || []));
    const covered = controls.filter((c) => observed.has(c.id)).length;
    const assetsObserved = new Set(recs.filter((r) => r.kind === 'observation' && inPeriod(r.collectedAt || r.recordedAt)).flatMap((r) => (r.subjects || []).filter((s) => s.appId && s.envId).map((s) => `${s.appId}/${s.envId}`)));
    const openHigh = recs.filter((r) => r.kind === 'finding' && ['open', 'triaged', 'remediating'].includes(r.status) && ['critical', 'high'].includes(r.severity));
    emit({ kpiId: 'cm_coverage', series: 'raw', unit: 'percent', dimensions: dims, value: controls.length ? round((100 * covered) / controls.length, 2) : 0, numerator: covered, denominator: controls.length, sampleSize: controls.length, inputsRef: { files: [files[0]] }, notes: `asset coverage ${assetsObserved.size}/${envPairs.length} (app,env) pairs; high+ findings linked to initiatives ${openHigh.filter((f) => f.initiativeId).length}/${openHigh.length}` });
  }

  if (wants('cm_time_to_implementation')) {
    const closed = (master.initiatives || []).filter((i) => i.status === 'closed' && i.closedAt && inPeriod(i.closedAt));
    const days = closed.map((i) => (Date.parse(i.closedAt) - Date.parse(i.createdAt)) / 86400000);
    const withinSla = closed.filter((i) => i.dueAt && i.closedAt <= i.dueAt).length;
    const overdueOpen = (master.initiatives || []).filter((i) => !['closed', 'cancelled'].includes(i.status) && i.dueAt && i.dueAt < periodEnd).length;
    emit({ kpiId: 'cm_time_to_implementation', series: 'raw', unit: 'days', dimensions: dims, value: round(median(days), 2), sampleSize: closed.length, inputsRef: { files: [files[1]] }, notes: `p90 ${round([...days].sort((a, b) => a - b)[Math.max(0, Math.ceil(days.length * 0.9) - 1)] || 0, 2)} days; overdue open initiatives: ${overdueOpen}` });
    emit({ kpiId: 'cm_time_to_implementation', series: 'sla-compliance-rate', unit: 'ratio', dimensions: dims, value: closed.length ? round(withinSla / closed.length) : 0, numerator: withinSla, denominator: closed.length, sampleSize: closed.length, inputsRef: { files: [files[1]] } });
  }

  if (wants('suggestion_acceptance_rate')) {
    const all = (suggestions.suggestions || []).filter((s) => inPeriod(s.surfacedAt || s.createdAt));
    const acc = all.filter((s) => ['accepted', 'merged', 'reverted'].includes(s.status)).length;
    const decided = all.filter((s) => ['accepted', 'merged', 'reverted', 'rejected', 'expired'].includes(s.status)).length;
    const merged = all.filter((s) => ['merged', 'reverted'].includes(s.status));
    const reverted = merged.filter((s) => s.status === 'reverted' && s.revertedAt && s.mergedAt && Date.parse(s.revertedAt) - Date.parse(s.mergedAt) <= 30 * 86400000).length;
    const checked = merged.filter((s) => s.retentionCheckedAt && s.mergedAt && Date.parse(s.retentionCheckedAt) - Date.parse(s.mergedAt) >= 30 * 86400000);
    const retained = checked.filter((s) => s.retained === true).length;
    const base = { kpiId: 'suggestion_acceptance_rate', dimensions: dims, inputsRef: { files: [files[2]] } };
    emit({ ...base, series: 'raw', unit: 'percent', value: decided ? round((100 * acc) / decided, 2) : 0, numerator: acc, denominator: decided, sampleSize: all.length });
    emit({ ...base, series: 'merge-rate', unit: 'percent', value: acc ? round((100 * merged.length) / acc, 2) : 0, numerator: merged.length, denominator: acc, sampleSize: acc });
    emit({ ...base, series: 'revert-rate', unit: 'percent', value: merged.length ? round((100 * reverted) / merged.length, 2) : 0, numerator: reverted, denominator: merged.length, sampleSize: merged.length });
    emit({ ...base, series: 'retention-30d', unit: 'percent', value: checked.length ? round((100 * retained) / checked.length, 2) : 0, numerator: retained, denominator: checked.length, sampleSize: checked.length });
  }

  if (wants('incident_rate')) {
    const incidents = recs.filter((r) => r.kind === 'incident' && r.severity !== 'info' && inPeriod(r.detectedAt || r.recordedAt));
    const pd = listDir('kpis/data/raw/pagerduty').filter((f) => f.endsWith('.json')).flatMap((f) => readJson(`kpis/data/raw/pagerduty/${f}`).incidents || []).filter((i) => inPeriod(i.created_at));
    const keys = new Set(incidents.map((i) => i.dedupKey));
    const pdOnly = pd.filter((i) => !(i.incident_key && keys.has(i.incident_key)));
    const both = pd.filter((i) => i.incident_key && keys.has(i.incident_key)).length;
    const changes = (master.initiatives || []).filter((i) => i.status === 'closed' && inPeriod(i.closedAt)).length + (suggestions.suggestions || []).filter((s) => ['merged', 'reverted'].includes(s.status) && inPeriod(s.mergedAt)).length;
    const total = incidents.length + pdOnly.length;
    const mttr = incidents.filter((i) => i.resolvedAt).map((i) => (Date.parse(i.resolvedAt) - Date.parse(i.detectedAt)) / 3600000);
    const base = { kpiId: 'incident_rate', dimensions: dims, inputsRef: { files: [files[0], ...listDir('kpis/data/raw/pagerduty').filter((f) => f.endsWith('.json')).map((f) => `kpis/data/raw/pagerduty/${f}`)] } };
    emit({ ...base, series: 'raw', unit: 'per-1000-changes', value: changes ? round((1000 * total) / changes, 2) : total * 1000, numerator: total, denominator: changes, sampleSize: total, notes: `maxwell ${incidents.length}, pagerduty-only ${pdOnly.length}, reconciled ${both}; MTTR ${round(mttr.length ? mttr.reduce((a, b) => a + b, 0) / mttr.length : 0, 2)} h` });
    emit({ ...base, series: 'incidents-per-application', unit: 'count', value: appsAll.length ? round(total / appsAll.length, 4) : total, numerator: total, denominator: appsAll.length || 1, sampleSize: total });
  }
}

// ---- run record --------------------------------------------------------------------------------------------
const kpiIds = registry.kpis.map((k) => k.kpiId).filter(wants);
const run = { schemaVersion: '1', kind: 'maxwell.kpi.run', runAt: nowIso, kpiIds, ...(onlyCompany ? { companyId: onlyCompany } : {}), sessionsConsidered, sessionsSampled, samplingMode: registry.sampling.mode, periodStart, periodEnd, outputs: [...outputs].sort(), status: errors.length ? (written ? 'partial' : 'failed') : 'success', ...(errors.length ? { errors: errors.map((e) => ({ message: e.slice(0, 500) })) } : {}), durationMs: Date.now() - t0, provenance: { harness: 'script', generatedAt: nowIso, workflow: 'kpis', agent: '.claude/scripts/kpis/compute.mjs', ...(gitCommit ? { gitCommit } : {}) } };
if (!validateRun(run)) { console.error(`run record invalid:\n${formatErrors(validateRun.errors)}`); console.error(errors.join('\n')); process.exit(2); }
mkdirSync('kpis/measurement', { recursive: true });
appendFileSync('kpis/measurement/runs.jsonl', JSON.stringify(run) + '\n');
console.log(`kpis: ${written} datapoint(s) written for ${kpiIds.join(', ')} [${periodStart} → ${periodEnd}] status=${run.status}`);
if (errors.length) { console.error(errors.join('\n')); process.exit(2); }
