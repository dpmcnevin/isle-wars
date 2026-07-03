import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// GitHub Pages base path — must match the repo name so asset URLs resolve at
// https://<user>.github.io/<repo>/. Set to '' for a custom-domain deploy.
const dev = process.env.NODE_ENV === 'development';
const base = dev ? '' : '/isle-wars';

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
		prerender: { entries: ['*'] }
	}
};

export default config;
