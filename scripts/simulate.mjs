#!/usr/bin/env node
// Headless AI-vs-AI simulation runner. Loads the same JS bundle the iOS app
// hosts in JavaScriptCore and drives it directly in Node — no browser, no
// SwiftUI. Useful for bulk self-play data collection or AI regression checks.
//
// Each game is CPU-bound and independent, so games are spread across worker
// threads (one JS engine instance per thread) rather than running serially
// on a single core. The main thread never simulates games itself — it just
// spawns workers, aggregates their results, and renders the dashboard.
//
// Usage:
//   npm run build:ios-bridge   # regenerate the bundle after any src/lib change
//   node scripts/simulate.mjs [numGames] [difficulty] [startingArmies]
//   node scripts/simulate.mjs -c [difficulty] [startingArmies]   # run until Ctrl-C
//   node scripts/simulate.mjs 500 2 3 --log ./training-data      # + ML training log
//
// --log <dir>               write one gzipped JSONL shard per `--shard-games` games to <dir>
// --shard-games <n>         games per shard file, per worker (default 500)
// --workers <n>             parallel worker threads (default: cpu count - 1)
// --value-net-players <l>   comma-separated players (e.g. "blue,green") whose attack
//                           choices use the trained value net instead of the hand-tuned
//                           heuristic -- pits the two policies head-to-head in one game.
//                           e.g. node scripts/simulate.mjs 500 2 3 --value-net-players blue
//
// Log resolution: one record per player-turn (board state before that turn),
// not per placement/attack/roll. `runAiTurn()` executes a whole turn
// atomically inside the JS engine, so per-action granularity isn't visible
// from here anyway — and turn-level snapshots are what a value/position
// evaluator needs (state -> eventual winner), without the 10-50x blowup of
// logging every intermediate action.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import pc from 'picocolors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bundlePath = path.join(__dirname, '../ios/IsleWars/Resources/game-bundle.js');
const PLAYERS_ORDER = ['blue', 'green', 'red', 'brown'];
const MAX_TURNS_PER_GAME = 3000; // safety valve against a stalemate looping forever

// ---------------------------------------------------------------------------
// Core game loop — runs `numGames` games (Infinity for "until told to stop")
// and reports results via `onEvent`. Shared by both the worker-thread path
// and the (rare) single-worker path; identical logic either way.
// ---------------------------------------------------------------------------
// A tight synchronous loop never gives this thread's event loop a chance to
// run, so a pending `stop` postMessage (or, single-threaded, a pending
// SIGINT) would sit undelivered until the whole run finished — never, in
// `-c` mode. Yielding via setImmediate after each game keeps it interruptible.
const yieldToEventLoop = () => new Promise((r) => setImmediate(r));

async function runGames({ numGames, difficulty, startingArmies, logDir, shardGames, runId, tag, valueNetPlayers, shouldStop, onEvent }) {
	(0, eval)(readFileSync(bundlePath, 'utf8'));
	const IsleWars = globalThis.IsleWars;
	if (valueNetPlayers && valueNetPlayers.length) {
		IsleWars.setValueNetPlayers(JSON.stringify(valueNetPlayers));
	}

	if (logDir) mkdirSync(logDir, { recursive: true });
	let shardIndex = 0;
	let shardLines = [];
	let gamesInShard = 0;

	function flushShard() {
		if (!logDir || shardLines.length === 0) return;
		const file = path.join(logDir, `sim-${runId}-${tag}-${String(shardIndex).padStart(4, '0')}.jsonl.gz`);
		writeFileSync(file, gzipSync(Buffer.from(shardLines.join('\n') + '\n')));
		onEvent({ type: 'shard', file, records: shardLines.length, games: gamesInShard });
		shardLines = [];
		gamesInShard = 0;
		shardIndex++;
	}

	function turnSnapshot(gameId, state) {
		return {
			type: 'turn',
			game_id: gameId,
			turn: state.turn,
			actor: state.current,
			difficulty,
			starting_armies: startingArmies,
			owners: state.states.map((st) => st.owner ?? null),
			armies: state.states.map((st) => st.armies),
			terrain: state.map.grids.map((g) => g.terrain),
			production: state.map.grids.map((g) => (g.production ? 1 : 0)),
			hands: state.hands,
			alive: state.alive
		};
	}

	for (let i = 0; i < numGames && !shouldStop(); i++) {
		const gameId = `${runId}-${tag}-${i}`;
		IsleWars.startGame(difficulty, startingArmies);
		let state = JSON.parse(IsleWars.getState());

		const gameRecords = [];
		let ticks = 0;
		while (state.phase !== 'game_over' && ticks++ < MAX_TURNS_PER_GAME) {
			if (logDir) gameRecords.push(turnSnapshot(gameId, state));
			IsleWars.runAiTurn(state.current);
			state = JSON.parse(IsleWars.getState());
		}

		const winner = state.winner ?? 'none/timeout';

		if (logDir) {
			for (const rec of gameRecords) {
				rec.winner = winner;
				rec.final_turn = state.turn;
				shardLines.push(JSON.stringify(rec));
			}
			shardLines.push(JSON.stringify({ type: 'game_end', game_id: gameId, winner, final_turn: state.turn, difficulty, starting_armies: startingArmies }));
			gamesInShard++;
			if (gamesInShard >= shardGames) flushShard();
		}

		onEvent({ type: 'game', winner, turns: state.turn });
		await yieldToEventLoop();
	}

	flushShard();
}

