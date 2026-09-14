// runtime-probe-network-perimeter: read-only runtime probe of a company's network perimeter using the network-prober agent.
// Enumerates exposure from configuration (cloud and Kubernetes describe calls) and confirms it only with SAFE connectivity
// checks against the env record's declared urls[]: per host at most 7 HEAD/GET requests ("/" over https and http, one CORS
// HEAD, the four well-known paths) and 3 openssl s_client handshakes. No port scan, sweep, fuzzing, brute force,
// authentication, redirect following or off-list host, ever.
// Scout: every applications/*/env/*.json. Refute: evidence + regulatory-mapping lenses; high/critical findings, risks and
// incidents add the exploitability lens and need all three; assessed observations face the evidence lens in one batch per
// environment; rules-of-engagement section 7 safety records are written directly.
// args: { companyId (required), appIds?: string[], envIds?: string[] (REQUIRED to touch any prod/dr tier environment: named
//         explicitly, never inferred), dryRun?: boolean, now?: RFC 3339 UTC 'Z' string (the run timestamp for windows,
//         freezes and records; when absent the scout reads `date -u` exactly once), sessionId?: string, runId?: string }
// Returns { companyId, workflow, dryRun, now, sessionId, targets, observations, findings, risks, incidents, evidenceRequests,
//           cisoAlerts, roeViolations, probeNotes, skipped, sessionIds, ... }.
export const meta = {
  name: 'runtime-probe-network-perimeter',
  description: 'Read-only perimeter probe: exposure vs declared URLs, security groups, admin planes, WAF, TLS, headers, CORS, DNS, NetworkPolicies and egress; safe connectivity checks only, never a scan.',
  phases: [
    { title: 'Scout', detail: 'network-prober in scout mode lists every (app, env) from applications/*/env/*.json with exposure and declared urls and fixes one run timestamp; the workflow records every failed prod-gating, readOnly, method, credential, freeze and window check as a blocker and flags internet or partner environments without urls' },
    { title: 'Probe', detail: 'network-prober runs its NET-01..NET-12 checks from configuration plus a fixed per-host budget of HEAD/GET requests and TLS handshakes against declared urls only, within the rate limit, or plans them in dry-run and blocked modes' },
    { title: 'Refute', detail: 'refuter attacks each candidate through the evidence and regulatory-mapping lenses; high/critical findings, risks and incidents also face the exploitability lens and must survive all three; assessed observations are batch-checked through the evidence lens' },
    { title: 'Dedup', detail: 'Barrier: merge surviving findings by fingerprint, incidents by dedupKey and observations by control and subject across every environment; prefix blocked and dry-run observations; log every merge' },
    { title: 'Write', detail: 'soc-ledger-keeper appends controls, observations, findings (soc-ledger fingerprint reconciliation), risks and incidents through soc/append.mjs one environment at a time, then writes soc/versions/commit_<n>.diff with soc/version.mjs' },
    { title: 'Summary', detail: 'report-writer refreshes the control-summary and open-findings sections of summary.md, plus risks and incidents when this run wrote any, and returns counts' },
  ],
};

const WORKFLOW = 'runtime-probe-network-perimeter';
const PROBE_AGENT = 'network-prober';
const CHECK_PREFIX = 'NET';
const ROE = '.claude/skills/runtime-probe-rules-of-engagement/SKILL.md';
const AGENT_DEF = '.claude/agents/' + PROBE_AGENT + '.md';
const CRED_METHODS = ['kubeconfig', 'ssh', 'docker-socket', 'cloud-api'];
const PROD_TIERS = ['prod', 'dr'];
const SEV_ORDER = ['info', 'low', 'medium', 'high', 'critical'];
const RFC3339Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Rules-of-engagement section 7 read-write credential rule. The RoE names it ROE-RW-CREDENTIAL; some prober definitions
// still call it probe-credential-not-read-only. RW_RULE (workflow config) is the id the prober's own section 8 uses today;
// either id is recognised as the section 7 safety finding.
const RW_RULE_IDS = ['ROE-RW-CREDENTIAL', 'probe-credential-not-read-only'];
const UNREDACTABLE_RISK_TITLE = 'Probe exposed to unredactable sensitive data';
const ASSESSED_RESULTS = ['satisfied', 'not-satisfied', 'partial'];

const companyId = args && args.companyId;
if (!companyId) throw new Error('args.companyId is required (company-profile/<companyId>)');
const dryRun = Boolean(args && args.dryRun);
const argNow = (args && args.now) || null;
if (argNow && !RFC3339Z.test(argNow)) throw new Error('args.now must be RFC 3339 UTC with a trailing Z, got ' + argNow);
const argSessionId = (args && args.sessionId) || null;
const runId = (args && args.runId) || null;
const appFilter = args && Array.isArray(args.appIds) && args.appIds.length ? args.appIds : null;
const envFilter = args && Array.isArray(args.envIds) && args.envIds.length ? args.envIds : null;
const skipped = [];
const evidenceRequests = [];
const cisoAlerts = [];
const roeViolations = [];
const probeNotes = [];
const sessionIds = new Set(argSessionId ? [argSessionId] : []);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };
const skip = (entry) => { skipped.push(entry); log('skipped ' + [entry.appId, entry.envId].filter(Boolean).join('/') + (entry.appId || entry.envId ? ': ' : '') + entry.reason); };

// ---- Workflow-specific configuration -----------------------------------------------------------------------------
const DOMAIN = 'network-perimeter';
const ROE_SECTION = 'network-perimeter';
const BASE_TAGS = ['runtime-probe', 'network-perimeter'];
const BASE_LENSES = ['evidence', 'regulatory-mapping'];
const SEVERE_LENSES = ['evidence', 'regulatory-mapping', 'exploitability'];
const PROBE_METHODS = ['cloud-api', 'kubeconfig', 'http-only'];
const RW_RULE = 'probe-credential-not-read-only'; // as network-prober section 8 names it
const RW_CHECK_ID = 'NET-RW';
const ALLOWED_TIERS = null; // cross-cutting probe: inherits the tier rule of the environment it touches (prod gating applies)
const LOCATION_EXAMPLES = 'host/<hostname>, sg/<group id>/<protocol>-<port>, alb/<name>/<port>, zone/<zone name>/<record name>, netpol/<namespace>, vpc/<vpc id>';
const RULE_EXAMPLES = '"perimeter-open-ingress-non-https", "perimeter-weak-tls", "perimeter-missing-security-headers"';
const EXTRA_READS = '';
const regmapHint = () => 'For perimeter gaps cite catalog ids, most specific first: for SEBI REs sebi-cscrf-2024 PR.AA.S2 (network segregation and segmentation) and PR.IP.S1 (hardening, port whitelisting) for NET-01, NET-02, NET-09, NET-10 and NET-12; PR.AA.S12 (remote access) and PR.AA.S7 (MFA from untrusted networks) for NET-03; PR.AA.S15 and PR.AA.S17 (network and API access control) with DE.CM.S2 for NET-04 and NET-07; PR.DS.S1 (encryption in transit) for NET-05 and NET-06; ID.AM.S1 and ID.AM.S3 (inventory, no shadow IT) for NET-01 and NET-08; RS.AN.S1 (externally disclosed vulnerabilities) for NET-11. For RBI REs rbi-cyber-tech-directions-2026 network-security, perimeter, remote-access, cryptography and DDoS clauses (no catalog file: follow network-prober section 4), rbi-digital-payment-security-2021 for payment channels. cert-in-directions-2022 Dir-iv for flow-log retention, Annex-II for the point of contact and Annex-I.iv / Annex-I.vi for takeover outcomes; dpdp-rules-2025 6(1)(a) for personal data in transit; pci-dss-4.0.1 only when dataClassification contains cardholder. Then global mappings: nist-csf-2.0 PR.IR-01 / PR.DS-02, cis-controls-8.1, nist-800-53-r5 SC-7 / AC-17, owasp-asvs-5.0. PR.IR and PR.PS are NIST CSF 2.0 ids: under sebi-cscrf-2024 they are mapping errors.';
// http-only environments without a declared limit are paced at 10/min (network-prober section 1); everything else 30/min.
const defaultRateFor = (t) => (t.method === 'http-only' ? 10 : 30);
const targetContext = (t) => 'Declared urls (the COMPLETE set of hosts you may contact): ' + ((t.urls || []).length ? t.urls.join(', ') : 'none') + '. ' + (t.noUrls ? 'NO_URLS_DECLARED: exposure is ' + t.exposure + ' but urls[] is empty, so run NO connectivity check (no curl, no openssl) and do configuration checks only; NET-01 reports every public listener as undeclared. ' : '') + (t.method === 'http-only' ? 'Method http-only: no credential exists and none may be resolved; run only the unauthenticated connectivity checks (NET-05, NET-06, NET-07, NET-11) against the declared urls; every configuration check (NET-01 to NET-04, NET-08 to NET-10, NET-12) is inconclusive with an evidence request. ' : '');
const lensText = (t, c, lens) => lens === 'exploitability'
  ? 'Exploitability lens (network): confirm the exposure is real where it is deployed. The environment exposure is ' + (t.exposure || '?') + ' with declared urls ' + ((t.urls || []).join(', ') || 'none') + '; an internet-reachability claim must rest on configuration evidence (internet-facing scheme, public IP, 0.0.0.0/0 rule, public endpoint flag) or on a captured response from a declared url, never on inference from names or on traffic to a host outside urls[]. Check for a compensating control that neutralises the path (WAF in BLOCK mode, security group restricted by prefix list, VPN or identity-aware proxy with MFA in front of an admin plane, private kube API endpoint) in the evidence, the env record, sdlc/policy.json or an implemented and effective ledger control; check the observed value came from ' + t.envId + ' and not another tier. Refute or return correctedSeverity when the reachable attack surface is narrower than claimed (internal or isolated exposure, non-prod tier, admin port reachable only from corporate CIDRs).'
  : 'Lens ' + lens + ': apply the refuter checks for this lens from your agent definition.';
