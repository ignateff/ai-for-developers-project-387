# Application releases

## Continuation in project 387

The release files and application version were preserved from project 386; old changelog links still refer to that repository. Its GitHub releases and tags were not imported. Review the first release PR in this repository against this boundary rather than treating historical changelog entries as newly published releases.

GitHub App installations, Actions variables and secrets are repository settings, not files. Configure them for **ignateff/ai-for-developers-project-387** using the steps below. The release job is skipped while `RELEASE_PLEASE_APP_ID` is unset; this does not skip CI or Hexlet checks. Configure the private key and App access before setting that variable; once the variable is set, missing or invalid credentials fail the workflow normally. No new deployment is part of the migration.

## Release behavior

Release Please maintains a single release PR for the application. It updates
`version.txt`, `CHANGELOG.md`, and `.release-please-manifest.json`. Merging that
PR creates a `v`-prefixed tag and a GitHub Release; it does not publish packages,
images, or deployments. `version.txt` starts at the intended first version,
`0.1.0`; the initial empty manifest does not claim a release already exists.

The first PR includes eligible conventional commits from the existing history.
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
`main` after credentials are configured. Do not merge the setup PR before the
App is installed and its credentials are configured.

## Verification

After the setup PR is merged, inspect the **Release Please** workflow run and
the generated release PR. Confirm version `0.1.0`, relevant existing history,
and a green **CI** run on that PR. Report any missing history or permission
failure rather than merging it. Merging the release PR is a separate decision;
after it is merged, check that the `v0.1.0` tag and GitHub Release were created.

Reference: [Release Please Action](https://github.com/googleapis/release-please-action)
and [manifest configuration](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md).
