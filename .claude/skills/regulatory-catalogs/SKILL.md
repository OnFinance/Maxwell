---
name: regulatory-catalogs
description: The regulatory reference data every Maxwell finding, risk, control and initiative depends on - references/instruments.json (all 36 vocab instruments with regulator, version, dates, official URL, applicability and the hard numeric obligations such as CERT-In 6 h reporting and 180-day logs, DPDP 72 h breach notice, SEBI CSCRF 1-week patching, RBI DAKSH 6 h), references/sla-table.json (remediation and reporting deadlines with the clause quoted, most-strict-wins), and the OSCAL-lite India catalogs under references/catalogs/. Explains how to select the instruments that bind a company from details.json, how to form control ids and cite regulatoryRefs, how to look up an SLA, and how catalogs are refreshed under the grounding contract. Load before citing any regulation, choosing a severity or SLA, or editing a catalog.
license: AGPL-3.0-only
compatibility: Node 22 and the Maxwell workspace layout; catalogs validate against v1/catalog/regulator-catalog.schema.json, the registry against v1/catalog/instruments.schema.json and the SLA table against vocab/sla-table.schema.json. Refreshing catalogs needs WebSearch/WebFetch
metadata:
  author: OnFinance
  version: 1.0.0
  registry: .claude/skills/regulatory-catalogs/references/instruments.json
  slaTable: .claude/skills/regulatory-catalogs/references/sla-table.json
allowed-tools: Read Grep Bash(node .claude/scripts/validate-data.mjs *) Bash(node -e *)
when_to_use: Whenever a workflow cites a regulatoryRef, forms a '<instrumentId>:<controlId>' control id, sets finding severity, slaDueAt or slaBasis, fills incident regulatorReportRefs deadlines, decides which instruments apply to a company, or refreshes an instrument or catalog
user-invocable: false
x-maxwell:
  kind: catalog
  workflows: [refresh-soc, refresh-ctx, refresh-vendor-ctx, refresh-metastore, probe-iac, probe-app-chart, probe-schemas, probe-cicd-env, probe-agent-graph, execute-scr, probe-sdlc, probe-dev-env, runtime-probe-appcontainers, runtime-probe-devtest-env, runtime-probe-qa-env, runtime-probe-prod-env, runtime-probe-harnesses, runtime-probe-sandboxes, runtime-probe-datapipeline, runtime-probe-network-perimeter, runtime-probe-identity-access, impl-change-management, impl-auto-improvement, report-audit-findings, report-audit-improvements]
---
# Regulatory catalogs

Maxwell is regulator-first (AGENTS.md section 6): every finding, risk and initiative cites at least one
`regulatoryRef`, the most specific Indian instrument first, and every severity and deadline comes from these
files, never from memory. Three artefacts live here:

| File | Schema | What it answers |
| --- | --- | --- |
| `references/instruments.json` | `v1/catalog/instruments.schema.json` | Which instruments exist, who they bind, their version/dates/URL, their numeric obligations |
| `references/sla-table.json` | `vocab/sla-table.schema.json` | How many days (or hours) a finding or report may take, by instrument, topic and severity |
| `references/catalogs/<instrumentId>.catalog.json` | `v1/catalog/regulator-catalog.schema.json` | The controls of one instrument: ids, prose, `defaultSeverity`, `mandatory`, params, crosswalk `mappings`, `probeWorkflows` |
| `references/regulatory-comms-manager-offline-copy.md` | none (reference) | The grounding contract and refresh mechanics copied from OnFinance's regulatory-comms-manager |

The registry lists exactly the ids of `.claude/schemas/vocab/instruments.schema.json`; the regulator of each
entry is the only regulator a `regulatoryRef` to that instrument may carry (loaders cross-check the pair).

## 1. Selecting the instruments that bind a company

Inputs from `company-profile/<c>/details.json`: `entityTypes`, `jurisdictions`,
`regulatoryRegistrations[] {regulator, category, status}` and `frameworksInScope`.