const CHECKS = () => 'NET-01 exposure vs declared urls (ruleId perimeter-undeclared-exposure): every internet-facing listener, public IP, alias and Ingress host maps to a declared url; '
  + 'NET-02 security groups and NACLs (perimeter-open-ingress-non-https): no 0.0.0.0/0 or ::/0 ingress except TCP 443 (80 only as redirect) on edge groups, no internet ingress on 22, 3389, 5432, 3306, 1433, 1521, 6379, 27017, 9200, 6443, 2379, 10250, data subnets deny by NACL; '
  + 'NET-03 admin planes behind VPN/MFA (perimeter-admin-plane-exposed): kube API private or restricted to corporate CIDRs, SSH, RDP and database ports only via VPN, Session Manager or an identity-aware proxy that enforces MFA (IdP MFA proof by evidence request); '
  + 'NET-04 WAF and DDoS (perimeter-waf-missing-or-counting): a WAF on every prod internet entry point blocking (not count-only) with a rate-based rule and logging to the SIEM, DDoS protection for payment and market-facing endpoints; '
  + 'NET-05 TLS versions, ciphers, certificates (perimeter-weak-tls): TLS 1.0/1.1 refused, TLS 1.2 AEAD or 1.3, a modern listener policy, certificate valid > 30 days with a complete chain and SAN covering every declared host, RSA >= 2048 or ECDSA, no SHA-1; '
  + 'NET-06 HSTS and security headers (perimeter-missing-security-headers): Strict-Transport-Security max-age >= 31536000 with includeSubDomains, CSP or frame-ancestors, nosniff, Referrer-Policy, no-store on API paths, no version-revealing Server or X-Powered-By, http answers 301/308 to https; '
  + 'NET-07 CORS and allowed hosts (perimeter-wildcard-cors-or-hosts): no wildcard or reflected origin (never with Allow-Credentials true) and no wildcard host on prod, allowed hosts equal urls[]; '
  + 'NET-08 DNS hygiene (perimeter-dns-dangling-or-unsigned): no dangling record, CAA limits issuance, DNSSEC on customer-facing zones, SPF and DMARC when the mail zone is in scope, from the DNS provider API only; '
  + 'NET-09 default-deny NetworkPolicies (perimeter-no-default-deny-netpol): default-deny ingress and egress with DNS-only egress to kube-system and narrow exceptions, no qa or prod application namespace without a policy; '
  + 'NET-10 egress controls and flow logs (perimeter-ungoverned-egress): no IGW route from workload subnets, egress via a governed gateway or allow-listed firewall, VPC endpoints for cloud services, flow logs on and retained >= 180 days in India; '
  + 'NET-11 well-known endpoints (perimeter-verbose-or-missing-wellknown): security.txt with Contact and a future Expires, health endpoints return 200 without stack traces, versions, hostnames or dependency URLs, robots.txt reveals no admin paths; '
  + 'NET-12 segmentation between tiers (perimeter-prod-peered-to-nonprod): prod data subnets private, prod not peered or routed to devtest, qa or sandbox VPCs, distinct management CIDRs. Use no other check ids.';
const EXTRA_PROHIBITIONS = () => 'never change a security group, listener, WAF rule, DNS record or NetworkPolicy; for ec2 describe-vpn-connections always pass the --query projection network-prober section 2 gives so CustomerGatewayConfiguration (pre-shared keys) never leaves the API; nothing of the SAFETY block below may be relaxed.';
const EXTRA_PROMPT = (t) => (t.mode !== 'blocked' && (t.urls || []).length && !t.noUrls
  ? (t.mode === 'dry-run' ? 'Plan the connectivity checks with exactly this budget and send nothing. ' : '') + 'SAFETY (absolute, on top of network-prober section 2 and rules-of-engagement section 2): you are not a scanner. Contact only the declared urls above. The complete per-host budget for this run is at most 7 HTTP requests and 3 TLS handshakes: (1) HEAD https://<host>/ ; (2) HEAD http://<host>/ (redirect check); (3) HEAD https://<host>/ with the single header Origin: https://maxwell-probe.invalid (CORS); (4) to (7) GET https://<host>/.well-known/security.txt, /health/live, /health/ready and /robots.txt; and `openssl s_client -connect <host>:443 -servername <host> -tls1_1 </dev/null`, then -tls1_2, then -tls1_3, once each. NET-06 reads its headers from requests 1, 2 and 4 to 7, NET-07 from request 3, NET-11 from 4 to 7 and NET-05 from the handshakes: never repeat a request to serve another check. curl form: `curl -sS -I -m 15 --retry 0 -A "maxwell-network-prober/1 (read-only compliance probe)" <url>` (-X GET instead of -I for 4 to 7). Never pass -L or --location: a 30x is recorded from its status and Location header, never followed. A client-side refusal for -tls1_1 (for example "no protocols available" because the local OpenSSL build cannot offer TLS 1.1) is not a server refusal: record that part of NET-05 as inconclusive. Never run nmap, masscan, nikto, sslscan, testssl, dig or nslookup, wordlists or any tool that walks ports, paths or subdomains; never POST, PUT, PATCH or DELETE, submit a form, send credentials or cookies, or attempt a login; never contact an IP directly. A 403 from a WAF for the probe user-agent is evidence the WAF works: stop connectivity checks for that host (WAF_BLOCKED). Connection resets or 5xx on three consecutive requests: stop (TARGET_UNSTABLE).'
  : '');
const SCOUT_EXTRA_PROPS = {};
const SCOUT_TARGET_PROPS = { urls: { type: 'array', items: { type: 'string' } } };
const scoutScopeLines = [
  'Read every applications/<app_id>/env/<env_id>.json of every considered app and return all of them as targets, whatever their exposure (internal and isolated environments still have NetworkPolicy, egress and segmentation checks). Add urls exactly as declared in the env record (empty array when absent); never add hosts from DNS, certificates, load-balancer names or READMEs. An app with no environment files gets a skipped entry {appId, reason: "no env records"}.',
];
const afterScout = () => {};
const extraBlockers = (t) => (t.method === 'http-only' && !(t.urls || []).length ? ['NO_URLS_DECLARED: probeAccess.method is http-only but urls[] is empty, so nothing may be contacted and no configuration access exists'] : []);
const afterTargets = (targets) => {
  for (const t of targets) {
    t.noUrls = (t.exposure === 'internet' || t.exposure === 'partner') && !(t.urls || []).length;
    if (t.noUrls && t.mode !== 'blocked') skip({ appId: t.appId, envId: t.envId, reason: 'NO_URLS_DECLARED: exposure ' + t.exposure + ' with empty urls[]; connectivity checks skipped, configuration checks only' });
  }
};
const afterProbe = () => {};
const companySubjectKey = () => 'company';

// ---- Rules-of-engagement time checks: pure functions of the run timestamp -----------------------------------------
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const toMinutes = (hhmm) => { const p = String(hhmm).split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); };
const inWeeklyWindow = (iso, w) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || !w || !Array.isArray(w.daysOfWeek)) return false;
  const day = DAY_NAMES[d.getUTCDay()];
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const start = toMinutes(w.startUtc);
  const end = toMinutes(w.endUtc);
  if (start === end) return w.daysOfWeek.includes(day);
  if (end > start) return w.daysOfWeek.includes(day) && minute >= start && minute < end;
  const prevDay = DAY_NAMES[(d.getUTCDay() + 6) % 7];
  return (w.daysOfWeek.includes(day) && minute >= start) || (w.daysOfWeek.includes(prevDay) && minute < end);
};
const inFreeze = (iso, f) => {
  const t = new Date(iso).getTime();
  const from = new Date(f.from).getTime();
  const to = new Date(f.to).getTime();
  return !Number.isNaN(t) && !Number.isNaN(from) && !Number.isNaN(to) && t >= from && t < to;
};
const blockerCodes = (blockers) => [...new Set((blockers || []).map((b) => String(b).split(':')[0]))];
const blockedPrefix = (blockers) => 'BLOCKED (' + blockerCodes(blockers).join(', ') + '): ' + (blockers || []).join('; ');
const describeWindows = (ws) => (ws || []).map((w) => (w.daysOfWeek || []).join('/') + ' ' + w.startUtc + '-' + w.endUtc + 'Z').join(', ');

