import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextProblems } from '../lib/context-refs.mjs';
import { WORKSPACE } from '../lib/toolchain.mjs';

const example = () => JSON.parse(readFileSync(join(WORKSPACE, '.claude/schemas/v1/company/context.schema.json'), 'utf8')).examples[0];

test('the schema example has no broken cross-references', () => {
  assert.deepEqual(contextProblems(example(), { registrationNos: new Set(['INZ000123456', 'IN-DP-123-2016']), appIds: new Set(['trading-core']) }), []);
});

test('dangling ids, unpaired questionnaires, foreign registrations and a wrong status are reported', () => {
  const doc = example();
  doc.licenses[0].processIds.push('ghost');
  doc.questionnaires[1].questions[0].yields.push({ type: 'platform', id: 'nowhere' });
  doc.obligations.push({ obligationId: 'orphan', title: 'Orphan', regulator: 'RBI', source: { type: 'statute', ref: 'x' }, questionnaireId: 'q-mca' });
  doc.status = 'complete';
  const problems = contextProblems(doc, { registrationNos: new Set(['INZ000123456']), appIds: new Set() });
  for (const re of [/unknown process 'ghost'/, /unknown platform 'nowhere'/, /orphan.*exactly one questionnaire/, /IN-DP-123-2016.*not a details\.json/, /no applications\/trading-core/, /complete but 1 question/]) {
    assert.ok(problems.some((p) => re.test(p)), `expected ${re}: ${problems.join(' | ')}`);
  }
});

test('answer.mjs records a human answer from stdin and flips the status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxwell-ctx-'));
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    symlinkSync(join(WORKSPACE, '.claude/schemas'), join(dir, '.claude/schemas'));
    mkdirSync(join(dir, 'company-profile/zenith-securities'), { recursive: true });
    const doc = example();
    writeFileSync(join(dir, 'company-profile/zenith-securities/context.json'), JSON.stringify(doc));
    const run = (args, input) => spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/ctx/answer.mjs'), ...args], { cwd: dir, input, encoding: 'utf8' });
    const r = run(['zenith-securities', 'q-sebi-broker-2', '--now', '2026-09-15T10:00:00Z'], 'Yes, designated a QSB in the FY26 SEBI list.\n');
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(readFileSync(join(dir, 'company-profile/zenith-securities/context.json'), 'utf8'));
    const q = after.questionnaires[1].questions[1];
    assert.equal(q.status, 'answered');
    assert.equal(q.answeredBy, 'human');
    assert.equal(q.answer, 'Yes, designated a QSB in the FY26 SEBI list.');
    assert.equal(after.status, 'complete');
    assert.equal(after.provenance.agent, 'ctx/answer');
    assert.equal(run(['zenith-securities', 'q-nope'], 'x').status, 3);
    assert.equal(run(['zenith-securities', 'q-sebi-broker-1'], '').status, 2, 'an empty answer is refused');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
