# Offline copy: regulatory-comms-manager workflow mechanics (snapshot 2026-09-11)

One-time extraction from the private OnFinance/regulatory-comms-manager repository (commit f53afdf). Maxwell does
not integrate with that repo; `refresh-ctx` and `refresh-vendor-ctx` copy the mechanics below. Names are verbatim.

## 1. How regulatory reality is discovered
- There is no crawler. Discovery is LLM web research (WebSearch/WebFetch) against the regulators' OWN registers
  under a grounding contract; the only hard-coded domain is `rbi.org.in`. Regulator source pages used in practice:
  `sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=NN` (SEBI intermediary database),
  `rbi.org.in/Scripts/BS_NBFCList.aspx`, `pfrda.org.in/list-of-pops`, `irdai.gov.in/corporate-agents1`,
  `mca.gov.in/mcafoportal/companyLLPMasterData.do`, `cdslindia.com/DP/dplist.aspx`, exchange member directories,
  `nsearchives.nseindia.com/content/equities/EQUITY_L.csv`, `api.bseindia.com/BseIndiaAPI/api/ListofScripData/w`.
- Documents (circulars) arrive as PDFs in `regulators/<slug>/communications/<doc-slug>/{document.json, source.pdf}`;
  regulator slugs are `<iso3166-alpha2>-<shortform>` (`in-sebi`, `in-rbi`, `in-irdai`, SROs `in-sro-nse`).

### Grounding contract (copy verbatim into refresh-ctx prompts)
```
GROUNDING CONTRACT — non-negotiable:
- Ground every claim in a page you actually fetched, and record the URL. Regulator's own register first.
- Never invent a registration number, licence, scheme, or date.
- If you cannot ground it, say so and leave it empty. An empty field with a note is CORRECT.
- Distinguish the GROUP from the ENTITY: a parent's or sister company's licence is not this entity's.
```
### Bias toward no-op (copy verbatim)
```
BIAS TOWARD NO-OP: the profile is presumed CORRECT. You are looking for evidence it is WRONG.
"I could not confirm the profile's claim" is NOT drift — it is silence, and silence changes nothing.
Report drift only when a public source positively contradicts what the profile says.
```

## 2. The license-refresh workflow (model for `refresh-ctx`)
Phases: Snapshot → (Recheck ‖ Discover) → Verify → Apply.
- Snapshot returns a skeleton of the profile, never the whole file.
- Worklist is plain code, not an agent: per licence three units (`:registration`, `:offerings`, `:segments`)
  plus one `business-unit:listing`.
- Drift kinds: `license_added, license_surrendered, registration_changed, offering_added, offering_removed,
  segment_added, segment_removed, listing_changed, none`. Drift item fields: `kind, branch, detail, from, to,
  evidence, evidence_url, effective_date`.
- Discovery lenses: `registers` (sweep the regulators' own registers for ANY registration held by the entity
  that is not in the profile) and `corporate` (corporate actions / regulatory news since `last_refreshed`).
- Adversarial verification: three refuter lenses per drift. Destructive kinds (`license_surrendered`,
  `offering_removed`, `segment_removed`) need unanimous non-refutation; others survive if fewer than 2 refute.
  Failed destructive claims are escalated to a human, never dropped.
- Apply rules: touch only named branches; DO NOT DELETE — MARK (`status: surrendered|lapsed`); append
  `applicability_events[]` with `circular: "public-refresh"`; append a refresh log
  `{date, kind:"public-refresh", drifts_applied, drifts_escalated, summary, changes:[{kind,branch,from,to,evidence,evidence_url}]}`;
  refresh research notes and `research_sources[]`; run validation.
- Quiet exit: no confirmed drift → write nothing (no log entry, no PR).
Maxwell mapping: profile = `company-profile/<id>/details.json` (regulatoryRegistrations, entityTypes,
frameworksInScope); refresh log = `soc` observation records with `methods: ["refresh-ctx"]`; escalations = `risk`
records; the summary goes to `summary.md` section `regulatory-posture`.

