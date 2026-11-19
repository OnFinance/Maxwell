import { createHash } from "node:crypto";
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { planArtexImport, readArtexAssessment } from '../soc/artex.mjs';

const header = 'ID,名称,类别,严重等级,状态,所属任务,发现时间,概述,流量证据数量,流量证据ID';
const csv = '\uFEFF' + header + '\r\n7,"Missing header, portal",Headers,medium,pending,Task,2026-10-01 12:00:00,"Ignored\nsummary",1,8\r\n';
const input = { csv, companyId: 'example-co', application: 'portal', source: 'internal', control: 'sebi-cscrf-2024:ID.RA.S1' };
test('rejects unsupported rows and requires an existing catalog control', () => {
  for (const change of [{ csv: 'id,title' }, { csv: csv.replace('medium','unassessed') }, { control: 'sebi-cscrf-2024:unknown' }, { companyId: '../bad' }]) {
    assert.throws(() => readArtexAssessment({ ...input, ...change }));
  }
});
test('CLI and snapshot imports share identity, schema validation and replay behavior', t => {
  const root = mkdtempSync(join(tmpdir(), 'artex-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'applications/portal'), { recursive: true });
  mkdirSync(join(root, 'company-profile/example-co'), { recursive: true });
  writeFileSync(join(root, 'applications/portal/README.md'), 'Portal');
  writeFileSync(join(root, 'company-profile/example-co/details.json'), '{}');
  writeFileSync(join(root, 'report.csv'), csv);
  const cli = (...extra) => {
    const p = spawnSync(process.execPath, [fileURLToPath(new URL('../soc/import-artex.mjs', import.meta.url)), '--company', input.companyId,
      '--app', input.application, '--source', input.source, '--control', input.control, '--file', 'report.csv', ...extra], { cwd: root, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout);
  };
  const ledger = join(root, 'company-profile/example-co/soc/main.jsonl');
  const assessment = readArtexAssessment(input);
  const preview = cli();
  assert.equal(existsSync(ledger), false);
  assert.deepEqual(preview.rows, planArtexImport(assessment, '').rows);
  assert.equal(cli('--confirm').written, 1);
  const entry = JSON.parse(readFileSync(ledger, 'utf8'));
  assert.equal(entry.regulatoryRefs[0].controlId, 'ID.RA.S1');
  assert.equal(entry.id, preview.rows[0].id);
  assert.equal(entry.provenance.inputsHash, preview.digest);
  assert.doesNotMatch(JSON.stringify(entry), /Ignored/);
  const legacy = { ...entry, fingerprint: 'f'.repeat(64), regulatoryRefs: [] };
  const replay = planArtexImport(assessment, JSON.stringify(legacy));
  assert.equal(replay.suffix, '');
  assert.equal(replay.rows[0].id, legacy.id);
  const accepted = { ...entry, status: 'risk-accepted', supersedes: entry.id, statusReason: 'Reviewed', resolvedAt: entry.recordedAt };
  const history = JSON.stringify(entry) + '\n' + JSON.stringify(accepted);
  writeFileSync(ledger, history);
  assert.equal(cli('--confirm').written, 0);
  assert.equal(planArtexImport(assessment, history).suffix, '');
  assert.equal(readFileSync(ledger, 'utf8'), history);
});

test('RBI worksheet attaches aggregate evidence and leaves regulatory decisions to a reviewer', () => {
  const script = fileURLToPath(new URL('../soc/rbi-artex-review.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [script], { input, encoding: 'utf8' });
  for (const [report, count] of [[csv, 1], [header, 0]]) {
    const result = run(report);
    assert.equal(result.status, 0, result.stderr);
    const worksheet = JSON.parse(result.stdout);
    assert.equal(worksheet.findingCount, count);
    assert.deepEqual(worksheet.severityCounts, count ? { medium: 1 } : {});
    assert.equal(worksheet.reportSha256, createHash('sha256').update(report).digest('hex'));
    assert.ok(worksheet.checklist.length > 0);
    assert.ok(worksheet.checklist.every(item => item.status === 'needs-review' && !item.evidenceReferences.length));
    assert.doesNotMatch(result.stdout, /Missing header, portal|Ignored/);
  }
  for (const bad of ['unexpected header', Buffer.alloc(512 * 1024 + 1), Buffer.from([255])]) {
    const result = run(bad);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});
