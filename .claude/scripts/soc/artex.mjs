// Import completed RuoJi6/ARTEX v0.3.30 Findings CSV exports.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { prepareLedgerAppend, RECORD_SCHEMA } from '../lib/ledger.mjs';
import { buildAjv, getValidator } from '../lib/schemas.mjs';
import { SLUG } from '../lib/company-catalogs.mjs';

export class ArtexError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
const header = ["ID", "名称", "类别", "严重等级", "状态", "所属任务", "发现时间", "概述", "流量证据数量", "流量证据ID"];
const severities = new Set(["critical", "high", "medium", "low", "info"]);

const hash = (value) => createHash("sha256").update(value).digest("hex");

export function readArtex(csv) {
  if (typeof csv !== "string" || Buffer.byteLength(csv) > 512 * 1024) throw new ArtexError("Choose an ARTEX findings CSV of at most 512 KiB.", 400);
  let records;
  try { records = parse(csv, { bom: true, skip_empty_lines: true, max_record_size: 65536 }); }
  catch { throw new ArtexError("Malformed ARTEX CSV. Check quoting and column counts.", 422); }
  if (JSON.stringify(records.shift()) !== JSON.stringify(header)) throw new ArtexError("Expected the RuoJi6 ARTEX v0.3.30 findings CSV header.", 422);
  if (records.length > 500) throw new ArtexError("Select at most 500 findings per export.", 413);
  const seen = new Set();
  return records.map((row, index) => {
    const [externalId, rawTitle, , severity, , , localTime, , count] = row;
    const title = rawTitle?.trim();
    if (!externalId || !/^(case:)?[1-9][0-9]{0,18}$/.test(externalId) || seen.has(externalId)) throw new ArtexError(`Row ${index + 2} has an invalid or duplicate ARTEX ID.`, 422);
    if (!title || title.length > 200 || /[\u0000-\u001f]/.test(title)) throw new ArtexError(`Row ${index + 2} needs a one-line title of at most 200 characters.`, 422);
    if (!severity || !severities.has(severity)) throw new ArtexError(`Row ${index + 2} needs an assessed severity. Review its rating in ARTEX and export again.`, 422);
    if (!count || !/^\d{1,9}$/.test(count) || !localTime || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(localTime)) throw new ArtexError(`Row ${index + 2} has an invalid evidence count or discovery time.`, 422);
    seen.add(externalId);
    // Free-form summaries, task descriptions and traffic are intentionally excluded.
    return { externalId, title, severity, evidenceCount: Number(count), localTime };
  });
}

/** Maxwell finding IDs use 128 bits encoded in 26 Crockford base32 characters. */
function findingId(fingerprint) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let bits = BigInt("0x" + fingerprint.slice(0, 32));
  let suffix = "";
  for (let i = 0; i < 26; i++) {
    suffix = alphabet[Number(bits & 31n)] + suffix;
    bits >>= 5n;
  }
  return "fnd_" + suffix;
}

// Resolve a reviewer-selected control against this release's catalog, independently of process.cwd().
function controlReference(key) {
  const match = typeof key === 'string' && /^([a-z0-9-]+):([a-zA-Z0-9][a-zA-Z0-9_.()-]{0,63})$/.exec(key);
  if (!match) throw new ArtexError('Choose the applicable control as instrument:control-id.');
  const [, instrument, controlId] = match;
  const url = new URL('../../skills/regulatory-catalogs/references/catalogs/' + instrument + '.catalog.json', import.meta.url);
  if (existsSync(url)) {
    const catalog = JSON.parse(readFileSync(url, 'utf8'));
    if (catalog.groups.some(group => group.controls.some(control => control.id === controlId))) {
      return { regulator: catalog.regulator, instrument, controlId };
    }
  }
  throw new ArtexError('Unknown control in the Maxwell shared catalogs.');
}

let validator;
export function ledgerValidator() {
  validator ??= getValidator(buildAjv({ root: fileURLToPath(new URL('../../schemas/', import.meta.url)) }).ajv, RECORD_SCHEMA);
  return validator;
}

export function readArtexAssessment({ csv, companyId, application, source, control }) {
  if (typeof companyId !== 'string' || !SLUG.test(companyId) || typeof application !== 'string' || !SLUG.test(application) ||
      typeof source !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(source)) throw new ArtexError('Invalid company, application or ARTEX source name.', 400);
  const rows = readArtex(csv);
  return { rows, companyId, application, source, regulatoryRef: controlReference(control), digest: hash(csv) };
}

export function planArtexImport(assessment, ledger, { actor = 'maxwell-cli', root } = {}) {
  const { companyId, application, source, regulatoryRef, digest } = assessment;
  const fingerprints = new Map();
  const previousHostedIds = new Map();
  for (const line of ledger.split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.kind !== 'finding' || record.companyId !== companyId) continue;
    fingerprints.set(record.fingerprint, record.id);
    // The first hosted adapter used its database org ID in the hash. An exported
    // workspace still carries the exact source name and external ID in that adapter's provenance.
    const externalId = record.source?.ruleId;
    if (record.source?.tool === 'ARTEX' && record.source.kind === 'manual' && record.target?.appId === application &&
        typeof record.description === 'string' && record.description.startsWith(`ARTEX source ${source}, finding ${externalId}. Evidence references: `)) {
      previousHostedIds.set(externalId, record.id);
    }
  }
  const at = new Date().toISOString();
  const records = [];
  const rows = assessment.rows.map(row => {
    const fingerprint = hash(JSON.stringify(['artex/v1', companyId, application, source, row.externalId]));
    const prior = fingerprints.get(fingerprint) ?? previousHostedIds.get(row.externalId);
    const id = prior ?? findingId(fingerprint);
    if (!prior) records.push({
      schemaVersion: '1', kind: 'finding', companyId, id, title: row.title,
      recordedAt: at, firstSeenAt: at, lastSeenAt: at, severity: row.severity, status: 'open', regulatoryRefs: [regulatoryRef],
      target: { type: 'application', appId: application }, source: { kind: 'manual', tool: 'ARTEX', ruleId: row.externalId },
      description: `ARTEX source ${source}, finding ${row.externalId}. Evidence references: ${row.evidenceCount}. Source discovery time: ${row.localTime} (timezone unspecified). Report SHA-256: ${digest}.`,
      fingerprint, provenance: { harness: 'human', generatedAt: at, agent: actor, inputsHash: digest }
    });
    return { id, ...row, action: prior ? 'existing' : 'create' };
  });
  const { suffix, problems } = prepareLedgerAppend(companyId, records, ledger, { root, validate: ledgerValidator() });
  if (problems.length) throw new ArtexError('Ledger validation failed: ' + problems.join('\n'));
  return { rows, records, suffix };
}
