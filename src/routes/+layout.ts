// Prerender the site to static HTML so it can be served from GitHub Pages.
export const prerender = true;
// No SSR — the app is fully client-side once loaded, and localStorage access
// is guarded so prerender can still generate the HTML shell.
export const ssr = true;
export const trailingSlash = 'always';
