import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOG_PATH = join(tmpdir(), 'isle-wars-events.jsonl');

/**
 * Dev-only middleware: POST /api/log appends a JSONL line to /tmp/isle-wars-events.jsonl,
 * DELETE /api/log clears it, GET /api/log returns the file contents. Handy for
 * capturing AI-vs-AI game traces you can analyze afterwards with jq, grep, etc.
 * Not included in the production static build.
 */
function isleWarsDevLogger() {
	return {
		name: 'isle-wars-dev-logger',
		configureServer(server: { middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void } }) {
			server.middlewares.use('/api/log', async (req: IncomingMessage, res: ServerResponse) => {
				try {
					if (req.method === 'POST') {
						const chunks: Uint8Array[] = [];
						for await (const c of req) chunks.push(c as Uint8Array);
						const body = Buffer.concat(chunks as Buffer[]).toString('utf8');
						let payload: unknown;
						try { payload = JSON.parse(body); } catch { payload = { raw: body }; }
						const line = JSON.stringify({ ts: new Date().toISOString(), ...(payload as object) }) + '\n';
						await fs.appendFile(LOG_PATH, line, 'utf8');
						res.setHeader('content-type', 'application/json');
						res.end(JSON.stringify({ ok: true, path: LOG_PATH }));
						return;
					}
					if (req.method === 'DELETE') {
						await fs.rm(LOG_PATH, { force: true });
						res.setHeader('content-type', 'application/json');
						res.end(JSON.stringify({ ok: true, path: LOG_PATH }));
						return;
					}
					if (req.method === 'GET') {
						try {
							const contents = await fs.readFile(LOG_PATH, 'utf8');
							res.setHeader('content-type', 'application/x-ndjson');
							res.end(contents);
						} catch {
							res.setHeader('content-type', 'application/x-ndjson');
							res.end('');
						}
						return;
					}
					res.statusCode = 405;
					res.end('Method not allowed');
				} catch (e) {
					res.statusCode = 500;
					res.end(String(e));
				}
			});
		}
	};
}

export default defineConfig({
	plugins: [sveltekit(), isleWarsDevLogger()]
});
