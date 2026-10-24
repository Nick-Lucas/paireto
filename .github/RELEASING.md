# Releasing

The **Release** workflow (`.github/workflows/release.yml`) bumps the version and publishes the extension to the Visual Studio Marketplace.

## Make a release

1. Make sure that CI passed on the newest commit on `main`. The workflow stops if it did not.
2. Go to **Actions → Release → Run workflow**.
3. Select `main`, select `patch`, `minor` or `major`, and select **Run workflow**.

The workflow does these steps:

1. The `bump` job runs `npm version`. Then it pushes the `chore(release): X.Y.Z` commit and the `vX.Y.Z` tag to `main` in one atomic push.
2. The `publish` job builds the VSIX from the tag and publishes it to the Marketplace. Then it creates a GitHub release with the VSIX attached.

If the `publish` job fails, fix the cause and select **Re-run failed jobs**. Do not start a new release, because that bumps the version again. `vsce publish --skip-duplicate` makes the re-run safe after a partial publish.

Do not change `version` in `package.json` by hand. Do not publish from a local machine.

## Settings that the workflow uses

| Name | Kind | Where | Purpose |
| --- | --- | --- | --- |
| `RELEASE_TOKEN` | Secret | Repository | A fine-grained personal access token from a repository admin, with **Contents: Read and write** on this repository. It lets the `bump` job push past the branch protection on `main`. |
| `AZURE_CLIENT_ID` | Variable | `marketplace` environment | The client ID of the Microsoft Entra app registration that publishes. |
| `AZURE_TENANT_ID` | Variable | `marketplace` environment | The tenant ID of that app registration. |

The `publish` job signs in to Microsoft Entra ID with GitHub OIDC. It does not use an Azure DevOps personal access token, because Azure DevOps retires global personal access tokens on 1 December 2026.

The app registration has a federated credential with these values:

- Issuer: `https://token.actions.githubusercontent.com`
- Subject: `repo:Nick-Lucas/paireto:environment:marketplace`
- Audience: `api://AzureADTokenExchange`

The **Show the Marketplace identity ID** step prints the ID of the identity that publishes. That ID is a member of the `Paireto` publisher, with the **Contributor** role.

When `RELEASE_TOKEN` expires, make a new token and replace the secret.
