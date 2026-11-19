# PR: Add Autonomous ARTEX Red-Team Integration to Maxwell

## Summary

Extends PR#27's offline ARTEX CSV import with **autonomous execution capability**. Maxwell can now run ARTEX v0.3.15 as a continuous red-team agent that validates compliance findings through actual exploitation, discovers attack paths, and proves exploitability with evidence chains.

## What Changed

### New Schemas (2 files)
- `.claude/schemas/v1/artex/attack-path.schema.json` — Attack path records with exploitation steps, evidence, MITRE ATT&CK mapping
- `.claude/schemas/v1/artex/task.schema.json` — ARTEX task metadata, authorization, results, reconciliation status

### New Agents (2 files)
- `.claude/agents/redteam-orchestrator.md` — Orchestrates ARTEX execution: authorization validation, task configuration, real-time monitoring, intervention triggers
- `.claude/agents/artex-reconciler.md` — Maps ARTEX dual-graph to Maxwell ledger: attack paths, exploitability scores, regulatory citations, evidence integrity

### New Workflow (1 file)
- `.claude/workflows/runtime-probe-redteam.js` — End-to-end autonomous red-team workflow with 8 phases (authorize → execute → reconcile → refute → write → report)

### New Scripts (2 files)
- `.claude/scripts/artex/run.mjs` — ARTEX runner: spawns v0.3.15 binary in sandbox, configures dual-graph, enforces scope boundaries, collects evidence
- `.claude/scripts/artex/export-graphs.mjs` — Exports ARTEX PostgreSQL graphs (asset graph, exploration graph, tool executions, guard interventions) after task completion

### Modified Files (1 file)
- `.claude/schemas/layout.json` — Added `artex/` to rootEntries and rules for task directories (graphs, HAR files, screenshots, logs)

### Documentation (1 file)
- `ARTEX-INTEGRATION.md` — Complete integration guide: architecture, prerequisites, usage modes, safety mechanisms, regulatory mapping, limitations

## How It Works

```
Maxwell Compliance Probes → Findings
                                ↓
                        runtime-probe-redteam
                                ↓
                    ┌───────────────────────┐
                    │ redteam-orchestrator  │
                    │ 1. Validate auth      │
                    │ 2. Check prerequisites│
                    │ 3. Configure ARTEX    │
                    │ 4. Execute (5h max)   │
                    │ 5. Monitor guard      │
                    └───────────┬───────────┘
                                ↓
                    ┌───────────────────────┐
                    │ ARTEX v0.3.15         │
                    │ • Planner (800ms)     │
                    │ • 3 Workers (parallel)│
                    │ • Guard (LLM + human) │
                    │ • Proxy (port 8788)   │
                    └───────────┬───────────┘
                                ↓
                    ┌───────────────────────┐
                    │ artex-reconciler      │
                    │ • Build attack paths  │
                    │ • Map to controls     │
                    │ • Calculate scores    │
                    │ • SHA-256 evidence    │
                    └───────────┬───────────┘
                                ↓
                    Maxwell SOC Ledger (append-only)
```

## Three Operating Modes

### 1. Reconnaissance Only
- **Authorization**: Any role (CISO/CTO/Compliance-Head)
- **What it does**: nmap, curl, DNS, TLS handshake (passive)
- **What it doesn't**: No exploitation, no auth bypass, no data access

### 2. Limited Exploitation (Default)
- **Authorization**: CISO/CTO minimum
- **What it does**: Auth bypass, privilege escalation, read-only data access
- **Human approval required**: Production data, root/cluster-admin, persistence
- **Prohibited**: Data modification, deletion, service disruption

### 3. Full Red-Team
- **Authorization**: Board-Authorized (for production)
- **What it adds**: Data exfiltration, C2, lateral movement
- **Still prohibited**: Data deletion, service disruption, third-party systems

## Safety Mechanisms

1. **Authorization Enforcement**
   - Written authorization required (authorizedBy, validUntil, legalBasis)
   - Role validation (CISO/CTO/Board-Authorized)
   - Production environments must be explicitly listed
   - Expiry checks (validUntil > now)

2. **ARTEX Guard**
   - Every tool call passes intercept rules → LLM judge → human approval
   - Auto-approved: nmap, curl, dig, openssl
   - Human required: kubectl exec, SQL queries, file writes
   - Guard log: `/workspace/artex/tasks/<id>/guard-log.jsonl`

3. **Recording Proxy**
   - All HTTP(S) traffic captured in HAR format (port 8788)
   - Credentials stripped from recordings
   - Evidence integrity (SHA-256 all artifacts)

4. **Intervention Triggers**
   - Maxwell stops ARTEX if:
     - Guard blocks > 20 in 5min (unexpected control)
     - 503s/timeouts > 30% (service disruption)
     - Denied CIDR/domain accessed (scope violation)
     - Human approval timeout > 15min

5. **Console Disabled**
   - ARTEX port 8787 never exposed (FBI warning about 1600+ exposed instances)
   - Runs headless only

## Example Usage