// ---- Schemas for structured agent output ---------------------------------------------------------------------------
const WINDOW = { type: 'object', required: ['daysOfWeek', 'startUtc', 'endUtc'], properties: { daysOfWeek: { type: 'array', items: { type: 'string' } }, startUtc: { type: 'string' }, endUtc: { type: 'string' } } };
const FREEZE = { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' }, reason: { type: 'string' } } };
const SCOUT_SCHEMA = {
  type: 'object',
  required: ['targets', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    harness: { type: 'string' },
    runTimestamp: { type: 'string' },
    entityTypes: { type: 'array', items: { type: 'string' } },
    frameworksInScope: { type: 'array', items: { type: 'string' } },
    existingControlIds: { type: 'array', items: { type: 'string' } },
    ...SCOUT_EXTRA_PROPS,
    targets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['appId', 'envId', 'tier', 'method', 'readOnly'],
        properties: {
          appId: { type: 'string' },
          envId: { type: 'string' },
          tier: { type: 'string' },
          exposure: { type: 'string' },
          method: { type: 'string' },
          readOnly: { type: 'boolean' },
          credentialKey: { type: 'string' },
          rateLimitPerMinute: { type: 'integer' },
          allowedWindows: { type: 'array', items: WINDOW },
          changeFreeze: { type: 'array', items: FREEZE },
          hosting: { type: 'string' },
          dataClassification: { type: 'array', items: { type: 'string' } },
          residency: { type: 'array', items: { type: 'string' } },
          owner: { type: 'string' },
          ...SCOUT_TARGET_PROPS,
          notes: { type: 'string' },
        },
      },
    },
    skipped: { type: 'array', items: { type: 'object', required: ['reason'], properties: { appId: { type: 'string' }, envId: { type: 'string' }, repoId: { type: 'string' }, reason: { type: 'string' } } } },
  },
};
const REG_REF = { type: 'object', required: ['regulator', 'instrument', 'controlId'], properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } } };
const EVIDENCE = { type: 'array', items: { type: 'object', required: ['type', 'ref'], properties: { type: { type: 'string' }, ref: { type: 'string' }, description: { type: 'string' }, sha256: { type: 'string' }, collectedAt: { type: 'string' } } } };
const SEVERITY = { type: 'string', enum: SEV_ORDER.slice().reverse() };
const SUBJECT = { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['environment', 'image', 'application', 'repo', 'company'] }, appId: { type: 'string' }, envId: { type: 'string' }, imageId: { type: 'string' }, repoId: { type: 'string' } } };
const OBSERVATION = {
  type: 'object',
  required: ['controlId', 'result', 'title', 'description'],
  properties: {
    controlId: { type: 'string' },
    frameworkRef: REG_REF,
    controlTitle: { type: 'string' },
    checkIds: { type: 'array', items: { type: 'string' } },
    ruleIds: { type: 'array', items: { type: 'string' } },
    result: { type: 'string', enum: ['satisfied', 'not-satisfied', 'partial', 'not-applicable', 'inconclusive'] },
    title: { type: 'string' },
    description: { type: 'string' },
    subject: SUBJECT,
    collectedAt: { type: 'string' },
    evidence: EVIDENCE,
  },
};
const FINDING = {
  type: 'object',
  required: ['title', 'description', 'severity', 'confidence', 'ruleId', 'checkId', 'fingerprint', 'regulatoryRefs', 'controlIds', 'target', 'tags'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    severity: SEVERITY,
    confidence: { type: 'string', enum: ['confirmed', 'likely', 'possible', 'unverified'] },
    ruleId: { type: 'string' },
    checkId: { type: 'string' },
    ocsfClassUid: { type: 'integer' },
    fingerprint: { type: 'string' },
    controlIds: { type: 'array', items: { type: 'string' } },
    regulatoryRefs: { type: 'array', items: REG_REF },
    target: SUBJECT,
    location: { type: 'object', properties: { path: { type: 'string' } } },
    collectedAt: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    remediation: { type: 'string' },
    evidence: EVIDENCE,
  },
};
const RISK = {
  type: 'object',
  required: ['title', 'statement', 'severity', 'likelihood', 'impact', 'regulatoryRefs'],
  properties: { title: { type: 'string' }, statement: { type: 'string' }, severity: SEVERITY, likelihood: { type: 'string' }, impact: { type: 'string' }, controlIds: { type: 'array', items: { type: 'string' } }, regulatoryRefs: { type: 'array', items: REG_REF }, evidence: EVIDENCE },
};
const INCIDENT = {
  type: 'object',
  required: ['title', 'description', 'severity', 'category', 'dedupKey', 'detectedAt'],
  properties: { title: { type: 'string' }, description: { type: 'string' }, severity: SEVERITY, category: { type: 'string' }, dedupKey: { type: 'string' }, detectedAt: { type: 'string' }, summary: { type: 'string' }, evidence: EVIDENCE },
};
const EVIDENCE_REQUEST = {
  type: 'object',
  required: ['kind', 'controlIds', 'requested', 'dueDays'],
  properties: { kind: { type: 'string' }, appId: { type: 'string' }, envId: { type: 'string' }, checkId: { type: 'string' }, controlIds: { type: 'array', items: { type: 'string' } }, requested: { type: 'string' }, owner: { type: 'string' }, dueDays: { type: 'integer' } },
};
const PROBE_SCHEMA = {
  type: 'object',
  required: ['appId', 'envId', 'aborted', 'commandsExecuted', 'observations', 'findings', 'risks', 'incidents', 'evidenceRequests', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    appId: { type: 'string' },
    envId: { type: 'string' },
    aborted: { type: 'boolean' },
    abortReason: { type: 'string' },
    identityReadOnly: { type: 'boolean' },
    commandsExecuted: { type: 'integer' },
    exportPath: { type: 'string' },
    exportSha256: { type: 'string' },
    ocsfPath: { type: 'string' },
    ocsfSha256: { type: 'string' },
    observations: { type: 'array', items: OBSERVATION },
    findings: { type: 'array', items: FINDING },
    risks: { type: 'array', items: RISK },
    incidents: { type: 'array', items: INCIDENT },
    evidenceRequests: { type: 'array', items: EVIDENCE_REQUEST },
    skipped: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    sessionId: { type: 'string' },
    refuted: { type: 'boolean' },
    confidence: { type: 'number' },
    lens: { type: 'string' },
    reason: { type: 'string' },
    correctedSeverity: SEVERITY,
    correctedRegulatoryRefs: { type: 'array', items: REG_REF },
    correctedControlIds: { type: 'array', items: { type: 'string' } },
    unverifiable: { type: 'array', items: { type: 'string' } },
  },
};
const BATCH_VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    sessionId: { type: 'string' },
    verdicts: { type: 'array', items: { type: 'object', required: ['key', 'refuted', 'reason'], properties: { key: { type: 'string' }, refuted: { type: 'boolean' }, reason: { type: 'string' } } } },
  },
};
const WRITE_SCHEMA = {
  type: 'object',
  required: ['observationIds', 'inconclusiveObservations', 'findingIds', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    controlIds: { type: 'array', items: { type: 'string' } },
    observationIds: { type: 'array', items: { type: 'string' } },
    inconclusiveObservations: { type: 'array', items: { type: 'object', required: ['id', 'controlIds'], properties: { id: { type: 'string' }, controlIds: { type: 'array', items: { type: 'string' } } } } },
    findingIds: { type: 'array', items: { type: 'string' } },
    supersededFindingIds: { type: 'array', items: { type: 'string' } },
    reopenedFindingIds: { type: 'array', items: { type: 'string' } },
    riskIds: { type: 'array', items: { type: 'string' } },
    incidentIds: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'string' } },
  },
};
const VERSION_SCHEMA = { type: 'object', required: ['written'], properties: { sessionId: { type: 'string' }, written: { type: 'boolean' }, diffPath: { type: 'string' }, notes: { type: 'string' } } };
const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['updated', 'openFindings'],
  properties: {
    sessionId: { type: 'string' },
    updated: { type: 'boolean' },
    sections: { type: 'array', items: { type: 'string' } },
    openFindings: { type: 'integer' },
    controlsAssessed: { type: 'integer' },
    bySeverity: { type: 'object', properties: { critical: { type: 'integer' }, high: { type: 'integer' }, medium: { type: 'integer' }, low: { type: 'integer' }, info: { type: 'integer' } } },
    version: { type: 'string' },
    notes: { type: 'string' },
  },
};

// ---- Phase 1: Scout ------------------------------------------------------------------------------------------------
phase('Scout');
log('Scouting ' + companyId + ' for ' + DOMAIN + ' targets' + (appFilter ? ' (apps: ' + appFilter.join(', ') + ')' : '') + (envFilter ? ' (envs: ' + envFilter.join(', ') + ')' : '') + (dryRun ? ' [dry run]' : ''));
const scout = await agent(
  [
    'SCOUT MODE for the ' + WORKFLOW + ' workflow, company ' + companyId + '. You only list targets from workspace files: run no command against any system, do not call creds/sops.mjs, and write no file. Your probing instructions (sections 1-9 of your definition) do not apply in this step.',
    argNow
      ? 'Run timestamp: the caller passed args.now = ' + argNow + '. Do not read the clock; return runTimestamp = "' + argNow + '".'
      : 'Run timestamp (rules-of-engagement section 1): args.now was not passed. Run `date -u +%Y-%m-%dT%H:%M:%SZ` exactly once, now, and return its output verbatim as runTimestamp. That single reading is the run timestamp for every window, freeze and record decision of this run; never run it a second time.',
    'Return harness = "claude-code" or "opencode" (whichever you run under) and sessionId = your harness session id when you know it.',
    'Read company-profile/' + companyId + '/details.json (return entityTypes and frameworksInScope) and list every application directory under applications/. Never open applications/<app_id>/credentials.json (ciphertext).',
    appFilter ? 'Only consider these appIds: ' + appFilter.join(', ') + '. Add a skipped entry for every other app with reason "filtered by args.appIds".' : 'Consider every application.',
    ...scoutScopeLines,
    'For every environment considered' + (envFilter ? ' (only envIds ' + envFilter.join(', ') + '; skip the others with reason "filtered by args.envIds")' : '') + ' return one target copied exactly from applications/<app_id>/env/<env_id>.json: {appId, envId, tier, exposure, method: probeAccess.method, readOnly: probeAccess.readOnly (literally as found), credentialKey: probeAccess.credentialKey (the key name only), rateLimitPerMinute, allowedWindows, changeFreeze, hosting: "<provider>/<region>/<accountRef or ->/<cluster or ->/<namespace or ->", dataClassification, residency, owner (environment or application owner from the env record or applications/<app_id>/README.md), notes}. Include environments whose method is none or unsuitable and prod/dr environments: the workflow applies tier, prod gating and access rules. Do not filter by tier or window yourself.',
    'Read company-profile/' + companyId + '/soc/main.jsonl (it may be empty or absent) and return existingControlIds: the ids of every kind "control" record (instrument-qualified, e.g. sebi-cscrf-2024:PR.AA.S3).',
    'Every app and environment you looked at must appear either as a target or in skipped [{appId, envId?, repoId?, reason}] so nothing is dropped silently.',
  ].filter(Boolean).join('\n'),
  { label: 'scout', phase: 'Scout', agentType: PROBE_AGENT, schema: SCOUT_SCHEMA, effort: 'low' },
);
if (!scout) throw new Error('Scout returned nothing; cannot continue');
noteSession(scout);
for (const s of scout.skipped || []) skip({ appId: s.appId, envId: s.envId, reason: (s.repoId ? 'repo ' + s.repoId + ': ' : '') + s.reason });
const entityTypes = scout.entityTypes || [];
const frameworksInScope = scout.frameworksInScope || [];
const existingControlIds = scout.existingControlIds || [];
const harness = scout.harness === 'opencode' ? 'opencode' : 'claude-code';

// One run timestamp for the whole run (rules-of-engagement section 1): args.now, else the scout's single `date -u`.
const scoutNow = typeof scout.runTimestamp === 'string' && RFC3339Z.test(scout.runTimestamp.trim()) ? scout.runTimestamp.trim() : null;
const now = argNow || scoutNow;
if (!argNow) log(scoutNow ? 'args.now absent: run timestamp ' + now + ' read once by the scout (date -u); pass args.now for a resume-stable run' : 'args.now absent and the scout returned no valid run timestamp' + (scout.runTimestamp ? ' (got "' + scout.runTimestamp + '")' : '') + ': every environment is blocked (no run timestamp)');
// A concrete session id for the probers (they abort MISSING_INPUT without one) and for the export directory.
const runSessionId = argSessionId || runId || scout.sessionId || ('maxwell-' + WORKFLOW + (now ? '-' + now.replace(/[^0-9]/g, '') : ''));
const runKey = runId || runSessionId;
const exportDir = 'kpis/data/raw/sessions/' + String(runSessionId).replace(/[^A-Za-z0-9._-]/g, '-');
const textExport = exportDir + '/' + WORKFLOW + '.' + PROBE_AGENT + '.text.export.json';
const ocsfExport = exportDir + '/' + WORKFLOW + '.' + PROBE_AGENT + '.ocsf.export.json';
afterScout(scout);

// Rules-of-engagement section 1 preconditions, decided here so the prober, the plan and a resumed run all agree.
// Every failed check is recorded (not just the first), freeze before window, with the RoE blocker codes.
const accessBlockers = (t) => {
  const b = [];
  if (PROD_TIERS.includes(t.tier) && !(envFilter && envFilter.includes(t.envId))) b.push('PROD_GATING: tier ' + t.tier + ' is probed only when args.envIds names "' + t.envId + '" explicitly (no wildcard, no inference from appIds)');
  if (t.readOnly !== true) b.push('PROBE_ACCESS_NOT_READ_ONLY: probeAccess.readOnly must be literally true');
  if (t.method === 'none') b.push('METHOD_NONE: probeAccess.method is none, so evidence must be requested from humans');
  else if (!PROBE_METHODS.includes(t.method)) b.push('METHOD_UNSUITABLE: probeAccess.method ' + t.method + ' cannot evidence ' + DOMAIN + ' checks (usable methods: ' + PROBE_METHODS.join(', ') + ')');
  else if (CRED_METHODS.includes(t.method) && !t.credentialKey) b.push('CREDENTIAL_KEY_MISSING: probeAccess.credentialKey is required for method ' + t.method);
  if (!now) {
    b.push('NO_RUN_TIMESTAMP: no run timestamp (args.now absent and no valid date -u reading from the scout)');
  } else {
    for (const f of (t.changeFreeze || []).filter((x) => inFreeze(now, x))) b.push('CHANGE_FREEZE_ACTIVE: ' + f.from + ' to ' + f.to + (f.reason ? ' (' + f.reason + ')' : ''));
    if ((t.allowedWindows || []).length && !(t.allowedWindows || []).some((w) => inWeeklyWindow(now, w))) b.push('OUTSIDE_ALLOWED_WINDOW: ' + describeWindows(t.allowedWindows) + ' (run timestamp ' + now + ')');
  }
  return b.concat(extraBlockers(t));
};