1. **Entity type.** An instrument applies when `applicability.entityTypes` intersects `details.entityTypes`,
   or when it is empty (voluntary or cross-sector frameworks: NIST, ISO, CIS, OWASP, MITRE, CSA, SOC 2 and
   the jurisdiction-wide laws MAS TRM, HKMA C-RAF, APRA, PRA, SEC, EU AI Act, CISA BOD).
2. **Jurisdiction.** `applicability.jurisdictions` must contain one of `details.jurisdictions` (`EU` matches any
   EU member state code), or be empty (global). An Indian stock broker never picks up NYDFS or APRA; an Indian
   bank with a Singapore branch listing `SG` does pick up MAS TRM.
3. **Category.** When `applicability.categories` is present, take the company's active
   `regulatoryRegistrations[].category` values of the same family - SEBI CSCRF RE categories (`mii`,
   `qualified-re`, `mid-size-re`, `small-size-re`, `self-certification-re`), RBI UCB tiers (`tier-1..4`), UCB
   cyber levels (`level-1..4`), NBFC layers (`nbfc-base-layer..nbfc-top-layer`). If the company has a category
   of that family, it must be listed; if it has none, the category filter does not exclude. Example:
   `sebi-cscrf-2024` lists the five SEBI RE categories, so a broker registered as `mid-size-re` is in scope with
   the mid-size obligations (half-yearly access reviews, annual VAPT), while an AMC with no SEBI category
   recorded is not excluded by the filter and is assessed against the base obligations until its category is
   captured.
4. **Registration status.** Ignore registrations whose `status` is not active (surrendered, lapsed, suspended).
5. **Superseded instruments.** If an applicable instrument appears in another applicable entry's
   `supersedes`, cite the successor for new records. `rbi-cyber-tech-directions-2026` (31 Jul 2026) repeals
   `rbi-cyber-security-framework-2016` and `rbi-it-governance-md-2023` for all seven RBI entity classes; open
   findings citing the old ids are re-mapped (append a superseding record, never edit a line).
6. **Scope versus applicability.** `frameworksInScope` is what the company is assessed against. An applicable
   instrument missing from it is drift: `refresh-ctx` reports it (observation plus risk), it does not silently
   add it. Findings cite instruments in scope; add an applicable-but-unscoped instrument only as a second ref.
7. **Controls inside an instrument.** A catalog control may narrow further with
   `applicability.reCategories` / `applicability.entityTypes`; empty means everything the instrument covers.

Typical Indian selections:

| Company | Primary (cite first) | Always add | Often add |
| --- | --- | --- | --- |
| Stock broker / DP (SEBI, mid-size RE) | `sebi-cscrf-2024` | `cert-in-directions-2022`, `dpdp-rules-2025` | `iso-27001-2022`, `nist-ssdf-800-218` |
| Scheduled commercial bank / SFB / PB | `rbi-cyber-tech-directions-2026` | `cert-in-directions-2022`, `dpdp-rules-2025` | `rbi-digital-payment-security-2021` (confirm status first, see note), `npci-system-audit`, `pci-dss-4.0.1` |
| NBFC (middle layer and above) | `rbi-cyber-tech-directions-2026` | `cert-in-directions-2022`, `dpdp-rules-2025` | `pci-dss-4.0.1` (card issuers) |
| Insurer / insurance intermediary | `irdai-info-cyber-security-2023` | `cert-in-directions-2022`, `dpdp-rules-2025` | `iso-27001-2022` |
| TPAP (UPI third-party app provider) | `npci-system-audit` | `cert-in-directions-2022`, `dpdp-rules-2025` | `pci-dss-4.0.1`, `owasp-asvs-5.0` |
| Payment aggregator / PPI issuer (RBI-authorised) | `cert-in-directions-2022` until the RBI PA/PPI cyber directions get a vocab id (flag the gap in the finding) | `dpdp-rules-2025`; `npci-system-audit` only if the entity is a UPI participant | `pci-dss-4.0.1`, `owasp-asvs-5.0` |
| Any company running LLM agents | the licence instrument above | `owasp-agentic-top10-2026`, `owasp-llm-top10-2025` | `csa-mcp-security-2025`, `nist-ai-600-1`, `mitre-atlas` |

