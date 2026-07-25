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

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: prepareFixtureWorkspace(),
	// Registers the read-only `paireto.test.inspect` control plane so extension-host tests can
	// assert on internal counters (e.g. that openDiff never runs the full refresh).
	env: { PAIRETO_TEST: '1' },
});
