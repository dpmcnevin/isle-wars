import polygonClipping from 'polygon-clipping';

export interface Island {
	id: number;
	name: string;
	value: number;
	center: [number, number];
	labelPos: [number, number]; // where to render the name/value label (in the water outside the island)
	shape: [number, number][]; // outline of the union of member hexes
}

export type Terrain = 'plain' | 'mountain' | 'forest' | 'marsh' | 'desert';

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

export interface WaterFeature {
	kind: 'lake' | 'bay';
	name: string;
	center: [number, number];
	hexes: [number, number][][]; // polygons of the constituent hexes (for optional shading)
}

export interface GameMap {
	islands: Island[];
	grids: Grid[];
	adj: number[][];
	seaLanes: [number, number][];
	waterHexes: [number, number][][]; // hex polygons for unassigned (water) cells
	waterFeatures: WaterFeature[]; // named lakes and bays
	rivers: [number, number][]; // unordered land-land edge pairs (a < b)
	walls: [number, number][]; // Wall-card barriers on shared hex edges (a < b); block movement/attack across that edge
	width: number;
	height: number;
	viewBox: { x: number; y: number; w: number; h: number }; // tight bbox around land
	winThreshold: number;
}

/** True if the edge between two land hexes is a river. */
export function crossesRiver(map: GameMap, a: number, b: number): boolean {
	const lo = Math.min(a, b), hi = Math.max(a, b);
	for (const [x, y] of map.rivers) if (x === lo && y === hi) return true;
	return false;
}

/** True if a Wall barrier sits on the shared edge between two hexes, blocking
 *  all movement and attacks across it. Symmetric in a/b. */