Notes on RBI entities:
- `rbi-it-outsourcing-md-2023` was **repealed on 28 Nov 2025** (DOR.RRC.REC.302/33-01-010/2025-26) and replaced
  by the entity-wise *Reserve Bank of India (<Entity> - Managing Risks in Outsourcing) Directions, 2025*. The
  successor has no vocab id yet. Do not add the 2023 id as a primary or "always" ref. Cite it only as a secondary
  or historical ref, for example on a finding first seen before 28 Nov 2025 or where the vendor contract still
  quotes it. Say in the description that the successor directions apply and that the id is missing from the
  vocab. For third-party IT and cyber arrangements outside the outsourcing directions, cite
  `rbi-cyber-tech-directions-2026` paras 126-135.
- `rbi-digital-payment-security-2021`: its status after RBI's Nov 2025 and Jul 2026 consolidations has not been
  checked on rbi.org.in (see its registry `version`). Add it only after confirming it is still in force.
- For payment aggregators and PPI issuers, the binding cyber instrument is RBI's own PA/PPI direction, not
  NPCI. NPCI's UPI system audit binds them only as UPI participants.

## 2. Control ids and regulatoryRefs

- A control id is the id **exactly as the instrument numbers it** (`common.schema.json#/$defs/controlId`:
  letters, digits, `.`, `_`, `(`, `)`, `-`, max 64). Each registry entry's `structure` states the scheme. When the
  registry entry has a `catalogFile`, the id must exist in that file. Entries without one (currently
  `rbi-cyber-tech-directions-2026` and `irdai-info-cyber-security-2023`) use the ids in `structure` and
  `hardRequirements[].controlId`.
- The ledger key of a control record is `<instrumentId>:<controlId>` built from `frameworkRefs[0]`, for example
  `sebi-cscrf-2024:PR.MA.S3`, `cert-in-directions-2022:Dir-iv`, `dpdp-rules-2025:7(2)(b)`,
  `rbi-cyber-tech-directions-2026:182`, `irdai-info-cyber-security-2023:2.16-3.6.1`, `pci-dss-4.0.1:6.3.3`,
  `owasp-agentic-top10-2026:ASI02`.
  The instrument prefix disambiguates clause numbers shared across instruments (PCI `1.2.1` vs RBI `1.2.1`).
- A `regulatoryRef` is `{regulator, instrument, controlId}` plus optional `version` (copy the registry
  `version`) and `url` (the registry `url` or a deeper link). `regulator` must equal the registry entry:
  `SEBI`, `RBI`, `IRDAI`, `CERT-In`, `MeitY` (both DPDP ids), `NPCI`, `EU-ESAs` (DORA), `EU-Commission` (DORA RoI
  ITS, AI Act), `NYDFS`, `PCI-SSC`, `SEC`, `MAS`, `HKMA`, `APRA`, `PRA` (SS1/21), `NIST`, `ISO`, `CIS`, `AICPA`,
  `OWASP`, `MITRE`, `CSA`, `CISA`.
- Order: most specific Indian instrument for the company's entity type first, CERT-In/DPDP second, global
  crosswalks last. Take crosswalks from the catalog control's `mappings[]` instead of inventing them.
- Severity when no CVSS applies: the cited catalog control's `defaultSeverity`. Never downgrade below it without
  a refuter verdict recorded as an observation.
- If a control you need is not in the catalog, cite the nearest control whose prose covers the gap and say so in
  the finding description; do not create an id. Instruments without a catalog are cited with the ids shown in
  their registry `structure` and `hardRequirements[].controlId`.

