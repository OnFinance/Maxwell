#!/usr/bin/env node
// Records a human's answer to an open question in company-profile/<company_id>/context.json.
// Usage: answer.mjs <company_id> <question_id> [--not-applicable] [--reason "<why>"] [--session <id>]
//        the answer text is read from stdin (so it never appears in a shell history or a transcript argument).
// The next refresh-ctx run keeps human answers verbatim and derives their yields. Exit 0 ok, 2 usage, 3 not found.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildAjv, getValidator, formatErrors } from '../lib/schemas.mjs';
import { contextProblems } from '../lib/context-refs.mjs';

const SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/company/context.schema.json';
const fail = (code, msg) => { process.stderr.write(`${msg}\n`); process.exit(code); };

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { 'not-applicable': { type: 'boolean' }, reason: { type: 'string' }, session: { type: 'string' }, now: { type: 'string' } } });
} catch (err) { fail(2, err.message); }
const { values: flags, positionals: [companyId, questionId] } = parsed;
if (!companyId || !questionId) fail(2, 'usage: answer.mjs <company_id> <question_id> [--not-applicable] [--reason <why>] < answer.txt');
const path = `company-profile/${companyId}/context.json`;
if (!existsSync(path)) fail(3, `${path} does not exist; run /refresh-ctx ${companyId} first`);
const doc = JSON.parse(readFileSync(path, 'utf8'));
const question = (doc.questionnaires || []).flatMap((q) => q.questions || []).find((q) => q.questionId === questionId);
if (!question) fail(3, `question ${questionId} is not in ${path}`);
const now = flags.now || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

if (flags['not-applicable']) {
  question.status = 'not-applicable';
  question.reason = flags.reason || 'marked not applicable by a human';
  delete question.answer; delete question.answeredBy; delete question.confidence; delete question.evidence; delete question.answeredAt;
} else {
  const answer = readFileSync(0, 'utf8').trim();
  if (!answer) fail(2, 'the answer is read from stdin and must not be empty');
  Object.assign(question, { answer, status: 'answered', answeredBy: 'human', confidence: 'high', evidence: [], answeredAt: now });
  delete question.reason;
}
const open = (doc.questionnaires || []).flatMap((q) => q.questions || []).filter((q) => q.status === 'open').length;
doc.status = open ? 'in_progress' : 'complete';
doc.provenance = { ...doc.provenance, harness: 'human', generatedAt: now, ...(flags.session ? { sessionId: flags.session } : {}), workflow: 'manual', agent: 'ctx/answer' };

const validate = getValidator(buildAjv().ajv, SCHEMA);
if (!validate(doc)) fail(2, `the updated context would not match its schema:\n${formatErrors(validate.errors)}`);
const problems = contextProblems(doc);
if (problems.length) fail(2, `the updated context has broken references:\n- ${problems.join('\n- ')}`);
writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
console.log(JSON.stringify({ written: path, questionId, status: question.status, openQuestions: open, contextStatus: doc.status }, null, 2));
