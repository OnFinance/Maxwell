# ARTEX Autonomous Red-Team Integration

This document describes Maxwell's integration with ARTEX (original v0.3.15) for autonomous penetration testing and exploitability validation.

## Overview

Maxwell now supports two modes of ARTEX integration:

1. **Offline import** (PR#27 - existing): Import completed ARTEX CSV exports into Maxwell's ledger
2. **Autonomous execution** (this PR): Run ARTEX as Maxwell's continuous red-team agent

This integration enables Maxwell to:
- **Validate exploitability**: Prove that compliance gaps are actually exploitable, not just theoretical
- **Discover attack paths**: Show step-by-step exploitation sequences with evidence
- **Prioritize remediations**: Escalate findings proven exploitable to critical priority
- **Measure time-to-exploit**: Track how quickly vulnerabilities can be weaponized

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Maxwell Workspace                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────┐           ┌──────────────────────────┐    │
│  │ Compliance Probes  │           │   ARTEX Red-Team Agent   │    │
│  │ (Static + Runtime) │           │  (Autonomous Offensive)  │    │
│  ├────────────────────┤           ├──────────────────────────┤    │
│  │ probe-iac          │           │ Planner (debounced 800ms)│    │
│  │ probe-app-chart    │──findings─▶ 3 Workers (parallel)     │    │
│  │ probe-cicd-env     │           │ Guard (human approval)   │    │
│  │ runtime-probe-*    │           │ Recording Proxy (8788)   │    │
│  └────────────────────┘           └──────────┬───────────────┘    │
│           │                                   │                     │
│           │                                   │                     │
│           ▼                                   ▼                     │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │              artex-reconciler Agent                         │   │
│  │  Maps ARTEX dual-graph → Maxwell SOC ledger                │   │
│  │  • Attack paths with evidence chains                       │   │
│  │  • Exploitability scores (CVSS-based)                      │   │
│  │  • Regulatory control citations                            │   │
│  │  • Time-to-exploit metrics                                 │   │
│  └────────────────────────┬───────────────────────────────────┘   │
│                            │                                        │
│                            ▼                                        │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │           Maxwell SOC Ledger (append-only)                 │   │
│  │  • Findings (exploitabilityConfirmed: true)                │   │
│  │  • Attack paths (path_ULID)                                │   │
│  │  • ARTEX task records                                       │   │
│  │  • Incidents (authorization violations)                     │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

### 1. ARTEX Binary

Install ARTEX v0.3.15 original (from archive):

```bash
# Download from archive (e.g., Hinln/ARTEX or other archive fork at v0.3.15 commit e6ec569)
git clone https://github.com/Hinln/ARTEX.git
cd ARTEX
git checkout e6ec569  # Last open release v0.3.15

# Build
go build -o artex .

# Install to /opt/artex/ or set ARTEX_BINARY env var
sudo mkdir -p /opt/artex
sudo cp artex /opt/artex/
```

### 2. PostgreSQL Database

ARTEX requires PostgreSQL for its dual-graph storage:

```bash
# Docker
docker run -d --name artex-postgres \
  -e POSTGRES_USER=artex \
  -e POSTGRES_PASSWORD=<secure-password> \
  -e POSTGRES_DB=artex_maxwell \
  -p 5432:5432 \
  postgres:15

# Or use existing Postgres instance and create database
createdb artex_maxwell
```

### 3. Sandbox Environment

ARTEX runs in a sandboxed environment with:
- Egress limited to authorized CIDRs/domains
- Read-only credentials only
- Recording proxy on port 8788
- No console access (port 8787 disabled)

Supported sandboxes:
- E2B
- Daytona
- Modal
- Vercel Sandbox
- AWS Lambda MicroVMs
- Docker (local)

### 4. Authorization

**Critical**: ARTEX requires explicit written authorization:

```json
{
  "authorizedBy": {
    "name": "Rajesh Kumar",
    "email": "ciso@example.com",
    "role": "CISO"  // or "CTO", "Compliance-Head", "Board-Authorized"
  },
  "authorizedAt": "2026-11-20T10:00:00Z",
  "validUntil": "2026-11-22T23:59:59Z",
  "legalBasis": "Email authorization ref: CISO-AUTH-2026-11-20-001",
  "notificationContacts": [
    "ciso@example.com",
    "security-team@example.com"
  ]
}
```

**Production red-teaming** requires:
- **Board-Authorized role** for `full-redteam` mode
- **CISO or CTO** minimum for `limited-exploitation`
- **Any authorized role** for `reconnaissance-only`

## Usage

### Mode 1: Reconnaissance Only (Safest)

Passive discovery only - no exploitation attempts:

```bash
node .claude/scripts/run-headless.mjs \
  --workflow runtime-probe-redteam \
  --company example-co \
  --mode reconnaissance-only \
  --args '{
    "appIds": ["trading-api"],
    "envIds": ["prod"],
    "authorization": {
      "authorizedBy": {"name": "...", "email": "...", "role": "CISO"},
      "authorizedAt": "2026-11-20T10:00:00Z",
      "validUntil": "2026-11-22T23:59:59Z",
      "legalBasis": "Email ref: CISO-AUTH-2026-11-20-001"
    }
  }'
```

**What it does:**
- nmap port scans on allowed domains
- curl HTTP requests to enumerate endpoints
- DNS lookups
- TLS handshake analysis
- Service version detection

**What it doesn't do:**
- Exploitation attempts
- Authentication bypass
- Brute force
- Data modification

### Mode 2: Limited Exploitation (Default)

Non-destructive exploitation with human approval gates:

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
    "authorization": { ... }
  }'
