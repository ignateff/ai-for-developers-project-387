# Application releases

## Continuation in project 387

The release files and application version were preserved from project 386; old changelog links still refer to that repository. Its GitHub releases and tags were not imported. Review the first release PR in this repository against this boundary rather than treating historical changelog entries as newly published releases.

The manifest and `version.txt` preserve `0.5.0` as the starting version, not as evidence of a release in project 387. The top-level `bootstrap-sha` points to the application import commit (`10d74ac`), which is excluded from the first release's commit collection. Eligible subsequent commits may appear in the first release PR. Release Please ignores this bootstrap boundary after a generated release PR is merged. Do not create an old tag or release to fill the gap without a separate decision.

GitHub App installations, Actions variables and secrets are repository settings, not files. Configure them for **ignateff/ai-for-developers-project-387** using the steps below. The release job is skipped while `RELEASE_PLEASE_APP_ID` is unset; this does not skip CI or Hexlet checks. Configure the private key and App access before setting that variable; once the variable is set, missing or invalid credentials fail the workflow normally. No new deployment is part of the migration.

## Release behavior

Release Please maintains a single release PR for the application. It updates
`version.txt`, `CHANGELOG.md`, and `.release-please-manifest.json`. Merging that
PR creates a `v`-prefixed tag and a GitHub Release; it does not publish packages,
images, or deployments. The manifest is the baseline for the next version,
not proof that the baseline version was published in this repository.

The first PR includes eligible conventional commits after the import boundary.
Review its notes and version before merging. Thereafter, fixes increment patch,
features minor, and breaking changes major. A maintainer decides when to merge
each release PR; CI runs `mise run check` on the PR.

## GitHub App

Create a GitHub App, install it on this repository only, and grant repository
permissions **Contents: read and write**, **Issues: read and write**, and
**Pull requests: read and write**. Metadata is read-only by default. No webhook
is needed. The workflow requests only those permissions for its short-lived
installation token. App-created branches trigger CI, unlike events generated
by the repository's default `GITHUB_TOKEN`.

Set the repository Actions variable `RELEASE_PLEASE_APP_ID` to the App ID and
the Actions secret `RELEASE_PLEASE_APP_PRIVATE_KEY` to the complete PEM private
key. Treat the key as a secret; do not paste it into issues, logs, or chat.
The workflow runs on pushes to `main` and can also be started manually on
`main` after credentials are configured. A manually disabled workflow must be
enabled separately, with owner agreement, before it can run.

## Verification

After the configuration is on `main` and credentials are installed, inspect the
**Release Please** run on the latest `main` and record its link in issue #19.
If a release PR is created, review its proposed version against `0.5.0`, its
notes against the post-import history, and its CI status. Check generated links:
in particular, a comparison against a nonexistent `v0.5.0` tag would be broken.
Report discrepancies rather than merging the PR. If no PR is created, explain
whether there are no releasable changes or whether the run failed. Merging a
release PR and creating a GitHub Release require a separate human decision.

Reference: [Release Please Action](https://github.com/googleapis/release-please-action)
and [manifest configuration](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md).