// ---------------------------------------------------------------------------
// Worker entry point: simulate this worker's share of games, report each
// game/shard back to the main thread over the message port.
// ---------------------------------------------------------------------------
if (!isMainThread) {
	let stopRequested = false;
	parentPort.on('message', (msg) => {
		if (msg.type === 'stop') stopRequested = true;
	});

	await runGames({
		...workerData,
		shouldStop: () => stopRequested,
		onEvent: (event) => parentPort.postMessage(event)
	});

	parentPort.postMessage({ type: 'exit' });
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Main thread: parse args, spawn workers, aggregate + render.
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);
const continuous = rawArgs.includes('-c');

function flagValue(name, def) {
	const idx = rawArgs.indexOf(name);
	return idx !== -1 ? rawArgs[idx + 1] : def;
}
const logDir = flagValue('--log', null);
const shardGames = Number(flagValue('--shard-games', 500));
const defaultWorkers = Math.max(1, os.cpus().length - 1);
const workerCount = Number(flagValue('--workers', defaultWorkers));
const valueNetPlayers = (flagValue('--value-net-players', '') || '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

const consumedFlags = new Set(['--log', '--shard-games', '--workers', '--value-net-players']);
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
	const a = rawArgs[i];
	if (a === '-c') continue;
	if (consumedFlags.has(a)) { i++; continue; }
	positional.push(a);
}

const numGames = continuous ? Infinity : Number(positional[0] ?? 100);
const difficulty = Number(positional[continuous ? 0 : 1] ?? 2);
const startingArmies = Number(positional[continuous ? 1 : 2] ?? 3);

const wins = {};
const turnCounts = [];
const startedAt = Date.now();
let played = 0;
let shardsWritten = 0;

const PLAYER_COLOR = { blue: pc.blue, green: pc.green, red: pc.red, brown: pc.yellow };
const BAR_WIDTH = 30;
const isTTY = Boolean(process.stdout.isTTY);
let liveLines = 0;

function fmtDuration(sec) {
	if (!Number.isFinite(sec)) return '--:--';
	const s = Math.max(0, Math.round(sec));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = s % 60;
	return h > 0
		? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
		: `${m}:${String(ss).padStart(2, '0')}`;
}

// Marks that something not part of the live dashboard block (e.g. a "wrote
// shard" line) was just printed as a normal scrolling line, so the next
// dashboard render appends fresh instead of erasing it.
function noteScrollingLine() {
	liveLines = 0;
}

