import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defineConfig } from '@vscode/test-cli';

// Tests that drive the ACTIVATED extension (e.g. openDiff preview behaviour) need the window's
// workspace to be a real Git repository at launch — WorkspaceRootCatalog resolves git roots from
// the workspace folders during activation, and the first folder can't be added mid-test (VS Code
// restarts the extension host). A per-run mkdtemp keeps it fresh WITHOUT a fixed shared path: a
// fixed path's rm-rf at config load would destroy a concurrent run's live workspace (two worktrees
// running `pnpm test` at once), and both runs would contend for one per-repo socket.
function prepareFixtureWorkspace() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paireto-test-workspace-'));
	const git = (...args) => execFileSync('git', args, { cwd: dir });
	git('init', '-q');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
	fs.writeFileSync(path.join(dir, 'notes.txt'), 'one\ntwo\n');
	git('add', '.');
	git('commit', '-q', '-m', 'base');
	return dir;
}

// The extension writes its per-repo socket, index and activity files below the XDG state dir. Left
// unset, a test run lands in the developer's own ~/.local/state and two worktrees running the suite
// at once contend for one index.lock. /private/tmp rather than os.tmpdir() because the socket path
// sits under this root and must stay inside the ~104-byte sun_path limit.
function prepareStateHome() {
	// macOS resolves /tmp to /private/tmp, so prefer the canonical spelling where it exists and fall
	// back to /tmp elsewhere — a Linux container has no /private.
	const root = fs.existsSync('/private/tmp') ? '/private/tmp' : '/tmp';
	return fs.mkdtempSync(path.join(root, 'pai-state-'));
}

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: prepareFixtureWorkspace(),
	// In Docker (see docker/README.md) VS Code runs as root under xvfb, so Electron needs --no-sandbox;
	// inert on a native macOS run where PAIRETO_DOCKER is unset.
	launchArgs: process.env.PAIRETO_DOCKER ? ['--no-sandbox', '--disable-gpu'] : [],
	// Registers the read-only `paireto.test.inspect` control plane so extension-host tests can
	// assert on internal counters (e.g. that openDiff never runs the full refresh).
	env: { PAIRETO_TEST: '1', XDG_STATE_HOME: prepareStateHome() },
});
