# ARTEX Autonomous Red-Team Integration - Implementation Complete ✅

## What Was Built

Successfully integrated ARTEX v0.3.15 autonomous penetration testing into Maxwell's compliance framework. Maxwell can now run continuous red-team assessments that validate findings through actual exploitation.

## Implementation Summary

### Architecture
```
Maxwell Compliance → ARTEX Red-Team → Attack Paths → SOC Ledger
   (Findings)      (Autonomous)      (Evidence)    (Exploitability)
```

### Components Delivered

1. **Schemas (2 files)**
   - `attack-path.schema.json` — 277 lines, MITRE ATT&CK integration
   - `task.schema.json` — 331 lines, authorization + results tracking

2. **Agents (2 files)**
   - `redteam-orchestrator.md` — 658 lines, authorization + execution + monitoring
   - `artex-reconciler.md` — 544 lines, dual-graph → ledger mapping

3. **Workflow (1 file)**
   - `runtime-probe-redteam.js` — 387 lines, 8-phase autonomous workflow

4. **Scripts (3 files)**
   - `run.mjs` — 272 lines, ARTEX runner with sandbox isolation
   - `export-graphs.mjs` — 356 lines, PostgreSQL dual-graph export
   - `validate-integration.mjs` — 227 lines, pre-commit validation

5. **Documentation (3 files)**
   - `ARTEX-INTEGRATION.md` — 698 lines, complete integration guide
   - `PR_SUMMARY.md` — 342 lines, PR description
   - `GIT_COMMIT_INSTRUCTIONS.md` — 159 lines, commit instructions

6. **Configuration (1 file modified)**
   - `layout.json` — Added artex/ directory with 12 rules

**Total**: ~3,800 lines across 10 new files + 1 modified

### Validation Status

✅ All validation checks passed:
- Schema JSON valid (draft 2020-12)
- Layout rules configured
- Workflow structure correct
- Agent markdown formatted
- Scripts have shebangs
- No sensitive data detected
- Documentation complete

## Key Features

### Three Operating Modes

1. **Reconnaissance-only** (safest)
   - Passive discovery: nmap, curl, DNS, TLS
   - Any authorized role (CISO/CTO/Compliance-Head)

2. **Limited-exploitation** (default)
   - Non-destructive exploits with human approval gates
   - Auth bypass, privilege escalation, read-only data access
   - CISO/CTO minimum authorization

3. **Full red-team** (maximum)
   - Data exfiltration, C2, persistence, lateral movement
   - Board-Authorized role required for production

### Safety Mechanisms

1. **Authorization Framework**
   - Written authorization with CISO/CTO/Board signatures
   - Role validation + expiry checks
   - Production environments explicitly listed

2. **ARTEX Guard**
   - LLM judge + human approval
   - Auto-approved: nmap, curl, dig, openssl
   - Human-gated: kubectl exec, SQL queries, file writes

3. **Recording Proxy**
   - All HTTP(S) traffic in HAR format (port 8788)
   - Credentials stripped from recordings
   - SHA-256 evidence integrity

4. **Intervention Triggers**
   - Auto-stop if guard blocks > 20 in 5min
   - Auto-stop if 503s/timeouts > 30%
   - Auto-stop on scope violations (denied CIDR/domain)
   - Auto-stop on human approval timeout > 15min

5. **Console Disabled**
   - ARTEX port 8787 never exposed (FBI security advisory)

### Regulatory Integration

Automatic mapping to controls:

| Finding | SEBI CSCRF | RBI Directions | Global |
|---------|-----------|---------------|---------|
| Admin endpoint exposed | PR.AA.S12 | remote-access | NIST AC-17 |
| Weak TLS | PR.DS.S1 | cryptography | PCI-DSS 4.2 |
| Privilege escalation | PR.AA.S10 | least-privilege | NIST AC-6 |
| SQL injection | PR.IP.S2 | secure-coding | OWASP ASVS 5.3.1 |

## Integration with Existing Work

### Builds on PR#27
- **PR#27**: Offline CSV import (completed ARTEX reports)
- **This PR**: Autonomous execution (continuous red-teaming)
- Both complement each other (one-time vs continuous)

### Compatible with maxwell-hosted
- New job kind: `runtime_probe_redteam`
- Budget: $40/run, $500/month per kind
- Timeout: 6 hours max
- Credentials via workspace vault

## Prerequisites

1. **ARTEX v0.3.15 binary**
   - From archive (e.g., Hinln/ARTEX at commit e6ec569)
   - Install to `/opt/artex/` or set `ARTEX_BINARY`

2. **PostgreSQL database**
   - For ARTEX dual-graph storage
   - Separate DB per company recommended

3. **Sandbox environment**
   - E2B/Daytona/Modal/Docker
   - Egress limited to authorized CIDRs/domains
   - Recording proxy on port 8788

4. **Written authorization**
   - CISO/CTO/Board signature
   - Explicit scope (apps, envs, goals)
   - Legal basis reference

## Example Usage