Example refs for a missing high-criticality patch on a SEBI broker's internet-facing trading API:

```json
[
  {"regulator": "SEBI", "instrument": "sebi-cscrf-2024", "controlId": "PR.MA.S3", "version": "SEBI/HO/ITD-1/ITD_CSC_EXT/P/CIR/2024/113"},
  {"regulator": "ISO", "instrument": "iso-27001-2022", "controlId": "A.8.8"},
  {"regulator": "NIST", "instrument": "nist-ssdf-800-218", "controlId": "RV.2.2"}
]
```

## 3. Hard requirements

`instruments.json` `hardRequirements[]` carry `{topic, requirement, value, unit, controlId}` with the value in
the unit the clause states (months stay months, `1 week` is recorded as 7 days because `weeks` is not a unit;
the requirement text keeps the original words). Use them for probe checklists and catalog params: CERT-In
`log-retention` 180 days (`Dir-iv`), RBI `vapt-cadence` VA every 6 months and PT every 12 months (para 151),
SEBI CSCRF RTO 2 hours / RPO 15 minutes (`RC.RP.S2`), PCI DSS session timeout 15 minutes (`8.2.8`). They are
not deadlines for findings; deadlines come only from the SLA table.

## 4. SLA lookup

`sla-table.json` rows are unique by (`instrument`, `topic`, `severity`). The table ships with
`precedence: most-strict-wins` and `defaults` critical 7, high 30, medium 90, low 180, info 365 days.

1. Candidate instruments = `details.frameworksInScope` plus the instruments in the record's `regulatoryRefs`.
2. Topic = `patch-sla` for vulnerabilities and misconfigurations with a fix; otherwise the cited catalog
   control's hard-requirement topic; incidents use `incident-reporting` / `breach-notification`. The topic
   vocabulary has no closure topic, so VAPT and audit observation closure rows live under `vapt-cadence`
   (SEBI Sec-4.3, 3 months) and `audit-cadence` (SEBI Sec-4.4 3 months, IRDAI 2.16-3.6.1 2 months), in both the
   registry and this table. Regulator notification of a control weakness (APRA CPS 234 para 36) is
   `compliance-reporting`.
