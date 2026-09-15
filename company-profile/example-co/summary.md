---
schemaVersion: "1"
kind: maxwell.company.summary
companyId: example-co
title: Example Capital Markets cyber resilience summary
version: "7.0.0"
sections: [overview, regulatory-posture, organization-context, applications, vendors, data-flows, control-summary, open-findings, initiatives, suggestions]
provenance:
  harness: claude-code
  generatedAt: "2026-09-15T08:46:53Z"
  sessionId: "e260102e-3e0a-4477-9cbd-15745845a58f"
  runId: "run_01M2J3YSE6N0AKT3R761XEMVCZ"
  workflow: refresh-ctx
  agent: report-writer
  model: claude-opus-5
  inputsHash: "cad7e8fb80b9e554b9d842faee93284e2a3d2e501c120478823f104fb6a79deb"
---
# Example Capital Markets — cyber resilience summary

## overview
Fictional fixture company: a SEBI mid-size RE discount broker and depository participant with an RBI middle-layer NBFC
arm, headquartered in Mumbai. Two applications are in scope: `mcp-gateway` (a MongoDB MCP server used by internal
AI agents) and `db-models` (a shared Python data-model library). Workflows populate the remaining sections.

## Regulatory posture
Registrations (`company-profile/example-co/details.json`):

| Regulator | Registration | Category | Status | Categorised | Registered |
|---|---|---|---|---|---|
| SEBI | INZ000999999 | mid-size-re | active | 2025-04-01 | 2016-06-01 |
| SEBI | IN-DP-999-2016 | mid-size-re | active | 2025-04-01 | 2016-09-01 |
| RBI | N-13.09999 | nbfc-middle-layer | active | 2025-10-01 | 2019-03-15 |

Frameworks in scope (6): `sebi-cscrf-2024`, `rbi-cyber-tech-directions-2026`, `rbi-outsourcing-risk-directions-2025`, `cert-in-directions-2022`, `dpdp-rules-2025`, `iso-27001-2022`. Entity types: stock-broker, depository-participant, nbfc.

| Instrument | Regulator | Applicability | Controls | Implemented | Partial | Planned | Not impl. | Unknown | Open findings | Past SLA |
|---|---|---|---|---|---|---|---|---|---|---|
| sebi-cscrf-2024 (SEBI CSCRF) | SEBI | mid-size-re | 126 | 0 | 0 | 18 | 0 | 108 | 39 | 0 |
| rbi-cyber-tech-directions-2026 (RBI Directions 2026) | RBI | nbfc-middle-layer | 99 | 0 | 0 | 0 | 0 | 99 | 0 | 0 |
| rbi-outsourcing-risk-directions-2025 (RBI Outsourcing Directions 2025) | RBI | nbfc-middle-layer | 176 | 0 | 0 | 5 | 0 | 171 | 0 | 0 |
| cert-in-directions-2022 (CERT-In Directions 2022) | CERT-In | entity type / global | 29 | 0 | 0 | 1 | 0 | 28 | 0 | 0 |
| dpdp-rules-2025 (DPDP Rules 2025) | MeitY | entity type / global | 48 | 0 | 0 | 0 | 0 | 48 | 0 | 0 |
| iso-27001-2022 (ISO/IEC 27001:2022) | ISO | entity type / global | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| rbi-it-outsourcing-md-2023 (RBI IT Outsourcing MD 2023 (repealed)) | RBI | nbfc-middle-layer (not in scope) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

`alternative` counts as Implemented and `not-applicable` is excluded from Controls (rbi-it-outsourcing-md-2023: 64). 39 open findings (status open, triaged or remediating), attributed by first `regulatoryRefs` instrument; Past SLA compares `slaDueAt` with 2026-09-15T08:46:53Z.
<!-- source: latest record per id in soc/main.jsonl (945 lines); kind control by id prefix, kind finding by regulatoryRefs[0].instrument -->

- sebi-cscrf-2024: family `PR.AA` has the most controls with status unknown or not-implemented (13), e.g. `sebi-cscrf-2024:PR.AA.S2`.
- rbi-cyber-tech-directions-2026: family `28` has the most controls with status unknown or not-implemented (3), e.g. `rbi-cyber-tech-directions-2026:28`.
- rbi-outsourcing-risk-directions-2025: family `74` has the most controls with status unknown or not-implemented (19), e.g. `rbi-outsourcing-risk-directions-2025:74(i)`.
- cert-in-directions-2022: family `Dir-i` has the most controls with status unknown or not-implemented (1), e.g. `cert-in-directions-2022:Dir-i`.
- dpdp-rules-2025: family `Sch1.B` has the most controls with status unknown or not-implemented (9), e.g. `dpdp-rules-2025:Sch1.B.1`.
- iso-27001-2022: no control records in the ledger, so no family can be ranked.
- rbi-it-outsourcing-md-2023: no control records in the ledger, so no family can be ranked.

Drift applied in this refresh: none. 0 escalated claim(s) awaiting human resolution as of this refresh.

Refresh date: 2026-09-15 (`provenance.generatedAt` 2026-09-15T08:46:53Z).

## Organization context
Example Capital Markets Private Limited (brand ExampleCo) is a fictional fixture company used to test Maxwell workflows from start to finish. It is an unlisted private limited company (CIN U67120MH2016PTC999999) based in Mumbai, Maharashtra, India. It is a mid-size SEBI-registered discount stock broker (INZ000999999) and depository participant (IN-DP-999-2016), and both are categorised as mid-size REs under SEBI CSCRF. It also runs a margin-funding business registered with RBI as a middle-layer NBFC (N-13.09999). It offers retail clients broking, depository services and margin funding, and routes client orders to NSE and BSE.

Context status: `in_progress` (`company-profile/example-co/context.json`).

| Business unit | Listed | Licences | Obligations | Processes |
|---|---|---|---|---|
| Stock broking and depository services | No | SEBI SEBI stock broker INZ000999999 (active), SEBI SEBI depository participant IN-DP-999-2016 (active) | MCA mca-board-and-kmp, MCA mca-general-meetings, MCA mca-annual-return-and-registers, MCA mca-financial-statements-and-audit, MCA mca-related-party-loans-deposits, MCA mca-secretarial-audit-csr, MCA mca-capital-charges-corporate-events | none |
| NBFC margin funding | No | RBI RBI NBFC (middle layer) N-13.09999 (active) | MCA mca-board-and-kmp, MCA mca-general-meetings, MCA mca-annual-return-and-registers, MCA mca-financial-statements-and-audit, MCA mca-related-party-loans-deposits, MCA mca-secretarial-audit-csr, MCA mca-capital-charges-corporate-events | none |

