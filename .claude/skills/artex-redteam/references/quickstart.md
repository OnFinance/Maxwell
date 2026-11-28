# ARTEX Integration Quick Start Guide

## For Developers: How to Test This Integration

### Step 1: Install ARTEX v0.3.15

```bash
# Clone from archive (Hinln/ARTEX preserves v0.3.15)
git clone https://github.com/Hinln/ARTEX.git
cd ARTEX
git checkout e6ec569  # v0.3.15 commit

# Build
go build -o artex .

# Install
sudo mkdir -p /opt/artex
sudo cp artex /opt/artex/artex
sudo chmod +x /opt/artex/artex

# Verify
/opt/artex/artex --version
# Should show: ARTEX v0.3.15
```

### Step 2: Set Up PostgreSQL

```bash
# Using Docker (easiest)
docker run -d --name artex-postgres \
  -e POSTGRES_USER=artex \
  -e POSTGRES_PASSWORD=artex_dev_password \
  -e POSTGRES_DB=artex_maxwell_dev \
  -p 5432:5432 \
  postgres:15

# Verify connection
psql postgresql://artex:artex_dev_password@localhost:5432/artex_maxwell_dev -c "SELECT version();"
```

### Step 3: Set Up Dev Environment

```bash
cd /Users/gunabhsharan/OnFinance/Maxwell

# Install dependencies (if not already done)
npm ci

# Validate schemas
npm run validate
# Should pass with no errors

# Set environment variables
export ARTEX_BINARY=/opt/artex/artex
export POSTGRES_URL=postgresql://artex:artex_dev_password@localhost:5432/artex_maxwell_dev
```

### Step 4: Dry-Run Test (No ARTEX Execution)

```bash
# Create a test authorization document
cat > /tmp/test-authorization.json << 'EOF'
{
  "authorizedBy": {
    "name": "Dev Test User",
    "email": "dev@test.local",
    "role": "CISO"
  },
  "authorizedAt": "2026-11-21T10:00:00Z",
  "validUntil": "2026-12-31T23:59:59Z",
  "legalBasis": "Development testing authorization - not for production"
}
EOF

# Dry-run (validates everything but doesn't execute ARTEX)
node .claude/scripts/run-headless.mjs \
  --workflow runtime-probe-redteam \
  --company test-co \
  --dry-run \
  --args "$(cat << 'EOJSON'
{
  "appIds": ["test-app"],
  "envIds": ["dev"],
  "mode": "reconnaissance-only",
  "authorization": $(cat /tmp/test-authorization.json),
  "goals": ["discover exposed endpoints"]
}
EOJSON
)"
```

Expected output:
```
[runtime-probe-redteam] Starting autonomous red-team assessment
[runtime-probe-redteam] Company: test-co
[runtime-probe-redteam] Mode: reconnaissance-only
[runtime-probe-redteam] Authorization: CISO (Dev Test User)
[runtime-probe-redteam] DRY RUN: Skipping ARTEX execution
Status: dry-run
```

### Step 5: Reconnaissance-Only Test (Safe, Real Execution)

**Prerequisites**:
- ARTEX binary installed
- PostgreSQL running
- Test target: Use your own dev environment or `scanme.nmap.org`

```bash
# Create test scope
cat > /tmp/recon-scope.json << 'EOF'
{
  "appIds": ["test-app"],
  "envIds": ["dev"],
  "mode": "reconnaissance-only",
  "authorization": {
    "authorizedBy": {
      "name": "Dev Test User",
      "email": "dev@test.local",
      "role": "CISO"
    },
    "authorizedAt": "2026-11-21T10:00:00Z",
    "validUntil": "2026-12-31T23:59:59Z",
    "legalBasis": "Dev testing - scanme.nmap.org only"
  },
  "goals": ["enumerate services on scanme.nmap.org"]
}
EOF

# Run reconnaissance
node .claude/scripts/artex/run.mjs /tmp/recon-scope.json
```

**What this does**:
- Spawns ARTEX with reconnaissance-only config
- Targets only `scanme.nmap.org` (authorized for testing)
- Runs nmap, curl, DNS lookups (passive)
- No exploitation attempts
- Saves results to `artex/tasks/<task-id>/`

Expected files after completion:
```
artex/tasks/artex-task-<id>/
├── artex-config.json
├── execution.log
├── guard-log.jsonl
├── proxy-captures/
│   └── step-001.har
└── screenshots/
```

### Step 6: Validate Outputs

```bash
# Check ARTEX execution log
cat artex/tasks/artex-task-*/execution.log

# Check guard interventions
cat artex/tasks/artex-task-*/guard-log.jsonl | jq

# Export graphs from PostgreSQL
node .claude/scripts/artex/export-graphs.mjs \
  --task artex-task-<id> \
  --postgres "$POSTGRES_URL" \
  --output artex/tasks/artex-task-<id>/

# Verify exports
ls -lh artex/tasks/artex-task-<id>/*.json
```

Expected outputs:
- `asset-graph.json` — Discovered assets (domains, IPs, services)
- `exploration-graph.json` — Goals, intents, facts
- `tool-executions.json` — Commands run
- `guard-interventions.json` — Guard decisions
- `export-metadata.json` — SHA-256, stats

### Step 7: Test Reconciliation

```bash
# Reconcile ARTEX findings to Maxwell ledger
# (This would normally happen automatically in the workflow)

# For manual testing, you can use artex-reconciler agent:
node .claude/scripts/run-agent.mjs artex-reconciler \
  --company test-co \
  --task-id artex-task-<id> \
  --graph-exports artex/tasks/artex-task-<id>/

# Check Maxwell ledger
grep -A 20 '"kind": "attack-path"' company-profile/test-co/soc/main.jsonl | jq
grep -A 20 '"kind": "artex-task"' company-profile/test-co/soc/main.jsonl | jq
```