```

**What it does:**
- Everything from reconnaissance mode
- Authentication bypass attempts
- Authorization testing
- Privilege escalation attempts
- Read-only data access validation

**Requires human approval for:**
- Accessing production data
- Executing commands as root/cluster-admin
- Establishing persistence
- Lateral movement

**Prohibited:**
- Data modification
- Data deletion
- Service disruption
- Third-party system access

### Mode 3: Full Red-Team (Maximum Authorization)

Complete offensive capabilities (Board authorization required for production):

```bash
node .claude/scripts/run-headless.mjs \
  --workflow runtime-probe-redteam \
  --company example-co \
  --mode full-redteam \
  --args '{
    "appIds": ["trading-api"],
    "envIds": ["prod"],
    "goals": [
      "prove complete compromise of trading-api",
      "demonstrate data exfiltration path"
    ],
    "authorization": {
      "authorizedBy": {"name": "Board Chair", "email": "...", "role": "Board-Authorized"},
      ...
    }
  }'
```

**Adds to limited-exploitation:**
- Data exfiltration simulation
- Command & control establishment
- Persistence mechanisms
- Lateral movement

**Still prohibited:**
- Data deletion (creates compliance incident)
- Service disruption (availability impact)
- Third-party systems (legal/contractual risk)

## Outputs

### 1. Attack Paths

Stored in Maxwell's ledger and artex directory:

```
artex/
└── tasks/
    └── artex-task-abc123/
        ├── asset-graph.json           # ARTEX discovered assets
        ├── exploration-graph.json     # Goals, intents, facts, findings
        ├── tool-executions.json       # Every command run
        ├── guard-interventions.json   # Human approval decisions
        ├── export-metadata.json       # SHA-256, stats
        ├── execution.log              # ARTEX stdout/stderr
        ├── guard-log.jsonl            # Live guard decisions
        ├── proxy-captures/
        │   ├── step-001.har           # HTTP traffic recording
        │   ├── step-002.har
        │   └── complete.har
        └── screenshots/
            ├── step-003-db-console.png
            └── admin-panel.png
```

### 2. Maxwell Ledger Records

Three types appended to `company-profile/<company-id>/soc/main.jsonl`:

**Attack Path:**
```json
{
  "kind": "attack-path",
  "id": "path_01XXXXX",
  "goal": "access production database without authentication",
  "outcome": "goal-proven",
  "severity": "critical",
  "exploitabilityScore": 9.2,
  "timeToExploit": {"duration": 8, "unit": "minutes"},
  "steps": [...],
  "evidence": [...]
}
```

**Finding (updated):**
```json
{
  "kind": "finding",
  "id": "fnd_01XXXXX",
  "title": "Admin endpoint exposed on port 8080",
  "exploitabilityConfirmed": true,
  "exploitabilityScore": 9.2,
  "attackPathIds": ["path_01XXXXX"],
  "remediationPriority": "critical-now"
}
```

**ARTEX Task:**
```json
{
  "kind": "artex-task",
  "id": "artex_01XXXXX",
  "status": "completed",
  "results": {
    "assetsDiscovered": 47,
    "findingsGenerated": 12,
    "attackPathsProven": 3,
    "guardInterventions": 8
  }
}
```

### 3. Summary Report

Added to `company-profile/<company-id>/summary.md`:

```markdown
## Autonomous Red-Team Assessment

**Last run**: 2026-11-21 14:00 UTC  
**Duration**: 5.2 hours  
**Mode**: Limited exploitation  
**Authorization**: CISO (valid until 2026-11-23)

### Proven Attack Paths
1. **[CRITICAL]** Unauthenticated database access via exposed admin endpoint
   - Time to exploit: 8 minutes
   - Evidence: [Recording](artex/tasks/artex-task-abc123/proxy-captures/step-002.har)
   - **Blocked by**: ARTEX guard before PII query

2. **[HIGH]** Cluster privilege escalation via RBAC misconfiguration
   - Time to exploit: 23 minutes
   - **Blocked by**: MFA requirement
```

## Safety Mechanisms

### 1. Authorization Enforcement

- Written authorization required with role validation
- Expiry checks (validUntil must be in future)
- Production environments must be explicitly listed
- Board authorization for full-redteam on production

### 2. ARTEX Guard

Every tool execution passes through guard:

```
┌─────────────┐
│ ARTEX Worker│
│ wants to run│
│ kubectl exec│
└──────┬──────┘
       │
       ▼
