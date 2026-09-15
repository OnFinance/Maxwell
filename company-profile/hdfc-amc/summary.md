---
schemaVersion: "1"
kind: maxwell.company.summary
companyId: hdfc-amc
title: HDFC Asset Management Company cyber resilience summary
version: "2.1.0"
sections: [overview, regulatory-posture, organization-context]
provenance:
  harness: claude-code
  generatedAt: "2026-09-15T10:27:04Z"
  sessionId: 3b21ec7f-e9e0-43fb-95bb-180391c88e48
  runId: run_01M2J9P78VT9RZ3CYFN8HJFF0C
  workflow: refresh-ctx
  agent: report-writer
  model: claude-opus-5
  inputsHash: "07e1cf3add41d9e4eed0bb0085e7c64cad5acb7ecb392e786cfb02fc61c642ac"
---
# HDFC Asset Management Company — cyber resilience summary

## Overview
No records as of 2026-09-15T09:48:32Z.

## Regulatory posture
Refreshed 2026-09-15 by refresh-ctx from details.json, context.json and soc/main.jsonl (0 ledger records as of 2026-09-15T10:27:04Z).

Registrations (details.json):
- SEBI MF/044/00/6: status active, category not-categorised, registered 2000-06-30
- SEBI INP000000506: status active, category not-categorised

Frameworks in scope: sebi-cscrf-2024, cert-in-directions-2022, dpdp-rules-2025 (3 instruments).

| Instrument | Regulator | Applicability | Controls | Implemented | Partial | Planned | Not impl. | Unknown | Open findings | Past SLA |
|---|---|---|---|---|---|---|---|---|---|---|
| sebi-cscrf-2024 (SEBI CSCRF 2024) | SEBI | applicable (entity types asset-management-company, portfolio-manager; no CSCRF RE category recorded, so the category filter does not exclude) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| cert-in-directions-2022 (CERT-In Directions 2022) | CERT-In | applicable (entity types) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| dpdp-rules-2025 (DPDP Rules 2025) | MeitY | applicable (entity types) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
<!-- source: applicability from .claude/skills/regulatory-catalogs/references/instruments.json; counts from latest records per id in soc/main.jsonl (empty) -->

No control records exist in the ledger yet, so no control family can be named as weakest; alternative would count as Implemented and not-applicable is excluded from Controls. Both SEBI registrations are recorded as not-categorised, so the CSCRF RE category is not captured.

- Drift applied in this run: none.
- Escalated claims awaiting human resolution: 0.
- Date of this refresh: 2026-09-15.

## Organization context
HDFC Asset Management Company Limited (brand HDFC Mutual Fund) is a publicly listed Indian asset management company based in Mumbai, Maharashtra (CIN L65991MH1999PLC123027). Its shares have been listed on the National Stock Exchange under the symbol HDFCAMC since 6 August 2018. It is the investment manager of HDFC Mutual Fund and sells mutual fund schemes, both actively managed and passive, to retail and institutional investors. It also offers portfolio management and advisory services to clients, through a network of investor service centres across India.

Context status: in_progress.

| Business unit | Listed | Licences | Obligations | Processes |
|---|---|---|---|---|
| HDFC Asset Management Company Limited | Yes (NSE HDFCAMC) | SEBI asset-management-company MF/044/00/6 (active), SEBI portfolio-manager INP000000506 (active) | MCA mca-companies-act, MCA mca-financial-reporting-audit, MCA mca-board-governance-rpt, MCA mca-csr-investor-protection, MCA mca-listed-entity-disclosures, SEBI sebi-lodr-listed-entity | fund-management, secretarial-compliance, general-meetings, shareholder-servicing, shareholder-grievance-redressal, secretarial-audit, statutory-financial-reporting, statutory-audit, internal-audit, compliance-monitoring, board-committee-governance, enterprise-risk-management, cyber-risk-oversight, unitholder-service-oversight, trustee-operating-support, related-party-disclosure, whistle-blower-mechanism, upsi-leak-investigation, csr-programme-management, csr-implementing-agency-oversight, unclaimed-dividend-iepf-management, listed-entity-disclosures, grievance-redressal, cyber-risk-management, client-services, listed-entity-secretarial-compliance, related-party-transaction-review, distribution-partner-management |

