import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// GitHub Pages base path — must match the repo name so asset URLs resolve at
// https://<user>.github.io/<repo>/. Set to '' for a custom-domain deploy.
// The Tauri desktop build also needs '' — it serves assets from the root of
// its own tauri:// protocol, not a /isle-wars/ subpath, and TAURI is set by
// the "build:tauri" script that src-tauri/tauri.conf.json's
// beforeBuildCommand invokes (see also ios/bridge, which imports src/lib
// directly rather than going through this build at all, so it never hits
// this path — only the two static-site consumers, GitHub Pages and Tauri,
// need to agree on a base here).
const dev = process.env.NODE_ENV === 'development';
const base = dev || process.env.TAURI ? '' : '/isle-wars';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: {
		// Force runes mode for the project, except for libraries.
		// Can be removed in svelte 6.
		runes: ({ filename }) =>
			filename.split(/[/\\]/).includes('node_modules') ? undefined : true
	},
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html', // SPA fallback so client-side routing works
			precompressed: false,
			strict: true
		}),
		paths: { base },
		// '*' only crawls links reachable from '/', and nothing links to
		// /recap (it's reached via a JS-built URL with a data fragment,
		// never an <a href>) — list it explicitly so the static build always
		// emits a real recap/index.html for GitHub Pages to serve.
		prerender: { entries: ['*', '/recap'] }
	}
};

export default config;