const targets = [];
for (const t of (scout.targets || []).filter((x) => x && x.appId && x.envId && x.tier)) {
  const where = { appId: t.appId, envId: t.envId };
  if (ALLOWED_TIERS && !ALLOWED_TIERS.includes(t.tier)) { skip({ ...where, reason: 'tier ' + t.tier + ' is outside this workflow (rules of engagement section 1: ' + WORKFLOW + ' touches ' + ALLOWED_TIERS.join('|') + ' only)' }); continue; }
  if (envFilter && !envFilter.includes(t.envId)) { skip({ ...where, reason: 'filtered by args.envIds' }); continue; }
  const prodTier = PROD_TIERS.includes(t.tier);
  const declared = Number.isInteger(t.rateLimitPerMinute) && t.rateLimitPerMinute > 0 ? t.rateLimitPerMinute : defaultRateFor(t);
  const rate = prodTier ? Math.min(declared, 60) : declared;
  if (rate !== declared || !Number.isInteger(t.rateLimitPerMinute)) log(t.appId + '/' + t.envId + ': rate limit set to ' + rate + '/min (' + (Number.isInteger(t.rateLimitPerMinute) ? 'declared ' + t.rateLimitPerMinute + ', capped at 60 on ' + t.tier : 'none declared, default for method ' + t.method) + ')');
  targets.push({ ...t, rate, blockers: [], mode: null });
}
if (envFilter) {
  const seen = new Set((scout.targets || []).filter(Boolean).map((x) => x.envId));
  for (const id of envFilter) if (!seen.has(id)) skip({ envId: id, reason: 'args.envIds names "' + id + '" but the scout found no matching applications/*/env/' + id + '.json in scope' });
}
for (const t of targets) {
  t.blockers = accessBlockers(t);
  t.mode = t.blockers.length ? 'blocked' : dryRun ? 'dry-run' : 'probe';
  if (t.blockers.length) log(t.appId + '/' + t.envId + ': blocked (' + t.blockers.join('; ') + '); inconclusive observations plus an evidence request' + (dryRun ? ' (dry run)' : ''));
}
afterTargets(targets);

log(targets.length + ' target(s): ' + targets.filter((t) => t.mode === 'probe').length + ' probe, ' + targets.filter((t) => t.mode === 'blocked').length + ' blocked, ' + targets.filter((t) => t.mode === 'dry-run').length + ' dry-run; ' + skipped.length + ' skipped; ' + existingControlIds.length + ' existing control record(s); run timestamp ' + (now || 'none') + ', session ' + runSessionId);
if (!targets.length) {
  log('No eligible ' + DOMAIN + ' environment for ' + companyId + '; nothing to probe');
  return { companyId, workflow: WORKFLOW, dryRun, now, sessionId: runSessionId, targets: [], controls: 0, observations: 0, findings: 0, risks: 0, incidents: 0, initiatives: 0, suggestions: 0, evidenceRequests, cisoAlerts, roeViolations, probeNotes, skipped, sessionIds: [...sessionIds] };
}

// ---- Prompt fragments ----------------------------------------------------------------------------------------------
const timeRule = 'Time (rules-of-engagement section 1): the run timestamp is ' + (now || '(none: blocked)') + '. Use it for every go/no-go decision (windows, freezes, credential and risk-acceptance expiry), as collectedAt of blocked and dry-run observations, and as recordedAt, generatedAt, detectedAt, firstSeenAt and lastSeenAt. In probe mode only, also run a fresh `date -u +%Y-%m-%dT%H:%M:%SZ` before the first target command and again before each check group: re-evaluate changeFreeze (first) and allowedWindows against it and abort with WINDOW_CLOSED when it falls outside; those fresh readings are the collectedAt of executed commands and of the observations built from them. Never use any other clock reading. RFC 3339 UTC with a trailing Z.';
const writerTimeRule = 'Time: recordedAt and provenance.generatedAt = ' + now + ', except that recordedAt must never be earlier than the last ledger line\'s recordedAt (a resumed or concurrent run): in that case reuse that later value. collectedAt, detectedAt and lastSeenAt are taken from the candidates as given (blocked and dry-run observations use ' + now + '). Never read the clock. RFC 3339 UTC with a trailing Z.';
const provenanceRule = 'Every record carries provenance: harness "' + harness + '", generatedAt, sessionId'
  + (argSessionId ? ' "' + argSessionId + '"' : ' (your own harness session id; "' + runSessionId + '" when you do not know it)')
  + (runId ? ', runId "' + runId + '"' : ', runId from MAXWELL_RUN_ID when set') + ', workflow "' + WORKFLOW + '", agent = your agent name.';
const fingerprintRule = 'ruleId and fingerprint (your sections 3 and 6, soc-ledger section 6 "Fingerprint"): every finding carries ruleId = the kebab-case value in the ruleId column of your section 3 table for the failing check (for example ' + RULE_EXAMPLES + '); checkId (' + CHECK_PREFIX + '-nn) is only a label for titles, descriptions and evidence and never enters the fingerprint. The CREDENTIAL_NOT_READ_ONLY finding uses the ruleId your section 8 names for it (today "' + RW_RULE + '"; rules-of-engagement section 7 calls the rule ROE-RW-CREDENTIAL), the same value in the finding and in any OCSF event for it. fingerprint = sha256(ruleId + "|" + targetKey + "|" + normalisedLocation) where targetKey is environment:<appId>/<envId>, image:<appId>/<imageId>, application:<appId> or company:' + companyId + ' and normalisedLocation is location.path naming the examined resource (' + LOCATION_EXAMPLES + ') with no timestamps, revisions, instance or pod ids, counts or line numbers, computed with the node crypto one-liner in the soc-ledger skill. It must equal the OCSF finding_info.uid, and analytic.name must equal ruleId, so re-runs and refresh-soc match.';

const modeRule = (t) => {
  if (t.mode === 'dry-run') return 'DRY RUN (args.dryRun = true; rules-of-engagement section 4, your section 7): execute NO command, HTTP request, TLS handshake, DNS query or SQL against any target and write no export file. Still read every workspace file and evaluate every precondition (credential scope via `sops.mjs get` is allowed because it prints a locator only), and return the plan: one inconclusive observation per control you would evidence, collectedAt ' + now + ', description starting "DRY RUN:" listing the ordered commands verbatim (locators as $NAME), the check ids and ruleIds and the evidence a human would attach instead. findings, risks and incidents must be empty arrays and commandsExecuted 0.';
  if (t.mode === 'blocked') return 'BLOCKED (rules-of-engagement section 8): ' + t.blockers.join('; ') + '. Run NO command against the target and do not resolve any credential (not even `sops.mjs get`). Return one observation per control this probe would have evidenced with result "inconclusive", collectedAt ' + now + ', subject {type: "environment", appId: "' + t.appId + '", envId: "' + t.envId + '"} and a description that starts exactly "' + blockedPrefix(t.blockers) + '" (every blocker verbatim), plus evidenceRequests (one per check group, each with checkId, controlIds, requested: the exact artefacts a human should attach with their sha256, owner "' + (t.owner || '<env or app owner>') + '", dueDays 14). findings, risks and incidents must be empty arrays and commandsExecuted 0. Never downgrade a control because of missing access.';
  return 'PROBE: at the run timestamp ' + now + ' the workflow found no blocker (prod gating against the explicit envIds, readOnly, method, credentialKey, changeFreeze, allowedWindows). Re-run your own section 1 checks with the caller inputs above and abort (aborted: true, abortReason code) if any fails, if a fresh `date -u` reading falls outside the window or inside a freeze mid-probe, or on any rules-of-engagement section 7 condition, returning partial results.';
};
const credentialRule = (t) => {
  if (t.mode === 'blocked' || !CRED_METHODS.includes(t.method)) return '';
  return 'Credentials (rules-of-engagement section 3): `node .claude/scripts/creds/sops.mjs get ' + t.appId + ' ' + (t.credentialKey || '<credentialKey>') + '` prints a locator, never a value; require scope "read-only", "' + t.envId + '" in envIds and no past expiresAt. Pass the locator by reference only ($NAME, AWS_PROFILE, --kubeconfig "$VAR"); never print, echo or write it. A locator that does not resolve in this shell is missing access (ACCESS_UNRESOLVED: inconclusive observations and an evidenceRequest), never a reason to find another way in.'
    + (t.mode === 'probe' ? ' Prove the identity is read-only before any other target command, exactly as your section 1 describes. If it can write: abort immediately with CREDENTIAL_NOT_READ_ONLY, never use it again, and return one candidate finding with ruleId "' + RW_RULE + '" (as your section 8 names it), checkId "' + RW_CHECK_ID + '" (label only), severity high, target {type: "environment", appId: "' + t.appId + '", envId: "' + t.envId + '"}, location.path "probe-identity/' + (t.credentialKey || 'credential') + '", regulatoryRefs {regulator: "SEBI", instrument: "sebi-cscrf-2024", controlId: "PR.AA.S3"} (least privilege) first, then PR.AA.S1 (identity and credential management), then an RBI access-control ref only as your section 8 allows; never invent an id.' : '');
};
const commandRule = (t) => 'Commands: exactly the families listed in section 2 of ' + AGENT_DEF + ', and only where rules-of-engagement section 2 (' + ROE + ') also allows them for method ' + t.method + ' and tier ' + t.tier + '; where the two lists differ the stricter wins, and anything in neither is forbidden. Every command runs as `timeout 60 <command>` with any redaction stage inside the pipeline before `| head -c 1048576`; no `&&` or `;`. A fact only a forbidden command could show is inconclusive with an evidence request, never a pass and never a fail. Workflow-level prohibitions on top of those lists: ' + EXTRA_PROHIBITIONS(t);

