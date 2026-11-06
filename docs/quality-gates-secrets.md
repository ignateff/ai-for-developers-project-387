# Secret scanning and temporary risk acceptance

Run `mise run check:secrets` before pushing. It uses the pinned Betterleaks
default rules, an explicit temporary config, an empty ignore file, and disabled
inline allow comments. Repository scanner configs, `.betterleaksignore`, and
`.gitleaksignore` cannot weaken this check. It never validates credentials against
live services.

The normal check scans both:

- A Git-selected working snapshot: tracked files (including tracked ignored
  files) plus untracked, nonignored files. Deleted files are skipped; symbolic
  links are scanned as link text, not followed outside the checkout.
- Full history reachable from HEAD, including merge diffs (`--full-history -m
  HEAD`). CI must fetch complete history.

The hook's `node scripts/check-secrets.mjs --staged` scans the actual complete
index snapshot, not unstaged working contents. Unresolved indexes and unsupported
Git entries fail rather than silently skipping data. Neither mode modifies the
index or working files.

## Initial exceptions: expire after 2026-12-06 UTC

The user explicitly approved temporary risk acceptance for **all initial
existing findings**, including unverified matches in the opaque design file.
This is not a claim that those design matches are false positives. Their
credential validity has not been checked. Do not open or parse `.pen` files to
investigate; follow the project's Pencil workflow.

`config/quality-gates/secrets-baseline.json` records metadata only:

- `snapshot`: exact path, rule, starting line, and full Git blob content hash.
  Changing any byte of an accepted file invalidates its snapshot exceptions,
  even if a replacement secret has the same rule and line.
- `history`: exact path, rule, starting line, and immutable commit hash.

The initial capture contains 35 snapshot entries and 140 history entries: the
original 105 supplied full-history findings (including agent checkpoint refs),
plus 35 existing merge-attributed copies exposed by enabling merge diffs. These
are exact existing matches, not rule-wide or directory-wide exclusions. Historical
entries outside HEAD ancestry do not cause extra refs to be scanned.

The policy requires version 1, a substantive risk-acceptance reason, and a real
calendar date in strict `YYYY-MM-DD` form. Every entry is validated on every run,
even if no finding currently matches it. The gate fails starting **2026-12-07
00:00 UTC** until remediation or a new explicit human review changes the policy.
The scheduled quality check runs the same command, so expiry is enforced without
a new commit. No runtime baseline regeneration or automatic renewal exists.

## Failure handling and review

New or changed findings fail with location/rule/identity metadata only. Neither
secret values nor matched source text are stored in the baseline or printed by
the wrapper. Temporary redacted scanner reports are removed after the run.
Missing/malformed reports, incomplete findings, scanner failures, unexpected
warnings and exit/report disagreements fail closed. The application also fails
if its baseline is missing; standalone scratch Git repositories without the
application package marker default to no exceptions for regression testing.

For a new finding, remove or rotate any actual credential and assess historical
exposure. For a suspected false positive, review the exact location and identity
with a human. Any approved exception must be explicit, narrowly identified,
documented and dated; do not regenerate the initial baseline, extend the deadline,
exclude directories or disable rules merely to make checks green.
