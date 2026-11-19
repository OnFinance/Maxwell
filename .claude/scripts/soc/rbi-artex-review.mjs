// Prepare a reviewer worksheet from one completed report. stdin and stdout are the only data channels.
import { createHash } from 'node:crypto';
import { readArtex } from './artex-csv.mjs';

const checklist = [
  ['5, 6.3–6.5', 'Document applicant eligibility, exclusions, fitness, readiness and the reason for testing.'],
  ['6.2', 'Record applicable statutory, privacy, data localisation, payment security and KYC/AML/CFT obligations and any written relaxation.'],
  ['6.5.2', 'Attach the proof of concept, test scenarios, expected outcomes, risks, mitigations and reporting schedule.'],
  ['6.7', 'Record test dates, participant eligibility and limits on participants, transactions and losses.'],
  ['6.8', 'Attach consumer disclosures, consent and withdrawal arrangements, compensation terms and evidence of indemnity cover.'],
  ['7.2', 'Record test design, agreed metrics, fortnightly progress reports and the final evaluation.'],
  ['6.6, 8', 'Review exit criteria, customer notification, outstanding obligations and the transition plan.']
];

try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw new Error('Report exceeds 512 KiB.');
    chunks.push(chunk);
  }
  const report = Buffer.concat(chunks);
  const rows = readArtex(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(report));
  const severityCounts = {};
  for (const row of rows) severityCounts[row.severity] = (severityCounts[row.severity] ?? 0) + 1;
  console.log(JSON.stringify({
    template: 'rbi-regulatory-sandbox-2024-v1',
    framework: 'https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=13375&Mode=0',
    reportSha256: createHash('sha256').update(report).digest('hex'),
    findingCount: rows.length, severityCounts,
    checklist: checklist.map(([section, review]) => ({ section, review, status: 'needs-review', evidenceReferences: [] }))
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
