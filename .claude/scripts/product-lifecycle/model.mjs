import { sha256 } from '../incident-investigation/core.mjs';
import { validateCheck } from '../remediation/checks.mjs';

export const digest = sha256;
export function ensure(value, message) { if (!value) throw new Error(message); }
export function pathKey(value) {
  ensure(typeof value === 'string' && value.length <= 512 && !value.includes('\\') && !/[\u0000-\u001f]/.test(value) && !value.startsWith('/') &&
    value.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git'), 'Invalid source path.');
  return value;
}
export function inspectProduct({ files, revision, application, environment }) {
  ensure(/^[a-f0-9]{40}$/.test(revision) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(application) &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(environment), 'A product, environment and full revision are required.');
  ensure(Array.isArray(files) && files.length > 0 && files.length <= 500, 'Select 1–500 source files.');
  const seen = new Set();
  let bytes = 0;
  const sources = files.map(file => {
    pathKey(file.path);
    ensure(!seen.has(file.path) && typeof file.content === 'string', 'Invalid or duplicate source.');
    seen.add(file.path); bytes += Buffer.byteLength(file.content);
    ensure(bytes <= 1024 * 1024, 'Selected source exceeds 1 MiB.');
    return { path: file.path, content: file.content, sha256: digest(file.content) };
  });
  const components = sources.filter(f => /(^|\/)(package.json|Dockerfile|go.mod|pyproject.toml|requirements.txt|Chart.yaml)$/.test(f.path))
    .map(f => ({ path: f.path, sha256: f.sha256, basis: 'manifest-present' }));
  const connections = [];
  for (const source of sources.filter(f => /\.[cm]?[jt]sx?$/.test(f.path))) {
    for (const match of source.content.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
      connections.push({ from: source.path, to: match[1], line: source.content.slice(0, match.index).split('\n').length,
        sourceSha256: source.sha256, confidence: 'source-reference-runtime-unconfirmed' });
      if (connections.length >= 1000) break;
    }
    if (connections.length >= 1000) break;
  }
  return { version: 1, application, environment, revision, sources, components, connections };
}
export function planRepair(model, check, signals = []) {
  validateCheck(check);
  ensure(check.type === 'json-field-equals', 'The first repair profile supports JSON field equality.');
  pathKey(check.path);
  const source = model.sources.find(s => s.path === check.path);
  ensure(source, 'The repair file was not collected at the selected revision.');
  const config = JSON.parse(source.content);
  let parent = config;
  for (const key of check.field.slice(0, -1)) {
    ensure(parent && typeof parent === 'object' && !Array.isArray(parent) && Object.hasOwn(parent, key), 'Repair field is missing.');
    parent = parent[key];
  }
  const key = check.field.at(-1);
  ensure(parent && typeof parent === 'object' && !Array.isArray(parent) && Object.hasOwn(parent, key) &&
    ['string','number','boolean'].includes(typeof parent[key]), 'Repair field must already be a primitive.');
  ensure(Array.isArray(signals) && signals.length <= 100, 'Too many telemetry observations.');
  const timeline = signals.map(s => {
    ensure(s && typeof s.id === 'string' && s.id.length <= 120 && typeof s.summary === 'string' && s.summary.length <= 500 &&
      typeof s.at === 'string' && Number.isFinite(Date.parse(s.at)) &&
      /^[a-f0-9]{40}$/.test(s.revision) && ['error','deployment','metric'].includes(s.type), 'Invalid telemetry observation.');
    return { id: s.id, at: s.at, type: s.type, summary: s.summary, revision: s.revision,
      matchesRevision: s.revision === model.revision };
  }).sort((a,b) => a.at.localeCompare(b.at));
  const before = parent[key];
  const needsRepair = before !== check.expected;
  parent[key] = check.expected;
  const candidate = JSON.stringify(config, null, 2) + '\n';
  return { profile: 'json-field-equals-v1', check, before, needsRepair, path: check.path, sourceSha256: source.sha256,
    candidate, candidateSha256: digest(candidate), timeline,
    diagnosis: { outcome: needsRepair ? 'configuration-mismatch' : 'check-satisfied',
      evidence: { path: check.path, field: check.field, sourceSha256: source.sha256 },
      operationalCause: 'unconfirmed', gaps: timeline.length ? ['Telemetry correlation requires reviewer confirmation.'] : ['No operational telemetry supplied.'] } };
}
export function verifyRepair(model, plan) {
  // A second pass builds the expected document independently of the patcher's JSON serialization.
  const source = model.sources.find(s => s.path === plan.path);
  ensure(source && digest(source.content) === plan.sourceSha256 && digest(plan.candidate) === plan.candidateSha256, 'Repair provenance mismatch.');
  validateCheck(plan.check);
  const before = JSON.parse(source.content), after = JSON.parse(plan.candidate);
  let expected = before;
  for (const key of plan.check.field.slice(0, -1)) expected = expected[key];
  expected[plan.check.field.at(-1)] = plan.check.expected;
  ensure(digest(before) === digest(after), 'The patch changed unrelated fields.');
  return { outcome: 'passed', profile: plan.profile, baseRevision: model.revision,
    candidateSha256: plan.candidateSha256, checkHash: digest(plan.check), scope: 'static-json-assertion' };
}