## 3. The refresh-circulars worker (model for "what changed recently")
1. `find-references` builds a worklist of (newer circular → historical circular) pairs deterministically: a
   reference is a literal citation only — the target's circular number appears in the source's clause text, or the
   target's parenthesised title core (12–90 chars) appears verbatim. Stopwords: `the, and, for, of, on, in, to, a,
   an, circular, master, direction, directions, regulations, amendment, sebi, rbi, irdai, reserve, bank, india,
   commercial` plus pure-numeric tokens; words must be >3 chars. Only refreshes backwards (source processed after
   target) and skips pairs already logged → idempotent.
2. One subagent per target applies `update_kind` rules; never deletes — supersession sets
   `status: "not-applicable"` with the reason.
3. Refresh log entry: `{date, source, kind ∈ amendment|supersession|regime_overhaul, tasks_updated, tasks_flagged,
   summary, changes:[{clause_number, task_id, field, from, to, evidence}]}`. `regime_overhaul` flags the
   licence profile for re-review (in Maxwell: append a `risk` record and bump `nextDueAt` on affected controls).
4. Ship as branch `refresh/<date>` + PR; never merge. Cadence nightly (`0 2 * * *`).

## 4. Closed vocabularies worth reusing
- Clause types: `not_a_clause, reference_bridge, new_definition, new_applicability_scope, new_date, new_obligation,
  new_manner_of_compliance, update_existing_definition, update_existing_applicability_scope, update_existing_date,
  update_existing_obligation, update_existing_manner_of_compliance`.
- Obligation update kinds: `definition, applicability, date, manner, substance, combined_glossary_obligation,
  supersession (effect ∈ restated|rewritten|split|narrowed|tightened|reversed|deleted), deletion, commencement`.
- Task/compliance types: `Policy`, `Control`, `Miscellaneous`, `Reporting, Disclosure & Filing - {Regulatory |
  External Stakeholder | Internal Stakeholder [Regulator Mandated] | Internal Stakeholder}`, `Risk - Framework -
  {Detection|Grading|Management|Mitigation} Criterion`, `Risk - Specific Instance - {…}`, `Systems Implementation -
  {Operational|Technical} Approach`.
- Six change families: `policy, controls, risks, reporting_disclosure, systems, miscellaneous`.
- Change types: `Added, Modified, Removed, Not Changed`. Frequency: `One-time, Daily, Weekly, Fortnightly, Monthly,
  Quarterly, Half-yearly, Annually, Event-based`. Date types: `issue, effective, due, amended_due, other`.
- Document types: RBI `circular, guideline, master_circular, notification, master_direction, act`; SEBI `act,
  circular, consultation_paper, gazette, master_circular, press_release, regulation, sebi_informal_guidance,
  sanctions_list`.
- Regulators known there (34): `ae-cbuae, ae-sca, gb-fca, gb-ofsi, in-cersai-ckycr, in-cersai-sicr, in-depwd,
  in-goi, in-ifsca, in-irdai, in-mca, in-mh-labour, in-mole, in-msde, in-mwcd, in-pfrda, in-rbi, in-sebi,
  in-sro-amfi, in-sro-bse, in-sro-mcx, in-sro-msei, in-sro-ncdex, in-sro-nse, in-uidai, mu-fsc, my-bnm, sg-mas,
  un-unsc, us-cftc, us-fdic, us-nj-dobi, us-ofac, us-sec`. CERT-In, MeitY and NPCI are NOT modelled there; Maxwell
  adds them because cyber duties (6-hour reporting, 180-day logs, DPDP breach notice) are first-class here.
- Entity classes in use (top): `nbfc_investment_and_credit_company, corporate_agent_composite,
  mutual_fund_distributor, depository_participant, point_of_presence_nps, scheduled_commercial_bank, stock_broker,
  authorised_dealer_category_i, banker_to_an_issue, research_analyst, upi_third_party_app_provider`.

## 5. Entity context document shape (license-profile.json)
`{status ∈ pending|in_progress|complete, business_unit{name, publicly_listed, entity_attributes[] (snake_case
atoms such as sebi_stock_broker_inz000240532, cdsl_depository_participant_in_dp_416_2019, not_a_qualified_stock_broker,
sebi_settlement_order_…), mca_questionnaire, secretarial_compliance_processes[]}, licenses[{license, regulator,
registration_number, status ∈ active|surrendered|lapsed, obligations_questionnaire, processes[],
platforms_supporting_functions[], offerings[{name, questionnaire, market_transaction_processes[],
customer_segments[{segment, questionnaire, processes[]}]}]}], applicability_events[{date, circular, clause_number,
change, branch_updated}], regulatory_perimeter[{sr_no, authority, nature, applicability ∈ Direct / Core |
Conditional | Event-driven}]}`. Every questionnaire answer is `{question, answer, source ("user" | "webfetch:<url>"),
confidence ∈ high|medium|low}`. Ungroundable questions are parked in `residuals.json` `{license, question, why}`.
Research notes template sections: Snapshot, Core business, Regulatory footprint, Compliance-relevant notes (recent
penalties, group structure), Sources (URL + fetch date); inferences marked *(inferred)*.

## 6. Change management tiers (model for Maxwell initiatives/tasks)
`INIT-NNN → CHG-NNN → TSK-NNN`. Initiative: `{id, title, status ∈ identified|scoped|in_progress|in_review|closed,
detected_at, summary, thread_id, source{document, circular_number, circular_title}, changes[{id, change_type,
existing{text, source_document, clause}, new{…}, delta, evidence}], rollout[{customer, status, spoc, due_date,
urgency ∈ High|Medium|Low, process_areas[], changes[{change_id, severity, families[], nature, impact, downstream,
spoc, due_date, completion_status ∈ Not Started|In Progress|Completed|Blocked|Not Applicable, evidence,
internal_impacts[{register ∈ policy|control|risk, ref, impact}], tasks[{id, title, description, department, spoc,
reviewer_spoc (must differ from spoc), frequency, effective_date, next_due_date, completion_status, evidence,
family}]}]}]}`. Control register rows: `ref (CTL-001, never reused), description, owner, frequency, linked_risk,
evidence`; risks `RSK-001 … likelihood ∈ low|medium|high`; policies `POL-001`.
Enforcement orders are classified `monetary_penalty|adjudication|settlement|final|compounding|
cancellation_of_licence|other` with regex pre-filters such as `\bmonetary penalty\b`, `cancels the licence of`.

## 7. Safety invariants to keep
Never delete structure on a refresh (mark status); every change cites evidence + clause; unsupported updates set
`human_resolution_needed: true`; headless/scheduled runs never push to production; quiet exit when nothing changed.
