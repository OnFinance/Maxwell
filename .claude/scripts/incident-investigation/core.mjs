import { createHash } from 'node:crypto';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,254}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ALERT_FIELDS = new Set([
  'schemaVersion', 'kind', 'alertId', 'companyId', 'scopeId', 'source', 'recipeId', 'recipeVersion', 'title',
  'priority', 'status', 'group', 'detectedAt', 'windowStart', 'windowEnd', 'evidenceCount', 'evidenceEventIds',
  'evidenceTruncated',
]);
const TERMINAL = new Set(['confirmation-pending', 'confirmed', 'false-positive', 'closed']);
export const INCIDENT_CATEGORIES = new Set(['targeted-scanning', 'compromise-critical-system', 'unauthorised-access', 'website-defacement', 'malware', 'ransomware', 'ddos', 'data-breach', 'data-leak', 'identity-theft', 'phishing', 'supply-chain', 'other']);
export const DATA_CLASSIFICATIONS = new Set(['public', 'internal', 'confidential', 'restricted', 'pii', 'spdi', 'cardholder', 'financial', 'regulatory']);

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

export const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export const caseIdFor = (alert) => `case_${sha256([alert.companyId, alert.alertId]).slice(0, 32)}`;
export const alertSignature = (alert) => sha256(alert);

function timestamp(value, field) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`invalid ${field}`);
  }
}

export function validateAlert(alert) {
  if (!alert || typeof alert !== 'object' || Array.isArray(alert)) throw new Error('alert must be an object');
  if (Object.keys(alert).some((field) => !ALERT_FIELDS.has(field))) throw new Error('alert contains unsupported fields');
  if (alert.schemaVersion !== '1' || alert.kind !== 'maxwell.detection.alert' || alert.status !== 'candidate') throw new Error('unsupported alert');
  for (const field of ['alertId', 'companyId', 'scopeId', 'source', 'recipeId']) {
    if (typeof alert[field] !== 'string' || !TOKEN.test(alert[field])) throw new Error(`invalid ${field}`);
  }
  if (!Number.isSafeInteger(alert.recipeVersion) || alert.recipeVersion < 1) throw new Error('invalid recipeVersion');
  if (typeof alert.title !== 'string' || alert.title.length < 1 || alert.title.length > 200) throw new Error('invalid title');
  if (!['critical', 'high', 'medium', 'low', 'info'].includes(alert.priority)) throw new Error('invalid priority');
  for (const field of ['detectedAt', 'windowStart', 'windowEnd']) timestamp(alert[field], field);
  if (Date.parse(alert.windowStart) > Date.parse(alert.windowEnd)) throw new Error('invalid alert window');
  if (!Array.isArray(alert.group) || !alert.group.length || alert.group.some((value) => typeof value !== 'string' || !TOKEN.test(value))) throw new Error('invalid group');
  if (!Number.isSafeInteger(alert.evidenceCount) || alert.evidenceCount < 1) throw new Error('invalid evidenceCount');
  if (!Array.isArray(alert.evidenceEventIds) || alert.evidenceEventIds.length > 100 || alert.evidenceEventIds.some((value) => typeof value !== 'string' || !TOKEN.test(value))) throw new Error('invalid evidenceEventIds');
  if (typeof alert.evidenceTruncated !== 'boolean') throw new Error('invalid evidenceTruncated');
  return structuredClone(alert);
}

export function createCase(alert, now = Date.now()) {
  const accepted = validateAlert(alert);
  const at = new Date(now).toISOString();
  return {
    schemaVersion: '1', kind: 'maxwell.investigation.case', caseId: caseIdFor(accepted), companyId: accepted.companyId,
    status: 'open', severity: accepted.priority, title: accepted.title, alertId: accepted.alertId,
    alertSignature: alertSignature(accepted), alert: accepted, owner: null, evidence: [], notes: [],
    openedAt: at, updatedAt: at, revision: 1,
    timeline: [{ at, action: 'opened', actor: 'maxwell-alert-intake' }],
  };
}

