# Upstream attribution

This Maxwell skill adapts the methodology from Cloudflare's `security-audit-skill`:

- Repository: https://github.com/cloudflare/security-audit-skill
- Pinned revision: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`
- License: MIT; the full notice is in `LICENSE` beside this file.

Maxwell keeps the upstream source-first evidence model, trust-boundary requirement, deterministic coverage ledger,
three-state verdict model, and independent verification. It replaces upstream report directories with Maxwell
session exports, maps confirmed results into SARIF and the SOC ledger, and uses Maxwell's sandbox and regulatory
catalogs.