const probePrompt = (t) => [
  'You are the ' + PROBE_AGENT + ' running the ' + WORKFLOW + ' workflow for company ' + companyId + ' (entityTypes: ' + (entityTypes.join(', ') || 'see details.json') + '; frameworksInScope: ' + (frameworksInScope.join(', ') || 'see details.json') + ').',
  'Caller inputs (your section 0; they satisfy MISSING_INPUT, do not substitute your own values): companyId=' + companyId + ', appId=' + t.appId + ', envId=' + t.envId + ', workflow=' + WORKFLOW + ', sessionId=' + runSessionId + ', runId=' + (runId || '(none; use MAXWELL_RUN_ID when set)') + ', harness=' + harness + ', dryRun=' + String(t.mode === 'dry-run') + ', envIds (explicit, from args.envIds; your prod/dr gate)=' + JSON.stringify(envFilter || []) + ', now=' + (now || '(none)') + ', textExportPath=' + textExport + ', ocsfExportPath=' + ocsfExport + '.',
  'Target: app ' + t.appId + ', environment ' + t.envId + ' (tier ' + t.tier + ', exposure ' + (t.exposure || '?') + ', hosting ' + (t.hosting || '?') + ', dataClassification ' + ((t.dataClassification || []).join('/') || '?') + ', residency ' + ((t.residency || []).join('/') || '?') + '). probeAccess.method = ' + t.method + (t.credentialKey && CRED_METHODS.includes(t.method) ? ', credentialKey = ' + t.credentialKey : '') + '. Rate limit: at most ' + t.rate + ' requests per minute (every CLI call, SQL statement, HTTP request and TLS handshake counts as one). ' + targetContext(t) + (t.notes ? ' Scout notes: ' + t.notes : ''),
  modeRule(t),
  'Read FIRST and obey: ' + AGENT_DEF + ' (your definition), then ' + ROE + ' (binding; section 9 "' + ROE_SECTION + '" is the minimum checklist). Skills: .claude/skills/maxwell-conventions/SKILL.md, .claude/skills/soc-ledger/SKILL.md, .claude/skills/ocsf-findings/SKILL.md, .claude/skills/regulatory-catalogs/SKILL.md with references/sla-table.json and references/catalogs/*.catalog.json, .claude/skills/credentials-sops/SKILL.md, .claude/skills/reference-architectures/SKILL.md. Confirm every controlId against references/catalogs/<instrumentId>.catalog.json when that file exists; for an instrument without a catalog file follow your section 4 (it says whether to cite the clause or omit the ref) and list "catalog missing: <instrument>" under skipped. Never invent a controlId.',
  'Workspace inputs: applications/' + t.appId + '/env/' + t.envId + '.json, applications/' + t.appId + '/README.md, applications/' + t.appId + '/repos/*.json, applications/' + t.appId + '/images/*.json (when present), company-profile/' + companyId + '/details.json, company-profile/' + companyId + '/sdlc/policy.json, company-profile/' + companyId + '/soc/main.jsonl (prior ' + WORKFLOW + ' observations and finding fingerprints)' + EXTRA_READS + '.',
  credentialRule(t),
  'Checks (your section 3 table, one result per check and subject; observations one per control per subject): ' + CHECKS(t),
  commandRule(t),
  EXTRA_PROMPT(t),
  t.mode === 'probe' ? 'Evidence (rules-of-engagement sections 5 and 6, your section 5): redact before hashing, writing or quoting; write redacted outputs keyed by command to ' + textExport + ' and OCSF events to ' + ocsfExport + ' (merge when the file already exists from another environment of this session; these are the only files you may write) and return both paths with the sha256 of the final files. Each executed command yields one evidence entry {type: "command-output" (or "url" for an HTTP request), ref: <command with locators as $NAME>, sha256 of the redacted output as stored in the export, collectedAt, description with the observed value and the check id}. Output you cannot redact is dropped, keeping only its byte length (never a hash of unredacted bytes), and triggers the section 7 abort.' : '',
  fingerprintRule,
  'Return observations: one per control per subject (controlId as <instrumentId>:<controlId>, preferring ids already in the ledger: ' + (existingControlIds.join(', ') || 'none yet') + '; for a new control include frameworkRef {regulator, instrument, controlId} and controlTitle so the ledger keeper can create it), checkIds and ruleIds aggregated, result, title, description (what was examined, expected, observed), subject ({type: "environment", appId: "' + t.appId + '", envId: "' + t.envId + '"} unless another asset type applies), collectedAt, evidence.',
  'Return findings (probe mode only, only for a Fail, or a Warning on a mandatory control, you can point at with the command and observed value in the description): title, description, severity exactly as your section 4 derives it from the catalog defaultSeverity of the most specific cited control (never intuition), confidence, ruleId, checkId, ocsfClassUid (2003, or 2004 for activity seen during the probe window), fingerprint, controlIds (a subset of the observation controlIds), regulatoryRefs (regulator from the regulators vocab, instrument from the instruments vocab, most specific applicable Indian instrument first, global mappings after), target (same shape as subject), location.path, collectedAt, tags (lower-case, starting with ' + BASE_TAGS.join(', ') + '), remediation, evidence.',
  'Return risks only for the rules-of-engagement section 7 unredactable-data condition (title exactly "' + UNREDACTABLE_RISK_TITLE + '", severity high, statement, likelihood, impact, regulatoryRefs with dpdp-rules-2025 6(1) safeguards first for personal data and cert-in-directions-2022 second) and incidents only for a detected probe side effect (category "unauthorised-access", title containing "probe side effect", status detected, severity high, detectedAt, dedupKey exactly "probe-side-effect:' + t.appId + '/' + t.envId + ':' + runKey + '", summary: one sentence for the company\'s CISO). Otherwise empty arrays. These are written without refutation, so state the abortReason and, for dropped output, its byte length in them.',
  'Return evidenceRequests (each with checkId and controlIds) whenever access was missing or a precondition or check could not be completed, skipped (every check not performed and why: tool missing, out of window, rate limit, method, sampling cap), commandsExecuted (commands actually run against the target), notes (sampling caps such as hosts per family, liveRunSkipped, account-wide delegation). Do NOT append to the ledger and do NOT edit summary.md.',
  timeRule, provenanceRule,
].filter(Boolean).join('\n');

const refutePrompt = (t, c, lens) => [
  'You are an adversarial refuter for the ' + WORKFLOW + ' workflow (company ' + companyId + '). Lens: ' + lens + '. Try to REFUTE the candidate ' + c.recordKind + ' below; default to refuted=true when you cannot verify it from the workspace yourself. Never run a command against, or send a request to, the target.',
  'Context: app ' + t.appId + ', environment ' + t.envId + ' (tier ' + t.tier + ', exposure ' + (t.exposure || '?') + '), method ' + t.method + ', session raw directory ' + exportDir + ', text export ' + (c.exportPath || 'none') + ', OCSF export ' + (c.ocsfPath || 'none') + ', prober definition ' + AGENT_DEF + '.',
  'Candidate:\n' + JSON.stringify(c.record, null, 1),
  lens === 'evidence'
    ? 'Evidence lens: open the text and OCSF exports and confirm each command-output ref has a captured, redacted output that shows the value the candidate claims; confirm the command is allowed by both section 2 of ' + AGENT_DEF + ' and rules-of-engagement section 2 (' + ROE + ') and ran against ' + t.envId + ', not another tier; confirm ruleId is the ruleId column of the prober\'s section 3 row for checkId (or the section 8 read-write rule) and that the OCSF event for this finding has finding_info.uid equal to the fingerprint; look for a compensating control in applications/' + t.appId + '/ (env, image, repo records), company-profile/' + companyId + '/sdlc/policy.json or an existing ledger control marked implemented and effective; check the severity against tier and exposure and return correctedSeverity when the evidence supports a different level.'
    : lens === 'regulatory-mapping'
      ? 'Regulatory-mapping lens: read .claude/skills/regulatory-catalogs/SKILL.md and its references; check each regulatoryRef instrument applies to this company (company-profile/' + companyId + '/details.json entityTypes, regulatoryRegistrations, jurisdictions, frameworksInScope), that the controlId exists in .claude/skills/regulatory-catalogs/references/catalogs/<instrumentId>.catalog.json when that file exists (an id absent from the catalog, such as a NIST CSF category cited under sebi-cscrf-2024, is a mapping error) and covers the gap, that the most specific Indian instrument comes first, and that severity matches the catalog defaultSeverity and SLA-table row. ' + regmapHint(t) + ' Return correctedRegulatoryRefs / correctedControlIds / correctedSeverity (catalog ids only) when the mapping is wrong but the gap is real; refute only when no applicable clause exists. If a catalog file is missing, say so in unverifiable and apply the prober definition\'s section 4 rule for uncatalogued instruments (never push an invented or function-level id).'
      : lensText(t, c, lens),
  'Read-only: never modify the workspace. Return {refuted, confidence, lens: "' + lens + '", reason, correctedSeverity?, correctedRegulatoryRefs?, correctedControlIds?, unverifiable?}.',
].join('\n');

