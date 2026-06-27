const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/** The node extension host bundle. */
const extensionConfig = {
	entryPoints: [
		'src/extension.ts'
	],
	bundle: true,
	format: 'cjs',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'node',
	// Prefer the ESM ("module") entry of deps: jsonc-parser's UMD build shadows `require`, so its
	// inner require("./impl/format") survives as a runtime call that can't resolve next to dist/.
	mainFields: ['module', 'main'],
	outfile: 'dist/extension.js',
	external: ['vscode'],
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

/** The React webview bundle (Welcome screen) — runs in the browser-like webview, self-contained IIFE. */
const webviewConfig = {
	entryPoints: [
		'src/welcome/webview/index.tsx'
	],
	bundle: true,
	format: 'iife',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'browser',
	jsx: 'automatic',
	outfile: 'dist/welcome.js',
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
	const ctxs = await Promise.all([
		esbuild.context(extensionConfig),
		esbuild.context(webviewConfig),
	]);
	if (watch) {
		await Promise.all(ctxs.map((c) => c.watch()));
	} else {
		await Promise.all(ctxs.map((c) => c.rebuild()));
		await Promise.all(ctxs.map((c) => c.dispose()));
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
