import polygonClipping from 'polygon-clipping';

export interface Island {
	id: number;
	name: string;
	value: number;
	center: [number, number];
	labelPos: [number, number]; // where to render the name/value label (in the water outside the island)
	shape: [number, number][]; // outline of the union of member hexes
}

export type Terrain = 'plain' | 'mountain' | 'forest' | 'marsh';

export interface Grid {
	id: number;
	island: number;
	x: number;
	y: number;
	production: boolean;
	terrain: Terrain;
	cityName?: string; // set on production-center hexes
	cell: [number, number][]; // hex polygon (6 vertices)
}

export interface GameMap {
	islands: Island[];
	grids: Grid[];
	adj: number[][];
	seaLanes: [number, number][];
	waterHexes: [number, number][][]; // hex polygons for unassigned (water) cells
	width: number;
	height: number;
	viewBox: { x: number; y: number; w: number; h: number }; // tight bbox around land
	winThreshold: number;
}

export function mulberry32(a: number) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ISLAND_NAMES = [
	'Iceland', 'Norvalia', 'Ardmark', 'Cordania', 'Vestros', 'Suriath',
	'Halon', 'Meridian', 'Southaven', 'Thraxos', 'Kell', 'Aramoor',
	'Braedon', 'Cyrus', 'Drakos', 'Emberly', 'Fjord', 'Grangar', 'Havel',
	'Ilyria', 'Jorvik', 'Kastros', 'Lyonesse', 'Mordant', 'Nordvale',
	'Olthar', 'Perendor', 'Quel', 'Rhesk', 'Skalgard', 'Tomarra',
	'Ulvra', 'Varn', 'Wistmere', 'Xanthos', 'Ymir', 'Zoraya',
	'Ashenshore', 'Blackreach', 'Coldwater', 'Duskholme', 'Elderfell',
	'Frostholt', 'Galewind', 'Highmoor', 'Ironvale', 'Jadecoast',
	'Krayvern', 'Lorewick', 'Mistrend', 'Nightshoal', 'Oakenreach',
	'Palewater', 'Ravenholt', 'Silvercrest', 'Tidesworn', 'Umbervale'
];

const CITY_NAMES = [
	'Highkeep', 'Ironhold', 'Silverport', 'Redwater', 'Blackfen',
	'Goldbridge', 'Whitewall', 'Greyhaven', 'Fairmount', 'Westport',
	'Eastwatch', 'Oldstone', 'Ravenmoor', 'Stormcrest', 'Sunspire',
	'Wolfsburg', 'Frostmere', 'Ashford', 'Thornwick', 'Elmshade',
	'Copperfall', 'Duskvale', 'Emberhold', 'Ironclad', 'Kingsreach',
	'Longbarrow', 'Marshend', 'Northgate', 'Oakenshield', 'Pinehollow',
	'Quarryhill', 'Riverrun', 'Stonemill', 'Tidewater', 'Umberwood',
	'Valeholm', 'Winterport', 'Yellowvale', 'Zephyr', 'Amberfield',
	'Bleakstone', 'Cedarhold', 'Dawnfort', 'Ebonvale', 'Farhaven',
	'Glassford', 'Harrowdeep', 'Ivorygate', 'Jasperfall', 'Kalebridge',
	'Larkspur', 'Millbrook', 'Newhaven', 'Ostmarsh', 'Pyremouth',
	'Quicksilver', 'Rathmoor', 'Saltmere', 'Twinbridges', 'Underhill',
	'Vaultspire', 'Windborne', 'Yewwood', 'Zennora', 'Ambersreach',
	'Brackenford', 'Cinderhold', 'Dragonspur', 'Everwatch', 'Frostgate',
	'Grimford', 'Hollowdale', 'Illmoor', 'Jadegate', 'Kestrelfall',
	'Lightreach', 'Moonvale', 'Nightshade', 'Osprey', 'Pinehaven',
	'Quinnsport', 'Rooksmere', 'Stormhold', 'Thornfell', 'Ustralia'
];

// -----------------------------------------------------------------------------
// Pointy-top hex grid using odd-r offset coordinates.
// s = side length (also circumradius). w = √3·s, h = 2·s. Row-spacing = 1.5·s.
// -----------------------------------------------------------------------------