┌─────────────┐    ┌──────────────┐
│ Guard: LLM  │───▶│ Intercept    │
│ Judge       │    │ Rules        │
└──────┬──────┘    └──────────────┘
       │
       ▼
┌─────────────┐
│ Human       │ (for sensitive actions)
│ Approval    │
└──────┬──────┘
       │
       ▼
  ✓ Approved / ✗ Blocked
```

Auto-approved tools: nmap, curl, dig, openssl  
Human approval required: kubectl exec, SQL queries, file writes

### 3. Recording Proxy

All HTTP(S) traffic captured on port 8788:
- Request/response pairs in HAR format
- Timing data
- No credential leakage (guard strips auth headers)

### 4. Intervention Triggers

Maxwell stops ARTEX immediately if:
- **Guard blocks > 20 in 5 minutes** (hitting unexpected control)
- **503s or timeouts > 30% of requests** (service disruption)
- **Denied CIDR or domain accessed** (authorization violation)
- **Human approval timeout > 15 minutes** (no response)

Incidents are logged to SOC ledger with CISO notification.

## Regulatory Mapping

ARTEX findings map to regulatory controls:

| Finding | SEBI | RBI | IRDAI | CERT-In | Global |
|---|---|---|---|---|---|
| Admin endpoint exposed | PR.AA.S12 | remote-access | Section 3.4 | Annex-I.iv | NIST AC-17 |
| Weak TLS | PR.DS.S1 | cryptography | Section 4.2 | - | PCI-DSS 4.2 |
| Privilege escalation | PR.AA.S10 | least-privilege | Section 3.3 | - | NIST AC-6 |
| SQL injection | PR.IP.S2 | secure-coding | Section 5.1 | - | OWASP ASVS 5.3.1 |

Maxwell's reconciler automatically cites the correct control for the company's entity types.

## Integration with maxwell-hosted

For the hosted SaaS version (maxwell-hosted), this integration adds:

1. **New job kind**: `runtime_probe_redteam` in the pack
2. **Credentials**: ARTEX task credentials delivered via workspace vault
3. **Egress rules**: ARTEX sandbox gets broader network access (customer-authorized CIDRs)
4. **Budget**: ARTEX runs are metered (5h x 450M tokens ≈ $35-40/run)
5. **Authorization UI**: Console form to upload authorization document

The pack's `pack.json` would declare:

```json
{
  "kinds": [
    {
      "id": "runtime_probe_redteam",
      "budget_usd": 40,
      "month_budget_usd": 500,
      "timeout_seconds": 21600
    }
  ]
}
```

## Limitations

### Current Implementation

- **ARTEX v0.3.15 only**: Original fork, not maintained successors
- **PostgreSQL required**: ARTEX's dual-graph needs Postgres
- **AWS-focused**: Runtime probes currently target AWS (GCP/Azure planned)
- **No multi-tenant**: Each company gets isolated ARTEX task/DB

### Known Security Considerations

- **ARTEX console disabled**: Port 8787 never exposed (FBI warning)
- **Login bypass in v0.3.14**: We use v0.3.15 (patched)
- **Network blast radius**: ARTEX gets broader egress than other probes (by design)
- **Evidence integrity**: SHA-256 all artifacts, strip credentials from HAR files

### Operational Constraints

- **Long-running**: 5+ hours typical (blocks sandbox)
- **Token-intensive**: 270M-450M tokens/run (expensive)
- **Human-in-loop**: Limited/full modes need approval responses
- **PostgreSQL management**: Cleanup, backups, migrations needed

## Future Enhancements

1. **Multi-tenant PostgreSQL**: Shared DB with row-level security per company
2. **RuoJi6 v0.3.30 support**: Maintained fork with English UI, Docker images
3. **Scheduled red-teaming**: Weekly/monthly automated runs
4. **Attack path visualization**: Graph UI showing exploitation chains
5. **Exploitability KPI**: Add to Maxwell's 6 KPIs (mean-time-to-exploit)
6. **Cloud provider parity**: GCP/Azure runtime probes
7. **Continuous validation**: Re-run ARTEX after remediation to confirm fix

## References

- [ARTEX Independent Guide](https://www.artex.sh/)
- [Original ARTEX](https://github.com/Autumn-27/ARTEX) (deleted 2026-10-08)
- [Hinln/ARTEX Archive](https://github.com/Hinln/ARTEX) (v0.3.15 preserved)
- [RuoJi6/ARTEX](https://github.com/RuoJi6/ARTEX) (maintained successor, v0.3.30)
- [Maxwell Compliance Framework](https://github.com/OnFinance/Maxwell)
- [SEBI CSCRF 2024](https://www.sebi.gov.in/)
- [RBI Cyber Directions 2026](https://www.rbi.org.in/)

## Contributing

See main [Maxwell CONTRIBUTING.md](./CONTRIBUTING.md) for:
- Schema changes (MAXWELL_SCHEMA_EDIT=1 required)
- Agent/workflow development
- Testing requirements
- PR checklist

ARTEX-specific:
- Test with reconnaissance-only mode first
- Never commit actual authorization documents (use examples)
- Sanitize HAR files (no real credentials)
- Run `npm run validate` before PR