### Common Issues & Solutions

#### Issue: ARTEX binary not found
```
Error: ARTEX binary not found at /opt/artex/artex
```

**Solution**:
```bash
# Check ARTEX installation
which artex
ls -l /opt/artex/artex

# Or set custom path
export ARTEX_BINARY=/path/to/artex
```

#### Issue: PostgreSQL connection failed
```
Error: Failed to connect to PostgreSQL
```

**Solution**:
```bash
# Check PostgreSQL is running
docker ps | grep artex-postgres

# Test connection
psql "$POSTGRES_URL" -c "SELECT 1;"

# Check connection string format
echo $POSTGRES_URL
# Should be: postgresql://user:pass@host:port/dbname
```

#### Issue: Authorization validation failed
```
Error: authorization.validUntil must be in the future (authorization expired)
```

**Solution**:
```bash
# Update validUntil to future date
# Must be RFC 3339 UTC with trailing Z
"validUntil": "2027-12-31T23:59:59Z"
```

#### Issue: Schema validation failed
```
Error: Ledger validation failed: schemaVersion is required
```

**Solution**:
```bash
# Run schema validation
npm run validate

# Check schema files
node .claude/scripts/artex/validate-integration.mjs
```

### Testing Checklist

Before declaring integration ready:

- [ ] ARTEX binary installed and version verified
- [ ] PostgreSQL running and connectable
- [ ] Dry-run test passes
- [ ] Reconnaissance-only test completes successfully
- [ ] ARTEX graphs export without errors
- [ ] Guard interventions logged correctly
- [ ] Recording proxy captures HAR files
- [ ] Reconciliation creates Maxwell ledger records
- [ ] Attack paths have complete evidence chains
- [ ] No credentials leaked in HAR files
- [ ] Authorization validation works (expiry, role, scope)
- [ ] Intervention triggers work (guard blocks, timeouts)
- [ ] Schema validation passes
- [ ] Layout rules accept artex/ directory

### Advanced Testing

#### Test Limited-Exploitation Mode

**⚠️ WARNING**: Only run against your own systems with authorization

```bash
# Create exploitation test (requires human approval)
cat > /tmp/exploit-scope.json << 'EOF'
{
  "mode": "limited-exploitation",
  "goals": [
    "attempt authentication bypass on test endpoint",
    "validate privilege escalation controls"
  ],
  "authorization": {
    "authorizedBy": {"name": "...", "email": "...", "role": "CISO"},
    "authorizedAt": "2026-11-21T10:00:00Z",
    "validUntil": "2026-12-31T23:59:59Z",
    "legalBasis": "Dev testing authorization"
  }
}
EOF

# Run with human approval webhook
node .claude/scripts/artex/run.mjs /tmp/exploit-scope.json
```

**What to expect**:
- ARTEX guard will request human approval for sensitive actions
- Webhook POSTed to configured endpoint
- Execution pauses until approval/denial received
- Timeout after 15 minutes

#### Test Intervention Triggers

```bash
# Simulate guard block threshold
# (ARTEX attempts 21 blocked actions in 5min)
# → Should auto-stop with intervention incident

# Simulate service disruption
# (Target returns 503 for 30%+ of requests)
# → Should auto-stop with disruption incident

# Simulate scope violation
# (ARTEX attempts to access denied CIDR)
# → Should auto-stop with authorization violation incident
```

### Performance Expectations

- **Reconnaissance-only**: 15-30 minutes for small targets
- **Limited-exploitation**: 2-5 hours typical
- **Full red-team**: 5+ hours (up to timeout)

### Resource Usage

- **CPU**: 2-4 cores (ARTEX workers + planner)
- **Memory**: 2-4GB (PostgreSQL + ARTEX + recording proxy)
- **Disk**: 500MB-2GB per task (graphs + HAR files + screenshots)
- **Network**: Controlled by rate limit (10-30 req/min)

### Cleanup After Testing

```bash
# Stop PostgreSQL
docker stop artex-postgres
docker rm artex-postgres

# Remove ARTEX tasks
rm -rf artex/tasks/artex-task-*

# Remove test authorization
rm /tmp/test-authorization.json /tmp/recon-scope.json /tmp/exploit-scope.json

# Clear test company from ledger
rm -rf company-profile/test-co/
```

### Next Steps After Testing

1. **If all tests pass**: Ready for PR review
2. **If issues found**: Fix and re-run validation
3. **After PR merged**: Deploy to maxwell-hosted with job kind config

### Getting Help

- **ARTEX issues**: Check logs in `artex/tasks/<id>/execution.log`
- **Schema issues**: Run `npm run validate -- <file>`
- **Integration issues**: Run `node .claude/scripts/artex/validate-integration.mjs`
- **PostgreSQL issues**: Check `docker logs artex-postgres`

### Security Reminder

🔒 **Never commit**:
- Real authorization documents
- Actual CISO/CTO signatures
- Production credentials
- Customer data in HAR files
- Private keys or tokens

✅ **Always**:
- Use test authorizations for development
- Sanitize HAR files (strip credentials)
- Test on your own systems only
- Get written authorization before production testing
- Follow safety mechanisms (guard, intervention triggers)

---

**Happy testing! 🚀**

For questions, see `ARTEX-INTEGRATION.md` or `PR_SUMMARY.md`.