function validateActor(actor) {
  if (typeof actor !== 'string' || !TOKEN.test(actor)) throw new Error('invalid actor');
}

function validateText(value, field, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /(?:AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|\b(?:password|access_token|secret)\s*[:=])/i.test(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value.trim();
}

export function applyCaseAction(current, action, now = Date.now()) {
  if (!current || current.kind !== 'maxwell.investigation.case') throw new Error('invalid case');
  if (!action || typeof action !== 'object') throw new Error('action is required');
  validateActor(action.actor);
  if (!Number.isSafeInteger(action.expectedRevision) || action.expectedRevision !== current.revision) throw new Error('case revision conflict');
  const at = new Date(now).toISOString();
  const next = structuredClone(current);
  const type = action.type;
  if (type === 'start') {
    if (current.status !== 'open') throw new Error(`cannot start case from ${current.status}`);
    next.status = 'investigating';
  } else if (type === 'assign') {
    if (TERMINAL.has(current.status)) throw new Error(`cannot assign case in ${current.status}`);
    next.owner = validateText(action.owner, 'owner', 255);
  } else if (type === 'add-evidence') {
    if (TERMINAL.has(current.status)) throw new Error(`cannot add evidence in ${current.status}`);
    if (next.evidence.length >= 100) throw new Error('evidence limit reached');
    const ref = validateText(action.ref, 'evidence ref');
    if (!SHA256.test(action.sha256 || '')) throw new Error('invalid evidence sha256');
    if (next.evidence.some((item) => item.sha256 === action.sha256 && item.ref === ref)) throw new Error('duplicate evidence');
    next.evidence.push({ ref, sha256: action.sha256, description: validateText(action.description, 'evidence description') });
  } else if (type === 'note') {
    if (TERMINAL.has(current.status)) throw new Error(`cannot add note in ${current.status}`);
    if (next.notes.length >= 100) throw new Error('note limit reached');
    next.notes.push({ at, actor: action.actor, text: validateText(action.text, 'note') });
  } else if (type === 'prepare-confirmation') {
    if (!['open', 'investigating'].includes(current.status)) throw new Error(`cannot confirm case from ${current.status}`);
    if (!next.owner) throw new Error('case must be assigned before confirmation');
    if (!next.evidence.length) throw new Error('case requires evidence before confirmation');
    if (typeof action.incidentId !== 'string' || !/^inc_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(action.incidentId)) throw new Error('invalid incident id');
    if (!INCIDENT_CATEGORIES.has(action.category)) throw new Error('invalid incident category');
    const classifications = action.affectedDataClassifications || [];
    if (!Array.isArray(classifications) || classifications.some((value) => !DATA_CLASSIFICATIONS.has(value)) || new Set(classifications).size !== classifications.length) throw new Error('invalid data classifications');
    next.status = 'confirmation-pending';
    next.confirmation = { incidentId: action.incidentId, category: action.category, affectedDataClassifications: classifications };
  } else if (type === 'complete-confirmation') {
    if (current.status !== 'confirmation-pending') throw new Error(`cannot complete confirmation from ${current.status}`);
    next.status = 'confirmed';
    next.confirmedIncidentId = current.confirmation.incidentId;
  } else if (type === 'dismiss') {
    if (!['open', 'investigating'].includes(current.status)) throw new Error(`cannot dismiss case from ${current.status}`);
    next.status = 'false-positive';
    next.dispositionReason = validateText(action.reason, 'disposition reason');
  } else if (type === 'close') {
    if (!['confirmed', 'false-positive'].includes(current.status)) throw new Error(`cannot close case from ${current.status}`);
    next.status = 'closed';
  } else throw new Error('unsupported case action');
  next.updatedAt = at;
  next.revision++;
  next.timeline.push({ at, action: type, actor: action.actor });
  return next;
}
