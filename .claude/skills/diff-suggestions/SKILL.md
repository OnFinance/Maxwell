---
name: diff-suggestions
description: How impl-auto-improvement turns a finding into a reviewable unified diff under company-profile/<c>/suggestions/suggestions/<sug_id>/<repo_id>/<name>.diff against the pinnedCommit of applications/<app>/repos/<repo_id>.json, generates it with git diff --no-index between scratch copies under /tmp (formatters and lockfile tools run only inside that copy) without ever modifying the target repo or Maxwell's checkout of it, computes linesAdded/linesRemoved/filesChanged, fills suggestions/master.json through the proposed -> surfaced -> accepted|rejected -> merged -> reverted lifecycle, and links findings, ledger controls, regulatory refs and initiatives. Load before writing any .diff or touching suggestions/master.json.
license: AGPL-3.0-only
compatibility: Requires git >= 2.40 on the host, a fetched checkout at applications/<app_id>/repos/<repo_id>/ (gitignored) and the Maxwell write-guard hook, which blocks writes into that checkout
metadata:
  author: OnFinance
  version: "1.0.0"
  schema: .claude/schemas/v1/suggestions/master.schema.json
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - Bash(git diff *)
  - Bash(git -C * diff *)
  - Bash(git -C * apply --check *)
  - Bash(git -C * apply --numstat *)
  - Bash(mktemp -d /tmp/*)
  - Bash(rm -r /tmp/maxwell-diff.*)
  - Bash(node --input-type=module *)
  - Bash(git -C * rev-parse *)
  - Bash(git -C * status *)
  - Bash(node .claude/scripts/*)
when_to_use: Whenever a workflow proposes a code, configuration, IaC, CI or policy change for a company's application repository; also when re-checking retention of previously merged suggestions
user-invocable: false
x-maxwell:
  kind: convention
  workflows: [impl-auto-improvement, impl-change-management, report-audit-improvements, execute-scr, probe-iac, probe-app-chart, probe-cicd-env]
---
# Diff suggestions

A suggestion is a **proposal**: a unified diff a human reviews and merges in the company's own repository.
Maxwell never pushes, commits, opens branches or edits files inside `applications/<app>/repos/<repo_id>/`. The
write guard blocks `Write`/`Edit` there and `.claude/settings.json` denies them; a Bash workaround is a
policy violation, not a clever fix. That includes Maxwell's own gitignored checkout: other workflows
(`probe-iac`, `probe-app-chart`, `execute-scr`) may be reading it concurrently, so it is never edited, not even
temporarily with a revert afterwards.

## 1. Where things live
```
company-profile/<company_id>/suggestions/master.json                       index, one entry per suggestion
company-profile/<company_id>/suggestions/suggestions/<sug_id>/<repo_id>/<name>.diff
applications/<app_id>/repos/<repo_id>.json                                  pinnedCommit, localCheckout, url
applications/<app_id>/repos/<repo_id>/                                       gitignored working copy
```
- `<sug_id>` is a fresh `sug_` prefixed ULID (26 Crockford base32 chars, first char 0-7), identical to
  `suggestionId` in master.json and reused as the directory name.
- `<repo_id>` equals `repoId` in the repo record; a suggestion touching two repos of one application has two
  directories under the same `<sug_id>`.
- `<name>` is kebab-case, describes the change, ends in `.diff`: `build-yml-sbom-job.diff`,
  `values-prod-readonly-rootfs.diff`. One diff file per repo per suggestion; many files may be inside it.
- Every diff `diffPath` in master.json is workspace-root-relative and must match the layout glob
  `company-profile/*/suggestions/suggestions/*/*/*.diff`.

## 2. Pin to the inspected commit
Before generating anything:
```
node -e 'const r=require("./applications/<app>/repos/<repo_id>.json");console.log(r.pinnedCommit,r.localCheckout)'
git -C applications/<app>/repos/<repo_id> rev-parse HEAD        # must equal (or start with) pinnedCommit
git -C applications/<app>/repos/<repo_id> status --porcelain    # must be empty
```
If HEAD differs from `pinnedCommit`, stop: `refresh-ctx` owns fetching and pinning. If the working tree is
dirty, stop and record an observation (`methods: ["impl-auto-improvement"]`, `result: "inconclusive"`) that
the checkout was modified outside Maxwell. `repos[].baseCommit` in master.json is the full 40-hex SHA from
`rev-parse HEAD` (the repo record may hold an abbreviated `pinnedCommit`); the diff is only valid for that commit.

## 3. Generate the diff (--no-index in a scratch tree, the only method)
The checkout is never touched. Copy only the files you change into an `a/` (original) and `b/` (proposed)
tree in a temp directory outside the workspace, edit `b/`, and diff the two trees in one command:
```
T=$(mktemp -d /tmp/maxwell-diff.XXXXXX)                         # never under the workspace
C=applications/<app>/repos/<repo_id>
for P in .github/workflows/build.yml deploy/helm/trading-api/values-prod.yaml; do   # repo-relative paths
  mkdir -p "$T/a/$(dirname "$P")" "$T/b/$(dirname "$P")"
  cp "$C/$P" "$T/a/$P"; cp "$C/$P" "$T/b/$P"
done
# edit files under $T/b with sed or a heredoc via Bash (the Write/Edit tools are blocked outside the
# workspace); add new files only under $T/b, delete only from $T/b
mkdir -p company-profile/<c>/suggestions/suggestions/<sug_id>/<repo_id>
git -C "$T" diff --no-index --unified=3 --no-color --src-prefix= --dst-prefix= a b \
  | sed -E 's#^diff --git b/(.+) b/\1$#diff --git a/\1 b/\1#; s#^diff --git a/(.+) a/\1$#diff --git a/\1 b/\1#' \
  > company-profile/<c>/suggestions/suggestions/<sug_id>/<repo_id>/<name>.diff
rm -r "$T"                                                       # not rm -rf: denied in settings.json and opencode.json
```
Why each piece is there (verified with git 2.53):
- Run with `-C "$T"` and empty prefixes because the tree names `a` and `b` then *are* the prefixes. Plain
  `git diff --no-index a/<p> b/<p>` adds git's own prefixes and emits `diff --git a/a/<p> b/b/<p>`, which
  `git apply` at the checkout rejects.
- Diffing the directories `a b` (not file by file) emits every file in path order, including added files
  (`new file mode 100644`, `--- /dev/null`) and deleted ones (`deleted file mode`, `+++ /dev/null`).
- For an added file git writes `diff --git b/<p> b/<p>` and for a deleted one `diff --git a/<p> a/<p>`; the
  `sed` rewrites only those header lines to the canonical `a/<p> b/<p>`. Never hand-edit hunks.
- `git diff --no-index` exits 1 when the trees differ; that is success here. In a pipeline the exit status is
  sed's, so check the output file is non-empty instead.
- Keep file modes: `cp` preserves the executable bit; a mode-only change shows as `old mode`/`new mode`.

When a tool must produce the change (formatter, lockfile regeneration, code generator), run it **inside the
scratch copy**, never in the checkout:
- copy every input the tool reads (the files it rewrites plus its config: `package.json`, `package-lock.json`,
  `.prettierrc`, `go.mod`/`go.sum`, `pyproject.toml`, …) into **both** `$T/a` and `$T/b`, so the config files
  do not show up as added files;
- run the tool with its working directory under `$T/b` and in a mode that neither executes repository code
  nor needs anything outside the copy (`npm install --package-lock-only --ignore-scripts`, `prettier --write
  <paths>`, `terraform fmt`), then diff `a b` exactly as above;
- if the tool needs the whole repository, network access to anything but the public package registry, or would
  run repository scripts, do not generate a diff: report the fix as `needs-human-design` (as `fix-author`
  does) and describe the command a human should run in the rationale of a change-management task instead.

Never `git add` (not even `-N`), `commit`, `stash`, `checkout`, `clean`, `checkout -b` or `push` in the
checkout.

## 4. Validate the diff
```
git -C applications/<app>/repos/<repo_id> apply --check "$PWD/<diffPath>"    # applies cleanly at pinnedCommit
git -C applications/<app>/repos/<repo_id> apply --numstat "$PWD/<diffPath>"  # per-file added/removed, changes nothing
node .claude/scripts/validate-data.mjs <diffPath>                            # layout + diff format
```
`-C` changes directory, so the diff path must be absolute. Use plain `--check` (`--unidiff-zero` takes no
value and git exits 129 on `--unidiff-zero=false`). `validate-data` requires `diff --git` (or `---`/`+++`)
headers and at least one `@@ -a,b +c,d @@` hunk. A diff that fails `apply --check` is not written to
master.json; regenerate it.

## 5. Compute the counts
`linesAdded` and `linesRemoved` count `+`/`-` lines inside hunks only (headers `---`/`+++` excluded);
`filesChanged` counts `diff --git` headers:
```
awk '/^diff --git /{f++; h=0; next} /^@@/{h=1; next} h && /^\+/{a++} h && /^-/{r++} END{printf "%d %d %d\n", a+0, r+0, f+0}' <diffPath>
```
Output order: linesAdded linesRemoved filesChanged. Cross-check with the column sums and row count of
`apply --numstat` above; they must agree (binary files show `-` in numstat and are not allowed in suggestions).
Record exactly these numbers; the acceptance-rate KPI uses them as a size dimension and a reviewer compares
them with the PR.

## 6. Size limits (split, do not squeeze)
- One category per suggestion (`category` enum in the schema); a diff that both upgrades a dependency and
  adds a CI gate is two suggestions.
- <= 400 changed lines and <= 10 files per diff; larger changes become a change-management initiative with
  tasks, plus a first small diff that a reviewer can accept in one sitting.
- No generated artefacts (lockfiles, minified bundles, vendored code) unless the suggestion *is* the
  regeneration, in which case explain it in `rationale`.
- No secrets, no real hostnames not already in the repo, no credentials in test fixtures. A diff written by
  Bash redirection bypasses the write guard's secret scan and `validate-data` does not scan diffs, so before
  recording it run the write guard's own detector (`findSecret` in `.claude/hooks/lib.mjs`: AWS keys, private
  keys, GitHub `ghp_`/`github_pat_`, Anthropic, Slack, Google `AIza` keys, JWTs and secret-valued JSON keys such
  as `"client_secret": "…"`) from the workspace root:
  ```
  node --input-type=module -e "import {findSecret} from './.claude/hooks/lib.mjs'; import {readFileSync} from 'node:fs'; const s=findSecret(readFileSync(process.argv[1],'utf8')); if(s){console.error('secret-shaped: '+s);process.exit(2)}" <diffPath>
  ```
  It must exit 0 with no output. As an extra check (not a substitute), `grep -nE 'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|sk-ant-|xox[baprs]-' <diffPath>`
  must print nothing either (`ASIA` temporary keys are not in `findSecret`). On any hit, discard the diff and
  regenerate it without the value. A `secret-removal` suggestion whose `-` lines would carry the live value is not
  written as a diff at all: raise the rotation task through `impl-change-management` and propose only the
  replacement reference (for example an External Secrets `secretKeyRef`) once the value is rotated.

## 7. Fill `suggestions/master.json`
Read the current index, append the new entry to `suggestions[]` (never delete or reorder), bump `updatedAt`
and the index-level `provenance`, then validate with `node .claude/scripts/validate-data.mjs
company-profile/<c>/suggestions/master.json`.

Required on creation (`status: "proposed"`):
- `suggestionId`, `title` (imperative, PR-title length), `rationale` (why, what the diff does, what risk it
  closes; becomes the PR body and must cite the finding and the clause), `category`, `severity` (copied from the
  linked finding, never estimated), `createdAt`, `prUrls: []`, `repos[]` (one `repoChange` per repo with
  `appId`, `repoId`, `diffPath`, `baseCommit`, `linesAdded`, `linesRemoved`, `filesChanged`), `findingIds`,
  `controlIds`, `regulatoryRefs` (>= 1 unless `category: other`), `sourceWorkflow`, `provenance` with `model`
  set (a KPI dimension).

Lifecycle and the timestamps the schema demands exactly:
| Transition | Who | Set |
|---|---|---|
| `proposed -> surfaced` | the workflow, when the diff is shown to a human (PR opened, ticket, or the suggestions section of summary.md written) | `surfacedAt`; add `prUrls[]` if a PR exists |
| `surfaced -> accepted` / `rejected` | a **human or script**, never an agent (`decidedBy.type` is `human|script`) | `decidedAt`, `decidedBy`, `decisionNote` (mandatory for rejections; feeds prompt tuning) |
| `accepted -> merged` | recorded by the next `impl-auto-improvement` run that finds the change on the default branch | `mergedAt`, `repos[].mergeCommit` |
| `merged -> reverted` | same | `revertedAt`, `repos[].revertCommit`, optional `repos[].revertPrUrl` |
| any open state `-> superseded` | when a newer suggestion replaces it | `closedAt`, `supersededBy` (the newer `sug_`) |
| `surfaced -> expired` | surfaced > 30 days without a decision | `closedAt` |
| retention check | `mergedAt + 30 days` or later | `retentionCheckedAt`, `retained` (true when every `mergeCommit` is still an ancestor of the default branch head) |

Do not set `mergedAt`/`mergeCommit` on anything but merged and reverted, `closedAt` on anything but
superseded and expired: the schema rejects the file. A status is only ever moved forward; to correct a
mistake append a superseding suggestion.

## 8. Linking
- `findingIds`: the `fnd_` ledger records the diff remediates (usually one). The finding's `severity` becomes
  the suggestion's severity.
- `controlIds`: the bare framework control ids (`GV.SC.S5`, `PS.3.2`) the change strengthens; each must
  correspond to a `regulatoryRefs` entry (`{regulator, instrument, controlId}`) and to a ledger control record
  `<instrument>:<controlId>`. The ledger key is instrument-qualified; master.json carries the instrument in
  `regulatoryRefs` and the bare id in `controlIds` (the common `controlId` pattern has no colon, although the
  schema description calls them ledger control ids). When two instruments share a bare id (`1.2.1` in PCI DSS
  and an RBI clause), list it once and let `regulatoryRefs` carry both instruments.
- `regulatoryRefs`: most specific Indian instrument first (SEBI CSCRF 2024, RBI directions 2026, IRDAI 2023,
  CERT-In 2022, DPDP Rules 2025), global mappings after.
- `initiativeId`: set when the diff implements a change-management task; then also add the `sug_` to that
  task's `suggestionIds[]` via `impl-change-management`, never by editing the task file from this workflow.
- Ledger: append an `observation` through `soc/append.mjs` (`title: "Suggestion sug_… proposed for fnd_…"`,
  `controlIds` as instrument-qualified ledger ids, `methods: ["impl-auto-improvement"]`, `result:
  "not-applicable"` because a proposal assesses nothing, `evidence: [{type: "workspace-file", ref: <diffPath>,
  sha256}]`) so `soc/versions/commit_<n>.diff` shows the proposal was raised. Also add the `sug_` to the
  finding's `suggestionIds[]` by appending a superseding finding record, never by editing the line.

## 9. Re-checking on later runs
For every entry in `surfaced`, `accepted` or `merged` state, after `refresh-ctx` has fetched and re-pinned
the checkout (this workflow never fetches): `git -C <checkout> apply --reverse --check <abs diff>` succeeds =>
the change is present on the default branch => merged; find the commit with `git -C <checkout> log
--format=%H -S'<distinctive added line>' -- <path>` and confirm it with `git merge-base --is-ancestor`.
Forward `apply --check` still succeeding => not merged yet. A previously merged change whose reverse check now
fails and whose forward check succeeds again => reverted; find the revert commit the same way with the removed
line. When neither direction applies the code has moved on: leave the status unchanged and, if the finding is
still open, propose a superseding suggestion against the new `pinnedCommit`. Record what you can prove; never guess `mergeCommit`.
A `surfaced` entry found merged without a recorded decision stays `surfaced` until a human or script records
`accepted`; agents never set `decidedBy`.

## 10. Finish
`node .claude/scripts/validate-data.mjs <diffPath> company-profile/<c>/suggestions/master.json` green,
checkout still clean at `pinnedCommit` (`status --porcelain` empty, `rev-parse HEAD` unchanged; this only
confirms nothing touched it), temp directory removed with `rm -r "$T"`, the suggestions section of summary.md left to
`report-audit-improvements` (this workflow does not write reports).