3. Rows match when `instrument` is a candidate, `topic` matches and `severity` equals the finding's or is `any`.
   The catalog control's own `slaDays`, when present, is one more candidate. Three kinds of row need an extra
   check before they match:
   - **Trigger rows.** Some rows are keyed `critical` only so that (instrument, topic, severity) stays unique.
     Their `basis` starts with `TRIGGER -`. They apply only when that trigger happened, whatever the incident's
     severity:
     - `apra-cps-230` para 42: 24 h when a critical operation is disrupted beyond tolerance.
     - `nydfs-23-nycrr-500` 500.17(c)(1): 24 h after an extortion payment.
     If the trigger did not happen, use the instrument's `any` row (72 h) even for a critical incident. If it did,
     use the trigger row even for a lower-severity incident.
   - **`cisa-bod-26-04`** is a US federal directive. Use it only when a company has adopted it as a benchmark in
     `frameworksInScope`. Its rows apply only to findings whose CVE is in CISA KEV (`inKev: true`), and the tier
     follows the `cve-enrichment` KEV floor:
     - KEV on an asset with `exposure: internet` or `partner` is `critical`: 3 days.
     - Any other KEV finding is `high`: 30 days (the BOD's non-public KEV tier).
     Non-KEV findings skip the BOD rows. The BOD's own answer for non-public, non-KEV assets is "fix on system
     upgrade", which is not a deadline.
   - **Repealed instruments.** Rows for `rbi-it-outsourcing-md-2023` and `rbi-cyber-security-framework-2016`
     apply only to incidents and findings first seen before the repeal.
   **Business days** are always counted as the same number of calendar days (APRA CPS 234 para 36 is 10 days,
   SEC 8-K Item 1.05 is 4 days). A regulator clock never runs out on a weekend because of the conversion.
4. `most-strict-wins`: take the smallest `days` (for reports compare `hours` when present). Copy that row into
   `slaBasis` verbatim (`instrument`, `controlId`, `topic`, `severity`, `days`) and set
   `slaDueAt = firstSeenAt + days`; a CISA KEV `dueDate` that is earlier is a ceiling.
5. No row: `defaults[severity]`, `slaBasis {instrument: <most specific cited>, days}` with no topic.
6. **Company overrides.** Only when a human switches the table to `precedence: company-override` do
   `sdlc/policy.json dependencyPolicy.vulnerabilitySlaDays[severity]` values replace the `patch-sla` rows and the
   defaults for that company; no other topic is overridable. The table ships most-strict-wins because a company
   policy must not relax a regulator's clock. A policy looser than the table is itself a finding
   (`probe-sdlc` PO.4), never a reason to extend `slaDueAt`.

Worked examples:

| Case | Candidates | Chosen |
| --- | --- | --- |
| High CVE with fix, SEBI mid-size RE in scope of CERT-In, DPDP, ISO | CSCRF patch-sla high 7; default 30 | `sebi-cscrf-2024 PR.MA.S3 patch-sla high 7` |
| Critical CVE on internet-facing KEV component, Indian bank with `pci-dss-4.0.1` in scope and `cisa-bod-26-04` adopted as a benchmark in `frameworksInScope` | BOD critical 3 (KEV + exposed); PCI critical 30; RBI Directions have no patch row; default 7 | `cisa-bod-26-04 Table-1 patch-sla critical 3` |
| Critical CVE, same bank, component not in KEV | BOD rows skipped (not KEV); PCI critical 30; default 7 | PCI critical 30 matches, so the default does not apply: `pci-dss-4.0.1 6.3.3 patch-sla critical 30` |
| Medium VAPT gap, insurer | IRDAI patch-sla medium 60; default 90 | `irdai-info-cyber-security-2023 2.16-3.6.1 patch-sla medium 60` |
| Ransomware incident at an NBFC, PII affected | RBI 6 h, CERT-In 6 h, DPDP 72 h | one `regulatorReportRefs` entry per regulator with its own `deadlineHours` (6, 6, 72) |

For incidents do not collapse regulators: each regulator gets its own report ref and deadline from its row; the
most-strict rule applies within one regulator only.

## 5. The India catalogs

Counts are `groups[].controls[]` entries at `lastReviewedAt`; recount with
`node -e` over the file after any refresh.

| Instrument | File | Regulator | Groups | Controls | Id pattern |
| --- | --- | --- | --- | --- | --- |
| SEBI CSCRF 2024 | `catalogs/sebi-cscrf-2024.catalog.json` | SEBI | 26 | 136 | `PR.MA.S3`, `GV.SC.S5`, `Sec-4.3` |
| RBI Directions 2026 | `catalogs/rbi-cyber-tech-directions-2026.catalog.json` | RBI | 54 | 228 | paragraph number, e.g. `182`, `151`, `28(7)` |
| RBI IT Outsourcing MD 2023 (**repealed 28 Nov 2025**) | `catalogs/rbi-it-outsourcing-md-2023.catalog.json` | RBI | 13 | 90 | `17(h)`, `13(a)`, `Appendix-I` groups |
| IRDAI ICS Guidelines 2023 | `catalogs/irdai-info-cyber-security-2023.catalog.json` | IRDAI | 33 | 103 | `<policy>-<control>`, e.g. `2.16-3.6.1`, `2.10-3.5`, `1.10` |
| CERT-In Directions 2022 | `catalogs/cert-in-directions-2022.catalog.json` | CERT-In | 6 | 32 | `Dir-ii`, `Annex-I.xi`, `CCSAPG-13.1.2` |
| DPDP Rules 2025 | `catalogs/dpdp-rules-2025.catalog.json` | MeitY | 14 | 52 | `7(2)(b)`, `Sch1.B.4`, `Act-8(7)` |

Global instruments have no catalog; their ids come from the published standard.

## 6. Refreshing instruments, catalogs and the SLA table

Catalog changes are human-reviewed changes to `.claude/skills/**`, made with the `manual` workflow by
`ctx-researcher` (or a person) and never inside a probe run. Copy the mechanics of
`references/regulatory-comms-manager-offline-copy.md`:

1. **Ground everything.** Paste the GROUNDING CONTRACT and BIAS TOWARD NO-OP blocks from section 1 of the
   offline copy verbatim into the research prompt. Sources are the regulator's own site first (sebi.gov.in,
   rbi.org.in, irdai.gov.in, cert-in.org.in, egazette.gov.in / meity.gov.in, npci.org.in), then the official
   publisher for global standards. Never invent a circular number, date, paragraph or number; an empty field
   with a note is correct.