Licences:
- **SEBI stock broker** (SEBI INZ000999999, stock-broker, active). Obligations: sebi-broker-regs-2026 (SEBI, statute: Securities and Exchange Board of India (Stock Brokers) Regulations, 2026); sebi-broker-master-circular-2024 (SEBI, circular: Master Circular for Stock Brokers, SEBI/HO/MIRSD/MIRSDPoD1/P/CIR/2024/110 dated 9 Aug 2024); sebi-broker-electronic-trading (SEBI, circular: Review of Framework to address the 'technical glitches' in Stock Brokers' Electronic Trading Systems, HO/38/44/12(1)2026-MIRSD-TPD1 dated 9 Jan 2026); sebi-kyc-master-circular-2023 (SEBI, circular: Master Circular on Know Your Client (KYC) norms for the securities market, SEBI/HO/MIRSD/SECFATF/P/CIR/2023/169 dated 12 Oct 2023); sebi-aml-cft-master-circular-2024 (SEBI, circular: Guidelines on AML Standards and CFT / Obligations of Securities Market Intermediaries under the PMLA, 2002 and Rules (SEBI master circular dated 6 Jun 2024)); sebi-investor-grievance-scores-odr (SEBI, circular: Master Circular on the redressal of investor grievances through SCORES, SEBI/HO/OIAE/IGRD/P/CIR/2022/0150 dated 7 Nov 2022); sebi-cscrf-2024 (SEBI, instrument: sebi-cscrf-2024). Offerings: Stock broking on NSE and BSE, Stock broking (NSE/BSE order routing). Customer segments: none recorded. Platforms: MongoDB MCP gateway [sebi-cscrf-2024, cert-in-directions-2022, dpdp-rules-2025, iso-27001-2022]; Security operations centre (M-SOC NSE/BSE and SIEM) [sebi-cscrf-2024, cert-in-directions-2022, iso-27001-2022]; AWS ap-south-1 (EKS, RDS, S3) [no instruments]; MongoDB Atlas on AWS ap-south-1 [no instruments]; GitHub Enterprise Cloud (source, Actions CI, packages) [no instruments].
- **SEBI depository participant** (SEBI IN-DP-999-2016, depository-participant, active). Obligations: sebi-dp-regs-2018 (SEBI, statute: Securities and Exchange Board of India (Depositories and Participants) Regulations, 2018 [last amended on 30 Apr 2025]); sebi-kyc-master-circular-2023 (SEBI, circular: Master Circular on Know Your Client (KYC) norms for the securities market, SEBI/HO/MIRSD/SECFATF/P/CIR/2023/169 dated 12 Oct 2023); sebi-aml-cft-master-circular-2024 (SEBI, circular: Guidelines on AML Standards and CFT / Obligations of Securities Market Intermediaries under the PMLA, 2002 and Rules (SEBI master circular dated 6 Jun 2024)); sebi-investor-grievance-scores-odr (SEBI, circular: Master Circular on the redressal of investor grievances through SCORES, SEBI/HO/OIAE/IGRD/P/CIR/2022/0150 dated 7 Nov 2022); sebi-cscrf-2024 (SEBI, instrument: sebi-cscrf-2024). Offerings: Depository participant services. Customer segments: none recorded. Platforms: MongoDB MCP gateway [sebi-cscrf-2024, cert-in-directions-2022, dpdp-rules-2025, iso-27001-2022]; Security operations centre (M-SOC NSE/BSE and SIEM) [sebi-cscrf-2024, cert-in-directions-2022, iso-27001-2022]; AWS ap-south-1 (EKS, RDS, S3) [no instruments]; MongoDB Atlas on AWS ap-south-1 [no instruments]; GitHub Enterprise Cloud (source, Actions CI, packages) [no instruments].
- **RBI NBFC (middle layer)** (RBI N-13.09999, nbfc, active). Obligations: rbi-nbfc-sbr (RBI, circular: RBI (NBFC - Registration, Exemptions and Framework for Scale Based Regulation) Directions, 2025 (RBI/DOR/2025-26/339)); rbi-cyber-tech-2026 (RBI, instrument: rbi-cyber-tech-directions-2026); rbi-outsourcing-2025 (RBI, instrument: rbi-outsourcing-risk-directions-2025); rbi-nbfc-kyc (RBI, circular: RBI (NBFC - Know Your Customer) Directions, 2025 (RBI/DOR/2025-26/361)); rbi-nbfc-rbc (RBI, circular: RBI (NBFC - Responsible Business Conduct) Directions, 2025 (RBI/DOR/2025-26/362)); rbi-nbfc-credit (RBI, circular: RBI (NBFC - Credit Facilities) Directions, 2025 (RBI/DOR/2025-26/347)); rbi-nbfc-fraud (RBI, circular: RBI (Fraud Risk Management in NBFCs) Directions, 2024 (RBI/DOS/2024-25/120)); rbi-nbfc-misc (RBI, circular: RBI (NBFC - Miscellaneous) Directions, 2025 (RBI/DOR/2025-26/373)). Offerings: Margin funding through the NBFC registration. Customer segments: none recorded. Platforms: MongoDB MCP gateway [sebi-cscrf-2024, cert-in-directions-2022, dpdp-rules-2025, iso-27001-2022]; Security operations centre (M-SOC NSE/BSE and SIEM) [sebi-cscrf-2024, cert-in-directions-2022, iso-27001-2022]; AWS ap-south-1 (EKS, RDS, S3) [no instruments]; GitHub Enterprise Cloud (source, Actions CI, packages) [no instruments]; MongoDB Atlas managed clusters (AWS ap-south-1) [no instruments]; GitHub source hosting and CI [no instruments].

Customer segments: 0 recorded. Offerings: 4. Platforms: 8.

### Questionnaires
23 questionnaires; 14 answered, 177 open, 0 not-applicable. Answer an open question with `node .claude/scripts/ctx/answer.mjs example-co <question_id>` (answer on stdin).

- **q-mca-board-and-kmp** (obligation mca-board-and-kmp): 0 answered / 8 open / 0 not-applicable
  - `mca-board-and-kmp-board-composition`: How many directors sit on the board, and how many are independent, nominee or whole-time directors? Reason: No source I could reach gives the board size or how many directors are independent, nominee or whole-time. details.json has only contacts (CISO, CTO, compliance officer, DPO) and no directors. The website in the profile (https://example-co.invalid) does not resolve. A public search for the CIN U67120MH2016PTC999999 and the legal name found nothing for this entity. The only near match was PL Capital Markets Private Limited, a different company, and I did not use it. MCA master data (the list of directors and signatories) needs a login or CAPTCHA, which is outside the public-register rule. A compliance officer needs to answer this.
  - `mca-board-and-kmp-resident-director`: Which director meets the s.149(3) requirement to have stayed in India at least 182 days in the previous calendar year? Reason: No fetched page or workspace file names the directors or where they lived. The s.149(3) test (at least 182 days in India in the previous calendar year) is something only the company can confirm. MCA master data does not record residency.
  - `mca-board-and-kmp-meeting-cadence`: How many board meetings were held last financial year, and are notices, agendas and minutes kept under SS-1? Reason: No annual report, MGT-7 or board report could be fetched, so the number of FY2025-26 board meetings is unknown. Whether notices, agendas and minutes are kept under SS-1 needs the company secretary to confirm. The company website does not resolve.
  - `mca-board-and-kmp-board-committees`: Which board committees exist (audit, risk, IT strategy, nomination, CSR) and which of them are there because of SEBI or RBI rules? Reason: No source lists the company's board committees. The licences in details.json (SEBI broker INZ000999999, SEBI DP IN-DP-999-2016, RBI NBFC-ML N-13.09999) point to which committees might be required. Examples are the risk and IT strategy committees under the RBI Directions and the CSCRF technology committee. That is only what the rules would require, not proof the committees exist, so I left it open for a compliance officer to confirm.
  - `mca-board-and-kmp-company-secretary`: Does the company employ a whole-time company secretary, and who are its KMP (MD or CEO, CFO, CS)? Reason: s.203 requires a whole-time company secretary in a private company with paid-up share capital of Rs 10 crore or more. No fetched source gives this company's paid-up capital, so I could not tell whether the rule applies (it is not 'not-applicable'). No source names an MD, CEO, CFO or company secretary either. details.json names only the CISO (Meera Krishnan), CTO (Arjun Desai) and compliance officer and DPO (Farah Sheikh). None of those roles is KMP under s.2(51) unless the company has designated them as such.
  - `mca-board-and-kmp-interest-disclosures`: How are directors' MBP-1 interest disclosures and DIR-8 eligibility declarations collected and recorded each year? Reason: This is an internal secretarial process (collecting MBP-1 under s.184 and DIR-8 under s.164). No public source or workspace file describes it. The company secretary or compliance officer needs to answer.
  - `mca-board-and-kmp-din-kyc`: Are all directors' DINs active with DIR-3 KYC filed, and who tracks those filings? Reason: DIN status and DIR-3 KYC can only be checked on the MCA portal, which needs a login or CAPTCHA and falls outside the public, unauthenticated fetch rule. The directors' DINs are not known from any source. Who tracks the filings is an internal matter.
  - `mca-board-and-kmp-secretarial-tooling`: Which system or service provider does the company use to keep board papers, minutes and the secretarial compliance calendar? Reason: No workspace file names a board portal, minutes system or secretarial compliance service. A search of applications/*/README.md and applications/*/env/*.json for board, secretarial, minutes, governance, director and committee found nothing. The three vendor files (aws, github, mongodb-atlas) cover only infrastructure and code hosting. The company website does not resolve.
- **q-mca-general-meetings** (obligation mca-general-meetings): 0 answered / 4 open / 0 not-applicable
  - `mca-general-meetings-agm-date`: On what date was the last annual general meeting held, and for which financial year? Reason: No public source gave an AGM date. details.json calls the entity a 'Fictional fixture' and its website is https://example-co.invalid, which cannot be fetched. A web search for CIN U67120MH2016PTC999999 found no MCA master-data record or filing, and MCA master data cannot be fetched without a portal login or captcha. There is no context.json with a human answer. The company secretary must supply the date of the last AGM and the financial year it covered.
  - `mca-general-meetings-shareholding`: Who holds the equity shares (promoters, a holding company, investors), and does any holder have control or significant beneficial ownership? Reason: No annual return (MGT-7), shareholding pattern, BEN-2 filing or company website could be fetched. The website is .invalid, the CIN search returned no record, and no workspace file names shareholders, a holding company or significant beneficial owners. I did not assume a group structure. A compliance officer must name the shareholders and any SBO.
  - `mca-general-meetings-mode`: Are general meetings held in person, by video conference or by postal ballot, and do shareholders vote electronically? Reason: No notice of meeting, annual report or website page could be fetched to show whether general meetings are held in person, by VC/OAVM or by postal ballot, or whether members vote electronically. The READMEs of the db-models and mcp-gateway applications do not mention any meeting or e-voting platform. The company secretary must answer this.
  - `mca-general-meetings-mgt14`: Which special resolutions or board resolutions did the company file on MGT-14 in the last 24 months? Reason: MGT-14 filings are listed only in the MCA V3 portal, which needs a login or captcha, and the web search for this CIN found no public copy of any filing. As a private company, the entity may be exempt under s.117(3)(g) from filing s.179(3) board resolutions, but special resolutions still have to be filed. Which resolutions were filed in the last 24 months could not be confirmed. The company secretary must list them.
- **q-mca-annual-return-and-registers** (obligation mca-annual-return-and-registers): 0 answered / 5 open / 0 not-applicable
  - `mca-annual-return-and-registers-registered-office`: What is the registered office address on MCA master data, and is the company's active status shown there? Reason: No fetched source gives the registered office address or company status. The MCA master data page returned HTTP 403, and MCA lookups need a CAPTCHA, which this workflow does not solve. A public search for CIN U67120MH2016PTC999999 found nothing. details.json only has headquarters city and state (Mumbai, Maharashtra), which is not the registered office on MCA master data. The profile marks this company as a fictional fixture, so no public MCA record is expected. A compliance officer should supply the address and status.
  - `mca-annual-return-and-registers-annual-return-filed`: For which financial year was the latest annual return (MGT-7/MGT-7A) filed, and was it filed on time? Reason: No MCA filing history or annual report was available. MCA master data returned 403 and V3 filing lookups need a login or CAPTCHA. The company website in details.json (https://example-co.invalid) uses a reserved domain that cannot resolve. The workspace has no secretarial records. A compliance officer should give the financial year of the latest MGT-7 or MGT-7A filing and whether it was filed on time.
  - `mca-annual-return-and-registers-statutory-registers`: Are the statutory registers kept physically or electronically, and who is their custodian? Reason: No public source or workspace file says how statutory registers (s.88 register of members and others) are kept or who holds them. The application READMEs describe only mcp-gateway (MongoDB MCP gateway) and db-models (a SQLAlchemy library), and neither mentions secretarial records. details.json has no company-secretary contact. A compliance officer can answer this in one sentence.
  - `mca-annual-return-and-registers-sbo`: Has the company identified its significant beneficial owners and filed BEN-2, or recorded that it has none? Reason: No fetched source shows the significant beneficial owners, a BEN-2 filing, or a record that there are none. BEN-2 filings and shareholding data are on MCA V3, which could not be reached (403 or CAPTCHA). The workspace has no shareholding or group-structure data. This question needs a compliance officer's answer.
  - `mca-annual-return-and-registers-website-return`: Does the company publish its annual return on its website, and if so at what URL? Reason: details.json lists a website, https://example-co.invalid, so the s.92(3) duty to publish the annual return would apply if the site is real. But the .invalid top-level domain is reserved and never resolves, so no page could be fetched to check for a published annual return. No other company website was found. A compliance officer should give the real website and the URL of the annual return, if published.
- **q-mca-financial-statements-and-audit** (obligation mca-financial-statements-and-audit): 0 answered / 7 open / 0 not-applicable
  - `mca-financial-statements-and-audit-accounting-framework`: Are the financial statements prepared under Ind AS or the older Indian GAAP, and are consolidated statements prepared for any subsidiaries? Reason: No source was found. The company's own website (https://example-co.invalid, from details.json) does not resolve. A public search for the legal name and CIN U67120MH2016PTC999999 found no annual report or MCA filing. details.json says the company is a fictional fixture. The workspace files (details.json, summary.md, the application READMEs) say nothing about Ind AS or Indian GAAP, or about any subsidiaries or consolidated statements. A compliance officer needs to answer this.
  - `mca-financial-statements-and-audit-aoc4`: For which financial year was the latest AOC-4 filed with the Registrar of Companies? Reason: No AOC-4 filing history was available. MCA master data and filing views need the MCA portal, which may require a login or CAPTCHA, and no authenticated fetch is allowed. A public search for the CIN returned no match. A compliance officer needs to name the latest financial year filed.
  - `mca-financial-statements-and-audit-statutory-auditor`: Which firm is the statutory auditor, when was it appointed and when does its s.139 term end? Reason: No annual report, ADT-1 filing or website page names the statutory auditor, the appointment date or when the section 139 term ends. The workspace has no record of an auditor. A compliance officer needs to answer this.
  - `mca-financial-statements-and-audit-books-backup`: Which accounting system holds the books of account, and where are its daily electronic backups kept in India under Rule 3 of the Accounts Rules? Reason: No finance or accounting system is described in any workspace file. The only applications are mcp-gateway and db-models, and their READMEs do not mention books of account or accounting backups. No public source names the accounting software or where its backups are kept in India under Rule 3. No platform was inferred. A compliance officer needs to answer this.
  - `mca-financial-statements-and-audit-audit-trail`: Does the accounting software keep an edit log (audit trail) that cannot be disabled, as the amended Accounts Rules require? Reason: The accounting software is unknown (see books-backup), and no source says whether its edit log (audit trail) exists or can be disabled under the amended Rule 3(1) of the Accounts Rules. A compliance officer or the finance platform owner needs to answer this.
  - `mca-financial-statements-and-audit-revenue-lines`: Which revenue lines appear in the financial statements (brokerage, DP charges, margin-funding interest, other income)? Reason: No financial statements could be fetched, and the company website does not resolve. The licences in details.json (stock broker, depository participant, NBFC) suggest brokerage, DP-charge and margin-funding income. But revenue lines are only reported from the financial statements, so none were inferred and no offerings were derived. A compliance officer needs to confirm this.
  - `mca-financial-statements-and-audit-audit-qualifications`: Did the latest auditor's report or CARO report carry any qualification, emphasis of matter or internal-financial-control weakness? Reason: No auditor's report, CARO 2020 report or internal-financial-controls report was available from any public source or workspace file. A compliance officer needs to say whether the latest reports carried any qualification, emphasis of matter or IFC weakness.
- **q-mca-related-party-loans-deposits** (obligation mca-related-party-loans-deposits): 0 answered / 5 open / 0 not-applicable
  - `mca-related-party-loans-deposits-group-structure`: Does the company have a holding company, subsidiaries or associates, and which group entities hold their own SEBI or RBI licences? Reason: No public source names a holding company, subsidiary or associate. The company is a fictional fixture: its website (example-co.invalid) cannot be reached, a web search for the legal name and CIN U67120MH2016PTC999999 found no MCA master data, annual report or filing, and MCA master data sits behind a CAPTCHA, which is off-limits. Neither details.json nor the application READMEs mention group entities. Only the compliance officer can say whether a group exists and which group entities hold their own SEBI or RBI licences.
  - `mca-related-party-loans-deposits-rpt-types`: What related-party transactions does the company enter into (shared services, technology, premises, intra-group funding), and are they at arm's length? Reason: No annual report, AOC-2 or financial statement notes could be found, so the related-party transactions are unknown. The only related evidence is in the workspace: the three vendor files (AWS, GitHub, MongoDB Atlas) all say intraGroup false. That rules out intra-group outsourcing for those three suppliers, but it says nothing about shared services, premises or intra-group funding, or about arm's-length pricing. Needs a compliance officer's answer.
  - `mca-related-party-loans-deposits-rpt-approval`: How are related-party transactions identified, approved (board or shareholders) and disclosed in AOC-2? Reason: No public board report, AOC-2 filing or related-party policy exists for this fictional entity, and no workspace file describes how related-party transactions are identified, approved or disclosed. A compliance officer needs to describe the approval and disclosure process.
  - `mca-related-party-loans-deposits-margin-funding-lending`: Is margin-trading or client lending done by this entity in the ordinary course of NBFC business, and does it rely on the s.186 NBFC carve-out? Reason: details.json records an active RBI NBFC registration N-13.09999 (nbfc-middle-layer) for this legal entity and calls the business 'a middle-layer NBFC margin-funding arm'. It does not say whether margin-trading or client lending is booked in this entity in the ordinary course of NBFC business, or whether the company relies on the s.186(11) NBFC carve-out. 'Arm' could mean a division or a separate company. No public source (website, annual report, exchange MTF approval list) could be found, so the lending offering is not yielded on a guess. Needs a compliance officer's answer.
  - `mca-related-party-loans-deposits-dpt3`: Does the company file DPT-3 returns, and does it hold any money that counts as a deposit or as exempt money? Reason: No MCA filing index is publicly available for this fictional CIN (MCA lookups need a CAPTCHA, which is off-limits), and no workspace file mentions DPT-3 filings, deposits or exempt money such as client margin or loans from directors. The compliance officer can answer in one line.
- **q-mca-secretarial-audit-csr** (obligation mca-secretarial-audit-csr): 0 answered / 4 open / 0 not-applicable
  - `mca-secretarial-audit-csr-csr-applicability`: Does the company meet a s.135 CSR threshold, and if so how much did it spend on CSR last year and through which projects? Reason: No source this session shows the company's net worth, turnover or net profit (the s.135(1) tests: net worth Rs 500 crore, turnover Rs 1000 crore or net profit Rs 5 crore), a board's report, CSR spend or CSR projects. details.json calls the company a fictional fixture, its website is https://example-co.invalid, and a web search on the legal name and CIN found no annual report or MCA filing. A compliance officer needs to answer this.
  - `mca-secretarial-audit-csr-secretarial-audit`: Does the company obtain a secretarial audit report (MR-3), and who is the practising company secretary? Reason: The CIN (U67120MH2016PTC999999) shows a private company. Under s.204 and rule 9(1)(c), a private company needs a secretarial audit only if its outstanding loans or borrowings from banks or public financial institutions are Rs 100 crore or more. That figure is unknown (see the borrowings question), so it is not clear whether rule 9 applies. No MR-3 report and no practising company secretary's name was found in any fetched source or workspace file. A compliance officer needs to answer this.
  - `mca-secretarial-audit-csr-internal-audit`: Does the company have an internal auditor under s.138, and is internal audit in-house or outsourced? Reason: No source names an internal auditor or says whether internal audit is done in-house or outsourced. For a private company, s.138 and rule 13 of the Companies (Accounts) Rules apply when turnover is Rs 200 crore or more, or outstanding bank/PFI borrowings are Rs 100 crore or more. Neither figure is available. The workspace files (details.json, summary.md, the application READMEs) do not describe an internal audit function. A compliance officer needs to answer this.
  - `mca-secretarial-audit-csr-borrowings`: Do outstanding loans or borrowings from banks or public financial institutions exceed Rs 100 crore? Reason: No balance sheet, annual return (MGT-7), charge register or annual report was available this session. details.json has a middle-layer NBFC margin-funding arm, which suggests the company borrows, but it gives no borrowing amount. So we cannot say whether bank/PFI borrowings exceed Rs 100 crore. A compliance officer needs to answer this.
- **q-mca-capital-charges-corporate-events** (obligation mca-capital-charges-corporate-events): 0 answered / 6 open / 0 not-applicable
  - `mca-capital-charges-corporate-events-listing-status`: Are any of the company's securities, including non-convertible debentures or commercial paper, listed on NSE or BSE? Reason: No source fetched this session shows whether any securities are listed. The company is a fictional fixture: its website https://example-co.invalid does not resolve, and a web search for the CIN U67120MH2016PTC999999 or the legal name found no matching exchange or MCA record. The CIN's PTC suffix shows a private company, but that alone does not rule out listed NCDs or commercial paper. A compliance officer needs to confirm this.
  - `mca-capital-charges-corporate-events-objects-clause`: What main objects does the memorandum of association state, and do they cover stock broking, depository and NBFC activities? Reason: The memorandum of association is not public in any source this session could reach. MCA master data returned HTTP 403, the company website does not resolve and no annual report was found. The workspace description (broker, DP, NBFC margin funding) comes from the profile, not from the MoA objects clause, so it cannot answer this question.
  - `mca-capital-charges-corporate-events-charges`: Which charges are registered on the MCA charge index, and to which lenders (for example, for margin-funding borrowings)? Reason: The MCA charge index needs the MCA portal. The master-data page returned HTTP 403 to an unauthenticated fetch, and portal logins are refused. No annual report or lender disclosure was found, and the workspace files name no lenders.
  - `mca-capital-charges-corporate-events-name-change`: Has the company changed its name, registered office state or constitution since incorporation in 2016? Reason: No MCA master data or name-history record could be fetched: HTTP 403 on mca.gov.in, and a web search found no record for this CIN. Nothing contradicts the profile's legal name 'Example Capital Markets Private Limited' or its Maharashtra (MH) registered-office code, so there is no drift, but the question is still unanswered.
  - `mca-capital-charges-corporate-events-restructuring`: Has there been a merger, demerger, change of control or share allotment to new investors in the last 24 months? Reason: No exchange filing, NCLT order, MCA filing or news source for this entity was found in the last 24 months. The website does not resolve and MCA was unreachable (HTTP 403). A compliance officer needs to confirm whether there were mergers, changes of control or share allotments.
  - `mca-capital-charges-corporate-events-roc-orders`: Has the Registrar of Companies or the tribunal issued any adjudication, compounding or penalty order against the company or its officers? Reason: No ROC or NCLT adjudication, compounding or penalty order for this entity was found. A web search for the CIN and legal name found none, and the MCA adjudication pages were not reachable without authentication. Not finding an order does not prove there is none, so this stays open.
- **q-sebi-broker-regs-2026** (obligation sebi-broker-regs-2026): 1 answered / 10 open / 0 not-applicable
  - `sebi-broker-regs-2026-exchange-segments`: On which stock exchanges and segments (equity cash, equity derivatives, currency, commodity, debt) is the company a trading or clearing member under INZ000999999? Reason: refuted: entity-identity: details.json does name Example Capital Markets Private Limited (CIN U67120MH2016PTC999999), but it only says the company routes client orders to NSE and BSE and uses the SOC 
  - `sebi-broker-regs-2026-clearing-model`: Does the company clear its own trades as a self-clearing member, or through a professional clearing member (and which one)? Reason: No fetched page or workspace file says whether the company is a self-clearing member or uses a professional clearing member. The company is fictional, so it has no NSE Clearing or ICCL member-directory entry, and its website does not resolve.
  - `sebi-broker-regs-2026-proprietary-trading`: Does the company trade on its own (proprietary) account in addition to executing client orders? Reason: No source says whether the company trades on its own account. details.json only describes routing client orders, and the exchange directories that show proprietary trading are not available for a fictional entity.
  - `sebi-broker-regs-2026-compliance-officer`: Who is the designated compliance officer for the broking business, and has that officer been notified to the exchanges? Reason: refuted: source-authenticity: The answer text matches details.json contacts (compliance-officer Farah Sheikh, compliance@example-co.invalid; dpo Farah Sheikh), but the yield process:secretarial-compli
  - `sebi-broker-regs-2026-authorised-persons`: Does the company operate through authorised persons, and how many are registered with the exchanges? Reason: No source says whether the company uses authorised persons or how many are registered. The counts are on NSE/BSE AP lists, which do not cover this fictional entity, and no workspace file mentions authorised persons.
  - `sebi-broker-regs-2026-qualified-broker`: Has any exchange designated the company a Qualified Stock Broker, and for which financial year? Reason: No FY2026-27 Qualified Stock Broker list was found. A web search turned up only NSE QSB circulars up to 2024 (for example NSE/INSP/61213 of 19 Mar 2024), and a fictional entity would not be on any real exchange list. The CSCRF category mid-size-re in details.json is a SEBI cyber category, not a QSB designation, so it does not answer the question.
  - `sebi-broker-regs-2026-client-segments`: Which client segments does the broking business serve: resident retail, NRI, HNI, corporates or institutions? Reason: refuted: source-authenticity: details.json supports only 'discount broker' and the tag retail-broking (so segment:retail-investors is fine); nothing in the file says the clients are 'resident', so the
  - `sebi-broker-regs-2026-net-worth-monitoring`: Which function monitors net worth and deposit requirements, and how often are they reported to the exchanges? Reason: No source names the function that monitors net worth and deposits or how often they are reported to the exchanges. Neither details.json nor the application READMEs cover it, and the company's filings and website are not available.
  - `sebi-broker-regs-2026-internal-audit`: Who conducts the periodic internal audit of the broking operations, and how often is it done? Reason: No source says who does the internal audit of broking operations or how often. details.json auditCadence covers only cyber audit (1 per year) and VAPT (2 per year), which are not the broking internal audit, and no audit firm is named.
  - `sebi-broker-regs-2026-books-records`: On which back-office system are the books of account, order logs and client records kept, and for how long? Reason: No source names a back-office system for the books of account, order logs and client records, or says how long they are kept. The mcp-gateway README only says AI agents query the client-data and order stores, and db-models is a shared data-model library. Neither is identified as the back-office system of record, and the env files give infrastructure log retention, not record retention.
- **q-sebi-broker-master-circular-2024** (obligation sebi-broker-master-circular-2024): 0 answered / 10 open / 0 not-applicable
  - `sebi-broker-master-circular-2024-onboarding-channels`: Through which channels are broking clients onboarded: fully online, assisted by authorised persons, or on paper at branches? Reason: No public source for this company: the website example-co.invalid does not resolve, and a web search found no pages about the company. The workspace READMEs and env files describe only internal tooling, not how clients are onboarded. A compliance officer must answer.
  - `sebi-broker-master-circular-2024-products`: Which products can clients trade under the broking licence (delivery equity, intraday, F&O, currency, commodity, IPO bids, exchange mutual fund orders)? Reason: The company website, where products would normally be listed, cannot be fetched (example-co.invalid does not resolve). No exchange or other public page lists this company's products. The profile only calls it a 'discount broker', which does not say which segments or products are offered.
  - `sebi-broker-master-circular-2024-running-account`: How often does the company settle clients' running accounts (monthly or quarterly, as each client chooses)? Reason: No fetched source or workspace file says how often client running accounts are settled. A compliance officer must answer.
  - `sebi-broker-master-circular-2024-client-funds`: How are client funds upstreamed to the clearing corporation, and how are client fund balances reported to the exchanges? Reason: No fetched source or workspace file describes how client funds are upstreamed to the clearing corporation or reported to the exchanges.
  - `sebi-broker-master-circular-2024-margin-collection`: How does the company collect margin from clients: cash, a margin pledge through the depository, or both? Reason: No fetched source or workspace file describes how margin is collected (cash or depository margin pledge). The company holds a DP registration (IN-DP-999-2016), but that alone does not show pledges are used for margin.
  - `sebi-broker-master-circular-2024-mtf`: Does the company offer a margin trading facility, and is it funded from the broker's own books or by the NBFC arm? Reason: The profile description mentions a 'middle-layer NBFC margin-funding arm', but that is the profile's own claim, not a fetched source. It also does not say whether the SEBI margin trading facility is run from the broker's own books or funded by the NBFC. No public source could be fetched to settle this. A compliance officer must answer.
  - `sebi-broker-master-circular-2024-ibt-platforms`: Which internet and mobile trading platforms (in-house or vendor-built) does the company offer, and have the exchanges approved them? Reason: No fetched source names a client-facing internet or mobile trading platform, or exchange approval for one. The workspace applications (mcp-gateway, db-models) are internal tools. details.json maps critical function order-routing to mcp-gateway, but nothing shows it is an exchange-approved trading platform for clients, so it is not recorded as one.
  - `sebi-broker-master-circular-2024-contract-notes`: How does the company issue electronic contract notes, daily margin statements and quarterly statements of account? Reason: No fetched source or workspace file describes how electronic contract notes, daily margin statements or quarterly statements of account are issued.
  - `sebi-broker-master-circular-2024-dormant-accounts`: What procedure does the company follow to flag inactive or dormant trading accounts and reactivate them? Reason: No fetched source or workspace file describes a procedure for flagging or reactivating dormant accounts.
  - `sebi-broker-master-circular-2024-unauthorised-trade-controls`: How does the company prevent unauthorised trades, for example with order confirmations, SMS/email trade alerts and exchange-verified client contact details? Reason: No fetched source or workspace file describes controls against unauthorised trades, such as order confirmations, SMS/email alerts or verified client contact details.
- **q-sebi-broker-electronic-trading** (obligation sebi-broker-electronic-trading): 0 answered / 9 open / 0 not-applicable
  - `sebi-broker-electronic-trading-systems`: Which electronic trading systems (web, mobile app, trading API, dealer terminals) does the company run, and which applications implement each? Reason: No source names the company's electronic trading systems (web, mobile app, trading API, dealer terminals). Example Capital Markets is a made-up test company with no public website, annual report or exchange member page to fetch. Only two applications exist in the workspace. applications/mcp-gateway/README.md describes an internal MongoDB MCP gateway that lets AI agents query client-data and order stores. applications/db-models/README.md describes a shared SQLAlchemy model library with no runtime. Neither file says it is a client trading front end, so no trading platform can be recorded. A compliance officer should list the trading systems and the applications behind each.
  - `sebi-broker-electronic-trading-order-routing`: Which system accepts, checks and routes client orders to NSE and BSE, and is it built in-house or bought from a vendor? Reason: No source identifies the system that accepts, checks and routes client orders to NSE and BSE, or whether it was built or bought. details.json criticalFunctions[0] 'order-routing' lists appIds ['mcp-gateway']. The mcp-gateway README, however, describes that app only as an internal gateway through which AI agents query client-data and order stores. It does not say it accepts or routes orders to exchanges. The env files show it runs on AWS EKS ap-south-1 (prod) and was built from the public OnFinance/mongodb-mcp-server repository. The vendor files (aws, mongodb-atlas) cover hosting and databases, not an order management system or exchange connectivity. The order router and whether it is built or bought therefore stay unconfirmed. The possible mismatch between the order-routing critical function and mcp-gateway's stated purpose should go to a human.
  - `sebi-broker-electronic-trading-glitch-reporting`: What is the company's procedure for reporting a technical glitch to the exchanges, and who owns it? Reason: No public source or workspace file describes how the company reports technical glitches to the exchanges or who owns that duty. The company has no public website or filings. The READMEs and env files do not cover incident reporting. details.json lists ciso, cto, compliance-officer and dpo contacts, but none is named as owner of glitch reporting. A compliance officer should describe the procedure and name its owner.
  - `sebi-broker-electronic-trading-bcp-dr`: Does the company keep a DR site for its trading systems, and when was the last DR drill or live switchover? Reason: No source confirms or rules out a DR site for trading systems, and none records a DR drill or live switchover date. mcp-gateway has dev, qa and prod env files: prod is AWS ap-south-1 (eks-prod-mumbai), qa is eks-nonprod-mumbai and dev runs on developer laptops. No DR environment or second region is recorded. A missing file does not prove there is no DR site, so this stays open. A compliance officer should state the DR site and the date of the last drill or switchover.
  - `sebi-broker-electronic-trading-capacity`: How does the company monitor and plan capacity of its trading systems against peak order load? Reason: No source describes capacity monitoring or planning for trading systems against peak order load. The workspace README and env files give no capacity figures. mcp-gateway prod observability lists only log retention and a Wazuh SIEM. The company has no public disclosures.
  - `sebi-broker-electronic-trading-api-access`: Does the company give retail clients API access for algorithmic trading, and how are API users authenticated (static IP, OAuth)? Reason: No source says whether retail clients get API access for algo trading, or how API users are authenticated. The workspace shows only that db-models stores clients' Zerodha and Binance trading-account credentials (summary.md findings). Those are third-party accounts, not an API this company offers its own clients, so no algo-trading offering or API platform can be recorded.
  - `sebi-broker-electronic-trading-algo-providers`: Does the company empanel third-party algo providers, and how many algos has it registered with the exchanges? Reason: No source lists empanelled third-party algo providers or algos registered with NSE or BSE. The company is a made-up test company with no exchange member page or public disclosure. The workspace vendor files cover only AWS, GitHub and MongoDB Atlas, and none is an algo provider.
  - `sebi-broker-electronic-trading-algo-types`: Does the company offer white-box (logic disclosed) algos, black-box algos, or neither to retail clients? Reason: No source says whether the company offers white-box or black-box algos to retail clients, or neither. No public website, product page or exchange filing exists, and no workspace file mentions algo offerings. A compliance officer should answer.
  - `sebi-broker-electronic-trading-change-management`: How are changes to trading software tested and approved before going live, including exchange mock sessions? Reason: No source describes how changes to trading software are tested and approved, including exchange mock sessions. The workspace records CI on GitHub Actions for the application repos (vendors/github.json). It does not name any trading software, nor any testing, approval or mock-session procedure for it. The company has no public disclosure.
- **q-sebi-dp-regs-2018** (obligation sebi-dp-regs-2018): 0 answered / 10 open / 0 not-applicable
  - `sebi-dp-regs-2018-depositories`: Is the company a participant of CDSL, NSDL or both, and under which DP IDs? Reason: No source fetched this session shows which depository (CDSL, NSDL or both) the company is a participant of, or its DP IDs. The CDSL DP list (cdslindia.com/DP/dplist.aspx, the URL in the offline copy's section 1) returned HTTP 403. A public search for the legal name found no register or company page. The company website example-co.invalid does not resolve. details.json holds SEBI registration IN-DP-999-2016, but that does not name a depository or a DP ID. The workspace READMEs and env files say nothing about it. A compliance officer should confirm.
  - `sebi-dp-regs-2018-account-types`: Which demat account types does the DP open: individual, BSDA, HUF, corporate, NRI repatriable or non-repatriable, clearing member pool? Reason: No company website, account-opening form or depository page could be fetched (example-co.invalid does not resolve). The workspace READMEs (mcp-gateway, db-models) and env files do not describe demat account types. Needs a compliance officer's answer.
  - `sebi-dp-regs-2018-account-count`: How many demat accounts does the DP service, as published by the depository or disclosed by the company? Reason: No depository statistics page or company disclosure for this entity was found. The public search returned nothing for the legal name, and the CDSL DP list returned HTTP 403. No count can be given without a source.
  - `sebi-dp-regs-2018-services`: Which depository services does the DP provide: pledge and margin pledge, off-market transfers, dematerialisation, transmission, eDIS? Reason: No source fetched this session lists the DP's services (pledge and margin pledge, off-market transfer, demat, transmission, eDIS). The company website does not resolve, and the workspace files do not mention depository services.
  - `sebi-dp-regs-2018-ddpi-poa`: Does the DP accept a DDPI or power of attorney for delivery and pledge instructions, and for what purposes? Reason: No company website, account-opening kit or tariff sheet could be fetched, and the workspace files do not mention DDPI or power of attorney. Needs a compliance officer's answer.
  - `sebi-dp-regs-2018-back-office`: Is the DP back office run in-house or on vendor software, and which vendor? Reason: The workspace names only the applications mcp-gateway (a MongoDB MCP gateway over the client-data and order stores) and db-models (a shared data-model library), plus the vendors aws, github and mongodb-atlas. None of these is described as DP back-office software, and no public source was found. Whether the DP back office is in-house or a vendor product is unknown.
  - `sebi-dp-regs-2018-concurrent-audit`: Who conducts the DP's internal or concurrent audit, and how often is it filed with the depository? Reason: No public source names the DP's internal or concurrent auditor or how often the audit is filed. details.json auditCadence covers VAPT (2 per year) and cyber audit (1 per year) only, not the DP internal or concurrent audit.
  - `sebi-dp-regs-2018-closure-transfer`: What turnaround does the DP commit to for account closure and transfer requests, and how are they tracked? Reason: No source fetched this session gives the DP's turnaround for account closure or transfer requests, or how they are tracked. The company website does not resolve.
  - `sebi-dp-regs-2018-investor-charter`: Does the DP publish the depository investor charter and its complaints data on its website? Reason: This is answerable only from the company website, but example-co.invalid does not resolve (ENOTFOUND). Whether the depository investor charter and complaints data are published cannot be confirmed.
  - `sebi-dp-regs-2018-compliance-officer`: Who is the DP's compliance officer, and does the same person also act for the broking registration? Reason: details.json names one company-wide contact with role compliance-officer, Farah Sheikh (compliance@example-co.invalid), who is also listed as DPO. It does not assign a compliance officer to each registration. So it does not show who is the compliance officer for the DP registration IN-DP-999-2016, or whether that person also acts for the broking registration INZ000999999. No SEBI, depository or exchange page was reachable to confirm. A compliance officer should confirm.
- **q-sebi-kyc-master-circular-2023** (obligation sebi-kyc-master-circular-2023): 0 answered / 8 open / 0 not-applicable
  - `sebi-kyc-master-circular-2023-kra`: With which KYC Registration Agency (or agencies) does the company upload and validate client KYC records? Reason: No source available this session names a KYC Registration Agency. Example Capital Markets Private Limited is a fictional fixture: its website (https://example-co.invalid) is on a reserved TLD that cannot resolve, its CIN and SEBI numbers are placeholders with no public register entry, and KRA lookups need a login. Workspace files (application READMEs, env files, vendor files, metastore, details.json) name no KRA vendor or interface. Ask the compliance officer.
  - `sebi-kyc-master-circular-2023-ckycr`: Does the company upload records to and download them from the Central KYC Records Registry (CKYCR)? Reason: No public source or workspace file says whether the entity uploads to or downloads from CKYCR. CKYCR records are not publicly searchable, and the fixture company has no website or filings to fetch. Ask the compliance officer.
  - `sebi-kyc-master-circular-2023-digital-kyc`: Does onboarding use Aadhaar e-KYC, DigiLocker or video in-person verification, and which vendor or platform runs it? Reason: No source names an Aadhaar e-KYC, DigiLocker or video-KYC flow, or a vendor or platform for one. The in-scope applications are mcp-gateway (an internal MongoDB MCP gateway for AI agents) and db-models (a shared data-model library), and neither README describes client onboarding. Ask the compliance officer.
  - `sebi-kyc-master-circular-2023-ipv`: Who carries out in-person verification: employees, authorised persons, or a video-KYC provider? Reason: No source says who carries out in-person verification (employees, authorised persons or a video-KYC provider). No IPV or VIPV vendor is recorded in vendors/, and there is no public website or filing to fetch for the fixture entity. Ask the compliance officer.
  - `sebi-kyc-master-circular-2023-non-individuals`: Does the company onboard NRIs, HUFs, corporates or trusts, and through which channel? Reason: No source says whether the company onboards NRIs, HUFs, corporates or trusts, or through which channel. details.json tags it 'retail-broking', which suggests retail clients but does not rule other client types in or out, so no segment is derived. Ask the compliance officer.
  - `sebi-kyc-master-circular-2023-periodic-update`: How often is client KYC updated, and does the frequency vary by client risk category? Reason: No source states how often client KYC is updated or whether the cadence varies by client risk category. No KYC policy is published or recorded in the workspace. Ask the compliance officer.
  - `sebi-kyc-master-circular-2023-third-party-reliance`: Does the company rely on KYC completed by another SEBI intermediary, or share its KYC records with group entities? Reason: No source describes reliance on KYC done by another SEBI intermediary, or sharing KYC records with group entities. The profile names the NBFC margin-funding arm as part of this same legal entity (RBI N-13.09999 is on the entity's own registrations), not as a group company, and no group structure or data-sharing arrangement is recorded. Ask the compliance officer.
  - `sebi-kyc-master-circular-2023-records`: Where are KYC documents and verification records stored, and for how long? Reason: No source says where KYC documents and verification records are stored or how long they are kept. The metastore records no retention period for any table (retentionDays is null throughout) and has no KYC document store. mcp-gateway's README mentions only generic 'client-data and order stores'. A ledger observation (obs_01M2G2AGFHXSCH94CR7SMFERAW) mentions Aadhaar/PAN fields only hypothetically ('would pass through'), which does not show where KYC records are kept. Env-file log retention (prod 365 days) covers application logs, not KYC records. Ask the compliance officer.
- **q-sebi-aml-cft-master-circular-2024** (obligation sebi-aml-cft-master-circular-2024): 0 answered / 9 open / 0 not-applicable
  - `sebi-aml-cft-master-circular-2024-principal-officer`: Who are the Principal Officer and Designated Director registered with FIU-IND for the company? Reason: No source names an FIU-IND Principal Officer or Designated Director. FIU-IND does not publish these registrations, and the company website (https://example-co.invalid) uses a reserved .invalid domain that cannot be fetched. details.json lists only a compliance officer (Farah Sheikh), and holding that role does not make her the PMLA Principal Officer. A compliance officer must answer.
  - `sebi-aml-cft-master-circular-2024-risk-categorisation`: How are clients categorised for money-laundering risk (low, medium, high, special category), and when is the rating reviewed? Reason: No fetchable company page, policy or workspace file describes client money-laundering risk categories or how often ratings are reviewed. The website domain is .invalid, and neither the READMEs nor the env files mention client risk rating.
  - `sebi-aml-cft-master-circular-2024-transaction-monitoring`: Which system raises AML and surveillance alerts on client trades and demat transactions, including alerts passed on by exchanges and depositories? Reason: No source names the system that raises AML or surveillance alerts on client trades, demat transactions or alerts passed on by exchanges and depositories. The prod env file names a Wazuh SIEM ("siem": "Wazuh (self-hosted, ap-south-1)"). That is a security event monitor, not evidence of AML trade surveillance, so no surveillance platform is claimed. The README describes mcp-gateway only as an AI-agent query gateway to the client-data and order stores.
  - `sebi-aml-cft-master-circular-2024-str-filing`: How are suspicious transaction reports and other FIU-IND reports prepared and filed through FINnet? Reason: No source describes how the company prepares STRs, CTRs or other FIU-IND reports or files them through FINnet. FIU-IND filings are not public, and the website cannot be fetched (.invalid domain).
  - `sebi-aml-cft-master-circular-2024-sanctions-screening`: Are clients screened against UN Security Council and UAPA lists at onboarding and on an ongoing basis, and with which tool? Reason: No source says whether clients are screened against UNSC or UAPA lists, or with which tool. None of the vendor records (aws, github, mongodb-atlas) is a screening provider, and no workspace file mentions sanctions screening.
  - `sebi-aml-cft-master-circular-2024-beneficial-ownership`: How does the company identify and verify the beneficial owners of non-individual clients? Reason: No fetchable source describes how the beneficial owners of non-individual clients are identified or verified. There is no company website or KYC policy page, and the workspace files are silent.
  - `sebi-aml-cft-master-circular-2024-high-risk-clients`: Does the company accept politically exposed persons or clients from high-risk jurisdictions, and under what approval? Reason: No source says whether the company accepts politically exposed persons or clients from high-risk jurisdictions, or what approval that needs. Customer segments beyond the 'retail-broking' tag in details.json cannot be grounded, and that tag does not answer this question.
  - `sebi-aml-cft-master-circular-2024-record-retention`: How long are transaction and client identification records kept after the relationship ends? Reason: No source states how long transaction and client identification records are kept after the relationship ends. The env files give only operational log retention (prod 365 days, qa 180 days, dev 30 days), which is not PMLA record retention. summary.md records that no retention period is set on the data models (finding fnd_01M2GMN63DEDR29P66QTKND8E7).
  - `sebi-aml-cft-master-circular-2024-training`: How often do employees and authorised persons receive AML/CFT training, and are they screened at hiring? Reason: No source describes how often employees and authorised persons get AML/CFT training, or whether they are screened at hiring. details.json gives only headcount (310 employees), and there is no public HR or policy page.
- **q-sebi-investor-grievance-scores-odr** (obligation sebi-investor-grievance-scores-odr): 0 answered / 8 open / 0 not-applicable
  - `sebi-investor-grievance-scores-odr-scores-registration`: Are both SEBI registrations enrolled on SCORES, and who handles SCORES complaints? Reason: No source says whether INZ000999999 or IN-DP-999-2016 is enrolled on SCORES or who handles SCORES complaints. SCORES enrolment is not on any public register. The company website in details.json (https://example-co.invalid) does not resolve. details.json names Farah Sheikh as compliance officer but does not give her a grievance or SCORES role. A compliance officer needs to answer this.
  - `sebi-investor-grievance-scores-odr-channels`: Through which channels can clients complain (email, phone, app, branch), and what is the designated grievance email address? Reason: No grievance channels or designated grievance email address could be found. The company website (https://example-co.invalid) does not resolve. details.json lists only CISO, CTO, compliance and DPO email addresses, with no grievance address. The application READMEs describe internal tools only (an MCP gateway and a data-model library), not client complaint channels.
  - `sebi-investor-grievance-scores-odr-timeline`: What resolution timeline does the company's grievance procedure commit to, and how is it tracked? Reason: No published grievance procedure or resolution timeline was found for this entity. The company website does not resolve, and no workspace file describes one. The timeline set by the SEBI master circular is not evidence of what this company commits to, so it was not used as the answer. The master circular page that was fetched shows only its title and date, not the body text.
  - `sebi-investor-grievance-scores-odr-escalation`: What escalation matrix, with names and designations, does the company publish for unresolved complaints? Reason: No published escalation matrix was found. Brokers and DPs usually publish one on their website, but this company's website (https://example-co.invalid) does not resolve. details.json has no escalation contacts. Names and designations must not be guessed from the contacts list.
  - `sebi-investor-grievance-scores-odr-complaints-data`: How many complaints did the company receive, resolve and leave pending in the last financial year, as shown in its published data? Reason: No complaint figures (received, resolved or pending) could be found. They are normally in the investor charter disclosure on the company website, which does not resolve. No annual report or filing for this entity could be found publicly.
  - `sebi-investor-grievance-scores-odr-odr-enrolment`: Is the company enrolled on the Smart ODR portal, and do its client agreements include the online dispute resolution clause? Reason: No source shows whether the company is enrolled on the Smart ODR portal or whether its client agreements have the online dispute resolution clause. The company website does not resolve, and no workspace file covers client agreements or ODR.
  - `sebi-investor-grievance-scores-odr-exchange-depository`: How are complaints forwarded by the exchanges and depositories received and closed? Reason: No source describes how complaints forwarded by NSE, BSE or the depositories are received and closed. details.json records only order routing to NSE and BSE as a critical function. There is no public page or workspace file about handling complaints that come through the exchanges or depositories.
  - `sebi-investor-grievance-scores-odr-ticketing-platform`: Which ticketing or CRM system records client complaints and their resolution? Reason: No ticketing or CRM system is named. The vendor register lists only AWS (hosting), GitHub (source and CI) and MongoDB Atlas (managed database). The two application READMEs describe an internal MCP gateway and a data-model library. The lack of a CRM in the workspace does not show that none exists, so the question stays open for a compliance officer.
- **q-sebi-cscrf-2024** (obligation sebi-cscrf-2024): 4 answered / 8 open / 0 not-applicable
  - `sebi-cscrf-2024-category`: Which CSCRF category did the company determine for FY 2026-27 for the broking and DP registrations, and on what basis? Reason: No fetched source says what category was set for FY 2026-27 or on what basis. details.json records category mid-size-re with categorisedAt 2025-04-01 (FY 2025-26) for INZ000999999 and IN-DP-999-2016, but it gives no FY 2026-27 determination and no basis such as client count or trading volume. Public sources are unavailable: the entity is a fictional fixture and its website is example-co.invalid. A compliance officer should confirm the FY 2026-27 category and its basis.
  - `sebi-cscrf-2024-it-committee`: Has an IT Committee for REs been set up, and who chairs it? Reason: No workspace file (details.json, application READMEs, env files, vendor files, summary.md) mentions an IT Committee for REs or its chair, and no public source exists for this fictional fixture entity.
  - `sebi-cscrf-2024-ciso`: Who is the designated CISO, and to whom do they report? Reason: Only half of this question has a source. details.json contacts name Meera Krishnan (ciso@example-co.invalid) as CISO, but no file states who the CISO reports to. The question is left open so a human confirms the reporting line and the name.
  - `sebi-cscrf-2024-vapt`: How often is VAPT performed, by which CERT-In empanelled auditor, and when was the last report submitted? Reason: Only the frequency has a source: details.json auditCadence.vaptPerYear is 2 (twice a year). No file names the CERT-In empanelled auditor or the date the last VAPT report was submitted. A human should confirm all three.
  - `sebi-cscrf-2024-cyber-audit`: When was the last CSCRF cyber audit filed with the exchanges and depositories, and who performed it? Reason: details.json gives only the planned frequency (auditCadence.cyberAuditPerYear 1). No file records when the last CSCRF cyber audit was filed with the exchanges or depositories, or who performed it. summary.md lists a proposed initiative 'Evidence the cyber audit cycle and track audit observations to closure within 3 months' (SEBI Sec-4.4), which suggests no filing evidence is on record.
  - `sebi-cscrf-2024-incident-reporting`: What is the procedure for reporting cyber incidents to SEBI, the exchanges, the depositories and CERT-In within the prescribed hours? Reason: No workspace file describes the procedure for reporting cyber incidents to SEBI, the exchanges, the depositories or CERT-In, and no public source exists for this fictional fixture entity.
  - `sebi-cscrf-2024-recovery`: What RTO and RPO did the last DR drill achieve for critical systems? Reason: No file records a DR drill or the RTO and RPO it achieved. details.json records only the target impact tolerance for order-routing (maxOutageMinutes 30, maxDataLossMinutes 0), which is a target, not a drill result.
  - `sebi-cscrf-2024-access-reviews`: How often are privileged and user access reviews performed on critical systems? Reason: No workspace file states how often privileged or user access reviews are run on critical systems, and no public source exists for this fictional fixture entity.
- **q-rbi-nbfc-sbr** (obligation rbi-nbfc-sbr): 0 answered / 10 open / 0 not-applicable
  - `x-rbi-nbfc-sbr-cor-category`: Which NBFC category (for example NBFC-ICC) does RBI certificate of registration N-13.09999 record for the company? Reason: No source I fetched names the NBFC category (for example NBFC-ICC) on certificate N-13.09999. details.json and summary.md record only the layer (nbfc-middle-layer). A web search for the legal name found no company page and no register entry. The company is a fictional fixture (contact domains are .invalid), so no public register can show its row. A compliance officer should confirm the category.
  - `rbi-nbfc-sbr-layer-basis`: Is the company in the middle layer because its total assets are Rs 1,000 crore or more, or because of its category (for example deposit-taking)? Reason: No fetched source says whether the middle-layer placement comes from total assets of Rs 1,000 crore or more or from the NBFC's category. The profile records only categorisedAt 2025-10-01. There is no balance sheet, annual report or register row for this fictional entity.
  - `rbi-nbfc-sbr-deposit-taking`: Is the NBFC deposit-taking (NBFC-D) or non-deposit-taking (NBFC-ND)? Reason: No fetched source says whether the NBFC is deposit-taking (NBFC-D) or non-deposit-taking (NBFC-ND). The profile description says 'margin-funding arm', which does not settle it. The RBI register cannot be checked for a fictional registration number.
  - `rbi-nbfc-sbr-asset-size`: What were the NBFC's total assets at the last audited balance sheet date? Reason: No audited balance sheet, annual report or MCA filing is available for this fictional company. The workspace does not record total assets.
  - `rbi-nbfc-sbr-nof`: Does the NBFC meet the net owned fund required for its category (Rs 10 crore for NBFC-ICC by the paragraph 42 glide path)? Reason: No financial statements or regulator source give the net owned fund. Also, the NBFC category that sets the NOF threshold is itself unconfirmed (see x-rbi-nbfc-sbr-cor-category).
  - `rbi-nbfc-sbr-customer-interface`: Does the NBFC have a public customer interface, or does it lend only to group or broking clients? Reason: No company website or public source describes who the NBFC lends to. The profile description ('margin-funding arm' of a discount broker) suggests broking clients, but it does not say whether there is a public customer interface. Recording a lending segment or offering from that would be a guess.
  - `rbi-nbfc-sbr-group-structure`: Is the NBFC a separate legal entity, or is the lending business carried out inside Example Capital Markets Private Limited, the SEBI broker entity? Reason: details.json puts the RBI registration N-13.09999 on the legal entity Example Capital Markets Private Limited (CIN U67120MH2016PTC999999). However, the description calls the NBFC an 'arm', and no MCA master data or RBI register row was fetched to show whether the NBFC is the same legal entity or a separate subsidiary. This is the profile's own claim, not an external confirmation. It stays open for a compliance officer. No drift is reported because nothing contradicts the profile.
  - `rbi-nbfc-sbr-ml-governance`: Has the NBFC appointed a Chief Compliance Officer and the board committees required of the middle layer, and who holds those roles? Reason: details.json lists a compliance-officer contact (Farah Sheikh), but no source says she is the NBFC's RBI Chief Compliance Officer. No source names the board committees required of a middle-layer NBFC (for example the audit, risk management and IT strategy committees). No annual report or company governance page exists for this fictional entity.
  - `rbi-nbfc-sbr-change-in-control`: Has there been any change in shareholding, control or management since registration that needed prior RBI approval, and was it obtained? Reason: No MCA filings, shareholding disclosures or RBI approvals are available for this fictional company, and the workspace records no change in control since registration on 2019-03-15. Having no record is not evidence that nothing changed.
  - `rbi-nbfc-sbr-returns`: Which periodic returns does the NBFC file with the RBI Department of Supervision, and through which portal? Reason: No fetched source lists the Department of Supervision returns the NBFC files or the portal it uses (for example CIMS). None of the workspace application READMEs or environment files mention RBI regulatory reporting (grep for nbfc, rbi, cims, xbrl and returns found nothing in applications/*). A regulatory-reporting process is therefore not yielded until someone confirms it.
- **q-rbi-cyber-tech-2026** (obligation rbi-cyber-tech-2026): 3 answered / 8 open / 0 not-applicable
  - `rbi-cyber-tech-2026-board-policies`: Has the Board approved the IT, information security and cybersecurity policies required by the 2026 Directions, and when were they last reviewed? Reason: No source says whether the Board approved IT, information security or cybersecurity policies, or when it last reviewed them. The company's declared website (https://example-co.invalid) does not resolve, and example-co is a fictional fixture with no annual report or filings. details.json, the application READMEs, the env files and the soc ledger contain no Board approval or policy review date. sdlc/policy.json covers SDLC only (reviewCadenceMonths, owner) and is not the Board-approved IT, information security or cybersecurity policy. A compliance officer must answer this.
  - `rbi-cyber-tech-2026-critical-systems`: Which information systems does the NBFC classify as critical: the loan management, margin funding, collateral or pledge, and customer portal systems? Reason: No source classifies any NBFC information system as critical. details.json criticalFunctions has only 'order-routing' (routing client orders to NSE and BSE), a broking function carried by mcp-gateway. No loan management, margin funding, collateral or pledge, or customer portal system appears in applications/ (only mcp-gateway and db-models) or in the vendor files. A compliance officer must say which lending systems are classified as critical.
  - `rbi-cyber-tech-2026-platform-apps`: Do the mcp-gateway application and the client-data and order stores it queries also carry NBFC borrower or loan data? Reason: No source confirms or rules this out. The mcp-gateway README says it lets AI agents query 'the client-data and order stores' with data classes pii and financial, and it does not mention borrower or loan data. The prod and qa env files classify data only as pii and financial. The gateway's database targets come from a runtime connection string (ledger observation obs_01M2FTV6HWRF2KFZCSKGXQ4EC8), so the code cannot show whether lending stores are reachable. The db-models library (models.py: Secrets, Entity, User, Holdings, Insights and similar) has no loan, borrower, margin-funding, pledge or collateral model, but that proves nothing about mcp-gateway's runtime targets. The application owner must confirm.
  - `rbi-cyber-tech-2026-incident-reporting`: What process and owner report cyber incidents on DAKSH within six hours of detection (para 141), alongside CERT-In and exchange reporting? Reason: No source describes a cyber incident reporting process or owner for DAKSH (RBI), CERT-In or the exchanges. details.json lists ciso, cto, compliance-officer and dpo contacts but no designated-officer role and no incident reporting procedure. The soc ledger has no incident records or observations about DAKSH reporting. The website is unreachable. A compliance officer must answer this.
  - `rbi-cyber-tech-2026-is-audit`: When was the last annual IS audit (para 56) completed, and by whom? Reason: No source records a completed IS audit or its auditor. details.json only declares a target cadence (auditCadence.cyberAuditPerYear: 1). Ledger finding fnd_01M2GS6B87TV7NHZQ8BMGDR4HZ (status triaged) says there is 'no observation evidencing a completed cyber audit'. The audit date and auditor must come from a compliance officer.
  - `rbi-cyber-tech-2026-vapt`: When were the last vulnerability assessment (six-monthly) and penetration test (12-monthly) of critical systems under para 121 done? Reason: No source gives the date of the last vulnerability assessment or penetration test. details.json declares auditCadence.vaptPerYear: 2 as a target, but ledger finding fnd_01M2GS6B87TV7NHZQ8BMGDR4HZ says no completed audit or VAPT is evidenced. The NBFC's critical systems are not identified either (see rbi-cyber-tech-2026-critical-systems). A compliance officer must answer this.
  - `rbi-cyber-tech-2026-bcp-dr`: When was the last DR drill for critical systems (half-yearly under para 129), and what RTO and RPO are set for lending systems? Reason: No source records a DR drill date, and no RTO or RPO is set for lending systems. The only impact tolerance in details.json is for the broking function 'order-routing' (maxOutageMinutes 30, maxDataLossMinutes 0), not for lending. A compliance officer must give the drill date and the lending RTO and RPO.
  - `rbi-cyber-tech-2026-customer-auth`: Which digital channels do NBFC customers use to apply for, draw down or repay loans, and what authentication protects them? Reason: No source names the digital channels NBFC customers use to apply for, draw down or repay loans, or how those channels authenticate them. There is no customer-facing lending application under applications/, and the company website (https://example-co.invalid) does not resolve. The profile only calls the NBFC a 'margin-funding arm', with no channel detail. A compliance officer must answer this.
- **q-rbi-outsourcing-2025** (obligation rbi-outsourcing-2025): 5 answered / 6 open / 0 not-applicable
  - `rbi-outsourcing-2025-policy`: Has the Board approved an outsourcing policy that covers both financial services and IT services outsourcing? Reason: No source found. The company website (https://example-co.invalid) does not resolve (getaddrinfo ENOTFOUND), and no annual report, filing or workspace file mentions a Board-approved outsourcing policy. The ledger holds control records for the Board-approved financial-services and IT outsourcing policies but no observation that such a policy exists. The compliance officer needs to confirm.
  - `rbi-outsourcing-2025-financial-services`: Which financial services activities (sourcing, collection, recovery, KYC verification, customer support) does the NBFC outsource, and to whom? Reason: No public or workspace source says which financial-services activities of the NBFC margin-funding arm (sourcing, collection, recovery, KYC verification, customer support) are outsourced. The website does not resolve, and the vendor register (company-profile/example-co/vendors/) lists only IT services: AWS, MongoDB Atlas and GitHub.
  - `rbi-outsourcing-2025-group`: Does the NBFC receive services from group entities such as the broking business (shared technology, operations, staff), and are those covered by arm's-length agreements? Reason: Not answerable from the sources. details.json shows the broking, DP and NBFC registrations all held by one legal entity (CIN U67120MH2016PTC999999), so the broking business is not a separate group entity. All three vendor records have intraGroup false. No source says whether any other group company (parent or sister) provides technology, operations or staff, or whether arm's-length agreements exist. The compliance officer needs to confirm.
  - `rbi-outsourcing-2025-inventory`: Does the NBFC keep an inventory of outsourced IT services (paragraph 82), and who owns it? Reason: Not answerable from the sources. The workspace vendor register (company-profile/example-co/vendors/) lists three services, and each has a lastAssessment dated 2026-06-15 by the vendor-risk@example-co.invalid mailbox. No source says the company keeps this as its para 82 inventory with supply-chain dependency mapping, and none names an accountable owner. The compliance officer needs to confirm.
  - `rbi-outsourcing-2025-incident-notice`: Do agreements require service providers to report incidents to the NBFC within the directions' timeline (paragraph 61)? Reason: No source describes incident-reporting clauses in the service-provider agreements. The vendor records have no field for provider incident-notice timelines, and the agreements themselves are not in the workspace. The compliance officer needs to confirm whether the agreements require providers to report within the para 61 timeline.
  - `rbi-outsourcing-2025-grievance`: How are customer grievances about outsourced services (for example recovery agents or call centres) received and resolved? Reason: No source found. The company website (https://example-co.invalid) does not resolve, no grievance-officer contact is recorded in details.json, and no source says whether the NBFC uses recovery agents or outsourced call centres or how complaints about them are handled. The compliance officer needs to confirm.
- **q-rbi-nbfc-kyc** (obligation rbi-nbfc-kyc): 0 answered / 10 open / 0 not-applicable
  - `rbi-nbfc-kyc-applicability`: Does the NBFC have a customer interface that brings it within the KYC Directions? Reason: Paragraph 3 of the RBI (NBFC - KYC) Directions, 2025 (fetched) excludes 'NBFCs not having any customer interface'. The only workspace statement is the details.json description, 'a middle-layer NBFC margin-funding arm'. It does not say whether the NBFC lends directly to customers, or whether it is this legal entity rather than a group company. The READMEs and env files say nothing about lending customers. The company website (example-co.invalid) cannot be resolved, and a public search for the legal name and CIN found nothing. A compliance officer must confirm.
  - `rbi-nbfc-kyc-shared-onboarding`: Are NBFC borrowers onboarded through the broker's SEBI KYC process, through a separate RBI-compliant NBFC KYC, or both? Reason: No fetched source describes how NBFC borrowers are onboarded, whether through the broker's SEBI KYC, a separate RBI KYC, or both. The website cannot be resolved, and the READMEs (mcp-gateway, db-models) and env files do not mention KYC or onboarding.
  - `rbi-nbfc-kyc-channels`: Which onboarding channels does the NBFC use: V-CIP, digital KYC, Aadhaar e-KYC, CKYCR retrieval, or in person? Reason: No fetched source names the onboarding channels (V-CIP, digital KYC, Aadhaar e-KYC, CKYCR retrieval, in person). No workspace application is described as an onboarding or KYC platform.
  - `rbi-nbfc-kyc-segments`: Which customer types does the NBFC lend to: resident individuals, NRIs, HNIs, corporates, or trading clients of the group broker? Reason: The details.json description and tags ('retail-broking') refer to the broker, not to NBFC borrowers. No fetched source says which customer types the NBFC lends to. Treating the broker's retail clients as NBFC borrowers would mix up the group and the entity.
  - `rbi-nbfc-kyc-risk-categorisation`: How does the NBFC risk-categorise customers, and how does it schedule periodic KYC updation under paragraph 42? Reason: This is an internal KYC policy matter (risk categories and the periodic updation schedule). No public or workspace source describes it. A compliance officer must answer.
  - `rbi-nbfc-kyc-designated-director`: Who are the NBFC's Designated Director and Principal Officer, and have their details been communicated to FIU-IND and RBI? Reason: details.json lists a compliance officer and DPO (Farah Sheikh) but no Designated Director or Principal Officer under the PMLA. No fetched source shows whether details were sent to FIU-IND or RBI. Treating the compliance officer as the Principal Officer would be a guess.
  - `rbi-nbfc-kyc-fiu-reporting`: Which FIU-IND reports (CTR, STR, CCR, NTR) does the NBFC file, and is the reporting entity registration separate from the broker's? Reason: No fetched source shows which FIU-IND reports (CTR, STR, CCR, NTR) the NBFC files, or whether its FIU-IND reporting-entity registration is separate from the broker's. FIU-IND registrations are not published in a public register.
  - `rbi-nbfc-kyc-transaction-monitoring`: What system monitors NBFC customer transactions for suspicious activity? Reason: No README or env file describes an AML or transaction-monitoring system. The existing security-operations-centre platform is for cybersecurity (M-SOC and SIEM), not AML surveillance, so it is not reused here.
  - `rbi-nbfc-kyc-ckycr-upload`: Does the NBFC upload new customers' KYC records to CKYCR, and within what time? Reason: No fetched source says whether or how quickly the NBFC uploads KYC records to CKYCR.
  - `rbi-nbfc-kyc-sanctions-screening`: How does the NBFC screen customers against UN sanctions lists and other lists required by international agreements? Reason: No fetched source describes screening against UN sanctions lists or the lists required under Chapter IX. No workspace application is described as doing screening.
- **q-rbi-nbfc-rbc** (obligation rbi-nbfc-rbc): 1 answered / 9 open / 0 not-applicable
  - `rbi-nbfc-rbc-applicability`: Is the NBFC one of the categories the Responsible Business Conduct Directions cover, and does it have a customer interface? Reason: The RBC Directions (RBI/DOR/2025-26/362, fetched) apply to 'all layers, unless specified otherwise' across NBFC-D, NBFC-ICC, NBFC-Factor, NBFC-MFI, NBFC-IFC, IDF-NBFC and HFC, and exclude 'NBFCs not having any customer interface'. details.json records only the layer (nbfc-middle-layer, N-13.09999), not the NBFC category, and whether the NBFC has a customer interface. The company website (example-co.invalid) does not resolve, and the placeholder registration number cannot be matched on the RBI register. A compliance officer must confirm the category and the customer interface.
  - `rbi-nbfc-rbc-fpc`: Has the Board approved a Fair Practices Code, and is it published on the company website in the vernacular language? Reason: The Directions require a Board-approved Fair Practices Code, 'preferably be in the vernacular language', 'put up on its website'. The company website https://example-co.invalid did not resolve (ENOTFOUND), and no workspace file mentions a Fair Practices Code. A compliance officer must confirm that the Board approved it, when, and the published URL and language.
  - `rbi-nbfc-rbc-kfs`: Does the NBFC give a Key Facts Statement with APR to retail and MSME borrowers before loan execution? Reason: The KFS applies to 'all retail and MSME term loan products extended by all NBFCs' (Directions, fetched). No fetched source shows whether the NBFC's margin funding is a retail or MSME term loan, or whether it gives borrowers a KFS with APR. The website does not resolve.
  - `rbi-nbfc-rbc-segments`: Are the NBFC's borrowers retail individuals, MSMEs, corporates, or only clients of the group broker? Reason: No fetched source identifies the NBFC's borrowers (retail individuals, MSMEs, corporates, or only clients of the group broker). details.json tags the company 'retail-broking', but that describes the broking business, not the NBFC's borrowers. Treating broking clients as borrowers would be a guess.
  - `rbi-nbfc-rbc-grievance-officer`: Who is the NBFC's grievance redressal officer, and where are the escalation matrix and RBI Integrated Ombudsman details published? Reason: details.json contacts list ciso, cto, compliance-officer and dpo, but no grievance-officer. No fetched page publishes an escalation matrix or the RBI Integrated Ombudsman details, because the website example-co.invalid does not resolve. A compliance officer must name the grievance redressal officer and the publication URL.
  - `rbi-nbfc-rbc-internal-ombudsman`: Has the NBFC appointed an Internal Ombudsman, or does it fall below the Rs 5,000 crore NBFC-ND threshold in the 2026 Internal Ombudsman Directions? Reason: No fetched source records the NBFC's asset size or an Internal Ombudsman appointment, so the Rs 5,000 crore NBFC-ND threshold cannot be applied. ComplianceOS returned no result for the RBI Internal Ombudsman Directions, and the 2026 Directions' paragraph 3(1) was not read this session. A compliance officer must confirm the asset size and any appointment.
  - `rbi-nbfc-rbc-recovery`: Does the NBFC use recovery agents, or does it recover margin funding shortfalls by liquidating pledged collateral, and under which policy? Reason: No fetched source says whether the NBFC uses recovery agents or liquidates pledged collateral to recover margin shortfalls, or under which policy. The company website does not resolve, and no workspace README covers lending operations.
  - `rbi-nbfc-rbc-board-review`: How often does the Board review grievances and compliance with the Fair Practices Code? Reason: The Directions require the Board to 'provide for periodical review of the compliance of the Fair Practices Code and the functioning of the grievance redressal mechanism'. No fetched source (annual report, website, workspace file) states how often the Board does this review.
  - `rbi-nbfc-rbc-interest-policy`: Has the Board adopted an interest rate model, and are rate ranges and charges disclosed on the website? Reason: No fetched source shows a Board-adopted interest rate model, or rate ranges and charges disclosed on the website, because example-co.invalid does not resolve. A compliance officer must confirm the policy and the disclosure URL.
- **q-rbi-nbfc-credit** (obligation rbi-nbfc-credit): 0 answered / 9 open / 0 not-applicable
  - `rbi-nbfc-credit-las-offered`: Does the NBFC lend against listed shares or other securities, and if so, under which products? Reason: refuted: entity-identity: The only source naming Example Capital Markets Private Limited is its own details.json (the 'margin-funding arm' excerpt and N-13.09999 are present, but citing the profile ba
  - `rbi-nbfc-credit-ltv-monitoring`: How does the NBFC keep the 50 per cent LTV at all times and cure shortfalls within seven working days? Reason: No fetched source or workspace file describes how LTV is monitored or how shortfalls are cured. Neither application README (mcp-gateway, db-models) mentions a loan or collateral monitoring system. Needs the compliance officer or risk team.
  - `rbi-nbfc-credit-eligible-collateral`: Does the NBFC accept only Group 1 securities as collateral for loans above Rs 5 lakh? Reason: No public source or workspace file lists the securities the NBFC accepts as collateral. The company website does not resolve.
  - `rbi-nbfc-credit-exchange-reporting`: Does the NBFC file quarterly online reports of shares pledged to it with the stock exchanges, and who files them? Reason: No exchange filing or workspace file shows quarterly reports of pledged shares, or who files them. Needs the compliance officer.
  - `rbi-nbfc-credit-pledge-mechanism`: How are pledges created and invoked: depository margin pledge through the group DP, or another mechanism? Reason: The profile shows the DP registration IN-DP-999-2016 held by the same legal entity as the NBFC registration, not by a group DP. No source says whether pledges use the depository margin pledge or another mechanism.
  - `rbi-nbfc-credit-own-shares`: Does the NBFC have controls preventing loans against its own shares or debentures, or those of the group? Reason: No source describes controls against lending on the NBFC's own shares or debentures, or the group's. As a private limited company (CIN U67120MH2016PTC999999) its own shares are unlisted, but the controls themselves are unevidenced.
  - `rbi-nbfc-credit-policy`: Has the Board approved a credit or loan policy that sets exposure limits, margin requirements and collateral haircuts? Reason: No annual report or public policy document was available, and no workspace file mentions a Board-approved credit or loan policy.
  - `rbi-nbfc-credit-cic-reporting`: Does the NBFC report borrower credit data to the credit information companies, and to which ones? Reason: No source says which credit information companies the NBFC reports to. Answerable by the compliance officer.
  - `rbi-nbfc-credit-loan-book-size`: What are the size and number of borrowers of the NBFC's loan book against securities? Reason: No annual report, financial filing or public disclosure of the loan book size or borrower count was available. The nbfc-middle-layer category in the profile does not by itself give the loan book against securities.
- **q-rbi-nbfc-fraud** (obligation rbi-nbfc-fraud): 0 answered / 8 open / 0 not-applicable
  - `rbi-nbfc-fraud-policy`: Has the Board approved a fraud risk management policy, and when was it last reviewed (at least every three years)? Reason: No fetchable source says whether a Board-approved fraud risk management policy exists or when it was last reviewed. The company is a fictional fixture and its website (https://example-co.invalid) uses a reserved .invalid domain, so it cannot be fetched and there is no annual report or filing. The workspace files (details.json, applications/*/README.md, env/*.json, summary.md, vendors) never mention a fraud policy. A compliance officer must answer this.
  - `rbi-nbfc-fraud-committee`: Has the NBFC set up a Committee of Executives or an SCBMF to monitor frauds, and who are its members? Reason: No fetchable source names a Committee of Executives or a Special Committee of the Board for Monitoring and Follow-up of cases of Frauds (SCBMF), or its members. details.json contacts list only the CISO, CTO, compliance officer and DPO, and none is described as a fraud committee member. The company website cannot be fetched (reserved .invalid domain).
  - `rbi-nbfc-fraud-ews`: Does the NBFC run an early warning signal and red-flagged account framework, and on which system? Reason: No source describes an early warning signal (EWS) or red-flagged account (RFA) framework, or the system that runs it. The only application READMEs describe mcp-gateway (a MongoDB MCP gateway for AI agents that query client-data and order stores) and db-models (a shared SQLAlchemy model library). Neither mentions EWS, RFA or loan-account monitoring, so no platform can be assigned without guessing.
  - `rbi-nbfc-fraud-fmr`: Who files fraud monitoring returns with RBI within 14 days of classification, and how many frauds were reported in the last year? Reason: No public or workspace source names who files fraud monitoring returns (FMR) with RBI, or how many frauds were reported last year. FMR filings are not public, and the fixture has no annual report or website that can be fetched. The compliance officer must answer this.
  - `rbi-nbfc-fraud-lea`: Has the NBFC designated a nodal officer to report frauds to law enforcement agencies? Reason: No source names a nodal officer for reporting frauds to law enforcement agencies. details.json contacts have no such role, and no company website or filing can be fetched.
  - `rbi-nbfc-fraud-natural-justice`: Does the fraud classification process give the persons concerned a show cause notice with at least 21 days to respond? Reason: No source describes how the fraud classification process works, including whether a show cause notice gives at least 21 days to respond. This is an internal procedure that no fetchable public or workspace source records.
  - `rbi-nbfc-fraud-internal-audit`: Does internal audit cover fraud prevention, detection, classification, reporting and closure? Reason: No source describes what internal audit covers. details.json auditCadence records only VAPT (2 a year) and cyber audit (1 a year), and says nothing about internal audit of fraud prevention, detection, classification, reporting or closure.
  - `rbi-nbfc-fraud-cyber-link`: How are cyber-enabled frauds (account takeover, phishing, unauthorised pledge invocation) handed between the fraud and cyber incident response teams? Reason: No source describes a handoff between the fraud team and the cyber incident response team. The profile records socModel m-soc-nse-bse, and the ledger holds the catalog control rbi-cyber-tech-directions-2026:182 (DAKSH reporting within six hours). That control text is regulatory catalog content, not evidence of how the company handles cyber-enabled frauds such as account takeover, phishing or unauthorised pledge invocation. The mechanism cannot be stated without guessing.
- **q-rbi-nbfc-misc** (obligation rbi-nbfc-misc): 0 answered / 6 open / 0 not-applicable
  - `rbi-nbfc-misc-regional-office`: Which RBI regional office supervises the NBFC? Reason: No fetched source names the RBI regional office that supervises N-13.09999. The entity is a fictional fixture with no RBI NBFC register entry, and details.json does not have this field. Working it out from the Mumbai headquarters or the CoR prefix would be a guess.
  - `rbi-nbfc-misc-intimations`: What process tracks changes in directors, principal officer, auditors and registered address, and notifies RBI within one month? Reason: No workspace file or public page describes a process for tracking changes in directors, principal officer, auditors or registered address, or for telling RBI within one month. Only the compliance-officer contact is recorded.
  - `rbi-nbfc-misc-auditor-appointment`: Who is the NBFC's statutory auditor, and was the appointment made under RBI's 27 Apr 2021 guidelines on appointing statutory auditors? Reason: No annual report, MCA filing or workspace file names the statutory auditor or says whether the appointment followed RBI's 27 Apr 2021 guidelines. The fictional entity has no public filings.
  - `rbi-nbfc-misc-credit-rating`: Does the NBFC hold a credit rating, from which agency, and has every rating change been reported to RBI within 15 days? Reason: No rating agency release, annual report or workspace file shows a credit rating for the NBFC, so rating changes reported to RBI cannot be confirmed. The 'rating' fields in vendors/*.json are vendor risk ratings, not the NBFC's credit rating.
  - `rbi-nbfc-misc-financial-disclosures`: Does the NBFC publish annual financial statements with the disclosures required by the NBFC Financial Statements: Presentation and Disclosures Directions, 2025? Reason: No published annual report or financial statements exist for this fictional entity, and the workspace does not record whether the NBFC Financial Statements: Presentation and Disclosures Directions, 2025 disclosures are made.
  - `rbi-nbfc-misc-compliance-calendar`: Does the compliance function keep a calendar of RBI NBFC filings and intimations separate from the broker's SEBI calendar? Reason: No workspace file or public page describes a compliance calendar for RBI NBFC filings, or says whether it is kept separate from the SEBI broker calendar. A compliance officer needs to answer this.

### Processes
- market-transactions: Order routing to exchanges (`order-routing`; obligations sebi-cscrf-2024)
- other: Security monitoring via NSE/BSE M-SOC and SIEM (`security-monitoring`; obligations sebi-cscrf-2024, rbi-cyber-tech-2026)
- vendor-management: Third-party technology vendor risk assessment (`vendor-risk-assessment`; obligations sebi-cscrf-2024); Third-party technology vendor management (`vendor-management`; obligations rbi-cyber-tech-2026, rbi-outsourcing-2025)
- lending: Lending (margin funding) (`lending`; obligations rbi-nbfc-rbc)

## Applications
`refresh-apps` refreshed this section as of `provenance.generatedAt` 2026-09-15T01:07:20Z
(`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ, `provenance.sessionId`
ba015ad3-cd5b-4821-8df0-4ceb2aa31e60): 2/2 repos synced (0 advanced), 1 record written
(`applications/mcp-gateway/repos/mongodb-mcp-server.json`), 5 confirmed gap(s). Source:
`applications/*/README.md`, `applications/*/env/*.json`, `applications/*/images/*.json`,
`applications/*/repos/*.json` and this run's `refresh-apps` observations in `soc/main.jsonl`. Both
applications named in `details.json` `criticalFunctions[].appIds` (`mcp-gateway`) and present under
`applications/` (`mcp-gateway`, `db-models`) have application records; neither is a bare id with no
directory.

### mcp-gateway
Environments (`applications/mcp-gateway/env/*.json`):

| Env | Tier | Exposure | Residency | Log retention (d) | ≥180 d (CERT-In Dir-iv) |
|---|---|---|---|---|---|
| `dev` | dev | internal | IN | 30 | below 180 d — `CERT-In cert-in-directions-2022 Dir-iv` (CERT-In Directions 2022) |
| `qa` | qa | internal | IN | 180 | meets 180 d |
| `prod` | prod | partner | IN | 365 | meets 180 d |

Repos (`applications/mcp-gateway/repos/*.json`):

| Repo | Host | Default branch | Head commit | Last fetched |
|---|---|---|---|---|
| `mongodb-mcp-server` | github | main | `aaa72a040db4c32f3d6488d5e28e2892a68e9ee0` | 2026-09-15T01:07:20Z |

Images: `applications/mcp-gateway/images/` does not exist — no image record for the container built from
`mongodb-mcp-server`'s `Dockerfile` and deployed to `dev` (no digest, no SBOM); flagged this run as
image-untracked [obs_01M2HA93RFR9HZTQZ521NNKD25].

Open findings targeting this application's repo (latest-state map over `soc/main.jsonl`, status
open/triaged/remediating, as of 2026-09-14T21:01:13Z): 24 (18 high, 6 medium). Last probe `collectedAt`:
2026-09-15T01:07:20Z (`refresh-apps` repo sync [obs_01M2HA93N1YBMSZ1MWH62PH4N3]); most recent
security-finding probe `probe-agent-graph` at 2026-09-14T19:14:04Z.

Confirmed drift and credential gaps this run:
- untracked-repo: the generated `.github/workflows/vulnerability-scanner.lock.yml` checks out the upstream
  `github.com/mongodb-js/mongodb-mcp-server`, which has no `applications/` repo record of its own
  [obs_01M2HA93NV3WGRTKGNQMDTPEGB].
- credentials-unverifiable: all three credential lookups for `mcp-gateway` (`dev-docker-socket`,
  `prod-kubeconfig-ro`, `qa-kubeconfig-ro`) failed because no age decryption key was available in this
  sandbox, so it is unknown whether the entries exist or are overdue for rotation
  [obs_01M2HA93PRTNDKAN4WGGJ3F97S].
- evidence-request (2): `prod` and `qa` declare IaC path `deploy` in `mongodb-mcp-server`, but at the
  pinned commit `deploy/` contains only an Azure Bicep template and an AWS Bedrock AgentCore Dockerfile —
  no Kubernetes manifest or Helm chart exists to confirm either environment's declared cluster/namespace
  [obs_01M2HA93QKKY9J2JJT93FDJTHY].
- image-untracked: `dev`'s container image (built from the repo `Dockerfile`) has no
  `applications/mcp-gateway/images/` record, digest or SBOM [obs_01M2HA93RFR9HZTQZ521NNKD25].

### db-models
Environments (`applications/db-models/env/*.json`):

| Env | Tier | Exposure | Residency | Log retention (d) | ≥180 d (CERT-In Dir-iv) |
|---|---|---|---|---|---|
| `dev` | dev | isolated | IN | 0 | below 180 d — `CERT-In cert-in-directions-2022 Dir-iv` (CERT-In Directions 2022) |

Repos (`applications/db-models/repos/*.json`):

| Repo | Host | Default branch | Head commit | Last fetched |
|---|---|---|---|---|
| `onfinance-db-model-master` | github | master | `70b3633e171a1b8d389b27bb901c84c34a0e9bf6` | 2026-09-14T00:00:00Z |

Images: `applications/db-models/images/` does not exist — no image record.

Open findings targeting this application (latest-state map over `soc/main.jsonl`, status
open/triaged/remediating, as of 2026-09-14T21:01:13Z): 7 (2 high, 5 medium) against the
`onfinance-db-model-master` repo. Last probe `collectedAt`: 2026-09-15T01:07:20Z (`refresh-apps` repo sync
[obs_01M2HA718963SPZZBQGHZWRY0A], `result: satisfied`, 0 commits advanced).

No drift or credential gaps confirmed against `db-models` this run.

<!-- source: applications/*/env/*.json, applications/*/repos/*.json, applications/*/images/*.json (absent for both apps); open-findings counts = latest-state map over soc/main.jsonl kind:finding filtered to target.type in (repo, environment) with appId matching, status open|triaged|remediating; refresh-apps observations obs_01M2HA718963SPZZBQGHZWRY0A, obs_01M2HA93N1YBMSZ1MWH62PH4N3, obs_01M2HA93NV3WGRTKGNQMDTPEGB, obs_01M2HA93PRTNDKAN4WGGJ3F97S, obs_01M2HA93QKKY9J2JJT93FDJTHY, obs_01M2HA93RFR9HZTQZ521NNKD25 -->

## Vendors
`refresh-vendor-ctx` refreshed this section as of 2026-09-14T10:46:39Z: 0 vendors onboarded, 1 updated
(`github`, re-read at 2026-09-14T10:46:39Z), 6 new finding(s) raised this run, 0 findings re-seen. Source:
`company-profile/example-co/vendors/*.json` (3 files) and vendor-targeted findings in `soc/main.jsonl`.

| Vendor | Legal name | Status | Materiality | Critical functions | Hosting vs. residency | Newest assurance | Expiry | Open findings |
|---|---|---|---|---|---|---|---|---|
| `aws` | Amazon Web Services, Inc. | active | material | order-routing (`mcp-gateway`) | AWS ap-south-1, hosting `IN`; app residency requirement `IN` (match) | soc2-type2 (Ernst & Young LLP, period ending 2026-03-31) | 2027-03-31 | [fnd_01M2FRY4TTS6M3JJD1F1P7J0TQ] |
| `github` | GitHub, Inc. | active | material | none (`supportsCriticalFunction: false`; repos back `mcp-gateway`, `db-models`) | GitHub Enterprise Cloud, hosting `US`; no critical function assigned so no residency requirement applies | soc2-type2 (Ernst & Young LLP, period ending 2025-09-30) | 2026-09-30 | [fnd_01M2FS4806WHXANC3Q9QXEAXGF], [fnd_01M2FS481DGTPTR9NJGKAAMF49], [fnd_01M2FS482NWXE7E5MCZY2QMAZ0] |
| `mongodb-atlas` | MongoDB, Inc. | active | material | order-routing (`mcp-gateway`) | Atlas on AWS ap-south-1, hosting `IN`; app residency requirement `IN` (match) | none on file | n/a | [fnd_01M2FS9EBVSP2DPWN5K2D91QKW], [fnd_01M2FS9ECP3E0MTCRQFEJ97930] |

<!-- source: company-profile/example-co/vendors/*.json services[].hostingCountries vs applications/mcp-gateway/env/*.json residency; open findings = latest kind:finding per id with target.type:vendor and status open in soc/main.jsonl -->

Expiry note: GitHub's SOC 2 Type II report expires 2026-09-30, 16 days after this run's
`provenance.generatedAt` (2026-09-14T10:46:39Z), inside the 90-day assurance-expiring window; flagged in
[fnd_01M2FS4806WHXANC3Q9QXEAXGF]. `mongodb-atlas` carries no `assurance[]` entry in its vendor file at all.

## Data flows
`refresh-metastore` catalogued this run: 1 catalog (0 carried forward, 0 dropped), 14 tables, 36 PII columns,
0 pipelines, 0 lineage edges, 12 confirmed gap(s), from `company-profile/example-co/sdlc/metastore.json`
(`snapshotAt` 2026-09-14T11:10:49Z).

### Catalogs by application

| App | Catalog | Type | Tables | PII columns | Residency |
|---|---|---|---|---|---|
| `db-models` | `db-models-mongodb` | other (MongoDB document store; no document-store catalog type exists yet, see `schema-gap` below) | 14 | 36 | unknown — endpoint and region not resolvable (`endpointRef: db-models-mongodb-ro` is a placeholder, not a resolvable locator) [obs_01M2FTMXD2BWZNQ5TE51A42A5P] |

Table-level counts (columns / of which PII), all under schema `default`: `secrets` 7/6, `webinar` 4/0,
`communities` 5/1, `new_discussions` 20/7, `entity` 48/7, `insights_raw` 23/0, `insights_raw_crypto` 23/0,
`insights_raw_us_stocks` 23/0, `insights` 24/0, `user` 54/13, `notifications` 8/0, `feedback` 3/1, `reward`
9/1, `cached_chats` 2/0 (sum: 14 tables, 36 pii columns). `secrets` and `user` also carry `spdi` and
`financial`-classified columns (trading-account credentials, portfolio holdings and values)
[obs_01M2FTMXD2S83CCJ9B0H279E2R].

`mcp-gateway`'s repo `mongodb-mcp-server` recorded no catalog: it is a generic MongoDB MCP client whose
database, collections and fields come from a connection string supplied at runtime, so nothing could be
recorded from code [obs_01M2FTV6HWRF2KFZCSKGXQ4EC8]. It is the only application backing the
`order-routing` critical function (`details.json` `criticalFunctions[0]`).

### Pipelines and lineage
`pipelines: []` and `lineage: []` in `sdlc/metastore.json` — no orchestrator, source repo, schedule or
OpenLineage edge is recorded this run, so no source -> job -> sink chain carrying pii, spdi, cardholder or
financial data can be shown.

### Retention versus in-scope instruments
No table in `db-models-mongodb` carries a `retentionDays` value (all null in `sdlc/metastore.json`), so no
recorded retention period can be compared against the in-scope instruments' data- and log-retention periods
(`dpdp-rules-2025:8(3)` data-retention 1 year, `dpdp-rules-2025:6(1)(e)` log-retention 1 year,
`cert-in-directions-2022:Dir-v`/`Dir-vi` data-retention 5 years, `cert-in-directions-2022:Dir-iv` log-retention
180 days): no record-keeping period stated by an in-scope instrument is present in the metastore to compare.
This is itself an evidence request: `user`, `secrets` and several other collections hold personal data with
no retention setting, TTL index or expiry field in code [obs_01M2FTMXD2QGV91CGDAFY0YQ0S]. For `mcp-gateway`,
log retention is configured outside the repo (env files state prod 365 days, qa 180 days via a Wazuh SIEM) and
is requested for confirmation against `cert-in-directions-2022:Dir-iv` (180 days) and
`rbi-cyber-tech-directions-2026:95` [obs_01M2FTV6MCKCJTVHDHHP02KJ2V].

### Confirmed gaps (12)
db-models / onfinance-db-model-master (9): 1 endpointRef-missing [obs_01M2FTMXD2BWZNQ5TE51A42A5P], 3
evidence-request [obs_01M2FTMXD2QGV91CGDAFY0YQ0S], 4 classification-conflict
[obs_01M2FTMXD2S83CCJ9B0H279E2R], 1 schema-gap [obs_01M2FTN49XKFG0B4JAZRP4P6X1]. mcp-gateway /
mongodb-mcp-server (3): evidence-request for target inventory/residency
[obs_01M2FTV6K4Q25G1JT58HAZDV36], log retention [obs_01M2FTV6MCKCJTVHDHHP02KJ2V], and telemetry PII transfer
[obs_01M2FTV6NJKW6VW58KFH78E5AV]. Catalogue-level summaries: [obs_01M2FTMXD188SPBHGHF4AMHN97],
[obs_01M2FTV6HWRF2KFZCSKGXQ4EC8].

<!-- source: sdlc/metastore.json catalogs[].schemas[].tables[].columns[] counted by pii:true; soc/main.jsonl kind:observation with provenance.workflow:refresh-metastore and provenance.runId:run_01M2FGNVVQ15ZKXZWGW74YWAAQ -->

## Control summary
Latest control record per id in `company-profile/example-co/soc/main.jsonl`: 542 records, 478 applicable (64
`not-applicable`, superseded by the `rbi-it-outsourcing-md-2023` migration). `execute-scr`
(`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ, `provenance.sessionId` d39b9417-293b-4271-b6af-ce77f681e83f)
appended 2 new applicable control records this run (`sebi-cscrf-2024:PR.DS.S5`, `sebi-cscrf-2024:PR.DS.S6`,
both `implementationStatus: unknown` / `effectiveness: not-tested`) and re-assessed controls from its 67
observations (11 `satisfied`, 14 `partial`, 24 `not-satisfied`, 9 `not-applicable`, 9 `inconclusive`) across
secure-code-review, SDLC and developer-environment probing.

| Instrument | Controls | Not applicable | Effective | Partially effective | Ineffective | Not tested | Coverage |
|---|---|---|---|---|---|---|---|
| `sebi-cscrf-2024` (SEBI CSCRF 2024) | 126 | 0 | 2 | 6 | 11 | 107 | 15 % (19 of 126) |
| `rbi-cyber-tech-directions-2026` (RBI Cyber Tech Directions 2026) | 99 | 0 | 0 | 1 | 1 | 97 | 2 % (2 of 99) |
| `rbi-outsourcing-risk-directions-2025` (RBI Outsourcing Directions 2025) | 176 | 0 | 0 | 0 | 1 | 175 | 1 % (1 of 176) |
| `dpdp-rules-2025` (DPDP Rules 2025) | 48 | 0 | 0 | 3 | 4 | 41 | 15 % (7 of 48) |
| `cert-in-directions-2022` (CERT-In Directions 2022) | 29 | 0 | 0 | 0 | 1 | 28 | 3 % (1 of 29) |
| `rbi-it-outsourcing-md-2023` (repealed 2025-11-28) | 64 | 64 | 0 | 0 | 0 | 0 | n/a |
| **Total** | **542** | **64** | **2** | **10** | **18** | **448** | **6 % (30 of 478)** |

<!-- source: latest-state map over soc/main.jsonl kind=control, grouped by id prefix before ':'; not-applicable counted separately, the rest by effectiveness -->

Coverage divides the controls whose latest record carries a `lastAssessedAt` set from an observation `result` by
the applicable (not `not-applicable`) controls; `kpis/measurement/cm_coverage.md` defines the KPI.

Maxwell observed 30 of 478 applicable controls in this period (6 %); this run's `execute-scr` pass alone left
9 controls inconclusive for lack of resolvable evidence: `sebi-cscrf-2024:PR.DS.S1` [obs_01M2GR10X602CA21DDAATHYWX7],
`sebi-cscrf-2024:PR.MA.S3` [obs_01M2GR10ZN8XF7CRAWK2C2EK5Q], `sebi-cscrf-2024:PR.AA.S8` and
`cert-in-directions-2022:Dir-iv` [obs_01M2GR110GMYDRZ29NP7A89CCT], `sebi-cscrf-2024:PR.IP.S3`
[obs_01M2GS6B1B49AH50T7Z86EJP8K], [obs_01M2GSDQXXV6VM7WVPBQ9TEAD1], `sebi-cscrf-2024:PR.DS.S6`
[obs_01M2GSDQYQ7FF9DX4FWG8Q5RZ3], [obs_01M2GSDQZJ5G1DPQQ4BV28KXN7], `sebi-cscrf-2024:PR.IP.S1`
[obs_01M2GSDR5E3MP4KSF9VPRXXNPW] and `sebi-cscrf-2024:PR.IP.S2` [obs_01M2GSSNSZHC0K97GJXRPCDYA7]. No
environments were skipped this run: `execute-scr` probes repos, policy and config in the workspace, not live
environments.

**runtime-probe-appcontainers, dry run (2026-09-14T21:01:13Z, `provenance.runId`
run_01M2FGNVVQ15ZKXZWGW74YWAAQ).** This run recorded 4 new observations, all `result: inconclusive`; none of
them assessed any control's effectiveness or moved `implementationStatus`, and the effectiveness/coverage
table above is unchanged by this run. The 4 environments in scope were each blocked or dry-run rather than
executed, so no container-hardening evidence (CNT-01..CNT-11) exists for any of them yet:

| Environment | Outcome | Blocker | Observation |
|---|---|---|---|
| `db-models/dev` | blocked | `probeAccess.method` is `none`: evidence must be requested from humans | [obs_01M2GVQ333MP1VY4QEND1B9GF8] |
| `mcp-gateway/dev` | dry-run | no target command executed (dry-run mode); additionally CNT-01, CNT-09, CNT-10 cannot be evaluated because `applications/mcp-gateway/images/*.json` has no image record | [obs_01M2GVQE6G63H0ZVN7W8AY1Y8V] |
| `mcp-gateway/qa` | dry-run | no target command executed (dry-run mode); credential locator `qa-kubeconfig-ro` could not be decrypted in this sandbox (age key absent), independent of the dry-run status | [obs_01M2GVQDP375E0FEC0QG9RBYGT] |
| `mcp-gateway/prod` | blocked | PROD_GATING: `args.envIds` did not name `mcp-gateway/prod` explicitly, so no command ran against a production, pii/financial-classified, internet/partner-facing environment | [obs_01M2GVPXVCHE4ZQSMHA3EQBZYE] |

These 4 observations together cite 16 controls as coverage gaps, none of which may be described as assessed
on their strength: `sebi-cscrf-2024:GV.SC.S5`, `sebi-cscrf-2024:PR.DS.S6`, `sebi-cscrf-2024:PR.DS.S1`,
`sebi-cscrf-2024:PR.IP.S1`, `sebi-cscrf-2024:PR.IP.S12`, `sebi-cscrf-2024:PR.MA.S3`, `sebi-cscrf-2024:PR.AA.S1`,
`sebi-cscrf-2024:PR.AA.S3`, `sebi-cscrf-2024:PR.AA.S8`, `sebi-cscrf-2024:PR.AA.S9`,
`sebi-cscrf-2024:DE.CM.S1`, `sebi-cscrf-2024:DE.CM.S2`, `cert-in-directions-2022:Dir-iv`,
`dpdp-rules-2025:6(1)(b)`, `dpdp-rules-2025:6(1)(c)`, `dpdp-rules-2025:6(1)(e)`. All 4 environments remain
`implementationStatus: unknown` / `effectiveness: not-tested` on their control records, unchanged by this run;
0 controls were assessed by runtime-probe-appcontainers this period, and 0 findings or risks were raised from
it (dry-run/blocked results are never converted to findings).

## Open findings
`probe-schemas` ran against `example-co` this run (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ,
`provenance.sessionId` 2853edbc-3a09-4ec1-87ad-1afe187bb68c): 6 new data and API schema finding(s)
([fnd_01M2GMN60SYB8DHVX3XN4J84G5], [fnd_01M2GMN61NFQDTRGPZ5RMSMTWN], [fnd_01M2GMN62KVM9J9R852X3E3ST7],
[fnd_01M2GMN63DEDR29P66QTKND8E7], [fnd_01M2GMWPZ5DKN7DNH3D65T47FZ], [fnd_01M2GMWQ01QA647X5MYFGNS1MG]), 3
re-seen (0 reopened: [fnd_01M2G2AGPX8KWSY1KXGYADK4TK], [fnd_01M2G2AGVRZPBP3VH8FNAYH46V],
[fnd_01M2G2AGX1GZ9THG6HJ1VPP1EP] superseded with refreshed evidence, `status: open` unchanged), 11
observation(s) recorded (5 `not-satisfied`, 6 `partial`) [obs_01M2GMN5XBVMCMJ5V8VX8NR0BP],
[obs_01M2GMN5Y80ZKENZ2Z6TTWZR8K], [obs_01M2GMN5Z4B894SNSBPQRJEPMC], [obs_01M2GMN5ZYPC3SSB8KCNXB8X7T],
[obs_01M2GMWPRJJM5QFJX3G6NBT6JR], [obs_01M2GMWPSGBCYNXA6S2ZR7ZT5R], [obs_01M2GMWPTCBSW5HH427MNF8GB4],
[obs_01M2GMWPVB6XWCYHPQM9DMJ8P7], [obs_01M2GMWPWB887N582RCGZ1MNPP], [obs_01M2GMWPXBDB3P7BKCD617KSR8],
[obs_01M2GMWPY9B54SGT32H9MFQ5KY]. Two new findings target the `db-models` repo
`onfinance-db-model-master`'s data schema — Zerodha and Binance trading-account credentials persisted in
plain text with no encryption ([fnd_01M2GMN61NFQDTRGPZ5RMSMTWN]) and no retention, expiry or purge mechanism
for personal data or trading credentials ([fnd_01M2GMN63DEDR29P66QTKND8E7]) — plus two classification/consent
gaps in the same repo ([fnd_01M2GMN60SYB8DHVX3XN4J84G5], [fnd_01M2GMN62KVM9J9R852X3E3ST7]). Two more target the
`mcp-gateway` repo `mongodb-mcp-server`'s API contract: `switch-connection`'s `connectionString` argument
carries no `isSecret`/classification annotation ([fnd_01M2GMWPZ5DKN7DNH3D65T47FZ]) and `MDB_MCP_DRY_RUN` dumps
the full resolved config, including `isSecret`-marked fields, with no redaction
([fnd_01M2GMWQ01QA647X5MYFGNS1MG]).

`probe-iac` ran against `example-co` this run (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ,
`provenance.sessionId` ba28bc2c-2822-41eb-92a8-b6389d3f1d0d): 1 new IaC misconfiguration finding
([fnd_01M2GJYP56VKDHARQPPFVATT0D]), 0 re-seen (0 reopened), 5 observation(s) recorded (2 `not-satisfied`, 3
`partial`) [obs_01M2GJT53BPGENG0VRARSM1K13], [obs_01M2GJT54AQ19T0RTD2Q1YH0BA],
[obs_01M2GJT5571NMNHVA729XDW07Z], [obs_01M2GJT565V6DXPG6MJKH6MG84], [obs_01M2GJT5722DBPKT7XMV26HS8E]. The
new finding targets the `mcp-gateway` repo `mongodb-mcp-server`'s `deploy/aws/Dockerfile`: the base image
carries no digest and `npm install -g mongodb-mcp-server@latest` installs whatever release is current at
build time, both with no lockfile, against `sdlc/policy.json dependencyPolicy.lockfilesRequired = true`.

`probe-schemas` ran against `example-co` this run (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ,
`provenance.sessionId` 314aa113-98aa-471e-941d-e1aa88798b5a): 7 new data and API schema finding(s)
([fnd_01M2G2AGNMHKF9PCB4C85A3JQ3], [fnd_01M2G2AGPX8KWSY1KXGYADK4TK], [fnd_01M2G2AGR581507FMK0EADFKY6],
[fnd_01M2G2AGSC977KASP37WQXYSQA], [fnd_01M2G2AGTH64FMR4XR77ZAJH7B], [fnd_01M2G2AGVRZPBP3VH8FNAYH46V],
[fnd_01M2G2AGX1GZ9THG6HJ1VPP1EP]), 0 re-seen (0 reopened), 13 observation(s) recorded (9 `not-satisfied`, 4
`partial` against the schemas and tool contracts probed) [obs_01M2G24FKAKAVS5JTG628HDYT2],
[obs_01M2G24FM6869QF05J12Z8TVGB], [obs_01M2G24FN1C2V6TGNBNKX670H0], [obs_01M2G24FNWEXHPV4BHQXK1FFQ0],
[obs_01M2G24FPP5W96NFAQ6JF098SJ], [obs_01M2G2AGBTAPAK55XVEY24ANB4], [obs_01M2G2AGD08YM217WSQQWNP85A],
[obs_01M2G2AGE8XFQ4B12MRJBDWYCA], [obs_01M2G2AGFHXSCH94CR7SMFERAW], [obs_01M2G2AGGSXWPRR33K23JB6E90],
[obs_01M2G2AGHZT55J4AESPB6B0FPH], [obs_01M2G2AGK6ZVDTF4D9A0FNYF6V], [obs_01M2G2AGMDK4QXKHJRCYDQKTZT]. All
7 new findings target the `mcp-gateway` repo `mongodb-mcp-server`: unmasked personal/financial data returned
or exported by MCP tools, a plaintext-password response, missing default authentication on the HTTP
transport, unbounded/unvalidated tool arguments reaching the MongoDB driver, and MCP tool schemas carrying no
personal-data classification markers.

`probe-cicd-env` ran against `example-co` this run (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ,
`provenance.sessionId` 1a5b055e-58b2-4969-9611-d47c345c064a): 9 new CI/CD and supply-chain finding(s)
([fnd_01M2GH5AS0MM2F8MSFTDP36VV9], [fnd_01M2GH5AT8SW3Z6ZTZ73YN7QY6], [fnd_01M2GH5AVF2ZCBDXD5F25S2VGS],
[fnd_01M2GH5AWP81VXEQVWFXFRP3D9], [fnd_01M2GH5AXYX8NH35F6135G6VB4], [fnd_01M2GH5AZ5M0KCRXNTEY3DPH69],
[fnd_01M2GH5B0C1BP3QP8HHA0MJNVY], [fnd_01M2GH5B1JFJYTA2MGWES48JP5], [fnd_01M2GH5B2SNX0PD3EKVNVTPAG7]), 0
re-seen (0 reopened), 8 observation(s) recorded. All 9 new findings target the `mcp-gateway` repo
`mongodb-mcp-server`'s CI/CD pipeline and supply chain: an unpinned `node:24-alpine` base image on both
Dockerfiles, an unverified `curl | tar` binary install alongside an ignored `VERSION` build arg, no
dependency/SCA scan and no container-image scan gating publish, no IaC lint for the checked-in Azure Bicep
templates, a secrets-scanning gate (`git-secrets --register-aws`) narrower than the `gitleaks` tool the
policy declares, published images that are never signed/attested with cosign, a CI-generated SBOM that is
never captured into the workspace image inventory, and a static Docker Hub credential where the same repo
already uses OIDC federation for another publish target.

`probe-agent-graph` ran against `example-co` this run (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ,
`provenance.sessionId` 25584b4f-cb91-4da7-9198-1c6516a03390): 3 new agent-graph finding(s) against the OWASP
Agentic AI Top 10 2026 (`owasp-agentic-top10-2026`) ([fnd_01M2GPBK5MBCAFFV7KNH83JV1F],
[fnd_01M2GPBK5MSHBXGGFSRYHPXQY2], [fnd_01M2GPBK5MB962TKED1TFBTF3A]), 0 re-seen (0 reopened), 5 observation(s)
recorded [obs_01M2GPBK5JXJTXXTT6R2YA05PN], [obs_01M2GPBK5M3198JC7AD8BMB21H]. All 3 new findings target the
`mcp-gateway` repo `mongodb-mcp-server`: the elicitation-based confirmation for destructive MongoDB/Atlas
tools auto-approves when the client omits elicitation support
([fnd_01M2GPBK5MBCAFFV7KNH83JV1F], SEBI sebi-cscrf-2024 PR.AA.S3), write/delete MongoDB and Atlas tool
categories are enabled by default with no allow-list ([fnd_01M2GPBK5MSHBXGGFSRYHPXQY2], SEBI sebi-cscrf-2024
PR.AA.S3), and the streamable HTTP transport has no authentication by default
([fnd_01M2GPBK5MB962TKED1TFBTF3A], SEBI sebi-cscrf-2024 PR.AA.S17).

`execute-scr` ran against `example-co` this run (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ,
`provenance.sessionId` d39b9417-293b-4271-b6af-ce77f681e83f): 1 new secure-code-review finding
([fnd_01M2GMN61NFQDTRGPZ5RMSMTWN]; same fingerprint `5ecce787...` as the prior `probe-schemas` finding of that
id, so the ledger superseded it rather than opening a duplicate — no id change, title and description refreshed
with the secrets-management angle), 6 new SDLC-gap finding(s) ([fnd_01M2GS6B7DFR9B286Y0506V1VJ],
[fnd_01M2GS6B87TV7NHZQ8BMGDR4HZ], [fnd_01M2GSDSCS1E1NHBB2A9JSA11J], [fnd_01M2GSDSE000HR9FYWXXSM4ZM3],
[fnd_01M2GSSNXD1T94MJ6Q346HV4S6], [fnd_01M2GSSNY7B64D39NPE9K8Z80F]), 1 new developer-environment finding
([fnd_01M2GTZHA1AH7R8PAPGHNCWMJJ]), 1 finding re-seen (0 reopened: [fnd_01M2GMN61NFQDTRGPZ5RMSMTWN] superseded
with refreshed evidence, `status: open` unchanged), 67 observation(s) recorded (11 `satisfied`, 14 `partial`,
24 `not-satisfied`, 9 `not-applicable`, 9 `inconclusive`). The SDLC findings cover company-wide gaps — no
CODEOWNERS enforcement for security-sensitive paths ([fnd_01M2GS6B7DFR9B286Y0506V1VJ]) and no evidenced
completed audit or closure loop against `sebi-cscrf-2024:Sec-4.4` ([fnd_01M2GS6B87TV7NHZQ8BMGDR4HZ]) — plus
repo-level gaps: `mongodb-mcp-server`'s PR template has no security/data-impact checklist
([fnd_01M2GSDSCS1E1NHBB2A9JSA11J]) and its vitest coverage job has no minimum threshold
([fnd_01M2GSDSE000HR9FYWXXSM4ZM3]), and `onfinance-db-model-master` has no CI system to run its declared
blocking unit-tests gate at all ([fnd_01M2GSSNXD1T94MJ6Q346HV4S6]) and no committed Python lockfile despite
policy requiring one ([fnd_01M2GSSNY7B64D39NPE9K8Z80F]). The developer-environment finding is that
`db-models`' `dev` environment declares `secretsBackend: other` instead of the policy-mandated
`aws-secrets-manager` ([fnd_01M2GTZHA1AH7R8PAPGHNCWMJJ]).

`runtime-probe-appcontainers` ran against `example-co` this run (`provenance.runId`
run_01M2FGNVVQ15ZKXZWGW74YWAAQ, `provenance.sessionId` 1313863d-dc83-4635-9a3c-65042c349fd1, dry run): 0 new
findings, 0 re-seen. Environments `db-models/dev` and `mcp-gateway/prod` were blocked, `mcp-gateway/dev` and
`mcp-gateway/qa` were dry-run only ([obs_01M2GVQ333MP1VY4QEND1B9GF8], [obs_01M2GVQE6G63H0ZVN7W8AY1Y8V],
[obs_01M2GVQDP375E0FEC0QG9RBYGT], [obs_01M2GVPXVCHE4ZQSMHA3EQBZYE], see Control summary); an inconclusive
dry-run or blocked observation is never converted into a finding, so the open-findings table below is
unchanged by this run.

Latest record per finding id in `company-profile/example-co/soc/main.jsonl` with `status` in
`open | triaged | remediating`, as of `provenance.generatedAt` 2026-09-14T21:01:13Z (39 open: 23 high, 16
medium, 0 past SLA):

### High

| Id | Title | Target | Regulatory ref | First seen | SLA due | SLA status | Status | Initiative |
|---|---|---|---|---|---|---|---|---|
| [fnd_01M2FS4806WHXANC3Q9QXEAXGF] | assurance-expiring: github-cloud SOC 2 Type II report expires 2026-09-30, inside 90-day window | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S4 (SEBI CSCRF 2024) | 2026-09-14 | 2026-10-14T10:46:39Z | due in 30 d | open | n/a |
| [fnd_01M2FS9ECP3E0MTCRQFEJ97930] | contract-expiring: ATLAS-2025-1189 ended 2026-05-31, 106 days ago, no renewal evidence | vendor `mongodb-atlas` | SEBI sebi-cscrf-2024 GV.SC.S4 | 2026-09-14 | 2026-10-14T10:46:39Z | due in 30 d | open | n/a |
| [fnd_01M2G2AGPX8KWSY1KXGYADK4TK] | find/export tools return full unmasked documents from pii/financial-classified collections | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGR581507FMK0EADFKY6] | aggregate tool returns full unmasked pipeline results | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGSC977KASP37WQXYSQA] | export tool writes full unmasked documents to an unencrypted local file | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGTH64FMR4XR77ZAJH7B] | CreateDBUserTool returns a newly generated password in plain text | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S1 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGVRZPBP3VH8FNAYH46V] | mcp-gateway's HTTP transport (/mcp) has no default authentication | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S17 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2GH5AS0MM2F8MSFTDP36VV9] | Both Dockerfiles pin `node:24-alpine` with no content digest | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S1 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GH5AT8SW3Z6ZTZ73YN7QY6] | Unverified binary download in mcp-publish.yml, and deploy/aws/Dockerfile silently ignores its own version pin | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S4 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GH5AVF2ZCBDXD5F25S2VGS] | No dependency/SCA vulnerability scan in any of the 20 CI workflows | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S12 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GH5AWP81VXEQVWFXFRP3D9] | No container image vulnerability scan before the image is pushed to Docker Hub | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S12 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GH5AZ5M0KCRXNTEY3DPH69] | Policy's blocking secrets gate (gitleaks) is actually a narrower AWS-only scanner (git-secrets) | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S4 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GH5B1JFJYTA2MGWES48JP5] | SBOM generated by CI is never captured into the workspace image inventory for mcp-gateway | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 GV.SC.S5 | 2026-09-14 | 2026-10-14T13:48:42Z | due in 30 d | open | n/a |
| [fnd_01M2GH5B2SNX0PD3EKVNVTPAG7] | Docker Hub publish uses a static shared credential instead of the OIDC federation already used elsewhere in the repo | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S1 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GJYP56VKDHARQPPFVATT0D] | AWS Bedrock AgentCore Dockerfile has no pinned base image or package version | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S3 | 2026-09-14 | 2026-09-21T18:08:50Z | due in 7 d | open | n/a |
| [fnd_01M2GMN61NFQDTRGPZ5RMSMTWN] | db-models: Zerodha password, 2FA secret, API secrets and access tokens stored as plain MongoDB fields | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 PR.DS.S1 | 2026-09-14 | 2026-10-14T18:36:43Z | due in 30 d | open | n/a |
| [fnd_01M2GMWPZ5DKN7DNH3D65T47FZ] | switch-connection tool's connectionString argument carries no isSecret/classification annotation | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S1 | 2026-09-14 | 2026-09-21T18:36:43Z | due in 7 d | open | n/a |
| [fnd_01M2GMWQ01QA647X5MYFGNS1MG] | MDB_MCP_DRY_RUN dumps the full resolved config, including isSecret-marked fields, with no redaction | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S1 | 2026-09-14 | 2026-09-21T18:36:43Z | due in 7 d | open | n/a |
| [fnd_01M2GPBK5MBCAFFV7KNH83JV1F] | Elicitation-based approval for destructive MongoDB/Atlas tools auto-approves when the client omits elicitation support | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S3 (OWASP Agentic AI Top 10 2026 ASI09) | 2026-09-14 | 2026-09-21T19:14:04Z | due in 7 d | open | n/a |
| [fnd_01M2GPBK5MSHBXGGFSRYHPXQY2] | Write/delete MongoDB and Atlas tool categories are enabled by default with no allow-list | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S3 | 2026-09-14 | 2026-09-21T19:14:04Z | due in 7 d | open | n/a |
| [fnd_01M2GPBK5MB962TKED1TFBTF3A] | Streamable HTTP transport has no authentication by default | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S17 | 2026-09-14 | 2026-09-21T19:14:04Z | due in 7 d | open | n/a |
| [fnd_01M2GS6B87TV7NHZQ8BMGDR4HZ] | Declared audit cadence has no evidence of a completed audit or tracked closure of findings | company | SEBI sebi-cscrf-2024 Sec-4.4 | 2026-09-14 | 2026-12-13T19:35:56Z | due in 90 d | open | n/a |
| [fnd_01M2GTZHA1AH7R8PAPGHNCWMJJ] | db-models dev environment secretsBackend ("other") does not match the policy-mandated vault | environment `db-models/dev` | SEBI sebi-cscrf-2024 PR.AA.S1 | 2026-09-14 | 2026-09-21T19:35:56Z | due in 7 d | open | n/a |

### Medium

| Id | Title | Target | Regulatory ref | First seen | SLA due | SLA status | Status | Initiative |
|---|---|---|---|---|---|---|---|---|
| [fnd_01M2FRY4TTS6M3JJD1F1P7J0TQ] | material-without-evidence: aws-mumbai (order-routing, pii/financial) has no documented exit plan | vendor `aws` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2FS481DGTPTR9NJGKAAMF49] | contract-expiring: GH-ENT-2025-07 ended 2026-06-30, 76 days before now, no renewal evidence | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2FS482NWXE7E5MCZY2QMAZ0] | material-without-evidence: github lacks audit rights and a documented exit plan | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2FS9EBVSP2DPWN5K2D91QKW] | material-without-evidence: atlas-mumbai has no audit rights, no exit plan, contract lapsed | vendor `mongodb-atlas` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2G2AGNMHKF9PCB4C85A3JQ3] | MongoDB MCP tool schemas carry no personal-data classification markers | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 ID.AM.S5 | 2026-09-14 | 2026-09-28T13:14:50Z | due in 14 d | open | n/a |
| [fnd_01M2G2AGX1GZ9THG6HJ1VPP1EP] | Open EJSON filter/pipeline/document arguments and unbounded database/collection names reach the MongoDB driver directly | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S2 | 2026-09-14 | 2026-09-28T13:14:50Z | due in 14 d | open | n/a |
| [fnd_01M2GH5AXYX8NH35F6135G6VB4] | No IaC lint/scan for the checked-in Azure Bicep templates | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S6 | 2026-09-14 | 2026-09-28T13:48:42Z | due in 14 d | open | n/a |
| [fnd_01M2GH5B0C1BP3QP8HHA0MJNVY] | Published image is never signed or attested with cosign | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S2 | 2026-09-14 | 2026-09-28T13:48:42Z | due in 14 d | open | n/a |
| [fnd_01M2GMN60SYB8DHVX3XN4J84G5] | Metastore-catalogued PII/SPDI columns carry no classification annotation in models.py | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 ID.AM.S5 | 2026-09-14 | 2026-09-28T18:36:43Z | due in 14 d | open | n/a |
| [fnd_01M2GMN62KVM9J9R852X3E3ST7] | User document has no consent/purpose/notice reference | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 GV.OC.S2 | 2026-09-14 | 2026-09-28T18:36:43Z | due in 14 d | open | n/a |
| [fnd_01M2GMN63DEDR29P66QTKND8E7] | No retention, expiry or purge mechanism for personal data or trading credentials | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 PR.AA.S13 | 2026-09-14 | 2026-12-13T18:36:43Z | due in 90 d | open | n/a |
| [fnd_01M2GS6B7DFR9B286Y0506V1VJ] | No named owner or code-review role for security-sensitive paths; CODEOWNERS not enforced company-wide | company | SEBI sebi-cscrf-2024 GV.PO.S5 | 2026-09-14 | 2026-12-13T19:35:56Z | due in 90 d | open | n/a |
| [fnd_01M2GSDSCS1E1NHBB2A9JSA11J] | PR template for mongodb-mcp-server has no security/data-impact checklist despite pii and financial data downstream | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S2 | 2026-09-14 | 2026-12-13T19:35:56Z | due in 90 d | open | n/a |
| [fnd_01M2GSDSE000HR9FYWXXSM4ZM3] | vitest coverage runs in CI but no minimum coverage threshold is configured anywhere | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S6 | 2026-09-14 | 2026-12-13T19:35:56Z | due in 90 d | open | n/a |
| [fnd_01M2GSSNXD1T94MJ6Q346HV4S6] | Claimed blocking unit-tests gate cannot run on db-models repo because it has no CI system | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 PR.IP.S6 | 2026-09-14 | 2026-09-28T19:35:56Z | due in 14 d | open | n/a |
| [fnd_01M2GSSNY7B64D39NPE9K8Z80F] | No lockfile committed for db-models' only Python package manifest despite policy requiring one | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 PR.IP.S2 | 2026-09-14 | 2026-09-28T19:35:56Z | due in 14 d | open | n/a |

<!-- source: latest-state map over soc/main.jsonl kind=finding, filtered to status in open|triaged|remediating; SLA status = ceil((slaDueAt - 2026-09-14T21:01:13Z)/86400000) days -->

No findings in `risk-accepted`, `false-positive` or `duplicate` this period.

## Initiatives
`change_management/master.json counters` as of `updatedAt` 2026-09-14T21:12:30Z: 22 open / 0 closed / 0
cancelled / 0 overdue (overdue = `dueAt` earlier than 2026-09-14T21:12:30Z). All 22 were created this run by
`impl-change-management` (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ) from findings raised by
`probe-schemas`, `probe-iac`, `probe-cicd-env`, `probe-agent-graph`, `execute-scr` and `refresh-vendor-ctx`;
none is overdue as of this generation, so no row carries `**overdue <n> d**`.

| Id | Title | Status | Priority | Change type | Owner | Due | Tasks (done/total, blocked) | Findings | Regulatory ref |
|---|---|---|---|---|---|---|---|---|---|
| [init_01M2GWJHMWQE4QZ9YVBP20S1BX] | Renew lapsed material-vendor contracts and document exit plans and audit rights for AWS, GitHub and MongoDB Atlas | proposed | p2 | normal | compliance@example-co.invalid | 2026-10-14T21:12:30Z | 0/6, 0 blocked | 5 [fnd_01M2FRY4TTS6M3JJD1F1P7J0TQ][fnd_01M2FS481DGTPTR9NJGKAAMF49][fnd_01M2FS482NWXE7E5MCZY2QMAZ0][fnd_01M2FS9EBVSP2DPWN5K2D91QKW][fnd_01M2FS9ECP3E0MTCRQFEJ97930] | SEBI sebi-cscrf-2024 (SEBI CSCRF 2024) GV.SC.S3 |
| [init_01M2GWJF4XYSA816536HWERV4H] | Obtain and review GitHub Enterprise Cloud's renewed SOC 2 Type II report before the current one expires | proposed | p2 | normal | compliance@example-co.invalid | 2026-10-14T10:46:39Z | 0/4, 0 blocked | 1 [fnd_01M2FS4806WHXANC3Q9QXEAXGF] | SEBI sebi-cscrf-2024 GV.SC.S4 |
| [init_01M2GWJZSS8ZFTGSE4F4DRQN4F] | Annotate PII/SPDI fields with classification metadata in mongodb-mcp-server tool schemas and db-models models.py | proposed | p3 | normal | dpo@example-co.invalid | 2026-09-28T21:12:30Z | 0/4, 0 blocked | 2 [fnd_01M2G2AGNMHKF9PCB4C85A3JQ3][fnd_01M2GMN60SYB8DHVX3XN4J84G5] | SEBI sebi-cscrf-2024 ID.AM.S5 |
| [init_01M2GWJSJ3JACXRBXFT116SPFH] | Mask pii/financial fields in mongodb-mcp-server find, aggregate and export tool output | proposed | p2 | normal | dpo@example-co.invalid | 2026-10-14T21:12:30Z | 0/5, 0 blocked | 3 [fnd_01M2G2AGPX8KWSY1KXGYADK4TK][fnd_01M2G2AGR581507FMK0EADFKY6][fnd_01M2G2AGSC977KASP37WQXYSQA] | SEBI sebi-cscrf-2024 PR.DS.S4 |
| [init_01M2GWKQNTJ7082K1R20CDEN2P] | Remove plaintext credentials from MCP tool output, dry-run config dumps and the db-models Secrets document | proposed | p2 | normal | cto@example-co.invalid | 2026-09-21T21:12:30Z | 0/6, 0 blocked | 3 [fnd_01M2G2AGTH64FMR4XR77ZAJH7B][fnd_01M2GMN61NFQDTRGPZ5RMSMTWN][fnd_01M2GMWQ01QA647X5MYFGNS1MG] | SEBI sebi-cscrf-2024 PR.AA.S1 |
| [init_01M2GWK0AZG2HFKPP7Z4F79S9D] | Mark the switch-connection connectionString argument as secret in mongodb-mcp-server | proposed | p2 | normal | ciso@example-co.invalid | 2026-09-21T21:12:30Z | 0/4, 0 blocked | 1 [fnd_01M2GMWPZ5DKN7DNH3D65T47FZ] | SEBI sebi-cscrf-2024 PR.AA.S1 |
| [init_01M2GWK3BJ7Y4PPP919G8NZFRS] | Replace long-lived shared credentials with OIDC-federated and vault-managed secrets for mongodb-mcp-server publishing and the db-models dev tier | proposed | p2 | normal | cto@example-co.invalid | 2026-09-21T13:48:42Z | 0/4, 0 blocked | 2 [fnd_01M2GH5B2SNX0PD3EKVNVTPAG7][fnd_01M2GTZHA1AH7R8PAPGHNCWMJJ] | SEBI sebi-cscrf-2024 PR.AA.S1 |
| [init_01M2GWJNGS4TF5ASSHWGN2004Z] | Enforce mandatory authentication on mcp-gateway's HTTP and streamable MCP transports | proposed | p2 | normal | ciso@example-co.invalid | 2026-09-21T21:12:30Z | 0/5, 0 blocked | 2 [fnd_01M2G2AGVRZPBP3VH8FNAYH46V][fnd_01M2GPBK5MB962TKED1TFBTF3A] | SEBI sebi-cscrf-2024 PR.AA.S17 |
| [init_01M2GWJNM9B7WH4DA9BEK6AQHQ] | Bound the shared EJSON validator and namespace arguments of mongodb-mcp-server's MongoDB tools | proposed | p3 | normal | cto@example-co.invalid | 2026-09-28T21:12:30Z | 0/4, 0 blocked | 1 [fnd_01M2G2AGX1GZ9THG6HJ1VPP1EP] | SEBI sebi-cscrf-2024 PR.IP.S2 |
| [init_01M2GWJMMMHGYZP7M7H6PQJ0FT] | Sign and attest the published mcp-gateway image with cosign keyless signing | proposed | p3 | normal | ciso@example-co.invalid | 2026-09-28T21:12:30Z | 0/4, 0 blocked | 1 [fnd_01M2GH5B0C1BP3QP8HHA0MJNVY] | SEBI sebi-cscrf-2024 PR.IP.S2 |
| [init_01M2GWKJWQ5AJJZGZMWK8TKMRA] | Add a security review checklist to mongodb-mcp-server PRs and lock db-models dependencies | proposed | p3 | normal | ciso@example-co.invalid | 2026-09-28T21:12:30Z | 0/4, 0 blocked | 2 [fnd_01M2GSDSCS1E1NHBB2A9JSA11J][fnd_01M2GSSNY7B64D39NPE9K8Z80F] | SEBI sebi-cscrf-2024 PR.IP.S2 |
| [init_01M2GWK1FRDCWGPJVC10RJS43X] | Pin the node:24-alpine base image to a content digest in both mongodb-mcp-server Dockerfiles | proposed | p2 | normal | cto@example-co.invalid | 2026-09-21T21:12:30Z | 0/4, 0 blocked | 1 [fnd_01M2GH5AS0MM2F8MSFTDP36VV9] | SEBI sebi-cscrf-2024 PR.IP.S1 |
| [init_01M2GWJAYY9ZQ8Y0GQJ7XNYQ28] | Verify CI supply-chain downloads and replace the git-secrets job with the policy's blocking gitleaks gate in mongodb-mcp-server | proposed | p2 | normal | cto@example-co.invalid | 2026-09-21T21:12:30Z | 0/5, 0 blocked | 2 [fnd_01M2GH5AT8SW3Z6ZTZ73YN7QY6][fnd_01M2GH5AZ5M0KCRXNTEY3DPH69] | SEBI sebi-cscrf-2024 PR.IP.S4 |
| [init_01M2GWJK9ABSB5MBW1DHB4HNR3] | Add a blocking IaC scan gate for the Azure Bicep templates in mongodb-mcp-server CI | proposed | p3 | normal | ciso@example-co.invalid | 2026-09-28T21:12:30Z | 0/3, 0 blocked | 1 [fnd_01M2GH5AXYX8NH35F6135G6VB4] | SEBI sebi-cscrf-2024 PR.IP.S6 |
| [init_01M2GWJR746MQDJ90VXARW6DD1] | Enforce the unit-test gate with coverage thresholds on mongodb-mcp-server and a blocking CI test pipeline on db-models | proposed | p3 | normal | ciso@example-co.invalid | 2026-12-13T21:12:30Z | 0/5, 0 blocked | 2 [fnd_01M2GSDSE000HR9FYWXXSM4ZM3][fnd_01M2GSSNXD1T94MJ6Q346HV4S6] | SEBI sebi-cscrf-2024 PR.IP.S6 |
| [init_01M2GWPKP2RSJXDMRMC9F47V32] | Capture the CI-generated mcp-gateway image SBOM into the workspace image inventory | proposed | p2 | normal | ciso@example-co.invalid | 2026-10-14T21:12:30Z | 0/3, 0 blocked | 1 [fnd_01M2GH5B1JFJYTA2MGWES48JP5] | SEBI sebi-cscrf-2024 GV.SC.S5 |
| [init_01M2GWQ198WX455NVQVAQ62EST] | Pin the base image digest and mongodb-mcp-server version in the AgentCore Dockerfile | proposed | p2 | normal | cto@example-co.invalid | 2026-09-21T21:12:30Z | 0/4, 0 blocked | 1 [fnd_01M2GJYP56VKDHARQPPFVATT0D] | SEBI sebi-cscrf-2024 PR.IP.S3 |
| [init_01M2GWR6B9C4Y7Z2XEVDXA1WEH] | Add consent, purpose and notice references to the db-models User document | proposed | p3 | normal | dpo@example-co.invalid | 2026-09-28T21:12:30Z | 0/3, 0 blocked | 1 [fnd_01M2GMN62KVM9J9R852X3E3ST7] | SEBI sebi-cscrf-2024 GV.OC.S2 |
| [init_01M2GWPZP4P4134Q0ZVY3SEMP0] | Add retention, expiry and purge controls to the User and Secrets models | proposed | p3 | normal | dpo@example-co.invalid | 2026-12-13T21:12:30Z | 0/5, 0 blocked | 1 [fnd_01M2GMN63DEDR29P66QTKND8E7] | SEBI sebi-cscrf-2024 PR.AA.S13 |
| [init_01M2GWQXXT1Y73CPR2NKENXEBH] | Fail closed on missing elicitation and default-deny write/delete tools in mongodb-mcp-server | proposed | p2 | normal | ciso@example-co.invalid | 2026-09-21T21:12:30Z | 0/4, 0 blocked | 2 [fnd_01M2GPBK5MBCAFFV7KNH83JV1F][fnd_01M2GPBK5MSHBXGGFSRYHPXQY2] | SEBI sebi-cscrf-2024 PR.AA.S3 |
| [init_01M2GWQEVKZM0584YS6JR7F6JA] | Define named code owners for security-sensitive paths and enforce code-owner review | proposed | p3 | normal | ciso@example-co.invalid | 2026-12-13T21:12:30Z | 0/5, 0 blocked | 1 [fnd_01M2GS6B7DFR9B286Y0506V1VJ] | SEBI sebi-cscrf-2024 GV.PO.S5 |
| [init_01M2GWQJEHZ635MEEPXE7ATHXG] | Evidence the cyber audit cycle and track audit observations to closure within 3 months | proposed | p2 | normal | ciso@example-co.invalid | 2026-12-13T21:12:30Z | 0/6, 0 blocked | 1 [fnd_01M2GS6B87TV7NHZQ8BMGDR4HZ] | SEBI sebi-cscrf-2024 Sec-4.4 |

<!-- source: change_management/master.json initiatives[]; Findings column counts findingIds[]; Regulatory ref is regulatoryRefs[0] -->

### Blocked
No blocked tasks: every task file under `change_management/initiatives/*/tasks/*.json` has `status: todo`
(`taskCounts.blocked` is 0 on all 22 initiatives).

### Evidence requests
Tasks whose `verificationMethod.type` is `re-probe` and `status` is not `done` (these close the inconclusive
observations from `report-audit-findings`), grouped by initiative:

| Initiative | Task | Title | Re-probe workflow |
|---|---|---|---|
| [init_01M2GWJHMWQE4QZ9YVBP20S1BX] | — | none of this initiative's tasks are `re-probe` | — |
| [init_01M2GWJF4XYSA816536HWERV4H] | — | none of this initiative's tasks are `re-probe` | — |
| [init_01M2GWJZSS8ZFTGSE4F4DRQN4F] | task_2 | Add data_classification metadata to every PII/SPDI field in onfinance_db_model_master/models.py | probe-schemas |
| [init_01M2GWJZSS8ZFTGSE4F4DRQN4F] | task_3 | Add x-data-classification metadata to the mongodb-mcp-server tool argument schemas | probe-schemas |
| [init_01M2GWJSJ3JACXRBXFT116SPFH] | task_2 | Add a shared masking layer and apply it to FindTool and AggregateTool results | probe-schemas |
| [init_01M2GWJSJ3JACXRBXFT116SPFH] | task_3 | Mask and restrict ExportTool output files | probe-schemas |
| [init_01M2GWKQNTJ7082K1R20CDEN2P] | task_1 | Remove the generated password from the CreateDBUserTool result | probe-schemas |
| [init_01M2GWKQNTJ7082K1R20CDEN2P] | task_2 | Redact isSecret configuration fields in the dry-run config dump | probe-schemas |
| [init_01M2GWKQNTJ7082K1R20CDEN2P] | task_3 | Replace plaintext credential fields in the db-models Secrets document with Secrets Manager locators | probe-schemas |
| [init_01M2GWK0AZG2HFKPP7Z4F79S9D] | task_4 | Release the fix through qa and prod and re-run probe-schemas | probe-schemas |
| [init_01M2GWK3BJ7Y4PPP919G8NZFRS] | task_2 | Switch docker-publish.yml to an OIDC-federated login and remove the static Docker Hub secrets from its callers | probe-cicd-env |
| [init_01M2GWK3BJ7Y4PPP919G8NZFRS] | task_4 | Move db-models dev-tier credentials into AWS Secrets Manager and set dev.json secretsBackend to aws-secrets-manager | probe-dev-env |
| [init_01M2GWJNGS4TF5ASSHWGN2004Z] | task_1 | Make authentication mandatory in mcpHttpServer.ts setupMiddlewares | probe-schemas |
| [init_01M2GWJNGS4TF5ASSHWGN2004Z] | task_2 | Refuse to start the streamable HTTP transport without authentication on non-loopback hosts | probe-agent-graph |
| [init_01M2GWJNM9B7WH4DA9BEK6AQHQ] | task_4 | Release the limited validators through dev, qa and prod and re-run probe-schemas | probe-schemas |
| [init_01M2GWJMMMHGYZP7M7H6PQJ0FT] | task_1 | Add a keyless cosign sign step to docker-publish.yml | probe-cicd-env |
| [init_01M2GWJMMMHGYZP7M7H6PQJ0FT] | task_2 | Attach a cosign SBOM attestation to the signed image digest | probe-cicd-env |
| [init_01M2GWJMMMHGYZP7M7H6PQJ0FT] | task_4 | Re-probe the release pipeline and attach signing evidence to the finding | probe-cicd-env |
| [init_01M2GWKJWQ5AJJZGZMWK8TKMRA] | task_1 | Add a security and data-impact checklist to the mongodb-mcp-server PR template | probe-sdlc |
| [init_01M2GWKJWQ5AJJZGZMWK8TKMRA] | task_2 | Generate and commit a hash-pinned lockfile for onfinance-db-model-master | probe-sdlc |
| [init_01M2GWK1FRDCWGPJVC10RJS43X] | task_1 | Pin the root Dockerfile base image to the node:24-alpine index digest | probe-cicd-env |
| [init_01M2GWK1FRDCWGPJVC10RJS43X] | task_2 | Pin the AWS AgentCore Dockerfile base image to the same node:24-alpine digest | probe-cicd-env |
| [init_01M2GWJAYY9ZQ8Y0GQJ7XNYQ28] | task_1 | Pin and checksum-verify the mcp-publisher binary in mcp-publish.yml | probe-cicd-env |
| [init_01M2GWJAYY9ZQ8Y0GQJ7XNYQ28] | task_2 | Make deploy/aws/Dockerfile install the version named by its VERSION build argument | probe-cicd-env |
| [init_01M2GWJAYY9ZQ8Y0GQJ7XNYQ28] | task_3 | Replace the git-secrets job in code-health.yml with a pinned gitleaks 8.30.1 scan | probe-cicd-env |
| [init_01M2GWJK9ABSB5MBW1DHB4HNR3] | task_2 | Add a blocking check-iac job to .github/workflows/check.yml | probe-cicd-env |
| [init_01M2GWJR746MQDJ90VXARW6DD1] | task_1 | Add enforced vitest coverage thresholds to mongodb-mcp-server | probe-sdlc |
| [init_01M2GWJR746MQDJ90VXARW6DD1] | task_4 | Stand up a blocking GitHub Actions test pipeline for onfinance-db-model-master | probe-sdlc |
| [init_01M2GWPKP2RSJXDMRMC9F47V32] | task_3 | Re-probe the mcp-gateway CI pipeline and attach closure evidence | probe-cicd-env |
| [init_01M2GWQ198WX455NVQVAQ62EST] | task_1 | Pin the node:24-alpine base image by digest in deploy/aws/Dockerfile | probe-iac |
| [init_01M2GWQ198WX455NVQVAQ62EST] | task_2 | Build mongodb-mcp-server from the lockfile at a required exact VERSION | probe-iac |
| [init_01M2GWR6B9C4Y7Z2XEVDXA1WEH] | task_2 | Add consent, purpose and notice-version fields to the User document | probe-schemas |
| [init_01M2GWPZP4P4134Q0ZVY3SEMP0] | task_2 | Add an expires_at field and TTL index to the Secrets model | probe-schemas |
| [init_01M2GWPZP4P4134Q0ZVY3SEMP0] | task_3 | Add soft-delete and retention_until fields to the User model | probe-schemas |
| [init_01M2GWQXXT1Y73CPR2NKENXEBH] | task_1 | Make Elicitation.requestConfirmation() fail closed when the client lacks elicitation support | probe-agent-graph |
| [init_01M2GWQXXT1Y73CPR2NKENXEBH] | task_2 | Add a default-deny allow-list for create, update and delete tools | probe-agent-graph |
| [init_01M2GWQXXT1Y73CPR2NKENXEBH] | task_3 | Record the approved write-tool allow-list and set it in the AWS deployment config | probe-agent-graph |
| [init_01M2GWQEVKZM0584YS6JR7F6JA] | task_2 | Replace the catch-all CODEOWNERS in mongodb-mcp-server with path-specific ExampleCo owners | probe-sdlc |
| [init_01M2GWQEVKZM0584YS6JR7F6JA] | task_3 | Add a CODEOWNERS file to onfinance-db-model-master | probe-sdlc |
| [init_01M2GWQEVKZM0584YS6JR7F6JA] | task_4 | Enforce code-owner review in branch protection and set codeownersEnforced in the SDLC policy | probe-sdlc |
| [init_01M2GWQJEHZ635MEEPXE7ATHXG] | task_6 | Re-assess the audit controls in the ledger and re-run probe-sdlc to confirm the gap is closed | probe-sdlc |

## Suggestions
`impl-auto-improvement` refreshed this section as of `provenance.generatedAt` 2026-09-14T22:49:19Z (early
refresh; `report-audit-improvements` remains the owner of record). Source:
`company-profile/example-co/suggestions/master.json` (1 entry). New this run:
[sug_01M2H3EJHK5HE9BQCBFKTGCGBP]; no suggestion merged, reverted or retention-checked this run.

| Id | Title | Category | Severity | Status | Repo | +/- lines | Surfaced | Decided by | PR |
|---|---|---|---|---|---|---|---|---|---|
| [sug_01M2H3EJHK5HE9BQCBFKTGCGBP] | Add a blocking check-iac job that scans the Azure Bicep templates with checkov | cicd-gate | medium | proposed | `mcp-gateway/mongodb-mcp-server` | +25/-0 | not yet surfaced | n/a | none |

<!-- source: suggestions/master.json suggestions[]; finding fnd_01M2GH5AXYX8NH35F6135G6VB4 ("No IaC lint/scan for the checked-in Azure Bicep templates", medium, open-findings section) -->

### Acceptance (this period)
Computed per `kpis/measurement/suggestion_acceptance_rate.md` v1.0.0 over the 1 suggestion in
`suggestions/master.json`: 1 `proposed`, 0 `surfaced`, 0 `accepted`, 0 `rejected`, 0 `merged`, 0 `reverted`,
0 `expired`, 0 `superseded`.

- `acceptance_rate = |accepted∪merged∪reverted| / |accepted∪merged∪reverted∪rejected∪expired| = 0/0`:
  not computed — no suggestion has been decided (surfaced then accepted/rejected/expired) this period.
- `merge_rate = |merged∪reverted| / |accepted∪merged∪reverted| = 0/0`: not computed.
- `revert_rate = |reverted within 30 d of mergedAt| / |merged∪reverted| = 0/0`: not computed.
- `retention_30d = |merged with retentionCheckedAt ≥ mergedAt+30d and retained=true| / |merged checked| = 0/0`:
  not computed — no suggestion has been merged yet, so no retention check is due.

### Rejections
No suggestions rejected this period.
