// Shareable endgame recap: packs the finished game's stats, turning points,
// and everything needed to replay the turning-point mini maps into a
// URL-fragment-safe base64 blob, so a link reproduces the post-game summary
// screen with no server and no access to the original browser's localStorage
// save. The map itself is NOT embedded — `seed` regenerates the exact same
// GameMap via generateMap() (see map.ts), which keeps the link short even
// for a long, event-heavy game. The seed also packs difficulty/startingArmies
// /debug settings (see map.ts's encodeSeed/decodeSeedSettings), so a "play
// this map" link built from just `seed` reproduces the same rules too —
// RecapData doesn't need to carry them separately.
import type { ConquestEvent, EdgeEvent, HexArmyDelta, Player, PlayerStats, TurnSnapshot } from './game';
import type { TurningPoint } from './summary';

export interface RecapTurningPoint {
	turn: number;
	delta: number;
	territoriesAfter: number;
	armyDelta: number;
	headline: string;
	isFinal: boolean;
}

export interface RecapData {
	seed: string;
	winner: Player | null;
	turn: number;
	turningPoints: RecapTurningPoint[];
	history: TurnSnapshot[];
	stats: Record<Player, PlayerStats>;
	// Enough of the final GameState to drive reconstructOwnersAtTurn /
	// reconstructEdgesAtTurn (see summary.ts) against a regenerated map.
	finalOwners: (Player | null)[];
	conquests: ConquestEvent[];
	edgeEvents: EdgeEvent[];
	hexArmyDeltas: HexArmyDelta[];
	finalWalls: [number, number][];
	finalSeaLanes: [number, number][];
}

export function buildRecap(params: {
	seed: string;
	winner: Player | null;
	turn: number;
	turningPoints: TurningPoint[];
	history: TurnSnapshot[];
	stats: Record<Player, PlayerStats>;
	finalOwners: (Player | null)[];
	conquests: ConquestEvent[];
	edgeEvents: EdgeEvent[];
	hexArmyDeltas: HexArmyDelta[];
	finalWalls: [number, number][];
	finalSeaLanes: [number, number][];
}): RecapData {
	return {
		...params,
		turningPoints: params.turningPoints.map(({ turn, delta, territoriesAfter, armyDelta, headline, isFinal }) => ({
			turn,
			delta,
			territoriesAfter,
			armyDelta,
			headline,
			isFinal
		}))
	};
}

function base64UrlEncode(bytes: Uint8Array): string {
	let bin = '';
	bytes.forEach((b) => (bin += String.fromCharCode(b)));
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded: string): Uint8Array {
	const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
	const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
	const bin = atob(b64 + pad);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

async function readAllChunks(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) { out.set(c, offset); offset += c.length; }
	return out;
}

function gzipSupported(): boolean {
	return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const cs = new CompressionStream('gzip');
	const writer = cs.writable.getWriter();
	void writer.write(bytes as BufferSource).then(() => writer.close());
	return readAllChunks(cs.readable);
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream('gzip');
	const writer = ds.writable.getWriter();
	void writer.write(bytes as BufferSource).then(() => writer.close());
	return readAllChunks(ds.readable);
}

// The turning-points/conquests/history arrays repeat the same handful of
// JSON keys hundreds of times over a long game, so gzip shrinks the payload
// dramatically (routinely 5-10x) before it ever hits base64 (which itself
// inflates size ~33%). A single-char prefix makes the format self-describing
// so decode doesn't need to guess: 'z' = gzip-compressed, 'r' = raw JSON
// (fallback for browsers without Compression Streams — Safari <16.4 etc).
export async function encodeRecap(data: RecapData): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(data));
	if (gzipSupported()) {
		try {
			return 'z' + base64UrlEncode(await gzip(bytes));
		} catch {
			// fall through to raw
		}
	}
	return 'r' + base64UrlEncode(bytes);
}

export async function decodeRecap(encoded: string): Promise<RecapData | null> {
	try {
		const format = encoded[0];
		const bytes = base64UrlDecode(encoded.slice(1));
		const jsonBytes = format === 'z' ? await gunzip(bytes) : bytes;
		return JSON.parse(new TextDecoder().decode(jsonBytes)) as RecapData;
	} catch {
		return null;
	}
}