2. **Discover** amendments with the literal-citation rule (section 3 of the offline copy): a newer circular
   counts only if it cites the instrument's circular number or quotes its title core. Classify each change as
   `amendment`, `supersession` or `regime_overhaul`.
3. **Verify adversarially** with three `refuter` lenses; destructive changes (a control removed, an instrument
   superseded) need unanimous non-refutation, otherwise escalate to a human.
4. **Apply without deleting.** Keep every control id stable; rewrite prose, params and `defaultSeverity` in
   place, and record supersession by adding the old id to the successor's `supersedes` (the old entry stays in
   the registry because the vocab keeps it). New ids enter the vocab first through a schema change
   (`MAXWELL_SCHEMA_EDIT=1`), never ad hoc.
5. **Update dates and provenance.** Set `retrievedAt` and `provenance` on the catalog, `lastReviewedAt` on the
   registry entry and on the SLA table when a row changed. Every SLA row keeps the clause quoted in `basis`,
   prefixed with the instrument and clause number, and `days = ceil(hours / 24)` when `hours` is set.
6. **Propagate.** For a `regime_overhaul` append a `risk` record to every company whose scope includes the
   instrument and bump `nextDueAt` on the affected control records; `refresh-soc` then re-maps findings.
7. **Validate and exit quietly.** `node .claude/scripts/validate-data.mjs <changed files>` then
   `npm run validate`. If nothing was confirmed, write nothing.

## 7. Mistakes the validators will not catch

- Citing `rbi-cyber-security-framework-2016` or `rbi-it-governance-md-2023` for a new finding after 31 July 2026.
- Citing `rbi-it-outsourcing-md-2023` as the primary ref, or using its 17(h) 6-hour row for a new incident. It was
  repealed on 28 Nov 2025 by the entity-wise Managing Risks in Outsourcing Directions, 2025. Use
  `rbi-cyber-tech-directions-2026` (para 182 for incidents) and add the 2023 id only as a secondary or historical
  ref, noting that the successor has no vocab id.
- Applying `cisa-bod-26-04` rows to a non-KEV finding, or to a company that has not adopted the BOD in
  `frameworksInScope`.
- Matching a `TRIGGER -` row (APRA CPS 230 para 42, NYDFS 500.17(c)(1)) because the incident is critical, when
  the trigger itself did not happen.
- Using the SEBI patch timeline (1 week) for a non-patch VAPT observation; FAQ 17 sends those to the 3-month
  closure row.
- Treating CERT-In's 6 hours as the only clock: SEBI brokers also report to exchanges within 6 hours and file
  portal details within 24 hours; RBI entities report on DAKSH within 6 hours of detection.
- Pairing an instrument with the wrong regulator (DPDP is `MeitY`, not `CERT-In`; SS1/21 is `PRA`, not `FCA`).
- Converting units in hard requirements, or typing SLA days from memory instead of copying a row.
