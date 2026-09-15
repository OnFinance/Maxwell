// Cross-reference checks for company-profile/<c>/context.json that JSON Schema cannot express: every local id a
// record points at exists, obligations and questionnaires pair one to one, licences repeat a registration number
// from details.json, platforms name real applications, and status agrees with the open questions.
export function contextProblems(doc, { registrationNos = null, appIds = null } = {}) {
  const problems = [];
  const ids = (list, key) => new Set((list || []).map((x) => x[key]));
  const units = ids(doc.businessUnits, 'unitId');
  const licenses = ids(doc.licenses, 'licenseId');
  const obligations = ids(doc.obligations, 'obligationId');
  const questionnaires = ids(doc.questionnaires, 'questionnaireId');
  const processes = ids(doc.processes, 'processId');
  const offerings = ids(doc.offerings, 'offeringId');
  const segments = ids(doc.customerSegments, 'segmentId');
  const platforms = ids(doc.platforms, 'platformId');
  const byType = { process: processes, offering: offerings, segment: segments, platform: platforms };
  const check = (owner, field, list, set, what) => { for (const id of list || []) if (!set.has(id)) problems.push(`${owner}.${field} names unknown ${what} '${id}'`); };
  const dupes = (list, key, what) => { const seen = new Set(); for (const x of list || []) { if (seen.has(x[key])) problems.push(`duplicate ${what} id '${x[key]}'`); seen.add(x[key]); } };
  dupes(doc.businessUnits, 'unitId', 'business unit'); dupes(doc.licenses, 'licenseId', 'license'); dupes(doc.obligations, 'obligationId', 'obligation');
  dupes(doc.questionnaires, 'questionnaireId', 'questionnaire'); dupes(doc.processes, 'processId', 'process'); dupes(doc.offerings, 'offeringId', 'offering');
  dupes(doc.customerSegments, 'segmentId', 'segment'); dupes(doc.platforms, 'platformId', 'platform');
  for (const u of doc.businessUnits || []) {
    const o = `businessUnits[${u.unitId}]`;
    check(o, 'licenseIds', u.licenseIds, licenses, 'license'); check(o, 'obligationIds', u.obligationIds, obligations, 'obligation'); check(o, 'processIds', u.processIds, processes, 'process');
    if (u.publiclyListed && !u.listing) problems.push(`${o} is publiclyListed but has no listing`);
  }
  for (const l of doc.licenses || []) {
    const o = `licenses[${l.licenseId}]`;
    if (!units.has(l.unitId)) problems.push(`${o}.unitId names unknown business unit '${l.unitId}'`);
    check(o, 'obligationIds', l.obligationIds, obligations, 'obligation'); check(o, 'processIds', l.processIds, processes, 'process');
    check(o, 'offeringIds', l.offeringIds, offerings, 'offering'); check(o, 'platformIds', l.platformIds, platforms, 'platform');
    if (registrationNos && !registrationNos.has(l.registrationNo)) problems.push(`${o}.registrationNo '${l.registrationNo}' is not a details.json regulatoryRegistrations entry`);
  }
  const qByObligation = new Map();
  for (const q of doc.questionnaires || []) {
    if (!obligations.has(q.obligationId)) problems.push(`questionnaires[${q.questionnaireId}].obligationId names unknown obligation '${q.obligationId}'`);
    qByObligation.set(q.obligationId, (qByObligation.get(q.obligationId) || 0) + 1);
    const seenQ = new Set();
    for (const item of q.questions || []) {
      if (seenQ.has(item.questionId)) problems.push(`questionnaires[${q.questionnaireId}] repeats question id '${item.questionId}'`);
      seenQ.add(item.questionId);
      for (const y of item.yields || []) if (!byType[y.type].has(y.id)) problems.push(`question ${item.questionId} yields unknown ${y.type} '${y.id}'`);
      if (item.status === 'answered' && item.answeredBy === 'research' && !(item.evidence || []).length) problems.push(`question ${item.questionId} is answered by research without evidence`);
    }
  }
  for (const ob of doc.obligations || []) {
    if (!questionnaires.has(ob.questionnaireId)) problems.push(`obligations[${ob.obligationId}].questionnaireId names unknown questionnaire '${ob.questionnaireId}'`);
    else if (qByObligation.get(ob.obligationId) !== 1) problems.push(`obligations[${ob.obligationId}] must be raised by exactly one questionnaire (found ${qByObligation.get(ob.obligationId) || 0})`);
  }
  for (const p of doc.processes || []) {
    const o = `processes[${p.processId}]`;
    check(o, 'unitIds', p.unitIds, units, 'business unit'); check(o, 'licenseIds', p.licenseIds, licenses, 'license'); check(o, 'offeringIds', p.offeringIds, offerings, 'offering');
    check(o, 'segmentIds', p.segmentIds, segments, 'segment'); check(o, 'obligationIds', p.obligationIds, obligations, 'obligation');
  }
  for (const f of doc.offerings || []) {
    const o = `offerings[${f.offeringId}]`;
    if (!licenses.has(f.licenseId)) problems.push(`${o}.licenseId names unknown license '${f.licenseId}'`);
    check(o, 'segmentIds', f.segmentIds, segments, 'segment'); check(o, 'processIds', f.processIds, processes, 'process');
  }
  for (const s of doc.customerSegments || []) check(`customerSegments[${s.segmentId}]`, 'processIds', s.processIds, processes, 'process');
  for (const p of doc.platforms || []) {
    const o = `platforms[${p.platformId}]`;
    check(o, 'licenseIds', p.licenseIds, licenses, 'license');
    if (appIds) for (const a of p.appIds || []) if (!appIds.has(a)) problems.push(`${o}.appIds names no applications/${a}/ directory`);
  }
  const open = (doc.questionnaires || []).flatMap((q) => q.questions || []).filter((x) => x.status === 'open').length;
  if (doc.status === 'complete' && open) problems.push(`status is complete but ${open} question(s) are open`);
  if (doc.status === 'in_progress' && !open) problems.push('status is in_progress but no question is open');
  return problems;
}
