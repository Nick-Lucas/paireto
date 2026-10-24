# Releasing

The **Release** workflow (`.github/workflows/release.yml`) bumps the version and publishes the extension to the Visual Studio Marketplace.

## Make a release

1. Make sure that CI passed on the newest commit on `main`. The workflow stops if it did not.
2. Go to **Actions → Release → Run workflow**.
3. Select `main`, select `patch`, `minor` or `major`, and select **Run workflow**.

The workflow does these steps:

1. The `bump` job calculates the next stable version with `scripts/releaseVersion.mts` and sets it with `npm version`. Then it pushes the `chore(release): X.Y.Z` commit and the `vX.Y.Z` tag to `main` in one atomic push.
2. The `publish` job builds the VSIX from the tag and publishes it to the Marketplace. Then it creates a GitHub release with the VSIX attached.

If the `publish` job fails, fix the cause and select **Re-run failed jobs**. Do not start a new release, because that bumps the version again. `vsce publish --skip-duplicate` makes the re-run safe after a partial publish.

Do not change `version` in `package.json` by hand. Do not publish from a local machine.

## Pre-releases

The **Release** workflow also publishes a pre-release each time CI passes on a push to `main`. You do not start it. Users get the pre-release when they select **Switch to Pre-Release Version** on the extension in VS Code.

The `prerelease` job does not commit or tag. It sets the version only in the build, so `package.json` on `main` keeps the stable version.

If a new push to `main` passes CI while a pre-release publishes, the workflow stops the older pre-release run.

## Version numbers

The Marketplace accepts only `major.minor.patch` versions, and a pre-release cannot use the same version as a stable release. The workflow uses the numbering that the [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions) recommends:

- Stable releases use an even minor version. A `minor` bump goes to the next even minor version, for example from `0.30.4` to `0.32.0`.
- Pre-releases use the odd minor version above the stable version, and the patch is the workflow run number. For example, the stable version `0.30.0` gives pre-releases `0.31.<run number>`.

VS Code installs the highest version. A pre-release user gets each new pre-release, and gets a new stable release when its minor version is higher than the pre-release minor version.

`scripts/releaseVersion.mts` calculates both kinds of version from `package.json`.

## Settings that the workflow uses

| Name | Kind | Where | Purpose |
| --- | --- | --- | --- |
| `RELEASE_APP_CLIENT_ID` | Variable | `Release` environment | The client ID of the GitHub App that pushes the release commit and tag. |
| `RELEASE_APP_PRIVATE_KEY` | Secret | `Release` environment | A private key of that GitHub App. |
| `AZURE_CLIENT_ID` | Variable | `Release` environment | The client ID of the Microsoft Entra app registration that publishes. |
| `AZURE_TENANT_ID` | Variable | `Release` environment | The tenant ID of that app registration. |

The `publish` job signs in to Microsoft Entra ID with GitHub OIDC. It does not use an Azure DevOps personal access token, because Azure DevOps retires global personal access tokens on 1 December 2026.

The app registration has a federated credential with these values. The repository uses immutable OIDC subjects, so the subject holds the owner and repository IDs. The subject is case-sensitive and must match the environment name:

- Issuer: `https://token.actions.githubusercontent.com`
- Subject: `repo:Nick-Lucas@8896153/paireto@1269574683:environment:Release`
- Audience: `api://AzureADTokenExchange`

The **Show the Marketplace identity ID** step prints the ID of the identity that publishes. That ID is a member of the `Paireto` publisher, with the **Contributor** role.

The `bump` job pushes with a token from the GitHub App. The app has **Contents: Read and write** on this repository, and it is on the bypass list of the `main-2` ruleset, because that ruleset requires CI checks on `main`.