Licences:
- SEBI mutual fund asset management company (HDFC Mutual Fund) (MF/044/00/6, active): obligations sebi-mutual-funds-regulations (SEBI, statute: Securities and Exchange Board of India (Mutual Funds) Regulations, 2026 (sebi.gov.in pages dated 16 Jan 2026 and 1 Apr 2026), read with the SEBI Master Circular for Mutual Funds dated 20 Mar 2026); sebi-cscrf-2024 (SEBI, instrument: sebi-cscrf-2024); sebi-aml-kyc-investor-grievance (SEBI, circular: SEBI Master Circular 'Guidelines on Anti-Money Laundering (AML) Standards and Combating the Financing of Terrorism (CFT)/Obligations of Securities Market Intermediaries under the Prevention of...); sebi-lodr-listed-entity (SEBI, statute: Securities and Exchange Board of India (Listing Obligations and Disclosure Requirements) Regulations, 2015 [last amended on January 22, 2026]); offerings HDFC Mutual Fund schemes, Segregated Account Services, Alternative Investment Funds, Alternative Investment Funds managed by HDFC AMC (e.g. HDFC AMC Select AIF FOF - I, HDFC AMC Structured Credit Fund), Alternative Investment Funds managed as investment manager, HDFC MF equity-oriented schemes, HDFC MF debt schemes (including liquid, overnight, money market and target-maturity index funds), HDFC MF hybrid schemes (balanced advantage, arbitrage, equity savings, multi-asset), HDFC MF solution-oriented schemes (Retirement Savings Fund, Children's Fund), HDFC MF index funds and ETFs (including Gold and Silver ETFs), HDFC MF fund of funds schemes, HDFC MF close-ended schemes (Fixed Maturity Plans, Charity Fund for Cancer Cure); platforms hdfcfund-website (instruments none recorded), cams-rta (instruments none recorded), hdfc-mf-website-app (instruments none recorded), hdfc-mfonline-partners (instruments none recorded), hdfc-mf-whatsapp (instruments none recorded), stock-exchange-mf-platforms (instruments none recorded), mf-utility (instruments none recorded), mfcentral (instruments none recorded), scheme-custodians (instruments none recorded), hdfcfund-website-investor-portal (instruments none recorded), hdfc-mf-investor-app (instruments none recorded), partner-api-gateway (instruments none recorded), whatsapp-chatbot-channels (instruments none recorded), pms-client-portal (instruments none recorded), cams-rta-platforms (instruments none recorded), mf-central-mf-utility (instruments none recorded), hdfc-mfonline (instruments none recorded), hdfc-mf-mobile-app (instruments none recorded), investor-service-centres (instruments none recorded), kra-ckyc-registry (instruments none recorded), client-services-contact-centre (instruments none recorded), kfintech-share-registry (instruments none recorded), cams-mf-registrar (instruments none recorded), complaint-management-platform (instruments none recorded).
- SEBI portfolio manager (INP000000506, active): obligations sebi-portfolio-managers-regulations (SEBI, statute: Securities and Exchange Board of India (Portfolio Managers) Regulations, 2020 [last amended on February 10, 2025], read with the SEBI Master Circular for Portfolio Managers dated 16 Jul 2025); sebi-cscrf-2024 (SEBI, instrument: sebi-cscrf-2024); sebi-aml-kyc-investor-grievance (SEBI, circular: SEBI Master Circular 'Guidelines on Anti-Money Laundering (AML) Standards and Combating the Financing of Terrorism (CFT)/Obligations of Securities Market Intermediaries under the Prevention of...); sebi-lodr-listed-entity (SEBI, statute: Securities and Exchange Board of India (Listing Obligations and Disclosure Requirements) Regulations, 2015 [last amended on January 22, 2026]); offerings Portfolio Management Services, Portfolio Management Services and segregated accounts, Advisory mandates, Portfolio Management Services, Portfolio management services, Discretionary portfolio management services, Non-discretionary portfolio management services, PMS investment advisory services (non-binding), Co-investment portfolio management services for AIF investors, PMS investment approaches (equity, debt, hybrid, multi-asset, liquid, provident fund and bespoke mandates) (count 16), Category II AIFs managed by HDFC AMC (including private credit and HDFC AMC Select AIF FoF I), HDFC AMC Portfolio Management Services, HDFC AMC portfolio management services; platforms hdfcfund-website (instruments none recorded), cams-rta (instruments none recorded), hdfc-mfonline-partners (instruments none recorded), hdfcfund-website-investor-portal (instruments none recorded), hdfc-mf-investor-app (instruments none recorded), partner-api-gateway (instruments none recorded), whatsapp-chatbot-channels (instruments none recorded), pms-client-portal (instruments none recorded), cams-rta-platforms (instruments none recorded), mf-central-mf-utility (instruments none recorded), hdfc-mfonline (instruments none recorded), hdfc-mf-mobile-app (instruments none recorded), investor-service-centres (instruments none recorded), kra-ckyc-registry (instruments none recorded), client-services-contact-centre (instruments none recorded), kfintech-share-registry (instruments none recorded), cams-mf-registrar (instruments none recorded), complaint-management-platform (instruments none recorded).

Customer segments (21): High net-worth individuals, Family offices, Domestic corporates, Domestic and global institutions, Trusts and provident funds, Corporates and trusts, Provident funds (e.g. EPFO, SPFO mandates), Individual (retail) investors, about 68% of March 2026 MAAUM, Institutional investors, about 32% of March 2026 MAAUM, Individual (retail) mutual fund investors, Non-individual (corporate and other body) investors, NRI, PIO and OCI investors, Foreign Portfolio Investors, Trusts, Domestic and global institutions, Accredited and large value accredited investors, Retail mutual fund investors, Distribution partners, Resident individual investors, Non-individual investors (companies, trusts, firms, HUFs) subject to UBO declaration, PMS accredited and large value accredited investors.

Offerings: 25 recorded. Platforms: 37 recorded, 13 not linked to a licence.

Questionnaires (answered / open / not-applicable):
- q-mca-companies-act (mca-companies-act): 5 / 1 / 0
- q-mca-financial-reporting-audit (mca-financial-reporting-audit): 4 / 1 / 0
- q-mca-board-governance-rpt (mca-board-governance-rpt): 3 / 1 / 0
- q-mca-csr-investor-protection (mca-csr-investor-protection): 2 / 1 / 0
- q-mca-listed-entity-disclosures (mca-listed-entity-disclosures): 3 / 2 / 0
- q-sebi-mutual-funds-regulations (sebi-mutual-funds-regulations): 4 / 2 / 0
- q-sebi-portfolio-managers-regulations (sebi-portfolio-managers-regulations): 4 / 2 / 0
- q-sebi-cscrf-2024 (sebi-cscrf-2024): 3 / 2 / 0
- q-sebi-aml-kyc-investor-grievance (sebi-aml-kyc-investor-grievance): 4 / 2 / 0
- q-sebi-lodr-listed-entity (sebi-lodr-listed-entity): 4 / 1 / 0
- Total: 36 / 15 / 0

Open questions (internal first; answer with node .claude/scripts/ctx/answer.mjs hdfc-amc <question_id>):
- mca-companies-act-6 (internal): Which internal system or compliance tool tracks MCA filings, statutory registers and board meeting minutes, and who reviews it? Reason: internal: ask the compliance officer
- mca-financial-reporting-audit-5 (internal): Which accounting/ERP and fund accounting systems produce the company's financial statements, and who owns them? Reason: internal: ask the compliance officer. No fetched source or workspace file names the accounting, ERP or fund-accounting systems. The FY26 annual report says only that 'AUM is calculated by the...
- mca-board-governance-rpt-4 (internal): How are related-party transactions identified, approved by the audit committee and monitored between meetings? Reason: internal: ask the compliance officer. The Related Party Transactions Policy PDF (July 2025) is public, but its text could not be extracted this session, and how RPTs are tracked between meetings...
- mca-listed-entity-disclosures-4 (internal): How are unpublished price-sensitive information and designated persons' trading controlled, e.g. structured digital database, pre-clearance tool? Reason: internal: ask the compliance officer. The codes-policies page on hdfcfund.com returned 403. The BRSR only mentions refresher training on the 'Securities Dealing Code(s)' and says nothing about a...
- mca-listed-entity-disclosures-5 (internal): Which function decides whether an event (including a cyber incident) is material for exchange disclosure, and how is it escalated? Reason: internal: ask the compliance officer. The BRSR names the IT & Security Committee and the Risk Management Committee for cyber risk, but not who decides whether an event is material for disclosure....
- sebi-mutual-funds-regulations-risk-valuation (internal): Which function and system run scheme risk management, valuation, liquidity stress testing and surveillance for front-running and market abuse in scheme dealing? Reason: internal: ask the compliance officer
- sebi-mutual-funds-regulations-reporting (internal): Which team prepares the AMC's periodic regulatory reports to SEBI and AMFI and the reports to the trustees, and from which system are they generated? Reason: internal: ask the compliance officer
- sebi-portfolio-managers-regulations-client-platform (internal): Which system does the portfolio manager use for client portfolio accounting, fee computation and periodic client reports? Reason: internal: ask the compliance officer. The annual report says only that PMS/AIF have 'their own discrete teams and systems' and names no system; no workspace README or env file mentions a PMS platform.
- sebi-portfolio-managers-regulations-conflict-controls (internal): How does the compliance function monitor conflicts of interest and trade allocation between PMS client portfolios and mutual fund schemes? Reason: internal: ask the compliance officer. The DD (pp.57-58) says only that a CoI policy under CIR/MIRSD/5/2013 exists (updated 15 Jan 2025); how trade allocation between PMS and MF is monitored is not...
- sebi-cscrf-2024-soc-monitoring (internal): Does the AMC run its own security operations centre or use a third-party or market SOC, and which critical systems does it monitor? Reason: internal: ask the compliance officer
- sebi-cscrf-2024-technology-providers (internal): Which third-party technology providers host or operate regulated systems for the AMC (cloud hosting, fund accounting, order management, registrar systems), and how are they assessed? Reason: internal: ask the compliance officer
- sebi-aml-kyc-investor-grievance-aml-monitoring (internal): Which system screens investors against sanctions lists and monitors transactions to produce suspicious transaction reports to FIU-IND? Reason: internal: ask the compliance officer. The SAI says only that the AMC reports suspicious transactions to FIU-IND under PMLA and does not name a screening system. No workspace application README or...
- sebi-aml-kyc-investor-grievance-outsourced-kyc (internal): Which KYC and AML steps are done by the registrar and transfer agent or by distributors, and how does the AMC oversee them? Reason: internal: ask the compliance officer. Public documents show that CAMS (the RTA) runs the eKYC facility and that KYD distributors may perform IPV, but not how the KYC and AML work is split or how...
- sebi-lodr-listed-entity-disclosure-process (internal): Which team decides what material events and price-sensitive information are disclosed to the exchanges, and which system tracks designated persons' trading in the company's shares? Reason: internal: ask the compliance officer. Public sources show only that the company has a Policy for Determination of Materiality of Events and a Code of Practices & Procedures for Fair Disclosure of...
- mca-csr-investor-protection-2 (public): Which shareholder segments does the company have (promoter HDFC Bank, FPIs, mutual funds, retail), and how are shareholder complaints received and resolved? Reason: refuted: source-authenticity: The cited Equitymaster page gives June 2026 'Other Institutions' as 3.18%, not the answer's 2.79%, and Tijori and IndiaInfoline both give total institutions of 38.86%...

Processes by kind (52):
- fund-management: fund-management (mca-companies-act, mca-financial-reporting-audit); scheme-fund-management (sebi-mutual-funds-regulations); pms-portfolio-management (sebi-portfolio-managers-regulations)
- secretarial-compliance: secretarial-compliance (mca-companies-act, mca-listed-entity-disclosures); general-meetings (mca-companies-act); shareholder-servicing (mca-companies-act); secretarial-audit (mca-companies-act); board-committee-governance (mca-board-governance-rpt, sebi-lodr-listed-entity); trustee-operating-support (mca-board-governance-rpt); csr-programme-management (mca-csr-investor-protection); unclaimed-dividend-iepf-management (mca-csr-investor-protection); listed-entity-secretarial-compliance (sebi-lodr-listed-entity); related-party-transaction-review (sebi-lodr-listed-entity)
- grievance-redressal: shareholder-grievance-redressal (mca-companies-act, mca-csr-investor-protection, sebi-lodr-listed-entity); whistle-blower-mechanism (mca-board-governance-rpt); grievance-redressal (mca-listed-entity-disclosures); mf-investor-grievance-redressal (sebi-aml-kyc-investor-grievance); pms-client-grievance-redressal (sebi-aml-kyc-investor-grievance)
- regulatory-reporting: statutory-financial-reporting (mca-financial-reporting-audit); compliance-monitoring (mca-financial-reporting-audit); related-party-disclosure (mca-board-governance-rpt); listed-entity-disclosures (mca-listed-entity-disclosures); investor-complaint-disclosure (sebi-aml-kyc-investor-grievance)
- other: statutory-audit (mca-financial-reporting-audit); fund-accounting (sebi-mutual-funds-regulations)
- risk-management: internal-audit (mca-financial-reporting-audit); enterprise-risk-management (mca-board-governance-rpt, sebi-cscrf-2024, sebi-lodr-listed-entity); cyber-risk-oversight (mca-board-governance-rpt); cyber-risk-management (mca-listed-entity-disclosures); mf-pms-segregation-conflict-management (sebi-portfolio-managers-regulations); cscrf-compliance (sebi-cscrf-2024); cyber-risk-governance (sebi-cscrf-2024)
- client-services: unitholder-service-oversight (mca-board-governance-rpt); client-services (mca-listed-entity-disclosures); unit-distribution-channels (sebi-mutual-funds-regulations); unit-transactions (sebi-mutual-funds-regulations); systematic-plans (sebi-mutual-funds-regulations); account-statements-cas (sebi-mutual-funds-regulations); unclaimed-amounts (sebi-mutual-funds-regulations); pms-aif-operations (sebi-portfolio-managers-regulations); investor-transactions-servicing (sebi-cscrf-2024); distribution-partner-management (sebi-lodr-listed-entity)
- surveillance: upsi-leak-investigation (mca-board-governance-rpt)
- vendor-management: csr-implementing-agency-oversight (mca-csr-investor-protection); mf-service-provider-oversight (sebi-mutual-funds-regulations)
- kyc: investor-onboarding-kyc (sebi-mutual-funds-regulations); digital-ekyc-onboarding (sebi-cscrf-2024); mf-investor-kyc (sebi-aml-kyc-investor-grievance); investor-due-diligence-fatca-ubo (sebi-aml-kyc-investor-grievance)
- onboarding: pms-direct-onboarding (sebi-portfolio-managers-regulations); mf-investor-onboarding (sebi-aml-kyc-investor-grievance); pms-client-onboarding (sebi-aml-kyc-investor-grievance)