const lower = (a, b) => (SEV_ORDER.indexOf(a) <= SEV_ORDER.indexOf(b) ? a : b);
const isHigh = (sev) => sev === 'high' || sev === 'critical';
// High/critical findings (and any risk or incident that is not a section 7 safety record) face SEVERE_LENSES and need
// unanimity; everything else faces BASE_LENSES and needs a strict majority of all lenses (a missing verdict counts against).
const lensesFor = (kind, sev) => (kind !== 'finding' || isHigh(sev) ? SEVERE_LENSES : BASE_LENSES);
const applyVerdicts = (original, verdicts) => {
  const merged = { ...original };
  const reg = verdicts['regulatory-mapping'];
  if (reg && !reg.refuted && reg.correctedSeverity && merged.severity) merged.severity = reg.correctedSeverity;
  for (const lens of Object.keys(verdicts)) {
    const v = verdicts[lens];
    if (!v || v.refuted) continue;
    if (lens !== 'regulatory-mapping' && v.correctedSeverity && merged.severity) merged.severity = lower(merged.severity, v.correctedSeverity);
    if (v.correctedRegulatoryRefs && v.correctedRegulatoryRefs.length && (lens === 'regulatory-mapping' || !(reg && reg.correctedRegulatoryRefs))) merged.regulatoryRefs = v.correctedRegulatoryRefs;
    if (v.correctedControlIds && v.correctedControlIds.length && (lens === 'regulatory-mapping' || !(reg && reg.correctedControlIds))) merged.controlIds = v.correctedControlIds;
  }
  return merged;
};
const judge = async (t, c, i) => {
  const verdicts = {};
  let record = c.record;
  for (let round = 0; round < 2; round += 1) {
    const needed = lensesFor(c.recordKind, record.severity).filter((l) => !(l in verdicts));
    if (!needed.length) break;
    const votes = await parallel(needed.map((lens) => () =>
      agent(refutePrompt(t, { ...c, record }, lens), { label: 'refute ' + lens + ' ' + t.appId + '/' + t.envId + ' ' + c.recordKind + ' #' + (i + 1), phase: 'Refute', agentType: 'refuter', schema: VERDICT_SCHEMA, effort: 'high' })));
    needed.forEach((lens, k) => { verdicts[lens] = votes[k] || null; noteSession(votes[k]); });
    record = applyVerdicts(c.record, verdicts);
  }
  const lenses = lensesFor(c.recordKind, record.severity);
  const valid = lenses.map((l) => verdicts[l]).filter(Boolean);
  const refutations = valid.filter((v) => v.refuted).length;
  const upheld = valid.length - refutations;
  const severe = lenses === SEVERE_LENSES && (c.recordKind !== 'finding' || isHigh(record.severity));
  const survives = severe ? upheld === lenses.length : upheld * 2 > lenses.length;
  const reasons = lenses.map((l) => l + ': ' + (verdicts[l] ? (verdicts[l].refuted ? 'refuted - ' : 'upheld - ') + verdicts[l].reason : 'no verdict')).join(' | ');
  if (!survives) {
    skip({ appId: t.appId, envId: t.envId, reason: 'refuted ' + c.recordKind + ' (' + upheld + '/' + lenses.length + ' lenses upheld' + (severe ? ', unanimity required' : ', strict majority required') + '): ' + c.record.title + ' || ' + reasons });
    return null;
  }
  return { ...record, refutation: reasons };
};
// Assessed probe-mode observations (satisfied / not-satisfied / partial) can create a control's implementationStatus,
// so they face the evidence lens in one batch per environment; refuted or unjudged ones are downgraded to inconclusive.
const refuteObservations = async (t, probe, observations) => {
  const keyed = observations.map((o, k) => ({ key: 'o' + (k + 1), o }));
  if (!keyed.length) return observations;
  const res = await agent(
    [
      'You are an adversarial refuter for the ' + WORKFLOW + ' workflow (company ' + companyId + '). Lens: evidence. BATCH MODE: judge every keyed observation on its own and return exactly one verdict per key, in input order; default to refuted=true when you cannot verify it. Never run a command against, or send a request to, the target.',
      'Context: app ' + t.appId + ', environment ' + t.envId + ' (tier ' + t.tier + '), text export ' + (probe.exportPath || 'none') + ', OCSF export ' + (probe.ocsfPath || 'none') + ', prober definition ' + AGENT_DEF + '.',
      'For each observation confirm that the exports contain redacted output of allowed commands (section 2 of ' + AGENT_DEF + ' and rules-of-engagement section 2) run against ' + t.envId + ' that supports the result for that control and subject: "satisfied" needs every subject in scope examined and passing (not a sample, unless the prober definition caps sampling and the description says so); "not-satisfied" and "partial" need the gap visible in the captured output. Refute when the evidence is absent, from another environment, or shows a different result.',
      'Observations:\n' + JSON.stringify(keyed.map((x) => ({ key: x.key, ...x.o })), null, 1),
      'Read-only: never modify the workspace. Return {verdicts: [{key, refuted, reason}]}.',
    ].join('\n'),
    { label: 'refute evidence ' + t.appId + '/' + t.envId + ' observations (' + keyed.length + ')', phase: 'Refute', agentType: 'refuter', schema: BATCH_VERDICT_SCHEMA, effort: 'high' },
  );
  noteSession(res);
  const byKey = new Map(((res && res.verdicts) || []).filter((v) => v && v.key).map((v) => [v.key, v]));
  let downgraded = 0;
  const out = keyed.map(({ key, o }) => {
    const v = byKey.get(key);
    if (v && !v.refuted) return o;
    downgraded += 1;
    const why = v ? v.reason : 'no verdict returned';
    skip({ appId: t.appId, envId: t.envId, reason: 'observation ' + o.controlId + ' (' + o.result + ') downgraded to inconclusive by the evidence lens: ' + why });
    return { ...o, result: 'inconclusive', description: 'UNVERIFIED (evidence lens: ' + why + '): ' + (o.description || '') };
  });
  log(t.appId + '/' + t.envId + ': ' + (keyed.length - downgraded) + '/' + keyed.length + ' assessed observation(s) upheld by the evidence lens');
  return out;
};

// ---- Phase 2 + 3: per-environment pipeline (probe -> refute) -------------------------------------------------------
phase('Probe');
log('Probing ' + targets.length + ' environment(s); refutation runs per environment as soon as its probe returns (agents grouped under Refute)');
const probeOutcomes = new Map();
const isSafetyRisk = (r) => r && String(r.title || '').toLowerCase().includes('unredactable sensitive data');
const isSafetyIncident = (inc) => inc && /probe side effect/i.test(String(inc.title || ''));
const probed = await pipeline(
  targets,
  async (t, _item, index) => {
    const r = await agent(probePrompt(t), { label: t.mode + ' ' + t.appId + '/' + t.envId + ' #' + (index + 1), phase: 'Probe', agentType: PROBE_AGENT, schema: PROBE_SCHEMA, effort: t.mode === 'probe' ? 'high' : 'medium' });
    probeOutcomes.set(t.appId + '/' + t.envId, r ? { returned: true, aborted: Boolean(r.aborted), abortReason: r.abortReason || null } : { returned: false });
    if (!r) { skip({ appId: t.appId, envId: t.envId, reason: 'probe agent returned no schema-valid result; nothing recorded for this environment' }); return null; }
    noteSession(r);
    for (const s of r.skipped || []) skipped.push({ appId: t.appId, envId: t.envId, reason: 'probe: ' + s });
    if (r.notes) { probeNotes.push({ appId: t.appId, envId: t.envId, mode: t.mode, notes: r.notes }); log(t.appId + '/' + t.envId + ' notes: ' + r.notes); }
    if (t.mode !== 'probe' && r.commandsExecuted) {
      const v = { appId: t.appId, envId: t.envId, tier: t.tier, mode: t.mode, commandsExecuted: r.commandsExecuted, reason: 'rules-of-engagement breach: ' + PROBE_AGENT + ' reported ' + r.commandsExecuted + ' target command(s) in ' + t.mode + ' mode' + (t.blockers.length ? ' despite blockers: ' + t.blockers.join('; ') : '') + '; its candidate records are discarded' };
      roeViolations.push(v);
      cisoAlerts.push({ appId: t.appId, envId: t.envId, tier: t.tier, kind: 'roe-violation', message: 'CISO: ' + WORKFLOW + ' ran ' + r.commandsExecuted + ' command(s) against ' + t.appId + '/' + t.envId + ' while in ' + t.mode + ' mode; review the target audit log for the probe identity' });
      log('RoE VIOLATION ' + t.appId + '/' + t.envId + ': ' + v.reason);
    }
    if (r.aborted) skip({ appId: t.appId, envId: t.envId, reason: 'probe aborted: ' + (r.abortReason || 'unspecified') + ' after ' + (r.commandsExecuted || 0) + ' command(s)' });
    log(t.appId + '/' + t.envId + ' [' + t.mode + ']: ' + (r.commandsExecuted || 0) + ' command(s), ' + (r.observations || []).length + ' observation(s), ' + (r.findings || []).length + ' candidate finding(s), ' + (r.risks || []).length + ' risk(s), ' + (r.incidents || []).length + ' incident(s), ' + (r.evidenceRequests || []).length + ' evidence request(s)');
    return { target: t, probe: r };
  },
  async (prev) => {
    if (!prev) return null;
    const { target: t, probe } = prev;
    const observations = (probe.observations || []).filter((o) => o && o.controlId);
    if (t.mode !== 'probe') {
      const n = (probe.findings || []).length + (probe.risks || []).length + (probe.incidents || []).length;
      if (n) skip({ appId: t.appId, envId: t.envId, reason: t.mode + ': ' + n + ' candidate finding/risk/incident record(s) discarded; only inconclusive observations are written' });
      return { target: t, probe, observations, findings: [], risks: [], incidents: [] };
    }
    const candidates = [];
    const safety = { findings: [], risks: [], incidents: [] };
    for (const f of probe.findings || []) {
      if (!(f && f.fingerprint && /^[0-9a-f]{64}$/.test(f.fingerprint) && f.ruleId && (KEBAB.test(f.ruleId) || RW_RULE_IDS.includes(f.ruleId)) && (f.regulatoryRefs || []).length)) { skip({ appId: t.appId, envId: t.envId, reason: 'candidate finding dropped before refutation (fingerprint not 64 hex, ruleId missing or not kebab-case, or no regulatoryRefs): ' + ((f && f.title) || '?') + (f && f.ruleId ? ' [ruleId ' + f.ruleId + ']' : '') }); continue; }
      if (RW_RULE_IDS.includes(f.ruleId)) safety.findings.push(f);
      else candidates.push({ recordKind: 'finding', record: f, exportPath: probe.exportPath, ocsfPath: probe.ocsfPath });
    }
    for (const r of probe.risks || []) { if (isSafetyRisk(r)) safety.risks.push(r); else candidates.push({ recordKind: 'risk', record: r, exportPath: probe.exportPath, ocsfPath: probe.ocsfPath }); }
    for (const inc of probe.incidents || []) { if (isSafetyIncident(inc)) safety.incidents.push({ ...inc, dedupKey: 'probe-side-effect:' + t.appId + '/' + t.envId + ':' + runKey }); else candidates.push({ recordKind: 'incident', record: inc, exportPath: probe.exportPath, ocsfPath: probe.ocsfPath }); }
    // Rules-of-engagement section 7 safety records bypass refutation: the evidence behind them was deliberately dropped
    // (unredactable output) or lives outside the export (target audit log), so the evidence lens would always refute them.
    const expected = { findings: 'CREDENTIAL_NOT_READ_ONLY', risks: 'UNREDACTABLE_DATA', incidents: 'PROBE_SIDE_EFFECT' };
    for (const k of Object.keys(safety)) {
      for (const rec of safety[k]) {
        rec.refutation = 'not refuted: rules-of-engagement section 7 safety record written directly (abortReason ' + (probe.abortReason || 'none') + ')';
        log(t.appId + '/' + t.envId + ': section 7 safety ' + k.slice(0, -1) + ' written without refutation: ' + rec.title + (probe.abortReason === expected[k] ? '' : ' (note: abortReason is ' + (probe.abortReason || 'absent') + ', expected ' + expected[k] + ')'));
      }
    }
    const assessed = observations.filter((o) => ASSESSED_RESULTS.includes(o.result));
    const others = observations.filter((o) => !ASSESSED_RESULTS.includes(o.result));
    const results = await parallel([() => refuteObservations(t, probe, assessed)].concat(candidates.map((c, i) => () => judge(t, c, i))));
    const checkedObservations = others.concat(results[0] || assessed.map((o) => ({ ...o, result: 'inconclusive', description: 'UNVERIFIED (evidence lens returned nothing): ' + (o.description || '') })));
    const survivors = { findings: safety.findings.slice(), risks: safety.risks.slice(), incidents: safety.incidents.slice() };
    candidates.forEach((c, i) => { if (results[i + 1]) survivors[c.recordKind + 's'].push(results[i + 1]); });
    log(t.appId + '/' + t.envId + ': ' + (survivors.findings.length + survivors.risks.length + survivors.incidents.length - safety.findings.length - safety.risks.length - safety.incidents.length) + '/' + candidates.length + ' candidate(s) survived refutation');
    return { target: t, probe, observations: checkedObservations, ...survivors };
  },
);
afterProbe(probeOutcomes);

