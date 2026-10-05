import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { applyCaseAction, sha256 } from './core.mjs';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const priorityId = { low: 1, info: 1, medium: 2, high: 3, critical: 4 };
const severityId = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };
const regulatorFor = { 'cert-in-directions-2022': 'CERT-In', 'sebi-cscrf-2024': 'SEBI', 'rbi-cyber-tech-directions-2026': 'RBI', 'dpdp-rules-2025': 'MeitY' };

export function incidentIdFor(record) {
  let time = Date.parse(record.alert.detectedAt);
  let prefix = '';
  for (let i = 0; i < 10; i++) { prefix = CROCKFORD[time % 32] + prefix; time = Math.floor(time / 32); }
  const digest = Buffer.from(sha256([record.companyId, record.alertId]), 'hex');
  let suffix = '';
  for (let i = 0; i < 16; i++) suffix += CROCKFORD[digest[i] % 32];
  return `inc_${prefix}${suffix}`;
}

export function reportingClocks(companyDetails, slaTable, classifications = []) {
  const inScope = new Set(companyDetails.frameworksInScope || []);
  const wanted = new Set();
  if (inScope.has('cert-in-directions-2022')) wanted.add('cert-in-directions-2022');
  if (inScope.has('sebi-cscrf-2024')) wanted.add('sebi-cscrf-2024');
  if (inScope.has('rbi-cyber-tech-directions-2026')) wanted.add('rbi-cyber-tech-directions-2026');
  if (inScope.has('dpdp-rules-2025') && classifications.some((item) => item === 'pii' || item === 'spdi')) wanted.add('dpdp-rules-2025');
  return [...wanted].map((instrument) => {
    const topic = instrument === 'dpdp-rules-2025' ? 'breach-notification' : 'incident-reporting';
    const row = slaTable.entries.find((entry) => entry.instrument === instrument && entry.topic === topic && entry.severity === 'any');
    if (!row?.hours) throw new Error(`no reporting SLA for ${instrument}`);
    return { regulator: regulatorFor[instrument], instrument, slaTopic: topic, deadlineHours: row.hours };
  });
}

export function buildConfirmedArtifacts(record, { companyDetails, slaTable }) {
  if (record.status !== 'confirmation-pending' && record.status !== 'confirmed') throw new Error('case is not ready for incident publication');
  const { incidentId, category, affectedDataClassifications } = record.confirmation;
  const at = record.timeline.findLast((item) => item.action === 'prepare-confirmation')?.at;
  if (!at) throw new Error('confirmation timestamp is missing');
  const clocks = reportingClocks(companyDetails, slaTable, affectedDataClassifications);
  const incident = {
    schemaVersion: '1', kind: 'incident', id: incidentId, recordedAt: at, companyId: record.companyId,
    title: record.title, description: `Confirmed from Maxwell detection ${record.alert.recipeId} after analyst review of ${record.evidence.length} hashed evidence item(s).`,
    severity: record.severity, status: 'detected', category, dedupKey: `detection:${record.alertId}`,
    detectedAt: record.alert.detectedAt, regulatorReportRefs: clocks,
    affectedDataClassifications,
    timeline: record.timeline.map((item) => ({ at: item.at, note: `Investigation action: ${item.action}`, actor: { type: item.actor === 'maxwell-alert-intake' ? 'script' : 'human', id: item.actor } })),
    provenance: { harness: 'script', generatedAt: at, workflow: 'manual', agent: 'incident-investigation' },
  };
  const ocsf = {
    category_uid: 2, class_uid: 2005, activity_id: 1, type_uid: 200501,
    time: Date.parse(record.alert.detectedAt), severity_id: severityId[record.severity], status_id: 1,
    metadata: { version: '1.9.0', uid: incidentId, logged_time: Date.parse(at), product: { name: 'maxwell-incident-investigation', vendor_name: 'OnFinance', version: '1.0.0' }, labels: [`company:${record.companyId}`, `case:${record.caseId}`] },
    finding_info: { uid: sha256([record.alertId, incidentId]), title: record.title, desc: incident.description, analytic: { type_id: 1, type: 'Rule', name: record.alert.recipeId, uid: record.alert.recipeId, version: String(record.alert.recipeVersion) }, created_time: Date.parse(record.alert.detectedAt), first_seen_time: Date.parse(record.alert.windowStart), last_seen_time: Date.parse(record.alert.windowEnd), data_sources: [record.alert.source], types: [category] },
    finding_info_list: record.alert.evidenceEventIds.map((uid) => ({ uid, title: `Detection evidence ${uid}` })),
    assignee: { name: record.owner }, priority_id: priorityId[record.severity], verdict_id: 2,
    ticket: { uid: incidentId, type: 'Maxwell investigation' }, message: incident.description,
  };
  return { incident, ocsf };
}

export class LedgerIncidentWriter {
  constructor({ root = process.cwd(), spawn = spawnSync } = {}) { this.root = root; this.spawn = spawn; }
  append(record) {
    const ledgerPath = join(this.root, 'company-profile', record.companyId, 'soc', 'main.jsonl');
    try {
      const existing = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find((item) => item.id === record.id);
      if (existing) {
        if (sha256(existing) !== sha256(record)) throw new Error('incident id already exists with different content');
        return { appended: false };
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = this.spawn(process.execPath, ['.claude/scripts/soc/append.mjs', record.companyId, '-'], { cwd: this.root, input: JSON.stringify(record), encoding: 'utf8' });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'incident ledger append failed').trim());
    return { appended: true };
  }
}

export class ConfirmationCoordinator {
  constructor({ store, writer, companyDetails, slaTable, clock = () => Date.now() }) {
    this.store = store; this.writer = writer; this.companyDetails = companyDetails; this.slaTable = slaTable; this.clock = clock;
  }
  async confirm(companyId, caseId, { actor, expectedRevision, category, affectedDataClassifications = [] }) {
    let current = await this.store.getCase(companyId, caseId);
    if (!current) throw new Error('case not found');
    if (current.status === 'confirmed') return { case: current, ...buildConfirmedArtifacts(current, this), appended: false };
    if (current.status !== 'confirmation-pending') {
      const now = this.clock();
      const pending = applyCaseAction(current, { type: 'prepare-confirmation', actor, expectedRevision, category, affectedDataClassifications, incidentId: incidentIdFor(current) }, now);
      current = await this.store.saveChange(current, pending, { type: 'prepare-confirmation', actor }, now);
    }
    const artifacts = buildConfirmedArtifacts(current, this);
    const publication = this.writer.append(artifacts.incident);
    const now = this.clock();
    const confirmed = applyCaseAction(current, { type: 'complete-confirmation', actor, expectedRevision: current.revision }, now);
    const saved = await this.store.saveChange(current, confirmed, { type: 'complete-confirmation', actor }, now);
    return { case: saved, ...artifacts, appended: publication.appended };
  }
}

export function loadConfirmationContext(root, companyId) {
  return {
    companyDetails: JSON.parse(readFileSync(join(root, 'company-profile', companyId, 'details.json'), 'utf8')),
    slaTable: JSON.parse(readFileSync(join(root, '.claude/skills/regulatory-catalogs/references/sla-table.json'), 'utf8')),
  };
}
