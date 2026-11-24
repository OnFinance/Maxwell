// runtime-probe-redteam: Autonomous red-team assessment via ARTEX.
// ARTEX integration is not yet operational. This entry point returns an explicit unavailable
// result so callers can detect the gap and plan accordingly.
// Full implementation is preserved at:
//   .claude/skills/runtime-probe-rules-of-engagement/references/runtime-probe-redteam.impl.js
//
// args: { companyId (required), appIds?, envIds?, mode?, goals?, authorization, dryRun?, now?, sessionId?, runId? }

export const meta = {
  name: 'runtime-probe-redteam',
  description: 'ARTEX autonomous red-team assessment (not yet operational — returns unavailable)',
  phases: [
    { title: 'Check', detail: 'Confirm ARTEX integration prerequisites: binary, PostgreSQL, recording proxy, sandbox credentials' },
    { title: 'Authorize', detail: 'Validate written authorization from CISO/CTO/Board with scope, validUntil and legal basis' },
    { title: 'Configure', detail: 'Translate Maxwell applications and environments into ARTEX task goals and prohibited-action rules' },
    { title: 'Execute', detail: 'Spawn ARTEX with configured scope; monitor guard interventions; collect dual-graph exports' },
    { title: 'Reconcile', detail: 'Map ARTEX findings to Maxwell SOC ledger via artex-reconciler with regulatory citations' },
    { title: 'Write', detail: 'Append attack paths and exploitability-confirmed findings; version the ledger' },
  ],
};

const companyId = args && args.companyId;
if (!companyId) throw new Error('args.companyId is required');

const companyCatalogs = (args && Array.isArray(args.companyCatalogs) ? args.companyCatalogs : []).filter((c) => companyId && c
  && /^co:[a-z0-9][a-z0-9-]{1,62}:[a-z0-9][a-z0-9-]{1,62}$/.test(c.instrumentId) && c.instrumentId.indexOf('co:' + companyId + ':') === 0
  && c.file === 'company-profile/' + companyId + '/catalogs/' + c.instrumentId.slice(companyId.length + 4) + '.catalog.json');
const COMPANY_CATALOG_RULE = !companyCatalogs.length ? '' : '\n\nCompany catalogs: besides the shared catalogs, company ' + companyId
  + ' has its own catalogs, which apply to ' + companyId + ' only: ' + companyCatalogs.map((c) => c.instrumentId + ' (' + c.file + ')').join(', ')
  + '. Follow section 8 of .claude/skills/regulatory-catalogs/SKILL.md. Treat each as an instrument in scope for ' + companyId
  + ' (the instruments.json registry, frameworksInScope and the instrument-level entity filters do not apply to it; each control\'s own applicability does): include its controls wherever you select applicable instruments or controls, and key and cite them exactly like shared controls - ledger control id \'<instrumentId>:<controlId>\', regulatoryRef {regulator: the catalog\'s regulator, instrument: the instrumentId, controlId}. Severity comes from the control\'s defaultSeverity; the SLA from its slaDays (slaBasis.instrument = the instrumentId), else the sla-table defaults. Cite the most specific shared instrument first when one covers the gap and the company control after it; a company control comes first only when no shared control covers the gap. These ids are valid for ' + companyId
  + ': never refute or drop a mapping only because it cites one of them. Never cite any other \'co:\' id, and label these controls company-specific wherever you report controls.';
const ask = (prompt, opts) => agent(typeof prompt === 'string' ? prompt + COMPANY_CATALOG_RULE : prompt, opts);

// ARTEX prerequisites are not available. Report the gap so the caller knows why no probe ran.
const prereqNote = await ask(
  'Record that runtime-probe-redteam was invoked but ARTEX prerequisites are not yet configured for ' + companyId
  + '. Do not write anything to the ledger. Return { noted: true }.',
  { task: 'acknowledge-unavailable', dryRun: true }
);

return {
  companyId,
  workflow: 'runtime-probe-redteam',
  status: 'unavailable',
  reason: 'ARTEX integration is not yet configured. Prerequisites needed: ARTEX binary, PostgreSQL graph store, recording proxy, sandbox executor, and written authorization from CISO/CTO/Board. See .claude/skills/runtime-probe-rules-of-engagement/references/runtime-probe-redteam.impl.js for the full implementation.',
  prerequisites: [
    'ARTEX binary at configured path (default /opt/artex/artex)',
    'PostgreSQL instance for ARTEX graph storage',
    'Recording proxy for HAR capture',
    'Sandbox executor configured via /connect-sandbox',
    'Written authorization with CISO/CTO/Board role, validUntil, and legal basis reference',
  ],
  prereqNote,
  sessionIds: args && args.sessionId ? [args.sessionId] : [],
};