interface Hex {
	col: number;
	row: number;
	x: number;
	y: number;
	poly: [number, number][];
}

function hexPolygon(cx: number, cy: number, s: number): [number, number][] {
	const pts: [number, number][] = [];
	for (let i = 0; i < 6; i++) {
		const a = ((60 * i - 30) * Math.PI) / 180;
		pts.push([cx + s * Math.cos(a), cy + s * Math.sin(a)]);
	}
	return pts;
}

function buildHexGrid(width: number, height: number, s: number): Hex[][] {
	const w = Math.sqrt(3) * s;
	const rowH = 1.5 * s;
	// Ensure the entire hex (which extends ±w/2 horizontally and ±s vertically
	// from its center) fits inside the canvas at every position/parity.
	const rows = Math.floor((height - 2 * s) / rowH) + 1;
	const cols = Math.floor((width - w / 2) / w);
	const grid: Hex[][] = [];
	for (let r = 0; r < rows; r++) {
		const rowArr: Hex[] = [];
		for (let c = 0; c < cols; c++) {
			const x = w * c + (r % 2) * (w / 2) + w / 2;
			const y = rowH * r + s;
			rowArr.push({ col: c, row: r, x, y, poly: hexPolygon(x, y, s) });
		}
		grid.push(rowArr);
	}
	return grid;
}

// Odd-r offset neighbors: 6 hex neighbors depending on row parity.
function hexNeighbors(col: number, row: number): [number, number][] {
	if (row % 2 === 0) {
		return [
			[col - 1, row], [col + 1, row],
			[col - 1, row - 1], [col, row - 1],
			[col - 1, row + 1], [col, row + 1]
		];
	}
	return [
		[col - 1, row], [col + 1, row],
		[col, row - 1], [col + 1, row - 1],
		[col, row + 1], [col + 1, row + 1]
	];
}

function inBounds(grid: Hex[][], col: number, row: number): boolean {
	return row >= 0 && row < grid.length && col >= 0 && col < grid[0].length;
}

// -----------------------------------------------------------------------------
// Island growth. Given a seed hex, BFS outward, randomly claiming neighbors
// while (a) staying below a target size and (b) not overlapping other islands.
// Random claim order + rejection produces irregular multi-lobed shapes.
// -----------------------------------------------------------------------------

interface Growth {
	islandId: number;
	value: number;
	name: string;
	target: number;
	claimed: Set<string>;
}

function hexKey(c: number, r: number) { return `${c},${r}`; }

function growIsland(
	grid: Hex[][],
	claimedBy: Map<string, number>,
	seed: [number, number],
	target: number,
	islandId: number,
	rnd: () => number
): Set<string> {
	const claimed = new Set<string>();
	const frontier: [number, number][] = [];
	const [sc, sr] = seed;
	if (claimedBy.has(hexKey(sc, sr))) return claimed;
	// Refuse the seed itself if it's already adjacent to another island.
	for (const [nc, nr] of hexNeighbors(sc, sr)) {
		const owner = claimedBy.get(hexKey(nc, nr));
		if (owner != null && owner !== islandId) return claimed;
	}
	claimed.add(hexKey(sc, sr));
	claimedBy.set(hexKey(sc, sr), islandId);
	for (const [nc, nr] of hexNeighbors(sc, sr)) {
		if (inBounds(grid, nc, nr) && !claimedBy.has(hexKey(nc, nr))) {
			frontier.push([nc, nr]);
		}
	}
	while (claimed.size < target && frontier.length > 0) {
		// Pick a random frontier hex (not FIFO) → jagged, non-circular growth.
		const idx = Math.floor(rnd() * frontier.length);
		const [c, r] = frontier[idx];
		frontier[idx] = frontier[frontier.length - 1];
		frontier.pop();
		const k = hexKey(c, r);
		if (claimedBy.has(k)) continue;
		// Water-buffer rule: reject any hex that touches a different island.
		let touchesOther = false;
		for (const [nc, nr] of hexNeighbors(c, r)) {
			const owner = claimedBy.get(hexKey(nc, nr));
			if (owner != null && owner !== islandId) { touchesOther = true; break; }
		}
		if (touchesOther) continue;
		claimed.add(k);
		claimedBy.set(k, islandId);
		for (const [nc, nr] of hexNeighbors(c, r)) {
			const nk = hexKey(nc, nr);
			if (inBounds(grid, nc, nr) && !claimedBy.has(nk)) {
				frontier.push([nc, nr]);
			}
		}
	}
	return claimed;
}