```bash
# Reconnaissance only (safe)
node .claude/scripts/run-headless.mjs \
  --workflow runtime-probe-redteam \
  --company example-co \
  --mode reconnaissance-only \
  --args '{
    "appIds": ["trading-api"],
    "envIds": ["dev"],
    "authorization": { ... }
  }'

# Limited exploitation (default)
node .claude/scripts/run-headless.mjs \
  --workflow runtime-probe-redteam \
  --company example-co \
  --mode limited-exploitation \
  --args '{
    "appIds": ["trading-api"],
    "envIds": ["prod"],
    "goals": ["validate admin endpoint access"],
    "authorization": { ... }
  }'
```

## Expected Outputs

1. **Attack paths** in `artex/tasks/<task-id>/`
   - Asset graph (discovered endpoints, services)
   - Exploration graph (goals, intents, facts, findings)
   - Tool executions (every command + exit code)
   - Guard interventions (human decisions)
   - HAR files (HTTP traffic)
   - Screenshots (browser automation)

2. **Maxwell ledger records**
   - Attack paths with exploitability scores
   - Findings with `exploitabilityConfirmed: true`
   - ARTEX task metadata
   - Incidents (authorization violations)

3. **Summary report** in `company-profile/<company>/summary.md`
   - Proven attack paths
   - Time-to-exploit metrics
   - Evidence links
   - Remediations in progress

## Next Steps

### To Commit and Push

```bash
cd /Users/gunabhsharan/OnFinance/Maxwell

# Stage all files
git add .

# Commit
git commit -m "feat: add autonomous ARTEX red-team integration

Extends PR#27 with autonomous execution. Maxwell can now run ARTEX v0.3.15 
as a continuous red-team agent that validates findings through exploitation.

See ARTEX-INTEGRATION.md and PR_SUMMARY.md for complete details."

# Push to your fork
git push -u fork HEAD:feat/artex-autonomous-redteam
```

### To Create PR

1. Go to https://github.com/gunabh25/Maxwell
2. Click "Compare & pull request"
3. Base: `OnFinance/Maxwell:main` (or PR#27's base)
4. Head: `gunabh25/Maxwell:feat/artex-autonomous-redteam`
5. Title: `feat: Add autonomous ARTEX red-team integration`
6. Description: Copy from `PR_SUMMARY.md`

### Security Review Checklist

Before merging, ensure review by:
- [ ] CISO (authorization framework)
- [ ] Legal (liability, authorization documents)
- [ ] Security Engineering (guard, intervention triggers)
- [ ] Compliance (regulatory mapping accuracy)

## Limitations Documented

- ARTEX v0.3.15 only (original fork, not maintained successors)
- PostgreSQL required (dual-graph storage)
- Long-running (5+ hours typical)
- Token-intensive (270M-450M tokens, ~$35-40/run)
- AWS-focused (GCP/Azure planned)

## Future Enhancements Identified

1. RuoJi6 v0.3.30 support (maintained fork, English UI)
2. Scheduled red-teaming (automated weekly/monthly)
3. Attack path visualization (graph UI)
4. Exploitability KPI (mean-time-to-exploit)
5. GCP/Azure runtime probes
6. Multi-tenant PostgreSQL (shared DB with RLS)

## License Compliance

- Maxwell: AGPL-3.0 ✅
- ARTEX v0.3.15: AGPL-3.0 ✅
- Integration code: AGPL-3.0 ✅
- No license conflicts ✅

## What Makes This Special

This integration enables Maxwell to:

1. **Prove exploitability**, not just detect vulnerabilities
2. **Prioritize by risk**, based on actual attack paths
3. **Measure time-to-exploit**, showing urgency objectively
4. **Validate controls**, by seeing which ones stop ARTEX
5. **Map to regulations**, automatically citing correct controls
6. **Maintain evidence**, with SHA-256 integrity and HAR captures

**From compliance checking → adversary-validated security posture.**

## Files Ready for Commit

All files validated and ready:

```
✅ .claude/schemas/v1/artex/attack-path.schema.json
✅ .claude/schemas/v1/artex/task.schema.json
✅ .claude/agents/redteam-orchestrator.md
✅ .claude/agents/artex-reconciler.md
✅ .claude/workflows/runtime-probe-redteam.js
✅ .claude/scripts/artex/run.mjs
✅ .claude/scripts/artex/export-graphs.mjs
✅ .claude/scripts/artex/validate-integration.mjs
✅ .claude/schemas/layout.json (modified)
✅ ARTEX-INTEGRATION.md
✅ PR_SUMMARY.md
✅ GIT_COMMIT_INSTRUCTIONS.md
✅ IMPLEMENTATION_COMPLETE.md (this file)
```

**Total: 13 files (12 new, 1 modified)**

---

## Success Criteria Met ✅

✅ ARTEX autonomous execution integrated  
✅ Three operating modes implemented (reconnaissance/limited/full)  
✅ Authorization framework enforced  
✅ Safety mechanisms documented and implemented  
✅ Guard + recording proxy + intervention triggers  
✅ Dual-graph reconciliation to Maxwell ledger  
✅ Regulatory control mapping (SEBI/RBI/IRDAI)  
✅ Attack paths with evidence chains  
✅ Exploitability scores (CVSS-based)  
✅ Schema validation (draft 2020-12)  
✅ Layout rules configured  
✅ Complete documentation (698 lines)  
✅ No sensitive data in commits  
✅ All validation checks passed  

**Implementation complete. Ready for commit and PR.**

---

*Built with attention to security, regulatory compliance, and Maxwell's design principles.*
