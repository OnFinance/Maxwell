---
description: Create the minimum valid company-profile skeleton for a new company_id (details, summary, sdlc policy, empty ledger, masters)
argument-hint: <company_id> [legal name | facts.json]
allowed-tools: Bash(npm run *), Bash(node .claude/scripts/*), Read, Write
x-maxwell:
  workflow: seed-company
  touches: ["company-profile/*/**"]
  readsCredentials: false
---
Create `company-profile/$1/` with exactly the required files from `.claude/schemas/layout.json`
(`requiredPerCompany`): `details.json`, `summary.md`, `sdlc/policy.json`, `soc/main.jsonl` (empty file),
`change_management/master.json`, `suggestions/master.json`, plus `soc/versions/.gitkeep`,
`vendors/.gitkeep`, `change_management/initiatives/.gitkeep` and `suggestions/suggestions/.gitkeep`.
Use the schema `examples` as templates, set `companyId` to `$1`, legal name to `$2` if given, fill only fields
you actually know and leave the rest at the schema minimum. Every document gets a `provenance` block with
`harness` set to the current harness and `workflow: "seed-company"`. Finish with `npm run validate` and
report the created paths. Refuse if `company-profile/$1` already exists.

When `$2` is a path ending in `.json` (a hosted run writes the company's facts there, e.g. `in/company.json`), read it
instead of taking `$2` as the legal name. It holds facts in `details.json`'s own field names: `legalName`,
`entityTypes`, `jurisdictions`, `regulatoryRegistrations`, `contacts`, `socModel`, and optionally `frameworksInScope`,
`brandName`, `description`, `website`, `headquarters`, `identifiers`, `criticalFunctions`, plus `sdlcPolicy` with
`sdlc/policy.json`'s fields. Take every fact from it as given and copy the file nowhere. The company id `$1` and these
facts are the caller's: do not stop to ask about them or question the id; this is a non-interactive run. When
`frameworksInScope` is absent, take the instruments of
`.claude/skills/regulatory-catalogs/references/instruments.json` whose `applicability` matches the entity types and
jurisdictions. When the file lacks a fact `details.json` cannot be valid without (legal name, an entity type, a
primary jurisdiction, a contact, the SOC model, or a registration for a regulated entity type), write nothing and
name the missing facts.
