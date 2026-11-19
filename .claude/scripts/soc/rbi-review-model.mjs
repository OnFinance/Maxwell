import { createHash } from 'node:crypto';

const requirements = [
  ['eligibility', '5, 6.3–6.5', 'Document applicant eligibility, exclusions, fitness, readiness and the reason for testing.'],
  ['safeguards', '6.2', 'Record applicable statutory, privacy, data localisation, payment security and KYC/AML/CFT obligations and any written relaxation.'],
  ['design', '6.5.2', 'Attach the proof of concept, test scenarios, expected outcomes, risks, mitigations and reporting schedule.'],
  ['limits', '6.7', 'Record test dates, participant eligibility and limits on participants, transactions and losses.'],
  ['consumers', '6.8', 'Attach consumer disclosures, consent and withdrawal arrangements, compensation terms and evidence of indemnity cover.'],
  ['reporting', '7.2', 'Record test design, agreed metrics, fortnightly progress reports and the final evaluation.'],
  ['exit', '6.6, 8', 'Review exit criteria, customer notification, outstanding obligations and the transition plan.']
];

// These search terms locate passages for the human reviewer. A hit has no regulatory weight.
const topics = {
  eligibility: ['eligibility', 'incorporation', 'net worth'],
  safeguards: ['privacy', 'localisation', 'kyc', 'aml'],
  design: ['test scenario', 'expected outcome', 'mitigation'],
  limits: ['participant limit', 'transaction ceiling', 'loss cap'],
  consumers: ['consent', 'indemnity', 'compensation'],
  reporting: ['fortnightly', 'progress report', 'test result'],
  exit: ['exit', 'transition', 'outstanding obligation']
};

export function createWorksheet(reportSha256, rows) {
  const severityCounts = {};
  for (const row of rows) severityCounts[row.severity] = (severityCounts[row.severity] ?? 0) + 1;
  return {
    template: 'rbi-regulatory-sandbox-2024-v1',
    framework: 'https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=13375&Mode=0',
    reportSha256, findingCount: rows.length, severityCounts,
    checklist: requirements.map(([id, section, review]) => ({
      id, section, review, status: 'needs-review', evidenceReferences: [], rationale: '',
      assessment: 'missing-evidence'
    }))
  };
}

// All input strings are inert metadata. Evidence contents and external URLs are never executed or fetched.
export function reviewEvidence(previous, edits, finalize) {
  if (!Array.isArray(edits) || edits.length !== previous.checklist.length) throw new Error('Supply every checklist item.');
  const checklist = previous.checklist.map((item, index) => {
    const edit = edits[index];
    if (edit?.id !== item.id || !['needs-review', 'supported', 'gap', 'not-applicable'].includes(edit.status)) throw new Error('Invalid checklist decision.');
    if (typeof edit.rationale !== 'string' || edit.rationale.length > 1000) throw new Error('Limit each rationale to 1000 characters.');
    const rationale = edit.rationale.trim();
    if (!Array.isArray(edit.evidenceReferences) || edit.evidenceReferences.length > 8) throw new Error('Attach at most eight references per item.');
    const evidenceReferences = edit.evidenceReferences.map(ref => {
      if (!ref || typeof ref.name !== 'string' || !ref.name.trim() || ref.name.length > 160 || /[\u0000-\u001f]/u.test(ref.name) ||
          typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('Invalid evidence reference.');
      const reference = { name: ref.name.trim(), sha256: ref.sha256 };
      if (ref.text === undefined) return reference;
      if (typeof ref.text !== 'string' || Buffer.byteLength(ref.text) > 4096 ||
          createHash('sha256').update(ref.text).digest('hex') !== ref.sha256) throw new Error('Invalid text evidence or digest.');
      const passage = ref.text.split(/\r?\n/).find(line => topics[item.id].some(term => line.toLowerCase().includes(term)));
      return { ...reference, text: ref.text, passage: passage?.slice(0, 240) ?? '' };
    });
    if (edit.status === 'supported' && !evidenceReferences.length) throw new Error('Attach evidence for each supported decision.');
    if (edit.status !== 'needs-review' && !rationale) throw new Error('Explain each reviewer decision.');
    if (finalize && edit.status === 'needs-review') throw new Error('Decide every item before signing off.');
    return { ...item, status: edit.status, rationale, evidenceReferences,
      assessment: evidenceReferences.some(ref => ref.passage) ? 'candidate-passage-for-review' :
        evidenceReferences.length ? 'reference-present-human-verification-required' : 'missing-evidence' };
  });
  return { ...previous, checklist };
}