// -----------------------------------------------------------------------------
// Union all hex polygons of an island into a single outline polygon so we can
// draw a coastline on top of the territory hexes.
// -----------------------------------------------------------------------------

function unionHexes(hexes: Hex[]): [number, number][] {
	if (hexes.length === 0) return [];
	if (hexes.length === 1) return hexes[0].poly;
	let acc: [number, number][][][] = [[[...hexes[0].poly, hexes[0].poly[0]]]];
	for (let i = 1; i < hexes.length; i++) {
		const h = hexes[i];
		const ring: [number, number][] = [...h.poly, h.poly[0]];
		try {
			acc = polygonClipping.union(acc as any, [[ring]] as any) as [number, number][][][];
		} catch {
			// Fall back to accumulator unchanged on numerical hiccups.
		}
	}
	// Pick the largest ring
	let best: [number, number][] = hexes[0].poly;
	let bestArea = 0;
	for (const poly of acc) {
		const ring = poly[0] as [number, number][];
		const a = Math.abs(polygonArea(ring));
		if (a > bestArea) { bestArea = a; best = ring; }
	}
	if (best.length > 1 && best[0][0] === best[best.length - 1][0] && best[0][1] === best[best.length - 1][1]) {
		best = best.slice(0, -1);
	}
	return best;
}

function polygonArea(poly: [number, number][]): number {
	let a = 0;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
	}
	return a / 2;
}

// -----------------------------------------------------------------------------
// Main generator
// -----------------------------------------------------------------------------