```bash
node .claude/scripts/run-headless.mjs \
  --workflow runtime-probe-redteam \
  --company example-co \
  --mode limited-exploitation \
  --args '{
    "appIds": ["trading-api"],
    "envIds": ["prod"],
    "goals": [
      "validate unauthenticated admin endpoint access",
      "attempt privilege escalation to cluster-admin"
    ],
    "authorization": {
      "authorizedBy": {
        "name": "Rajesh Kumar",
        "email": "ciso@example.com",
        "role": "CISO"
      },
      "authorizedAt": "2026-11-20T10:00:00Z",
      "validUntil": "2026-11-22T23:59:59Z",
      "legalBasis": "Email authorization ref: CISO-AUTH-2026-11-20-001"
    }
  }'
```

**Output**: Attack paths proven, findings with exploitabilityConfirmed, evidence in `artex/tasks/<id>/`

## Regulatory Mapping

ARTEX findings automatically mapped to controls:

| Finding Type | SEBI CSCRF | RBI Directions | Global |
|---|---|---|---|
| Admin endpoint exposed | PR.AA.S12 | remote-access | NIST AC-17 |
| Weak TLS | PR.DS.S1 | cryptography | PCI-DSS 4.2 |
| Privilege escalation | PR.AA.S10 | least-privilege | NIST AC-6 |
| SQL injection | PR.IP.S2 | secure-coding | OWASP ASVS 5.3.1 |

## Prerequisites

1. **ARTEX v0.3.15**: Original fork (from archive, e.g., Hinln/ARTEX at commit e6ec569)
2. **PostgreSQL**: For ARTEX dual-graph storage
3. **Sandbox**: E2B/Daytona/Modal/Docker with egress limited to authorized CIDRs
4. **Authorization**: Written document with CISO/CTO/Board signature

## Integration with maxwell-hosted

For the SaaS version:

- New job kind: `runtime_probe_redteam`
- Budget: $40/run, $500/kind/month
- Timeout: 6 hours max
- Credentials: Delivered via workspace vault
- Authorization UI: Console form to upload/validate authorization document

## Limitations

- **ARTEX v0.3.15 only**: Original fork (not maintained RuoJi6 v0.3.30 yet)
- **PostgreSQL required**: ARTEX needs Postgres for its dual-graph
- **Long-running**: 5+ hours typical (blocks sandbox)
- **Token-intensive**: 270M-450M tokens/run (~$35-40)
- **AWS-focused**: Runtime probes currently AWS (GCP/Azure planned)

## Testing

### Before merging:
1. Validate schemas: `npm run validate`
2. Test reconnaissance mode (dry-run safe)
3. Verify layout rules accept artex directory
4. Check agent markdown formatting
5. Confirm workflow JavaScript syntax

### After ARTEX binary installed:
1. Reconnaissance-only mode on dev environment
2. Limited-exploitation with human approval
3. Authorization validation (expired, wrong role, missing legalBasis)
4. Guard intervention triggers (>20 blocks)
5. Evidence integrity (SHA-256, credential stripping)

## Relation to PR#27

**PR#27 (existing)**: Offline import of completed ARTEX CSV exports
- Human runs ARTEX separately
- Exports findings as CSV
- Maxwell imports via `npm run import:artex`

**This PR**: Autonomous execution
- Maxwell runs ARTEX directly
- Real-time monitoring and intervention
- Automatic reconciliation to ledger
- Attack path construction with evidence

Both complement each other:
- Use offline import for one-time assessments
- Use autonomous execution for continuous red-teaming

## Future Enhancements

1. RuoJi6 v0.3.30 support (maintained fork, English UI, Docker images)
2. Scheduled red-teaming (weekly/monthly automated runs)
3. Attack path visualization (graph UI)
4. Exploitability KPI (mean-time-to-exploit)
5. GCP/Azure runtime probes
6. Multi-tenant PostgreSQL (shared DB with RLS)

## Files Changed

**Added (9 files)**:
- `.claude/schemas/v1/artex/attack-path.schema.json` (277 lines)
- `.claude/schemas/v1/artex/task.schema.json` (331 lines)
- `.claude/agents/redteam-orchestrator.md` (658 lines)
- `.claude/agents/artex-reconciler.md` (544 lines)
- `.claude/workflows/runtime-probe-redteam.js` (387 lines)
- `.claude/scripts/artex/run.mjs` (272 lines)
- `.claude/scripts/artex/export-graphs.mjs` (356 lines)
- `ARTEX-INTEGRATION.md` (698 lines)
- `PR_SUMMARY.md` (this file)

**Modified (1 file)**:
- `.claude/schemas/layout.json` (+48 lines: artex rootEntry + 12 rules)

**Total**: ~3,571 lines of new code + documentation

## Checklist

- [ ] Schemas validated (`npm run validate`)
- [ ] No syntax errors in workflow JS
- [ ] Agent markdown formatting correct
- [ ] Layout.json accepts artex directory
- [ ] Documentation complete (ARTEX-INTEGRATION.md)
- [ ] PR summary explains integration clearly
- [ ] Safety mechanisms documented
- [ ] Authorization enforcement explained
- [ ] Integration with PR#27 clarified
- [ ] Future enhancements noted

## Security Review Required

⚠️ **This PR adds offensive security capabilities**. Requires review by:
- CISO (authorization framework)
- Legal (liability, authorization documents)
- Security Engineering (guard implementation, intervention triggers)
- Compliance (regulatory mapping accuracy)

## License Compliance

- Maxwell: AGPL-3.0 (existing)
- ARTEX v0.3.15: AGPL-3.0 (compatible)
- Integration code: AGPL-3.0 (this PR)

No license conflicts.