// ---- Phase 4: Dedup (barrier: needs every environment's survivors) -------------------------------------------------
phase('Dedup');
const subjectKey = (s, t) => (s && s.type === 'company' ? companySubjectKey(t) : [s && s.type || 'environment', (s && s.appId) || t.appId, (s && (s.envId || s.imageId || s.repoId)) || t.envId].join(':'));
const byFingerprint = new Map();
const byDedupKey = new Set();
const byRiskKey = new Set();
const byObservationKey = new Set();
const perTarget = [];
// Probe-mode environments first, so a real result for a shared (company-wide) control wins over an inconclusive one.
const MODE_RANK = { probe: 0, blocked: 1, 'dry-run': 2 };
for (const item of probed.filter(Boolean).sort((a, b) => MODE_RANK[a.target.mode] - MODE_RANK[b.target.mode])) {
  const t = item.target;
  const findings = [];
  for (const f of item.findings) {
    const first = byFingerprint.get(f.fingerprint);
    if (first) {
      first.alsoSeenIn.push(t.appId + '/' + t.envId);
      if (SEV_ORDER.indexOf(f.severity) > SEV_ORDER.indexOf(first.record.severity)) skip({ appId: t.appId, envId: t.envId, reason: 'duplicate fingerprint ' + f.fingerprint.slice(0, 12) + ' carried a higher severity (' + f.severity + ') than the kept record (' + first.record.severity + '); kept the refuted-and-merged first record' });
      skip({ appId: t.appId, envId: t.envId, reason: 'duplicate fingerprint ' + f.fingerprint.slice(0, 12) + ' merged into ' + first.at + ': ' + f.title });
      continue;
    }
    const kept = { at: t.appId + '/' + t.envId, alsoSeenIn: [], record: f };
    byFingerprint.set(f.fingerprint, kept);
    findings.push(kept);
  }
  const incidents = [];
  for (const inc of item.incidents) {
    if (byDedupKey.has(inc.dedupKey)) { skip({ appId: t.appId, envId: t.envId, reason: 'duplicate incident dedupKey ' + inc.dedupKey + ' merged' }); continue; }
    byDedupKey.add(inc.dedupKey);
    incidents.push(inc);
  }
  const risks = [];
  for (const r of item.risks) {
    const key = (r.title || '').toLowerCase() + '|' + t.appId + '|' + t.envId;
    if (byRiskKey.has(key)) { skip({ appId: t.appId, envId: t.envId, reason: 'duplicate risk merged: ' + r.title }); continue; }
    byRiskKey.add(key);
    risks.push(r);
  }
  const observations = [];
  for (const o of item.observations || []) {
    const key = o.controlId + '|' + subjectKey(o.subject, t);
    if (byObservationKey.has(key)) { skip({ appId: t.appId, envId: t.envId, reason: 'duplicate observation for ' + key + ' merged' + (o.result ? ' (dropped result ' + o.result + ')' : '') }); continue; }
    byObservationKey.add(key);
    if (t.mode === 'probe') { observations.push(o); continue; }
    const desc = String(o.description || '');
    const prefix = t.mode === 'dry-run' ? 'DRY RUN: ' : blockedPrefix(t.blockers) + '. ';
    observations.push({ ...o, result: 'inconclusive', collectedAt: now || o.collectedAt, description: desc.startsWith('DRY RUN:') || desc.startsWith('BLOCKED (') ? desc : prefix + desc });
  }
  const requests = [];
  for (const q of item.probe.evidenceRequests || []) {
    if (!q) continue;
    const scope = q.checkId || (q.controlIds || []).join(', ') || 'the blocked checks';
    requests.push({
      kind: 'evidence-request', appId: q.appId || t.appId, envId: q.envId || t.envId, tier: t.tier, blockers: t.blockers.slice(), checkId: q.checkId || null,
      controlIds: q.controlIds || [], requested: q.requested, owner: q.owner || t.owner || null, dueDays: Number.isInteger(q.dueDays) ? q.dueDays : 14, observationId: null, workflow: WORKFLOW,
      verificationMethod: { type: 're-probe', workflow: WORKFLOW, description: 'Re-run ' + WORKFLOW + ' for ' + t.appId + '/' + t.envId + (t.blockers.length ? ' once these blockers are cleared (' + t.blockers.join('; ') + ')' : '') + ' and confirm ' + scope + ' returns an assessed (not inconclusive) observation' },
    });
  }
  perTarget.push({ target: t, probe: item.probe, observations, findings, risks, incidents, requests });
}
log(byFingerprint.size + ' unique finding(s), ' + byObservationKey.size + ' observation(s), ' + byRiskKey.size + ' risk(s), ' + byDedupKey.size + ' incident(s), ' + perTarget.reduce((n, p) => n + p.requests.length, 0) + ' evidence request(s) across ' + perTarget.length + ' environment(s) after dedup');

// ---- Phase 5: Write (sequential so ledger id and fingerprint checks never race) ------------------------------------
phase('Write');
const written = { controlIds: [], observationIds: [], inconclusiveObservationIds: [], findingIds: [], supersededFindingIds: [], reopenedFindingIds: [], riskIds: [], incidentIds: [] };
const overlap = (a, b) => (a || []).filter((x) => (b || []).includes(x)).length;
const linkObservation = (q, inconclusive) => {
  const exact = inconclusive.find((o) => overlap(o.controlIds, q.controlIds) === (q.controlIds || []).length && (o.controlIds || []).length === (q.controlIds || []).length && (q.controlIds || []).length);
  if (exact) return exact.id;
  let best = null;
  let bestN = 0;
  for (const o of inconclusive) { const n = overlap(o.controlIds, q.controlIds); if (n > bestN) { best = o; bestN = n; } }
  return best ? best.id : null;
};
for (const p of perTarget) {
  const t = p.target;
  if (!p.observations.length && !p.findings.length && !p.risks.length && !p.incidents.length) { log('nothing to write for ' + t.appId + '/' + t.envId); evidenceRequests.push(...p.requests); continue; }
  const findingsForWrite = p.findings.map((k) => (k.alsoSeenIn.length ? { ...k.record, description: k.record.description + ' Also observed with the same fingerprint in: ' + k.alsoSeenIn.join(', ') + '.' } : k.record));
  const w = await agent(
    [
      'You are the soc-ledger-keeper for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read .claude/skills/soc-ledger/SKILL.md (sections 2, 6, 7 and 8), .claude/skills/maxwell-conventions/SKILL.md, .claude/skills/regulatory-catalogs/SKILL.md (references/sla-table.json for slaDueAt and regulatorReportRefs) and sections 4, 5, 7, 8 and 10 of ' + ROE + ' before writing.',
      'Ledger: company-profile/' + companyId + '/soc/main.jsonl (append-only). Append EVERY record by piping JSON to `node .claude/scripts/soc/append.mjs ' + companyId + ' -`; never edit the ledger directly and never create a scratch file anywhere. A rejected append means the record is wrong: fix it and retry. Never write a secret-shaped string.',
      'Target: app ' + t.appId + ', environment ' + t.envId + ' (tier ' + t.tier + ', mode ' + t.mode + (t.blockers.length ? ', blockers: ' + t.blockers.join('; ') : '') + '). Text export: ' + (p.probe.exportPath || 'none') + (p.probe.exportSha256 ? ' (sha256 ' + p.probe.exportSha256 + ')' : '') + '. OCSF export: ' + (p.probe.ocsfPath || 'none') + (p.probe.ocsfSha256 ? ' (sha256 ' + p.probe.ocsfSha256 + ')' : '') + '.',
      'Step 1 - controls: for each observation or finding controlId without a kind "control" record in the ledger, append one first (id = the instrument-qualified controlId, frameworkRefs from the observation frameworkRef or the catalog, title, statement, implementationStatus from the observation result: satisfied->implemented, partial->partial, not-satisfied->not-implemented, not-applicable->not-applicable, inconclusive->unknown; applicableAssets [the observation subject]). Assessed results below already survived the evidence lens. Never modify an existing control record from this run (soc-ledger section 8 rule 4 and rules-of-engagement section 8: implementationStatus moves only on evidence that the implementation changed, and never down because of an inconclusive result).',
      'Step 2 - observations (one per entry): kind observation, id obs_<ULID>, controlIds [controlId], title, description exactly as given (keep "DRY RUN:", "BLOCKED (...)" and "UNVERIFIED (...)" prefixes), methods ["' + WORKFLOW + '"], subjects [subject, default {type: "environment", appId: "' + t.appId + '", envId: "' + t.envId + '"}], collectedAt, expiresAt (collectedAt + 30 days for prod/dr, + 90 days otherwise, or the control cadence when shorter), result, toolOutput {format: "ocsf" when the OCSF export exists (else "text"), path, sha256} only when the export exists and mode is probe, evidence as given, tags ' + JSON.stringify(BASE_TAGS) + '. Return the inconclusive ones separately as inconclusiveObservations [{id, controlIds}].',
      'Observations to write:\n' + JSON.stringify(p.observations, null, 1),
      p.findings.length ? [
        'Step 3 - findings: reconcile each candidate exactly per soc-ledger section 8 (latest record per id = its last line). Grep the ledger for the candidate fingerprint.',
        '(a) No finding has this fingerprint: append a new finding with a fresh fnd_<ULID>, status "open", firstSeenAt = lastSeenAt = the candidate collectedAt (else ' + now + '), slaDueAt = firstSeenAt + days and slaBasis {instrument, controlId, topic, severity, days} copied from the matching sla-table.json row (patch-sla or the instruments.json hardRequirements topic, most-strict-wins; defaults[severity] when no row). List it under findingIds.',
        '(b) A finding has this fingerprint: NEVER mint a second fnd_ id. Append a supersession with the SAME id and supersedes = that id, copying the latest record and keeping firstSeenAt, setting lastSeenAt = the candidate collectedAt, refreshing severity (recompute slaDueAt from firstSeenAt when severity changed), evidence, relatedObservationIds and location, then by the latest status: open, triaged or remediating -> keep status, initiativeId and statusReason (list under supersededFindingIds); resolved -> status "open", statusReason "regressed in run ' + runKey + '", resolvedAt removed (list under supersededFindingIds and reopenedFindingIds); false-positive or duplicate -> keep status, statusReason and resolvedAt and change only lastSeenAt (plus recordedAt and provenance); risk-accepted -> find the risk whose relatedFindingIds contains this id with status accepted or deviation-approved: acceptedUntil later than ' + now + ' -> keep status and change only lastSeenAt; acceptedUntil passed -> supersede that risk with status "open" and a description noting the expired acceptance, and supersede the finding with status "open", statusReason "risk acceptance expired ' + '<acceptedUntil>; reopened in run ' + runKey + '", resolvedAt removed (list under reopenedFindingIds and the risk under riskIds).',
        'Every new or superseding finding: kind finding, title, description (observed value and command; append the refutation summary and the remediation), severity, confidence, controlIds (must exist after step 1), regulatoryRefs as given, target as given, location when given, fingerprint as given (do not recompute), source {kind: "ocsf", ocsfClassUid: <candidate ocsfClassUid or 2003>, ruleId: <candidate ruleId>, tool: "maxwell-' + PROBE_AGENT + '", toolVersion: "1.0.0"} when the OCSF export exists, else {kind: "runtime-probe", ruleId: <candidate ruleId>, tool: "maxwell-' + PROBE_AGENT + '", toolVersion: "1.0.0"} (the read-write credential finding, ruleId ' + RW_RULE_IDS.join(' or ') + ', always uses kind "runtime-probe"), relatedObservationIds (the step-2 ids for its controlIds), evidence (command-output entries plus {type: "ocsf", ref: <OCSF export path>, sha256} when present), tags as given. Drop the workflow-only keys checkId, ruleId, ocsfClassUid, collectedAt, remediation and refutation from the record body.',
        'Findings:\n' + JSON.stringify(findingsForWrite, null, 1),
      ].join('\n') : '',
      p.risks.length ? 'Step 4 - risks: kind risk, id rsk_<ULID>, title, statement, severity, likelihood, impact, status "open", controlIds, regulatoryRefs, relatedFindingIds when related; a risk whose title exactly matches an open risk for the same environment in the ledger is superseded (same id) instead of duplicated. Risks:\n' + JSON.stringify(p.risks, null, 1) : '',
      p.incidents.length ? 'Step 5 - incidents: kind incident, id inc_<ULID>, title, description (include the CISO summary), severity, status "detected", category, dedupKey exactly as given (probe-side-effect:<appId>/<envId>:<runId>; grep the ledger first and supersede an incident with the same dedupKey instead of duplicating), detectedAt, affectedAssets [{type: "environment", appId: "' + t.appId + '", envId: "' + t.envId + '"}], affectedDataClassifications ' + JSON.stringify(t.dataClassification || []) + ', regulatorReportRefs: one entry per regulator taken from the regulatory-catalogs references/sla-table.json incident-reporting rows for instruments that apply to this company (cert-in-directions-2022 always for an Indian entity; sebi-cscrf-2024, rbi-cyber-tech-directions-2026 or irdai-info-cyber-security-2023 per entityTypes and frameworksInScope; rbi-it-outsourcing-md-2023 when an outsourced provider runs the target) plus the dpdp-rules-2025 breach-notification row when affectedDataClassifications includes pii or spdi, each {regulator, instrument, slaTopic, deadlineHours} with deadlineHours copied from the row hours field (6 for CERT-In, SEBI and RBI rows, 72 for the DPDP row; never derived from days and never from memory), with no submittedAt. Incidents:\n' + JSON.stringify(p.incidents, null, 1) : '',
      writerTimeRule, provenanceRule,
      'Then run `node .claude/scripts/validate-data.mjs company-profile/' + companyId + '/soc/main.jsonl` and fix what it reports by appending corrected superseding records. Return {controlIds, observationIds, inconclusiveObservations, findingIds, supersededFindingIds, reopenedFindingIds, riskIds, incidentIds, skipped}, where skipped lists every record you could not write and why. Do not touch summary.md and do not run version.mjs.',
    ].filter(Boolean).join('\n'),
    { label: 'write ' + t.appId + '/' + t.envId, phase: 'Write', agentType: 'soc-ledger-keeper', schema: WRITE_SCHEMA, effort: 'medium' },
  );
  if (!w) {
    skip({ appId: t.appId, envId: t.envId, reason: 'ledger keeper returned no result; ' + p.observations.length + ' observation(s), ' + p.findings.length + ' finding(s), ' + p.risks.length + ' risk(s), ' + p.incidents.length + ' incident(s) NOT written' });
    evidenceRequests.push(...p.requests);
    if (p.incidents.length) cisoAlerts.push({ appId: t.appId, envId: t.envId, tier: t.tier, kind: 'probe-side-effect', incidentIds: [], message: 'CISO: ' + WORKFLOW + ' detected a probe side effect in ' + t.appId + '/' + t.envId + ' but the incident could NOT be written to the ledger; record it manually (dedupKey ' + p.incidents.map((i) => i.dedupKey).join(', ') + '); the CERT-In 6-hour clock may apply' });
    continue;
  }
  noteSession(w);
  const inconclusive = (w.inconclusiveObservations || []).filter((o) => o && o.id);
  for (const k of Object.keys(written)) if (k !== 'inconclusiveObservationIds') written[k].push(...(w[k] || []));
  written.inconclusiveObservationIds.push(...inconclusive.map((o) => o.id));
  for (const s of w.skipped || []) skipped.push({ appId: t.appId, envId: t.envId, reason: 'write: ' + s });
  for (const q of p.requests) { q.observationId = linkObservation(q, inconclusive); evidenceRequests.push(q); }
  if ((w.incidentIds || []).length) cisoAlerts.push({ appId: t.appId, envId: t.envId, tier: t.tier, kind: 'probe-side-effect', incidentIds: w.incidentIds, message: 'CISO: ' + WORKFLOW + ' detected a probe side effect in ' + t.appId + '/' + t.envId + '; see ' + w.incidentIds.join(', ') + ' in company-profile/' + companyId + '/soc/main.jsonl; the CERT-In 6-hour reporting clock may apply' });
  log(t.appId + '/' + t.envId + ': wrote ' + (w.observationIds || []).length + ' observation(s), ' + (w.findingIds || []).length + ' new finding(s), ' + (w.supersededFindingIds || []).length + ' re-seen, ' + (w.reopenedFindingIds || []).length + ' reopened, ' + (w.riskIds || []).length + ' risk(s), ' + (w.incidentIds || []).length + ' incident(s)');
}
for (const q of evidenceRequests) if (!q.observationId) skipped.push({ appId: q.appId, envId: q.envId, reason: 'evidence request ' + (q.checkId || (q.controlIds || []).join(',')) + ' has no inconclusive observation sharing its controlIds; impl-change-management must link it by controlIds' });