function renderDashboard(final = false) {
	const elapsedSec = (Date.now() - startedAt) / 1000;
	const avgTurns = turnCounts.reduce((a, b) => a + b, 0) / (turnCounts.length || 1);
	const minTurns = turnCounts.length ? Math.min(...turnCounts) : 0;
	const maxTurns = turnCounts.length ? Math.max(...turnCounts) : 0;
	const gamesPerSec = played / (elapsedSec || 1);
	const totalWins = Object.values(wins).reduce((a, b) => a + b, 0);
	const maxWinCount = Math.max(1, ...Object.values(wins));

	const lines = [];
	lines.push(pc.bold(final ? '=== final results ===' : '--- isle wars simulation ---'));
	lines.push(`workers: ${workerCount}   games: ${pc.bold(String(played))}${continuous ? '' : `/${numGames}`}   elapsed: ${fmtDuration(elapsedSec)}   ${gamesPerSec.toFixed(2)} games/s`);
	if (!continuous && Number.isFinite(numGames)) {
		lines.push(`eta: ${fmtDuration((numGames - played) / (gamesPerSec || 1))}`);
	}
	lines.push(`turns/game: avg ${avgTurns.toFixed(1)}  (min ${minTurns}, max ${maxTurns})`);
	lines.push('');
	for (const p of PLAYERS_ORDER) {
		const count = wins[p] ?? 0;
		const pct = totalWins ? (count / totalWins) * 100 : 0;
		const barLen = Math.round((count / maxWinCount) * BAR_WIDTH);
		const bar = '█'.repeat(barLen).padEnd(BAR_WIDTH, '·');
		const colorize = PLAYER_COLOR[p] ?? ((s) => s);
		lines.push(`  ${p.padEnd(6)} ${colorize(bar)} ${String(count).padStart(4)}  (${pct.toFixed(1)}%)`);
	}
	for (const key of Object.keys(wins)) {
		if (PLAYERS_ORDER.includes(key)) continue;
		lines.push(`  ${key.padEnd(6)} ${String(wins[key]).padStart(4)}`);
	}
	if (valueNetPlayers.length) {
		const valueNetWins = valueNetPlayers.reduce((sum, p) => sum + (wins[p] ?? 0), 0);
		const heuristicWins = totalWins - valueNetWins;
		lines.push('');
		lines.push(`policy: value-net (${valueNetPlayers.join(',')}) ${valueNetWins}  vs  heuristic ${heuristicWins}`);
	}
	if (logDir) {
		lines.push('');
		lines.push(`log: ${shardsWritten} shard(s) written -> ${logDir}`);
	}

	const output = lines.join('\n');
	if (isTTY && !final) {
		if (liveLines > 0) process.stdout.write(`\x1b[${liveLines}A\x1b[0J`);
		process.stdout.write(output + '\n');
		liveLines = lines.length + 1;
	} else {
		console.log(output);
		liveLines = 0;
	}
}

const runId = Date.now().toString(36);
const base = Number.isFinite(numGames) ? Math.floor(numGames / workerCount) : Infinity;
const remainder = Number.isFinite(numGames) ? numGames % workerCount : 0;

let stopRequested = false;
const workers = [];
let exitedCount = 0;

function handleWorkerEvent(event) {
	if (event.type === 'game') {
		wins[event.winner] = (wins[event.winner] ?? 0) + 1;
		turnCounts.push(event.turns);
		played++;
		renderDashboard();
	} else if (event.type === 'shard') {
		shardsWritten++;
		console.log(`  wrote ${event.file} (${event.records} records, ${event.games} games)`);
		noteScrollingLine();
	}
}

for (let w = 0; w < workerCount; w++) {
	const games = Number.isFinite(numGames) ? base + (w < remainder ? 1 : 0) : Infinity;
	const worker = new Worker(__filename, {
		workerData: { numGames: games, difficulty, startingArmies, logDir, shardGames, runId, tag: `w${w}`, valueNetPlayers }
	});
	worker.on('message', (event) => {
		if (event.type === 'exit') {
			exitedCount++;
			if (exitedCount === workerCount) renderDashboard(true);
		} else {
			handleWorkerEvent(event);
		}
	});
	worker.on('error', (err) => console.error(`worker ${w} error:`, err));
	workers.push(worker);
}

if (continuous) {
	process.on('SIGINT', () => {
		if (stopRequested) process.exit(1); // second Ctrl-C: bail immediately
		stopRequested = true;
		console.log('\nStopping after the current games finish (Ctrl-C again to force-quit)...');
		noteScrollingLine();
		for (const w of workers) w.postMessage({ type: 'stop' });
	});
}