export function generateMap(seed: number = Math.floor(Math.random() * 1e9)): GameMap {
	const rnd = mulberry32(seed);
	const width = 1400;
	const height = 900;

	// Total territories per game is roughly fixed. Number of landmasses varies
	// (3..7); with fewer islands, each one grows much larger.
	const nIslands = 3 + Math.floor(rnd() * 5); // 3..7
	const TOTAL_TERRITORIES = 46 + Math.floor(rnd() * 10); // 46..55
	const MIN_PER_ISLAND = 3;

	// Distribute TOTAL_TERRITORIES across islands with random weights so some
	// landmasses become much larger than others. Every island gets at least
	// MIN_PER_ISLAND hexes.
	const targets: number[] = Array(nIslands).fill(MIN_PER_ISLAND);
	let remaining = TOTAL_TERRITORIES - nIslands * MIN_PER_ISLAND;
	// Skewed weights: raising rnd() to a power biases toward small values with
	// occasional large ones, producing a mix of small islets + a couple of huge
	// landmasses.
	const weights = Array.from({ length: nIslands }, () => Math.pow(rnd(), 1.8) + 0.15);
	const totalWeight = weights.reduce((a, b) => a + b, 0);
	for (let i = 0; i < nIslands; i++) {
		const share = Math.floor((weights[i] / totalWeight) * remaining);
		targets[i] += share;
	}
	// Fix rounding drift: any leftover tiles go to the biggest-weighted island.
	let drift = TOTAL_TERRITORIES - targets.reduce((a, b) => a + b, 0);
	while (drift > 0) {
		let bestIdx = 0;
		for (let i = 1; i < nIslands; i++) if (weights[i] > weights[bestIdx]) bestIdx = i;
		targets[bestIdx]++;
		weights[bestIdx] -= 0.05; // tiny tiebreak so we spread residual drift a bit
		drift--;
	}

	// Derive bonus values from territory counts (bigger islands = bigger bonus).
	const values = targets.map((c) => Math.max(2, Math.min(15, Math.round(c * 0.65))));

	const namePool = [...ISLAND_NAMES].sort(() => rnd() - 0.5);
	const totalTerritories = TOTAL_TERRITORIES;

	// Choose hex size so all territories fit at ~50% land coverage.
	// Hex area = 3·√3/2 · s². Total land area ≈ totalTerritories · hexArea.
	// Aim for landArea ≈ 0.55 · canvasArea → s = √(0.55 · W·H / (totalT · 2.6))
	const s = Math.max(30, Math.min(75, Math.sqrt((0.55 * width * height) / (totalTerritories * 2.6))));
	const hexGrid = buildHexGrid(width, height, s);
	const nRows = hexGrid.length;
	const nCols = hexGrid[0].length;

	// Distribute seeds evenly by partitioning the hex grid into `nIslands`
	// rectangular tiles and picking one random hex per tile. Guarantees the
	// map fills the whole canvas rather than clustering in one corner.
	interface Seed { islandIdx: number; col: number; row: number; }
	const orderedIslands = values
		.map((v, i) => ({ v, i, target: targets[i] }))
		.sort((a, b) => b.target - a.target);
	const tileCols = Math.max(1, Math.round(Math.sqrt(nIslands * (nCols / nRows))));
	const tileRows = Math.max(1, Math.ceil(nIslands / tileCols));
	// Shuffle tile indices so island-to-tile assignment is random.
	const tileOrder = Array.from({ length: tileCols * tileRows }, (_, i) => i).sort(() => rnd() - 0.5);
	const seeds: Seed[] = [];
	for (let idx = 0; idx < orderedIslands.length; idx++) {
		const isl = orderedIslands[idx];
		const tileIdx = tileOrder[idx];
		const tCol = tileIdx % tileCols;
		const tRow = Math.floor(tileIdx / tileCols);
		// Hex range for this tile
		const c0 = Math.floor((tCol * nCols) / tileCols);
		const c1 = Math.floor(((tCol + 1) * nCols) / tileCols);
		const r0 = Math.floor((tRow * nRows) / tileRows);
		const r1 = Math.floor(((tRow + 1) * nRows) / tileRows);
		// Pick a random hex inside the tile, biased toward the interior so
		// growth has room to expand within the tile.
		const col = Math.min(nCols - 1, Math.max(0, c0 + Math.floor(rnd() * Math.max(1, c1 - c0))));
		const row = Math.min(nRows - 1, Math.max(0, r0 + Math.floor(rnd() * Math.max(1, r1 - r0))));
		seeds.push({ islandIdx: isl.i, col, row });
	}

	// Grow each island.
	const claimedBy = new Map<string, number>(); // hexKey → islandIdx
	const islandHexes: Map<number, Hex[]> = new Map();
	// Grow in order: biggest first (matches seed ordering above so they get room).
	for (const isl of orderedIslands) {
		const seed = seeds.find((s2) => s2.islandIdx === isl.i)!;
		let claimed = growIsland(hexGrid, claimedBy, [seed.col, seed.row], targets[isl.i], isl.i, rnd);
		// If the primary seed rejected (its neighbors already touched another
		// island's water buffer), try nearby free hexes so we don't lose the
		// entire island. Search outward in expanding rings.
		if (claimed.size === 0) {
			outer: for (let radius = 1; radius <= 6; radius++) {
				for (let dr = -radius; dr <= radius; dr++) {
					for (let dc = -radius; dc <= radius; dc++) {
						if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
						const nc = seed.col + dc;
						const nr = seed.row + dr;
						if (!inBounds(hexGrid, nc, nr)) continue;
						if (claimedBy.has(hexKey(nc, nr))) continue;
						claimed = growIsland(hexGrid, claimedBy, [nc, nr], targets[isl.i], isl.i, rnd);
						if (claimed.size > 0) break outer;
					}
				}
			}
		}
		const hexes: Hex[] = [];
		for (const k of claimed) {
			const [c, r] = k.split(',').map(Number);
			hexes.push(hexGrid[r][c]);
		}
		islandHexes.set(isl.i, hexes);
	}

	// Build Islands and Grids.
	const islands: Island[] = [];
	const grids: Grid[] = [];
	// Map hexKey → grid id so we can build adjacency after.
	const hexToGrid = new Map<string, number>();
	for (let i = 0; i < nIslands; i++) {
		const hexes = islandHexes.get(i) ?? [];
		if (hexes.length === 0) continue;
		let sumX = 0, sumY = 0;
		for (const h of hexes) { sumX += h.x; sumY += h.y; }
		const cx = sumX / hexes.length;
		const cy = sumY / hexes.length;
		const shape = unionHexes(hexes);
		const islandId = islands.length + 1;
		islands.push({
			id: islandId,
			name: namePool[i] ?? `Isle ${i + 1}`,
			value: values[i],
			center: [cx, cy],
			labelPos: [cx, cy], // computed below once all islands are placed
			shape
		});
		for (const h of hexes) {
			const gridId = grids.length;
			hexToGrid.set(hexKey(h.col, h.row), gridId);
			grids.push({
				id: gridId,
				island: islandId,
				x: h.x,
				y: h.y,
				production: rnd() < 0.22,
				terrain: 'plain',
				cell: h.poly
			});
		}
	}

	// Adjacency: within-island by hex neighborship.
	const adj: number[][] = grids.map(() => []);
	for (let gid = 0; gid < grids.length; gid++) {
		const g = grids[gid];
		// find hex by grid position — reverse lookup via col/row from stored hex.
		// We stashed by hexToGrid; iterate neighbors of this grid's underlying hex.
		// To find col/row, we need to know it — pull from hexes-in-island.
	}
	// Simpler: iterate the map from hexKey → gridId
	for (const [key, gid] of hexToGrid) {
		const [c, r] = key.split(',').map(Number);
		for (const [nc, nr] of hexNeighbors(c, r)) {
			const nk = hexKey(nc, nr);
			const ngid = hexToGrid.get(nk);
			if (ngid == null) continue;
			if (grids[gid].island !== grids[ngid].island) continue;
			if (gid < ngid) {
				adj[gid].push(ngid);
				adj[ngid].push(gid);
			}
		}
	}

	// Cross-island sea lanes: for each island, connect to its 2 nearest neighbor
	// islands via the closest hex pair. Ensures global connectivity.
	const seaLanes: [number, number][] = [];
	function addLane(a: number, b: number) {
		if (a === b) return;
		if (seaLanes.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) return;
		seaLanes.push([a, b]);
		if (!adj[a].includes(b)) adj[a].push(b);
		if (!adj[b].includes(a)) adj[b].push(a);
	}
	function nearestCross(iA: Island, iB: Island): [number, number] | null {
		const gsA = grids.filter((g) => g.island === iA.id);
		const gsB = grids.filter((g) => g.island === iB.id);
		if (gsA.length === 0 || gsB.length === 0) return null;
		let best: [number, number] = [gsA[0].id, gsB[0].id];
		let bestD = Infinity;
		for (const a of gsA) for (const b of gsB) {
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			if (d < bestD) { bestD = d; best = [a.id, b.id]; }
		}
		return best;
	}
	for (const isl of islands) {
		const others = islands
			.filter((o) => o.id !== isl.id)
			.map((o) => ({ o, d: Math.hypot(o.center[0] - isl.center[0], o.center[1] - isl.center[1]) }))
			.sort((a, b) => a.d - b.d);
		for (const { o } of others.slice(0, 2)) {
			const cross = nearestCross(isl, o);
			if (cross) addLane(cross[0], cross[1]);
		}
	}
	// Guarantee connectivity across all islands
	function componentCheck(): boolean {
		if (islands.length === 0) return true;
		const seen = new Set<number>([islands[0].id]);
		const stk = [islands[0].id];
		while (stk.length) {
			const cur = stk.pop()!;
			for (const g of grids.filter((x) => x.island === cur)) {
				for (const n of adj[g.id]) {
					const nIsl = grids[n].island;
					if (!seen.has(nIsl)) { seen.add(nIsl); stk.push(nIsl); }
				}
			}
		}
		return seen.size === islands.length;
	}
	let safety = 0;
	while (!componentCheck() && safety++ < 20) {
		const seen = new Set<number>([islands[0].id]);
		const stk = [islands[0].id];
		while (stk.length) {
			const cur = stk.pop()!;
			for (const g of grids.filter((x) => x.island === cur)) {
				for (const n of adj[g.id]) {
					const nIsl = grids[n].island;
					if (!seen.has(nIsl)) { seen.add(nIsl); stk.push(nIsl); }
				}
			}
		}
		const inside = islands.filter((i) => seen.has(i.id));
		const outside = islands.filter((i) => !seen.has(i.id));
		let bestPair: [Island, Island, number] = [inside[0], outside[0], Infinity];
		for (const a of inside) for (const b of outside) {
			const d = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]);
			if (d < bestPair[2]) bestPair = [a, b, d];
		}
		const cross = nearestCross(bestPair[0], bestPair[1]);
		if (!cross) break;
		addLane(cross[0], cross[1]);
	}

	// Mountain ranges: for each island with ≥3 hexes, ~45% chance to seed a
	// mountain range of 2..4 connected hexes. Mountain defenders get +1 to
	// their die roll.
	for (const isl of islands) {
		const gs = grids.filter((g) => g.island === isl.id);
		if (gs.length < 3) continue;
		if (rnd() >= 0.45) continue;
		const start = gs[Math.floor(rnd() * gs.length)];
		const rangeSize = 2 + Math.floor(rnd() * 3); // 2..4
		const range = new Set<number>([start.id]);
		const frontier: number[] = [start.id];
		while (range.size < rangeSize && frontier.length > 0) {
			const cur = frontier.shift()!;
			const neighbors = adj[cur].filter((n) => grids[n].island === isl.id && !range.has(n));
			if (neighbors.length === 0) continue;
			const pick = neighbors[Math.floor(rnd() * neighbors.length)];
			range.add(pick);
			frontier.push(pick);
		}
		for (const id of range) grids[id].terrain = 'mountain';
	}

	// Forests: for each island with ≥3 hexes and no mountain (or 50% chance
	// otherwise), grow a 2..4-hex forest cluster of PLAIN hexes.
	for (const isl of islands) {
		const gs = grids.filter((g) => g.island === isl.id);
		if (gs.length < 3) continue;
		const hasMountain = gs.some((g) => g.terrain === 'mountain');
		if (hasMountain && rnd() >= 0.5) continue;
		if (!hasMountain && rnd() >= 0.6) continue;
		const plains = gs.filter((g) => g.terrain === 'plain');
		if (plains.length === 0) continue;
		const start = plains[Math.floor(rnd() * plains.length)];
		const rangeSize = 2 + Math.floor(rnd() * 3);
		const range = new Set<number>([start.id]);
		const frontier: number[] = [start.id];
		while (range.size < rangeSize && frontier.length > 0) {
			const cur = frontier.shift()!;
			const neighbors = adj[cur].filter(
				(n) => grids[n].island === isl.id && !range.has(n) && grids[n].terrain === 'plain'
			);
			if (neighbors.length === 0) continue;
			const pick = neighbors[Math.floor(rnd() * neighbors.length)];
			range.add(pick);
			frontier.push(pick);
		}
		for (const id of range) grids[id].terrain = 'forest';
	}

	// Marshes: rarer than forests. 30% chance per island. Marsh hexes can't
	// launch a second attack in the same turn after being used as a source.
	for (const isl of islands) {
		const gs = grids.filter((g) => g.island === isl.id);
		if (gs.length < 4) continue;
		if (rnd() >= 0.3) continue;
		const plains = gs.filter((g) => g.terrain === 'plain');
		if (plains.length === 0) continue;
		const start = plains[Math.floor(rnd() * plains.length)];
		const rangeSize = 1 + Math.floor(rnd() * 3); // 1..3
		const range = new Set<number>([start.id]);
		const frontier: number[] = [start.id];
		while (range.size < rangeSize && frontier.length > 0) {
			const cur = frontier.shift()!;
			const neighbors = adj[cur].filter(
				(n) => grids[n].island === isl.id && !range.has(n) && grids[n].terrain === 'plain'
			);
			if (neighbors.length === 0) continue;
			const pick = neighbors[Math.floor(rnd() * neighbors.length)];
			range.add(pick);
			frontier.push(pick);
		}
		for (const id of range) grids[id].terrain = 'marsh';
	}

	// Assign a unique city name to every production-center hex.
	const cityPool = [...CITY_NAMES].sort(() => rnd() - 0.5);
	let cityIdx = 0;
	for (const g of grids) {
		if (g.production) {
			g.cityName = cityPool[cityIdx % cityPool.length];
			cityIdx++;
		}
	}

	// Choose a label position for each island: a spot in the water just
	// outside its bounding box. Prefer above; fall back to below, left, right
	// if above would run off the canvas or collide with another island.
	// Label positioning: put each label on a hex-vertex where multiple island
	// hexes meet (an intersection point). Prefer interior vertices (3 island
	// hexes meet) over border vertices (2 island hexes + water). Sitting on a
	// vertex means the label lands between hex centers, not on a city name.
	for (const isl of islands) {
		const gs = grids.filter((g) => g.island === isl.id);
		if (gs.length === 0) { isl.labelPos = isl.center; continue; }
		let sx = 0, sy = 0;
		for (const g of gs) { sx += g.x; sy += g.y; }
		const cx = sx / gs.length;
		const cy = sy / gs.length;
		if (gs.length === 1) {
			// Single-hex island: put the label at the top of the hex above the
			// army badge so both are visible.
			isl.labelPos = [gs[0].x, gs[0].y - 34];
			continue;
		}
		// Group hex vertices by rounded coordinates so shared vertices collapse.
		const vertexHits = new Map<string, { x: number; y: number; count: number; productionAdj: number }>();
		for (const g of gs) {
			for (const [vx, vy] of g.cell) {
				const key = `${Math.round(vx * 10)},${Math.round(vy * 10)}`;
				const entry = vertexHits.get(key);
				if (entry) {
					entry.count++;
					if (g.production) entry.productionAdj++;
				} else {
					vertexHits.set(key, { x: vx, y: vy, count: 1, productionAdj: g.production ? 1 : 0 });
				}
			}
		}
		// Score: higher count = better (interior). Penalize production adjacency
		// so the label doesn't get placed next to a city name. Prefer close to centroid.
		let best: { x: number; y: number } | null = null;
		let bestScore = -Infinity;
		for (const v of vertexHits.values()) {
			if (v.count < 2) continue; // coastline vertex — skip
			const dist = Math.hypot(v.x - cx, v.y - cy);
			const score = v.count * 100 - dist - v.productionAdj * 40;
			if (score > bestScore) { bestScore = score; best = v; }
		}
		isl.labelPos = best ? [best.x, best.y] : [cx, cy];
	}

	// Water hexes: every hex cell in the grid not claimed by any island.
	const waterHexes: [number, number][][] = [];
	for (let r = 0; r < hexGrid.length; r++) {
		for (let c = 0; c < hexGrid[r].length; c++) {
			if (!claimedBy.has(hexKey(c, r))) {
				waterHexes.push(hexGrid[r][c].poly);
			}
		}
	}

	// Compute a tight viewBox around the actual land, plus a small water margin,
	// so the SVG doesn't render huge empty regions where no island grew.
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const g of grids) {
		for (const [px, py] of g.cell) {
			if (px < minX) minX = px;
			if (px > maxX) maxX = px;
			if (py < minY) minY = py;
			if (py > maxY) maxY = py;
		}
	}
	if (!isFinite(minX)) {
		// Fallback if there are no grids (shouldn't happen).
		minX = 0; minY = 0; maxX = width; maxY = height;
	}
	const waterMargin = Math.max(60, s * 1.5); // ~1.5 hex of water on each side
	const vbX = Math.max(0, minX - waterMargin);
	const vbY = Math.max(0, minY - waterMargin);
	const vbW = Math.min(width, maxX + waterMargin) - vbX;
	const vbH = Math.min(height, maxY + waterMargin) - vbY;

	return {
		islands,
		grids,
		adj,
		seaLanes,
		waterHexes,
		width,
		height,
		viewBox: { x: vbX, y: vbY, w: vbW, h: vbH },
		winThreshold: Math.min(30, Math.floor(grids.length * 0.66))
	};
}

// Hex distance in axial coords derived from odd-r offsets.
function hexDistance(c1: number, r1: number, c2: number, r2: number): number {
	// Convert odd-r → cube
	const toCube = (c: number, r: number) => {
		const x = c - (r - (r & 1)) / 2;
		const z = r;
		const y = -x - z;
		return [x, y, z];
	};
	const [x1, y1, z1] = toCube(c1, r1);
	const [x2, y2, z2] = toCube(c2, r2);
	return (Math.abs(x1 - x2) + Math.abs(y1 - y2) + Math.abs(z1 - z2)) / 2;
}