let version = null;
const anythingWritten = written.observationIds.length + written.findingIds.length + written.supersededFindingIds.length + written.reopenedFindingIds.length + written.riskIds.length + written.incidentIds.length + written.controlIds.length > 0;
if (anythingWritten) {
  version = await agent(
    'You are the soc-ledger-keeper closing the ' + WORKFLOW + ' probe for company ' + companyId + ' (rules-of-engagement section 10). Run exactly: `node .claude/scripts/soc/version.mjs ' + companyId + ' --session ' + runSessionId + ' --workflow ' + WORKFLOW + '`. It writes company-profile/' + companyId + '/soc/versions/commit_<n>.diff for the lines appended in this run. Never pass --force; if it reports a prefix mismatch return written: false with the message in notes. Return {written, diffPath, notes}.',
    { label: 'version', phase: 'Write', agentType: 'soc-ledger-keeper', schema: VERSION_SCHEMA, effort: 'low' },
  );
  if (!version) skip({ reason: 'version.mjs step returned no result; soc/versions may lack this run\'s diff' });
  else { noteSession(version); log(version.written ? 'ledger version written: ' + (version.diffPath || '?') : 'ledger version NOT written: ' + (version.notes || '?')); }
} else {
  log('nothing was appended to the ledger; version.mjs skipped');
}

// ---- Phase 6: Summary ----------------------------------------------------------------------------------------------
phase('Summary');
let summary = null;
if (dryRun) {
  log('dry run: summary.md left unchanged (plans live in the inconclusive DRY RUN observations)');
} else if (!anythingWritten) {
  log('nothing was written to the ledger; summary.md left unchanged');
} else {
  const sections = ['control-summary', 'open-findings'].concat(written.riskIds.length ? ['risks'] : []).concat(written.incidentIds.length ? ['incidents'] : []);
  summary = await agent(
    [
      'You are the report-writer. Refresh the ' + sections.map((s) => '"' + s + '"').join(', ') + ' section(s) of company-profile/' + companyId + '/summary.md after the ' + WORKFLOW + ' workflow. Read .claude/skills/report-templates/SKILL.md and .claude/skills/maxwell-conventions/SKILL.md first and follow their section templates and [fnd_...]/[obs_...] citation style.',
      'Source of truth: company-profile/' + companyId + '/soc/main.jsonl (latest record per id; follow supersedes). This run: ' + written.findingIds.length + ' new finding(s) ' + JSON.stringify(written.findingIds) + ', ' + written.supersededFindingIds.length + ' re-seen, ' + written.reopenedFindingIds.length + ' reopened, ' + written.observationIds.length + ' observation(s) (' + written.inconclusiveObservationIds.length + ' inconclusive), ' + written.riskIds.length + ' risk(s) ' + JSON.stringify(written.riskIds) + ', ' + written.incidentIds.length + ' incident(s) ' + JSON.stringify(written.incidentIds) + ', ' + evidenceRequests.length + ' evidence request(s) pending, ' + perTarget.length + ' environment(s) covered: ' + perTarget.map((p) => p.target.appId + '/' + p.target.envId + ' [' + p.target.mode + (p.target.blockers.length ? ': ' + p.target.blockers.join('; ') : '') + ']').join(', ') + '. Call out blocked environments and UNVERIFIED observations as coverage gaps.',
      'Edit only those sections and the frontmatter (bump version, keep "sections" accurate, recompute provenance.inputsHash as the company-summary schema describes). Do not create any other file.',
      'Time: provenance.generatedAt = ' + now + '. Never read the clock.', provenanceRule,
      'Validate with `node .claude/scripts/validate-data.mjs company-profile/' + companyId + '/summary.md` and return {updated, sections, openFindings, controlsAssessed, bySeverity, version, notes}.',
    ].join('\n'),
    { label: 'summary', phase: 'Summary', agentType: 'report-writer', schema: SUMMARY_SCHEMA, effort: 'medium' },
  );
  if (!summary) skip({ reason: 'report-writer returned no result; summary.md may be stale' });
  else { noteSession(summary); log('summary.md: ' + summary.openFindings + ' open finding(s), version ' + (summary.version || '?')); }
}

if (cisoAlerts.length) log('CISO ALERT: ' + cisoAlerts.map((a) => a.message).join(' | '));
log('done: ' + written.observationIds.length + ' observation(s), ' + written.findingIds.length + ' finding(s), ' + written.riskIds.length + ' risk(s), ' + written.incidentIds.length + ' incident(s), ' + evidenceRequests.length + ' evidence request(s), ' + roeViolations.length + ' RoE violation(s), ' + skipped.length + ' skipped item(s)');
return {
  companyId,
  workflow: WORKFLOW,
  dryRun,
  now,
  sessionId: runSessionId,
  targets: targets.map((t) => ({ appId: t.appId, envId: t.envId, tier: t.tier, mode: t.mode, blockers: t.blockers, rateLimitPerMinute: t.rate })),
  commandsExecuted: perTarget.reduce((n, p) => n + (p.target.mode === 'probe' ? p.probe.commandsExecuted || 0 : 0), 0),
  controls: written.controlIds.length,
  observations: written.observationIds.length,
  findings: written.findingIds.length,
  reseenFindings: written.supersededFindingIds.length,
  reopenedFindings: written.reopenedFindingIds.length,
  risks: written.riskIds.length,
  incidents: written.incidentIds.length,
  initiatives: 0,
  suggestions: 0,
  ids: written,
  version,
  summary,
  evidenceRequests,
  cisoAlerts,
  roeViolations,
  probeNotes,
  skipped,
  sessionIds: [...sessionIds],
};