export function wallBetween(map: GameMap, a: number, b: number): boolean {
	const walls = map.walls ?? [];
	const lo = Math.min(a, b), hi = Math.max(a, b);
	for (const [x, y] of walls) if (x === lo && y === hi) return true;
	return false;
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

/**
 * Fisher-Yates shuffle. `Array.prototype.sort(() => rnd() - 0.5)` is NOT a
 * uniform shuffle — it's biased by the sort algorithm's implementation
 * (V8's TimSort keeps runs of already-sorted elements more often than chance
 * would predict), which matters here because ownership/order assignment is
 * done by index over the shuffled array. Always use this instead.
 */
export function shuffle<T>(arr: T[], rnd: () => number): T[] {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
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
	'Palewater', 'Ravenholt', 'Silvercrest', 'Tidesworn', 'Umbervale',
	// Bloodborne locales
	'Yharnam', 'Cainhurst', 'Hemwick', 'Byrgenwerth', 'Yahargul',
	'Loran', 'Pthumeru', 'Isz', 'Mensis',
	// Elden Ring / Lands Between
	'Limgrave', 'Liurnia', 'Caelid', 'Altus', 'Gelmir', 'Farum',
	'Nokron', 'Nokstella', 'Mohgwyn', 'Miquella', 'Belurat',
	'Enir', 'Rauh', 'Scadu', 'Shaded', 'Consecrated', 'Weeping'
];

const LAKE_NAMES = [
	'Lake Windemere', 'Lake Arannor', 'Lake Braxis', 'Lake Corvain', 'Lake Duskwater',
	'Lake Elandra', 'Lake Fenweald', 'Lake Glasspool', 'Lake Havenreach', 'Lake Illuvar',
	'Lake Jaydeep', 'Lake Kelvor', 'Lake Loriath', 'Lake Miremere', 'Lake Nyxholm',
	'Lake Ozryn', 'Lake Palewinds', 'Lake Quivenmoor', 'Lake Ravensmere', 'Lake Sildereth',
	'Lake Tolvaris', 'Lake Umbra', 'Lake Vellum', 'Lake Wysprith', 'Lake Yshiro'
];

const BAY_NAMES = [
	'Amber Bay', 'Blackfin Bay', 'Coral Cove', 'Driftwood Bay', 'Emberfin Cove',
	'Falcon Bay', 'Gullhaven', 'Harborlight', 'Iron Bay', 'Jasper Cove',
	'Kelpline Bay', 'Longshore Bay', 'Moonwater Bay', 'Netherbay', 'Osprey Cove',
	'Pearl Bay', 'Quaystone Bay', 'Ravenwater', 'Silver Bay', 'Tempest Cove',
	'Umberbay', 'Voidwater Bay', 'Whalers\' Cove', 'Xebec Bay', 'Yellowsail Bay',
	'Zephyr Cove', 'Bay of Storms', 'Bay of Reeds', 'Bay of Whispers', 'Bay of Ashes'
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
	'Quinnsport', 'Rooksmere', 'Stormhold', 'Thornfell', 'Ustralia',
	// Bloodborne
	'Oedon Chapel', 'Old Yharnam', 'Hypogean Gaol', 'Iosefka Clinic',
	'Nightmare Frontier', 'Upper Cathedral', 'Hunter\'s Dream',
	'Forbidden Woods', 'Lecture Building', 'Fishing Hamlet',
	// Elden Ring
	'Stormveil', 'Raya Lucaria', 'Volcano Manor', 'Leyndell', 'Farum Azula',
	'Elphael', 'Haligtree', 'Sellia', 'Sofria', 'Redmane',
	'Roundtable Hold', 'Church of Marika', 'Bellum', 'Deeproot',
	'Mountaintops', 'Nokstella', 'Ainsel', 'Siofra', 'Rold', 'Ordina',
	'Belurat', 'Enir-Ilim', 'Rauh Base', 'Ancient Ruins', 'Bonny Village'
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

	const namePool = shuffle(ISLAND_NAMES, rnd);

	// Fixed hex size → the underlying hex grid is always the same dimensions,
	// regardless of how many territories a given seed asks for. Sized so an
	// 8×11 (~88 hex) grid comfortably fits the 46..55 land-territory range
	// plus surrounding water.
	const s = 70;
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
	const tileOrder = shuffle(Array.from({ length: tileCols * tileRows }, (_, i) => i), rnd);
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
	function pathInPoly(px: number, py: number, poly: [number, number][]): boolean {
		let inside = false;
		for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			const xi = poly[i][0], yi = poly[i][1];
			const xj = poly[j][0], yj = poly[j][1];
			if (((yi > py) !== (yj > py)) &&
				(px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
		}
		return inside;
	}
	function pathClearsOtherIslands(aId: number, bId: number): boolean {
		const a = grids[aId], b = grids[bId];
		const dx = b.x - a.x, dy = b.y - a.y;
		const dist = Math.hypot(dx, dy) || 1;
		const steps = Math.max(6, Math.ceil(dist / 15));
		const startT = 0.08, endT = 0.92;
		// Same curve the renderer draws — arc height 6% of length, up to 22px,
		// perpendicular, with a deterministic side from the endpoint ids.
		const arc = Math.min(22, dist * 0.06);
		const side = ((aId + bId) % 2 === 0) ? 1 : -1;
		const perpX = (-dy / dist) * arc * side;
		const perpY = (dx / dist) * arc * side;
		const midX = (a.x + b.x) / 2 + perpX;
		const midY = (a.y + b.y) / 2 + perpY;
		function pointClear(px: number, py: number): boolean {
			for (const g of grids) {
				if (g.id === aId || g.id === bId) continue;
				if (pathInPoly(px, py, g.cell)) return false;
			}
			return true;
		}
		for (let i = 0; i <= steps; i++) {
			const t = startT + (endT - startT) * (i / steps);
			// Straight-line sample
			if (!pointClear(a.x + dx * t, a.y + dy * t)) return false;
			// Quadratic Bezier sample matching the rendered curve
			const omt = 1 - t;
			const bx = omt * omt * a.x + 2 * omt * t * midX + t * t * b.x;
			const by = omt * omt * a.y + 2 * omt * t * midY + t * t * b.y;
			if (!pointClear(bx, by)) return false;
		}
		return true;
	}
	function nearestCross(iA: Island, iB: Island, allowThroughLand = false): [number, number] | null {
		const gsA = grids.filter((g) => g.island === iA.id);
		const gsB = grids.filter((g) => g.island === iB.id);
		if (gsA.length === 0 || gsB.length === 0) return null;
		const pairs: Array<{ a: number; b: number; d: number }> = [];
		for (const a of gsA) for (const b of gsB) {
			pairs.push({ a: a.id, b: b.id, d: Math.hypot(a.x - b.x, a.y - b.y) });
		}
		pairs.sort((p, q) => p.d - q.d);
		for (const p of pairs) {
			if (pathClearsOtherIslands(p.a, p.b)) return [p.a, p.b];
		}
		// No clear-water pair. Only fall back when the caller says land is OK
		// (used by the last-ditch connectivity guarantee).
		if (allowThroughLand && pairs.length) return [pairs[0].a, pairs[0].b];
		return null;
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
		// Connectivity fallback — allow through-land as a last resort so no
		// island becomes totally unreachable.
		const cross = nearestCross(bestPair[0], bestPair[1], true);
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

	// Deserts: rare, 25% chance per island. A desert costs the attacker one
	// army just to enter (heat attrition), and can't host production centers.
	for (const isl of islands) {
		const gs = grids.filter((g) => g.island === isl.id);
		if (gs.length < 4) continue;
		if (rnd() >= 0.25) continue;
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
		for (const id of range) {
			grids[id].terrain = 'desert';
			grids[id].production = false;
		}
	}

	// Rivers: from a mountain hex (or random plain if none), walk toward the
	// coast picking neighbors with more water-side exposure, laying down a
	// land-land edge at each step. Rivers give the defender +1 die when the
	// attacker crosses them.
	const rivers: [number, number][] = [];
	const riverKey = new Set<string>();
	const addRiver = (a: number, b: number) => {
		const lo = Math.min(a, b), hi = Math.max(a, b);
		const k = `${lo},${hi}`;
		if (riverKey.has(k)) return;
		riverKey.add(k);
		rivers.push([lo, hi]);
	};
	// Count only same-island land neighbors — adj is polluted by cross-island
	// sea-lane pairs at this point in the pipeline.
	const coastScore = grids.map((_, gid) =>
		6 - adj[gid].filter((n) => grids[n].island === grids[gid].island).length
	);
	// A vertex is inland when three land hexes meet there. When any face of a
	// river crossing has a coastal vertex, that face touches the sea — the
	// river should end there rather than continue along the shoreline.
	const rvVKey = (v: [number, number]) => `${Math.round(v[0] * 10)},${Math.round(v[1] * 10)}`;
	const vertLandCount = new Map<string, number>();
	for (const g of grids) {
		for (const v of g.cell) {
			const k = rvVKey(v);
			vertLandCount.set(k, (vertLandCount.get(k) ?? 0) + 1);
		}
	}
	const faceHitsWater = (a: number, b: number): boolean => {
		const cb = new Set(grids[b].cell.map(rvVKey));
		for (const v of grids[a].cell) {
			const k = rvVKey(v);
			if (cb.has(k) && (vertLandCount.get(k) ?? 0) < 3) return true;
		}
		return false;
	};
	for (const isl of islands) {
		const own = grids.filter((g) => g.island === isl.id);
		if (own.length < 4) continue;
		const mountains = own.filter((g) => g.terrain === 'mountain');
		// One river per island — small islands sometimes skip.
		const nRivers = own.length >= 6 || mountains.length > 0 ? 1 : 0;
		// Start deep inland: the mountain (or plain) with the lowest coast
		// score is the most interior hex on the island.
		// Prefer mountains, but always fall back to inland plains after them —
		// mountains often sit on coast edges, and a mountain-only source list
		// would give up before trying the deeper interior.
		const rankedSources = [
			...mountains.slice().sort((a, b) => coastScore[a.id] - coastScore[b.id]),
			...own.filter((g) => g.terrain !== 'mountain')
				.sort((a, b) => coastScore[a.id] - coastScore[b.id]),
		];
		// Walk as far as possible along the island. Cap at island size so we
		// can never visit more hexes than the island contains.
		const maxSteps = Math.min(30, own.length);
		for (let k = 0; k < nRivers; k++) {
			// Try each ranked source until we find a walk long enough. Rivers
			// shorter than the minimum are discarded rather than committed.
			const MIN_RIVER_LEN = 4;
			for (let attempt = 0; attempt < rankedSources.length; attempt++) {
				const src = rankedSources[attempt];
				let cur = src.id;
				const visited = new Set<number>([cur]);
				const walk: [number, number][] = [];
				for (let step = 0; step < maxSteps; step++) {
					const opts = adj[cur].filter(
						(n) => !visited.has(n) && grids[n].island === isl.id
					);
					if (opts.length === 0) break;
					// Stay inland: prefer neighbors with the lowest coast score, so
				// the river only reaches the shore at its natural mouth.
				opts.sort((a, b) => (coastScore[a] - coastScore[b]) * 0.5 + (rnd() - 0.5));
					const next = opts[0];
					walk.push([cur, next]);
					visited.add(next);
					cur = next;
					// If the face we just crossed touches the sea at either
					// vertex, this is the river's mouth — stop rather than
					// continuing along the shoreline.
					if (faceHitsWater(walk[walk.length - 1][0], walk[walk.length - 1][1])) break;
				}
				if (walk.length >= MIN_RIVER_LEN) {
					for (const [a, b] of walk) addRiver(a, b);
					break;
				}
			}
		}
	}

	// Assign a unique city name to every production-center hex.
	const cityPool = shuffle(CITY_NAMES, rnd);
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

	// Named water features. Classification is per water hex:
	//   6 land neighbors → lake (fully enclosed)
	//   4-5 land neighbors → bay
	// Any hex touching the map border or lacking in-bounds neighbors is skipped.
	const waterFeatures: WaterFeature[] = [];
	const lakeNames = shuffle(LAKE_NAMES, rnd);
	const bayNames = shuffle(BAY_NAMES, rnd);
	let lakeIdx = 0;
	let bayIdx = 0;
	for (let r = 0; r < hexGrid.length; r++) {
		for (let c = 0; c < hexGrid[r].length; c++) {
			const k = hexKey(c, r);
			if (claimedBy.has(k)) continue;
			// Skip hexes right on the map edge — not truly enclosed.
			if (c === 0 || r === 0 || c === nCols - 1 || r === nRows - 1) continue;
			let landN = 0, oob = 0;
			for (const [nc, nr] of hexNeighbors(c, r)) {
				if (!inBounds(hexGrid, nc, nr)) { oob++; continue; }
				if (claimedBy.has(hexKey(nc, nr))) landN++;
			}
			if (oob > 0) continue;
			const h = hexGrid[r][c];
			if (landN === 6) {
				waterFeatures.push({
					kind: 'lake',
					name: lakeNames[lakeIdx++ % lakeNames.length],
					center: [h.x, h.y],
					hexes: [h.poly]
				});
			} else if (landN === 5) {
				waterFeatures.push({
					kind: 'bay',
					name: bayNames[bayIdx++ % bayNames.length],
					center: [h.x, h.y],
					hexes: [h.poly]
				});
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
		waterFeatures,
		rivers,
		walls: [],
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
