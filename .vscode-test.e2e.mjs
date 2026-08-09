// E2E configuration for the `vscode-test` CLI, launched ONLY by `out/e2e/runE2E.js`.
//
// It is a file of its own rather than a second labelled config in `.vscode-test.mjs` because an E2E
// run is not self-contained: runE2E.js has to build the sandbox repo and arm MockServer before VS
// Code starts, and write the cassette after it stops. Keeping this out of the default config is what
// stops `pnpm test` and the VS Code Test Explorer from launching a run that has no proxy to talk to.
//
// Every per-run value arrives in the environment, set by runE2E.js before it spawns the CLI.

import { defineConfig } from '@vscode/test-cli';

const required = (name) => {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is not set — launch an E2E run through out/e2e/runE2E.js`);
	}
	return value;
};

export default defineConfig({
	// The one spec this window was prepared for; runE2E.js passes `--grep` to pick the driver's suite
	// inside it. Both halves are Mocha's own selection.
	files: required('PAIRETO_E2E_SPEC'),
	// The pinned VS Code the repo's test cache already holds (see .vscode-test/); avoids a download.
	version: '1.128.0',
	workspaceFolder: required('PAIRETO_E2E_SANDBOX'),
	launchArgs: [
		'--user-data-dir',
		required('PAIRETO_E2E_USER_DATA_DIR'),
		// In Docker (see docker/README.md) VS Code runs as root under xvfb, so Electron needs
		// --no-sandbox; inert on a native macOS run where PAIRETO_DOCKER is unset.
		...(process.env.PAIRETO_DOCKER ? ['--no-sandbox', '--disable-gpu'] : []),
	],
	mocha: {
		// Every step drives a real agent turn, so the per-step budget is the timeout — Mocha's 2s
		// default would fail the run before the model had answered.
		timeout: Number(required('PAIRETO_E2E_STEP_TIMEOUT_MS')),
		// A step depends on the one before it, so once one fails the rest are noise.
		bail: true,
		color: false,
	},
});
