<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		game,
		newGame,
		placeArmies,
		beginAttack,
		beginMove,
		cancelAction,
		selectGrid,
		rollAttack,
		quitAttack,
		confirmMoveInAfterConquest,
		confirmMove,
		confirmAir,
		endTurn,
		playCard,
		discardCard,
		crossingDefenseBonus,
		loadSavedGame,
		clearSavedGame,
		getDebugSettings,
		updateDebugSettings,
		startGamePlaying,
		winProbability,
		defenseBonus,
		attackerBonus,
		canFerryConnect,
		canInvasionConnect,
		canArtilleryTarget,
		countryCount,
		fullIslandBonus,
		PLAYERS,
		PLAYER_COLORS,
		PLAYER_NAMES,
		CARD_LABELS,
		CARD_META,
		type Player,
		type CardType
	} from '$lib/game';
	import { runAiTurn } from '$lib/ai';

	let placeQty = $state(1);
	let moveQty = $state(1);
	let airQty = $state(1);
	let moveInQty = $state(0);
	// The hex the human clicked during placement — opens the qty modal.
	let placeTargetHex = $state<number | null>(null);

	// Qty modal helpers — covers placement, post-conquest move-in, move, and air.
	function isQtyPhase(): boolean {
		if ($game.current !== HUMAN) return false;
		if ($game.phase === 'placing' && placeTargetHex != null) return true;
		return $game.phase === 'attack_move_in' || $game.phase === 'move_qty' || $game.phase === 'air_qty';
	}
	function qtySourceHex(): number | null {
		if ($game.phase === 'placing') return placeTargetHex;
		return $game.selectedFrom;
	}
	function qtyInfo(srcArmies: number) {
		if ($game.phase === 'placing') {
			return {
				title: 'Place how many armies?',
				min: 1,
				max: Math.max(1, $game.armiesToPlace),
				confirmLabel: 'Place'
			};
		}
		if ($game.phase === 'attack_move_in') {
			return {
				title: 'Move additional armies into the captured hex',
				min: 0,
				max: Math.max(0, srcArmies - 1),
				confirmLabel: 'Move In'
			};
		}
		if ($game.phase === 'move_qty') {
			return {
				title: 'Move how many armies?',
				min: 1,
				max: Math.max(1, srcArmies - 1),
				confirmLabel: 'Move'
			};
		}
		return {
			title: 'Airlift how many armies?',
			min: 1,
			max: Math.max(1, srcArmies - 1),
			confirmLabel: 'Airlift'
		};
	}
	function qtyValue(): number {
		if ($game.phase === 'placing') return placeQty;
		return $game.phase === 'attack_move_in' ? moveInQty : $game.phase === 'move_qty' ? moveQty : airQty;
	}
	function setQty(n: number) {
		const src = qtySourceHex();
		if (!isQtyPhase() || src == null) return;
		const info = qtyInfo($game.states[src].armies);
		const v = Math.max(info.min, Math.min(info.max, Math.round(Number.isFinite(n) ? n : 0)));
		if ($game.phase === 'placing') placeQty = v;
		else if ($game.phase === 'attack_move_in') moveInQty = v;
		else if ($game.phase === 'move_qty') moveQty = v;
		else airQty = v;
	}
	function bumpQty(delta: number) { setQty(qtyValue() + delta); }
	function confirmQty() {
		const src = qtySourceHex();
		if (!isQtyPhase() || src == null) return;
		const info = qtyInfo($game.states[src].armies);
		const v = Math.max(info.min, Math.min(info.max, Math.round(qtyValue())));
		if ($game.phase === 'placing') {
			placeArmies(src, v);
			placeTargetHex = null;
			return;
		}
		if ($game.phase === 'attack_move_in') confirmMoveInAfterConquest(v);
		else if ($game.phase === 'move_qty') confirmMove(v);
		else confirmAir(v);
	}
	function cancelQty() {
		if ($game.phase === 'placing' && placeTargetHex != null) {
			placeTargetHex = null;
			return;
		}
		cancelAction();
	}
	// Whenever we enter a qty phase, clamp the associated variable so it's
	// always a valid number in range.
	$effect(() => {
		if ($game.phase !== 'placing' && placeTargetHex != null) placeTargetHex = null;
	});
	$effect(() => {
		const src = qtySourceHex();
		if (!isQtyPhase() || src == null) return;
		const info = qtyInfo($game.states[src].armies);
		if ($game.phase === 'placing') {
			placeQty = Math.max(info.min, Math.min(info.max, Math.round(Number.isFinite(placeQty) ? placeQty : 1)));
		} else if ($game.phase === 'attack_move_in') {
			moveInQty = Math.max(info.min, Math.min(info.max, Math.round(Number.isFinite(moveInQty) ? moveInQty : 0)));
		} else if ($game.phase === 'move_qty') {
			moveQty = Math.max(info.min, Math.min(info.max, Math.round(Number.isFinite(moveQty) ? moveQty : 1)));
		} else if ($game.phase === 'air_qty') {
			airQty = Math.max(info.min, Math.min(info.max, Math.round(Number.isFinite(airQty) ? airQty : 1)));
		}
	});
	let difficulty = $state(2);
	let startingArmies = $state(3);
	let showMenu = $state(false);

	const HUMAN: Player = 'blue';

	let aiRunning = $state(false);
	// AI speed: 1× (deliberate) | 2× (fast) | 0 (instant, no ticks)
	let aiSpeed = $state<1 | 2 | 0>(1);
	function aiTickMs() { return aiSpeed === 0 ? 0 : aiSpeed === 2 ? 20 : 60; }

	let autoRolling = $state(false);
	let hoveredGrid = $state<number | null>(null);
	let tooltipPos = $state<{ x: number; y: number } | null>(null);
	let hoveredCard = $state<CardType | null>(null);
	let cardTipPos = $state<{ x: number; y: number } | null>(null);
	let hoveredLogIdx = $state<number | null>(null);
	let logTipPos = $state<{ x: number; y: number } | null>(null);

	function logIcon(kind: string) {
		switch (kind) {
			case 'attack': return '⚔';
			case 'defeat': return '☠';
			case 'card': return '🎴';
			case 'event': return '⚡';
			default: return '·';
		}
	}
	function onLogHoverEnter(i: number, e: PointerEvent) {
		hoveredLogIdx = i;
		logTipPos = { x: e.clientX, y: e.clientY };
	}
	function onLogHoverMove(e: PointerEvent) {
		if (hoveredLogIdx != null) logTipPos = { x: e.clientX, y: e.clientY };
	}
	function onLogHoverLeave() {
		hoveredLogIdx = null;
		logTipPos = null;
	}

	function onCardHoverEnter(c: CardType, e: PointerEvent) {
		hoveredCard = c;
		cardTipPos = { x: e.clientX, y: e.clientY };
	}
	function onCardHoverMove(e: PointerEvent) {
		if (hoveredCard != null) cardTipPos = { x: e.clientX, y: e.clientY };
	}
	function onCardHoverLeave() {
		hoveredCard = null;
		cardTipPos = null;
	}

	function clampTip(x: number, y: number, w = 300, h = 160): { x: number; y: number } {
		const pad = 8;
		const offset = 14;
		if (typeof window === 'undefined') return { x: x + offset, y: y + offset };
		const winW = window.innerWidth;
		const winH = window.innerHeight;
		let tx = x + offset;
		let ty = y + offset;
		if (tx + w > winW - pad) tx = x - w - offset;
		if (ty + h > winH - pad) ty = y - h - offset;
		return {
			x: Math.max(pad, Math.min(tx, winW - w - pad)),
			y: Math.max(pad, Math.min(ty, winH - h - pad))
		};
	}

	function onHexPointerEnter(id: number, e: PointerEvent) {
		hoveredGrid = id;
		tooltipPos = { x: e.clientX, y: e.clientY };
	}
	function onHexPointerLeave(id: number) {
		if (hoveredGrid === id) hoveredGrid = null;
		tooltipPos = null;
	}

	// Drag-to-attack state
	let mapSvg: SVGSVGElement | undefined = $state();
	let dragFrom = $state<number | null>(null);
	let dragPt = $state<{ x: number; y: number } | null>(null);
	let pointerDownGrid: number | null = null;
	let pointerDownAt: { x: number; y: number } | null = null;

	function canStartAttackDrag(id: number): boolean {
		const s = $game;
		if (s.current !== HUMAN) return false;
		if (s.phase === 'action') {
			return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
		}
		if (s.phase === 'ferry_from') {
			return s.states[id].owner === HUMAN;
		}
		if (s.phase === 'invasion_from') {
			return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
		}
		if (s.phase === 'artillery_from') {
			return s.states[id].owner === HUMAN && s.states[id].armies >= 2 && s.map.grids[id].production;
		}
		return false;
	}

	function isValidAttackTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'action') return false;
		if (from === to) return false;
		if (!s.map.adj[from].includes(to)) return false;
		if (s.states[to].owner === HUMAN) return false;
		return true;
	}

	function isValidMoveTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'action') return false;
		if (from === to) return false;
		if (!s.map.adj[from].includes(to)) return false;
		if (s.states[to].owner !== HUMAN) return false;
		return true;
	}

	function isValidFerryTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'ferry_from' && s.phase !== 'ferry_to') return false;
		if (from === to) return false;
		if (s.states[to].owner !== HUMAN) return false;
		return canFerryConnect(s, from, to);
	}

	function isValidInvasionTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'invasion_from' && s.phase !== 'invasion_to') return false;
		return canInvasionConnect(s, from, to);
	}

	function isValidArtilleryTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'artillery_from' && s.phase !== 'artillery_to') return false;
		return canArtilleryTarget(s, from, to);
	}

	function isValidDragTarget(from: number, to: number): boolean {
		return isValidAttackTarget(from, to) || isValidMoveTarget(from, to)
			|| isValidFerryTarget(from, to) || isValidInvasionTarget(from, to)
			|| isValidArtilleryTarget(from, to);
	}

	function svgPoint(e: PointerEvent): { x: number; y: number } | null {
		if (!mapSvg) return null;
		const pt = mapSvg.createSVGPoint();
		pt.x = e.clientX;
		pt.y = e.clientY;
		const m = mapSvg.getScreenCTM();
		if (!m) return null;
		const p = pt.matrixTransform(m.inverse());
		return { x: p.x, y: p.y };
	}

	function onPolyPointerDown(id: number, e: PointerEvent) {
		if (canStartAttackDrag(id)) {
			pointerDownGrid = id;
			pointerDownAt = svgPoint(e);
		}
	}

	function onSvgPointerMove(e: PointerEvent) {
		if (hoveredGrid != null) tooltipPos = { x: e.clientX, y: e.clientY };
		if (pointerDownGrid == null || !pointerDownAt) return;
		const p = svgPoint(e);
		if (!p) return;
		if (dragFrom == null) {
			const dx = p.x - pointerDownAt.x;
			const dy = p.y - pointerDownAt.y;
			if (Math.hypot(dx, dy) > 10) {
				dragFrom = pointerDownGrid;
			}
		}
		if (dragFrom != null) dragPt = p;
	}

	function onSvgPointerUp() {
		if (dragFrom != null && hoveredGrid != null) {
			const from = dragFrom;
			const to = hoveredGrid;
			if (isValidAttackTarget(from, to)) {
				beginAttack();
				selectGrid(from);
				selectGrid(to);
			} else if (isValidMoveTarget(from, to)) {
				beginMove();
				selectGrid(from);
				selectGrid(to);
			} else if (isValidFerryTarget(from, to)) {
				selectGrid(from);
				selectGrid(to);
			} else if (isValidInvasionTarget(from, to)) {
				selectGrid(from);
				selectGrid(to);
			} else if (isValidArtilleryTarget(from, to)) {
				selectGrid(from);
				selectGrid(to);
			}
		}
		dragFrom = null;
		dragPt = null;
		pointerDownGrid = null;
		pointerDownAt = null;
	}

	onMount(() => {
		loadDebugUi();
		loadSavedGame();
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	function onKey(e: KeyboardEvent) {
		if ($game.current !== HUMAN || $game.phase === 'game_over') return;
		const tag = (e.target as HTMLElement | null)?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA') return;
		if (e.key === 'Escape') { cancelQty(); return; }
		if (isQtyPhase()) {
			if (e.key === 'Enter') { confirmQty(); e.preventDefault(); return; }
			if (e.key === 'ArrowUp' || e.key === '+') { bumpQty(1); e.preventDefault(); return; }
			if (e.key === 'ArrowDown' || e.key === '-') { bumpQty(-1); e.preventDefault(); return; }
		}
		if ($game.phase === 'action') {
			if (e.key === 'a' || e.key === 'A') { beginAttack(); e.preventDefault(); }
			else if (e.key === 'm' || e.key === 'M') { beginMove(); e.preventDefault(); }
			else if (e.key === 'p' || e.key === 'P') { endTurn(); e.preventDefault(); }
		} else if ($game.phase === 'attack_rolling') {
			if (e.key === 'Enter' || e.key === ' ') { rollAttack(); e.preventDefault(); }
		}
	}

	async function startAutoRoll() {
		autoRolling = true;
		while (autoRolling && $game.phase === 'attack_rolling') {
			rollAttack();
			await new Promise((r) => setTimeout(r, 90));
		}
		autoRolling = false;
	}
	function stopAutoRoll() { autoRolling = false; }

	// Reactively drive AI turns whenever current is not the human (or always,
	// when the "Auto-play" debug option is on).
	$effect(() => {
		const s = $game;
		if (aiRunning) return;
		if (!s.gameStarted) return; // waiting for Start Game
		if (s.phase === 'game_over') return;
		if (s.current === HUMAN && !debugAutoPlay) return;
		aiRunning = true;
		(async () => {
			await new Promise((r) => setTimeout(r, aiSpeed === 0 ? 40 : 200));
			await runAiTurn(s.current, aiTickMs());
			aiRunning = false;
		})();
	});

	function gridFill(id: number, s: typeof $game) {
		const st = s.states[id];
		return st.owner ? PLAYER_COLORS[st.owner] : '#334';
	}

	function isSelectable(id: number, s: typeof $game): boolean {
		if (s.current !== HUMAN) return false;
		switch (s.phase) {
			case 'placing':
				return s.states[id].owner === HUMAN;
			case 'attack_select_from':
				return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
			case 'attack_select_to':
				if (s.selectedFrom == null) return false;
				return s.map.adj[s.selectedFrom].includes(id) && s.states[id].owner !== HUMAN;
			case 'move_select_from':
				return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
			case 'move_select_to':
				if (s.selectedFrom == null) return false;
				return s.map.adj[s.selectedFrom].includes(id) && s.states[id].owner === HUMAN;
			case 'bomb_select':
				return s.states[id].owner !== HUMAN && !!s.states[id].owner;
			case 'air_from':
				return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
			case 'air_to':
				return s.states[id].owner === HUMAN && id !== s.selectedFrom;
			case 'reinforce_select':
			case 'fortify_select':
				return s.states[id].owner === HUMAN;
			case 'sabotage_select':
				return s.states[id].owner !== HUMAN && !!s.states[id].owner;
			case 'ferry_from':
				return s.states[id].owner === HUMAN;
			case 'ferry_to':
				if (s.selectedFrom == null) return false;
				return s.states[id].owner === HUMAN && canFerryConnect(s, s.selectedFrom, id);
			case 'invasion_from':
				return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
			case 'invasion_to':
				if (s.selectedFrom == null) return false;
				return canInvasionConnect(s, s.selectedFrom, id);
			case 'artillery_from':
				return s.states[id].owner === HUMAN && s.states[id].armies >= 2 && s.map.grids[id].production;
			case 'artillery_to':
				if (s.selectedFrom == null) return false;
				return canArtilleryTarget(s, s.selectedFrom, id);
			case 'deforest_select':
				return s.map.grids[id].terrain === 'forest';
			case 'oasis_select':
				return s.map.grids[id].terrain === 'desert' && s.states[id].owner === s.current;
			case 'storm_from':
				return s.map.seaLanes.some(([a, b]) => a === id || b === id);
			case 'storm_to':
				if (s.selectedFrom == null) return false;
				return s.map.seaLanes.some(
					([a, b]) => (a === s.selectedFrom && b === id) || (a === id && b === s.selectedFrom)
				);
			default:
				return false;
		}
	}

	function handleGridClick(id: number) {
		const s = $game;
		if (s.current !== HUMAN) return;
		if (s.phase === 'placing') {
			if (s.states[id].owner !== HUMAN) return;
			// Open the placement qty modal; user picks how many armies to drop.
			placeTargetHex = id;
			// Default to placing everything remaining unless the user explicitly
			// prefers a smaller default; the modal will clamp.
			placeQty = Math.max(1, Math.min(placeQty || 1, s.armiesToPlace));
			return;
		}
		if (!isSelectable(id, s)) return;
		selectGrid(id);
	}

	function startNewGame() {
		newGame(difficulty, startingArmies);
		showMenu = false;
	}

	function confirmClearSave() {
		const ok = confirm(
			'Clear the saved game and start a fresh one?\n\nThis wipes your current progress in this browser and cannot be undone.'
		);
		if (!ok) return;
		clearSavedGame();
		newGame(difficulty, startingArmies);
	}

	function polygonPoints(pts: [number, number][]): string {
		return pts.map((p) => p.join(',')).join(' ');
	}

	// Build one continuous polyline per river that follows actual hex edges.
	// For each hex on the river chain, we walk along that hex's perimeter from
	// the entry face to the exit face, so bends and straight sections both trace
	// real hex-edge boundaries rather than cutting through hex interiors.
	const riverPolylines = $derived.by(() => {
		const rivers = $game.map.rivers ?? [];
		if (rivers.length === 0) return [] as [number, number][][];
		const grids = $game.map.grids;
		const vkey = (v: [number, number]) => `${Math.round(v[0] * 10)},${Math.round(v[1] * 10)}`;
		// Return the two shared vertices (points on the hex edge) between two
		// adjacent hexes.
		const sharedFace = (a: number, b: number): [number, number][] => {
			const cb = new Set(grids[b].cell.map(vkey));
			return grids[a].cell.filter((v) => cb.has(vkey(v)));
		};
		const idxInCell = (cell: [number, number][], v: [number, number]) => {
			const k = vkey(v);
			return cell.findIndex((c) => vkey(c) === k);
		};
		// A vertex is "inland" if three land hexes meet at it. Coastal vertices
		// only appear in one or two land cells (the missing corner is water).
		const vertLandCount = new Map<string, number>();
		for (const g of grids) {
			for (const v of g.cell) {
				const k = vkey(v);
				vertLandCount.set(k, (vertLandCount.get(k) ?? 0) + 1);
			}
		}
		const isInland = (v: [number, number]) => (vertLandCount.get(vkey(v)) ?? 0) >= 3;
		// Perimeter walk in hex `h` from entry to exit. Prefer the direction that
		// stays inland; break ties by shorter arc so the river doesn't hug the
		// coast when both sides of the hex are viable.
		const arcThrough = (h: number, entry: [number, number], exit: [number, number]) => {
			const cell = grids[h].cell;
			const n = cell.length;
			const ei = idxInCell(cell, entry);
			const xi = idxInCell(cell, exit);
			if (ei < 0 || xi < 0) return [entry, exit];
			let best: number[] = [];
			let bestCost = Infinity;
			for (const dir of [1, -1] as const) {
				const seq: number[] = [];
				let c = ei;
				for (let s = 0; s <= n; s++) {
					seq.push(c);
					if (c === xi) break;
					c = (c + dir + n) % n;
				}
				if (seq[seq.length - 1] !== xi) continue;
				let coastal = 0;
				for (let i = 1; i < seq.length - 1; i++) {
					if (!isInland(cell[seq[i]])) coastal++;
				}
				const cost = coastal * 1000 + seq.length;
				if (cost < bestCost) {
					bestCost = cost;
					best = seq;
				}
			}
			return best.map((i) => cell[i]);
		};

		// Hex-node graph of river edges.
		const nbr = new Map<number, number[]>();
		for (const [a, b] of rivers) {
			if (!nbr.has(a)) nbr.set(a, []);
			if (!nbr.has(b)) nbr.set(b, []);
			nbr.get(a)!.push(b);
			nbr.get(b)!.push(a);
		}
		const ek = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
		const used = new Set<string>();
		const paths: [number, number][][] = [];
		const nodes = [...nbr.keys()].sort(
			(a, b) => nbr.get(a)!.length - nbr.get(b)!.length
		);

		for (const start of nodes) {
			while (true) {
				const firstNbr = nbr.get(start)!.find((n) => !used.has(ek(start, n)));
				if (firstNbr === undefined) break;
				used.add(ek(start, firstNbr));
				const chain: number[] = [start, firstNbr];
				let prev = start;
				let cur = firstNbr;
				while (true) {
					const next = nbr.get(cur)!.find((n) => n !== prev && !used.has(ek(cur, n)));
					if (next === undefined) break;
					used.add(ek(cur, next));
					chain.push(next);
					prev = cur;
					cur = next;
				}
				// Collect the two vertices of each face (shared hex edge) in the chain.
				const faces: [[number, number], [number, number]][] = [];
				for (let i = 0; i < chain.length - 1; i++) {
					const f = sharedFace(chain[i], chain[i + 1]);
					if (f.length !== 2) { faces.length = 0; break; }
					faces.push([f[0], f[1]]);
				}
				if (faces.length === 0) continue;

				// Pick a per-face entry vertex (0 or 1) minimizing total perimeter
				// arc length through interior hexes. Brute-force over 2^faces —
				// river chains are short (~4–8 faces) so this stays tiny.
				const eCount = faces.length;
				let bestMask = 0;
				let bestCost = Infinity;
				const totalMasks = 1 << eCount;
				for (let mask = 0; mask < totalMasks; mask++) {
					let cost = 0;
					for (let j = 1; j < chain.length - 1; j++) {
						const entryV = faces[j - 1][(mask >> (j - 1)) & 1];
						const exitV = faces[j][(mask >> j) & 1];
						const arc = arcThrough(chain[j], entryV, exitV);
						cost += arc.length;
					}
					if (cost < bestCost) {
						bestCost = cost;
						bestMask = mask;
					}
				}

				// Emit the polyline. Start with a short stub across the source face,
				// walk through each interior hex's chosen perimeter arc, and end with
				// a stub across the mouth face.
				const pts: [number, number][] = [];
				const startEntry = faces[0][bestMask & 1];
				const startOther = faces[0][1 - (bestMask & 1)];
				pts.push(startOther, startEntry);
				for (let j = 1; j < chain.length - 1; j++) {
					const entryV = faces[j - 1][(bestMask >> (j - 1)) & 1];
					const exitV = faces[j][(bestMask >> j) & 1];
					const arc = arcThrough(chain[j], entryV, exitV);
					for (let i = 1; i < arc.length; i++) pts.push(arc[i]);
				}
				const endOther = faces[eCount - 1][1 - ((bestMask >> (eCount - 1)) & 1)];
				pts.push(endOther);
				paths.push(pts);
			}
		}
		return paths;
	});

	function seaLanePath(a: number, b: number, s: typeof $game) {
		// Draw as a quadratic Bezier that arcs perpendicular to the segment.
		// A slight curve prevents lanes from overlapping straight-through hex
		// centers and gives them a nautical "sea route" feel.
		const g1 = s.map.grids[a];
		const g2 = s.map.grids[b];
		const midX = (g1.x + g2.x) / 2;
		const midY = (g1.y + g2.y) / 2;
		const dx = g2.x - g1.x;
		const dy = g2.y - g1.y;
		const len = Math.hypot(dx, dy) || 1;
		// Perpendicular unit vector — arc height ~12% of segment length, capped.
		const perpX = -dy / len;
		const perpY = dx / len;
		const arc = Math.min(22, len * 0.06);
		// Deterministic side based on the endpoint ids so the curve doesn't jitter
		// between renders.
		const side = ((a + b) % 2 === 0) ? 1 : -1;
		const cx = midX + perpX * arc * side;
		const cy = midY + perpY * arc * side;
		return `M ${g1.x} ${g1.y} Q ${cx} ${cy} ${g2.x} ${g2.y}`;
	}

	// Debug menu
	let showDebug = $state(false);
	let debugDisableSave = $state(false);
	let debugStarterCards = $state(false);
	let debugAutoPlay = $state(false);
	let debugDieSides = $state(10);

	function loadDebugUi() {
		const d = getDebugSettings();
		debugDisableSave = d.disableSave;
		debugStarterCards = d.starterCards;
		debugAutoPlay = d.autoPlay;
		debugDieSides = d.dieSides;
	}

	function setDebugDieSides(v: number) {
		const sides = Math.max(2, Math.min(100, Math.round(v || 0)));
		debugDieSides = sides;
		updateDebugSettings({ dieSides: sides });
	}

	function toggleDebugDisableSave() {
		debugDisableSave = !debugDisableSave;
		updateDebugSettings({ disableSave: debugDisableSave });
	}

	function toggleDebugStarterCards() {
		debugStarterCards = !debugStarterCards;
		updateDebugSettings({ starterCards: debugStarterCards });
	}

	function toggleDebugAutoPlay() {
		debugAutoPlay = !debugAutoPlay;
		updateDebugSettings({ autoPlay: debugAutoPlay });
		// If autoplay was just enabled and we're waiting on the start gate,
		// go ahead and start so the AI can run.
		if (debugAutoPlay && !$game.gameStarted) startGamePlaying();
	}

	interface HexModifier { name: string; desc: string; }
	interface HexInfo {
		title: string;
		owner: string;
		ownerColor: string;
		armies: number;
		city?: string;
		modifiers: HexModifier[];
	}
	function hexInfo(gridId: number): HexInfo {
		const g = $game.map.grids[gridId];
		const st = $game.states[gridId];
		const title = gridLabelLocal(gridId, $game);
		const owner = st.owner ? PLAYER_NAMES[st.owner] : 'Neutral';
		const ownerColor = st.owner ? PLAYER_COLORS[st.owner] : '#556';
		const terrainMap: Record<string, [string, string]> = {
			plain: ['Plain', 'Open ground. No combat modifier.'],
			mountain: ['Mountain', 'Defender rolls +1 on every die.'],
			forest: ['Forest', 'Attacker rolls +1 (cover on approach).'],
			marsh: ['Marsh', 'After attacking from here, cannot launch another attack from this hex this turn.'],
			desert: ['Desert', 'Heat attrition — any move into a desert (conquest, regular move, or air move) burns 1 army. Cannot host a production center.']
		};
		const modifiers: HexModifier[] = [];
		if (g.production) {
			modifiers.push({
				name: 'City',
				desc: 'Production center (★) — grants extra reinforcements to its owner and is the only launchpad for Artillery.'
			});
		}
		const [terrainName, terrainDesc] = terrainMap[g.terrain] ?? ['Plain', ''];
		// Only surface terrain when it has an actual effect. Plain adds nothing on
		// its own; skip it unless there are no other modifiers to show.
		if (g.terrain !== 'plain' || modifiers.length === 0) {
			modifiers.push({ name: terrainName, desc: terrainDesc });
		}
		if (st.fortified) {
			modifiers.push({
				name: '🛡 Fortified',
				desc: '+2 defense on this hex. Lost when the hex is captured.'
			});
		}
		return {
			title,
			owner,
			ownerColor,
			armies: st.armies,
			city: g.cityName,
			modifiers
		};
	}

	function gridLabelLocal(id: number, s: typeof $game): string {
		const g = s.map.grids[id];
		const isl = s.map.islands.find((i) => i.id === g.island)!;
		const localIdx = s.map.grids.filter((x) => x.island === g.island).findIndex((x) => x.id === id) + 1;
		return `${isl.name}-${localIdx}`;
	}
</script>

<svelte:head><title>Isle Wars — SvelteKit clone</title></svelte:head>

<!-- Shared hex-render snippets: used by both the map SVG and the attack modal
     so any change to how a hex reads (badge, fort ring, prod star, terrain
     overlay, city label) stays consistent everywhere. -->
{#snippet hexTerrain(polyPts: string, terrain: 'plain'|'mountain'|'forest'|'marsh'|'desert')}
	{#if terrain === 'mountain'}
		<polygon points={polyPts} fill="url(#mountain-pattern)" pointer-events="none" />
	{:else if terrain === 'forest'}
		<polygon points={polyPts} fill="url(#forest-pattern)" pointer-events="none" />
	{:else if terrain === 'marsh'}
		<polygon points={polyPts} fill="url(#marsh-pattern)" pointer-events="none" />
	{:else if terrain === 'desert'}
		<polygon points={polyPts} fill="url(#desert-pattern)" pointer-events="none" />
	{/if}
{/snippet}
{#snippet hexBadge(gridId: number, cx: number, cy: number, scale: number, showCityLabel: boolean)}
	{@const g = $game.map.grids[gridId]}
	{@const st = $game.states[gridId]}
	{@const badgeR = 20 * scale}
	{@const fortR1 = 30 * scale}
	{@const fortR2 = 34 * scale}
	<g pointer-events="none">
		{#if st.fortified}
			<circle cx={cx} cy={cy} r={fortR1} fill="none" stroke="#7fcfff" stroke-width={3 * scale} stroke-dasharray="{6 * scale} {4 * scale}" opacity="0.95" />
			<circle cx={cx} cy={cy} r={fortR2} fill="none" stroke="#7fcfff" stroke-width={1.5 * scale} opacity="0.55" />
		{/if}
		<circle cx={cx} cy={cy} r={badgeR} fill="#000" fill-opacity="0.6"
			stroke={st.fortified ? '#7fcfff' : g.production ? '#ffe14a' : '#fff'}
			stroke-width={(st.fortified ? 3 : g.production ? 2.5 : 1.5) * scale} />
		<text x={cx} y={cy + 7 * scale} text-anchor="middle"
			font-family="monospace" font-weight="bold"
			font-size={20 * scale} fill="#fff">{st.armies}</text>
		{#if st.fortified}
			<text x={cx - 18 * scale} y={cy - 14 * scale} text-anchor="middle"
				font-size={16 * scale} style="filter: drop-shadow(0 0 {3 * scale}px #7fcfff);">🛡</text>
		{/if}
		{#if g.production}
			<text x={cx + 20 * scale} y={cy - 15 * scale} text-anchor="middle"
				font-size={18 * scale} fill="#ffe14a">★</text>
			{#if showCityLabel && g.cityName}
				<text x={cx} y={cy + 34 * scale} class="city-label city-label-outline" text-anchor="middle">{g.cityName}</text>
				<text x={cx} y={cy + 34 * scale} class="city-label" text-anchor="middle">{g.cityName}</text>
			{/if}
		{/if}
	</g>
{/snippet}

<main>
	<header>
		<div class="header-row">
			<div class="scoreboard">
				{#each PLAYERS as p}
					<div class="score" class:current={$game.current === p} class:dead={!$game.alive[p]}>
						<span class="dot" style="background:{PLAYER_COLORS[p]}"></span>
						<strong>{PLAYER_NAMES[p]}</strong>
						<span class="score-nums">{countryCount($game, p)}<span class="dim">/{$game.map.grids.length}</span></span>
						<span class="bonus">+{fullIslandBonus($game, p)}</span>
					</div>
				{/each}
			</div>
			<div class="actions">
				<span class="turn">T{$game.turn}</span>
				<label class="speed">
					<select bind:value={aiSpeed}>
						<option value={1}>1×</option>
						<option value={2}>2×</option>
						<option value={0}>⚡</option>
					</select>
				</label>
				<button class="icon-btn" title="New Game" onclick={() => (showMenu = !showMenu)}>{showMenu ? '✕' : 'New'}</button>
				<button class="icon-btn" title="Debug" onclick={() => (showDebug = !showDebug)}>Debug</button>
				<button class="icon-btn danger" title="Clear Save" onclick={confirmClearSave}>Clear</button>
			</div>
		</div>
	</header>

	{#if showMenu}
		<section class="menu">
			<h2>New Game</h2>
			<label>Difficulty
				<select bind:value={difficulty}>
					<option value={1}>1 — Easy</option>
					<option value={2}>2 — Normal (default)</option>
					<option value={3}>3 — Hard</option>
					<option value={4}>4 — Hardest</option>
				</select>
			</label>
			<label>Starting armies per country
				<input type="number" min="1" max="10" bind:value={startingArmies} />
			</label>
			<button onclick={startNewGame}>Start</button>
		</section>
	{/if}

	{#if showDebug}
		<section class="debug-panel">
			<div class="debug-header">
				<span class="debug-badge">DEBUG</span>
				<h2>Developer Options</h2>
				<button class="close-x" onclick={() => (showDebug = false)} aria-label="Close debug">✕</button>
			</div>
			<div class="debug-options">
				<label class="toggle-card" class:on={debugDisableSave}>
					<input type="checkbox" checked={debugDisableSave} onchange={toggleDebugDisableSave} />
					<div class="toggle-slot"><div class="toggle-thumb"></div></div>
					<div class="toggle-text">
						<div class="toggle-title">Disable local save</div>
						<div class="toggle-desc">Wipes the current save and skips future saves so a reload always gives you a fresh map.</div>
					</div>
				</label>
				<label class="toggle-card" class:on={debugStarterCards}>
					<input type="checkbox" checked={debugStarterCards} onchange={toggleDebugStarterCards} />
					<div class="toggle-slot"><div class="toggle-thumb"></div></div>
					<div class="toggle-text">
						<div class="toggle-title">Blue starts with every card</div>
						<div class="toggle-desc">Deals one of each card type to Blue's hand at the start of every new game for testing.</div>
					</div>
				</label>
				<label class="toggle-card" class:on={debugAutoPlay}>
					<input type="checkbox" checked={debugAutoPlay} onchange={toggleDebugAutoPlay} />
					<div class="toggle-slot"><div class="toggle-thumb"></div></div>
					<div class="toggle-text">
						<div class="toggle-title">Auto-play the whole game</div>
						<div class="toggle-desc">The AI controls all four players so you can watch a game play itself. Turn off to take over Blue again.</div>
					</div>
				</label>
				<div class="toggle-card">
					<div class="toggle-text" style="flex:1">
						<div class="toggle-title">Base die sides</div>
						<div class="toggle-desc">Combat rolls a fair 1–N die per side. Higher N shrinks the impact of the +1/+2 bonuses; d6 is the classic feel, d10 is the current default.</div>
					</div>
					<div class="die-controls">
						{#each [6, 8, 10, 12, 20] as sides}
							<button class="die-btn" class:on={debugDieSides === sides} onclick={() => setDebugDieSides(sides)}>d{sides}</button>
						{/each}
						<input class="die-num" type="number" min="2" max="100" value={debugDieSides} onchange={(e) => setDebugDieSides(+(e.currentTarget as HTMLInputElement).value)} />
					</div>
				</div>
			</div>
			<div class="debug-footer">Settings apply immediately (die changes take effect on the next roll).</div>
		</section>
	{/if}


	{#if $game.phase === 'game_over'}
		<section class="banner {$game.winner === HUMAN ? 'win' : 'lose'}">
			{#if $game.winner === HUMAN}
				<h2>Victory! Blue conquered the isles.</h2>
			{:else if $game.winner}
				<h2>Defeat. {PLAYER_NAMES[$game.winner]} won.</h2>
			{:else}
				<h2>Game Over</h2>
			{/if}
			<button onclick={startNewGame}>New Game</button>
		</section>
	{/if}

	{#if $game.gameStarted}
		<div class="msg">{$game.message}</div>
	{/if}

	{#if !$game.gameStarted && $game.phase !== 'game_over'}
		<div class="start-prompt">
			<div>
				<h2>Ready to play?</h2>
				<p>Take a look at the map, then hit <strong>Start Game</strong> to let the opponents make their moves.</p>
			</div>
			<button class="primary big" onclick={startGamePlaying}>Start Game →</button>
		</div>
	{/if}

	<div class="grid">
		<div class="mapwrap">
			<svg
				bind:this={mapSvg}
				viewBox={$game.map.viewBox ? `${$game.map.viewBox.x} ${$game.map.viewBox.y} ${$game.map.viewBox.w} ${$game.map.viewBox.h}` : `0 0 ${$game.map.width} ${$game.map.height}`}
				class="map"
				onpointermove={onSvgPointerMove}
				onpointerup={onSvgPointerUp}
				onpointerleave={onSvgPointerUp}
			>
				<defs>
					<!-- Subtle mountain-peak pattern overlaid on mountain hexes. -->
					<pattern id="mountain-pattern" width="42" height="36" patternUnits="userSpaceOnUse">
						<path d="M-4 36 L14 10 L32 36 Z M28 36 L46 10 L64 36 Z"
							fill="#000" opacity="0.28" stroke="none" />
						<path d="M14 10 L10 17 L18 17 Z M46 10 L42 17 L50 17 Z"
							fill="#ffffff" opacity="0.35" />
					</pattern>
					<!-- Forest pattern: sparse trees (crown + long trunk). Two trees
					     per tile at low opacity so it reads as texture, not noise. -->
					<pattern id="forest-pattern" width="48" height="48" patternUnits="userSpaceOnUse">
						<rect x="10.5" y="20" width="3" height="16" fill="#4a2d18" opacity="0.6" />
						<circle cx="12" cy="16" r="10" fill="#000" opacity="0.28" />
						<circle cx="12" cy="14" r="3" fill="#5cb85c" opacity="0.32" />
						<rect x="32.5" y="34" width="3" height="14" fill="#4a2d18" opacity="0.6" />
						<circle cx="34" cy="30" r="11" fill="#000" opacity="0.28" />
						<circle cx="34" cy="28" r="3.2" fill="#5cb85c" opacity="0.32" />
					</pattern>
					<!-- Desert pattern: warm sand overlay with a few dune ridges and
					     scattered dots so it reads as arid ground. -->
					<pattern id="desert-pattern" width="44" height="38" patternUnits="userSpaceOnUse">
						<rect x="0" y="0" width="44" height="38" fill="#e8c07a" opacity="0.32" />
						<path d="M-2 26 Q10 20 22 26 T46 26" fill="none" stroke="#8a5a20" stroke-width="1.3" opacity="0.55" stroke-linecap="round" />
						<path d="M-2 12 Q10 6 22 12 T46 12" fill="none" stroke="#8a5a20" stroke-width="1.1" opacity="0.4" stroke-linecap="round" />
						<circle cx="8" cy="32" r="1.1" fill="#5c3a12" opacity="0.6" />
						<circle cx="30" cy="18" r="1" fill="#5c3a12" opacity="0.55" />
						<circle cx="36" cy="34" r="1.1" fill="#5c3a12" opacity="0.6" />
					</pattern>
					<!-- Marsh pattern: horizontal reed strokes suggesting wet ground. -->
					<pattern id="marsh-pattern" width="40" height="34" patternUnits="userSpaceOnUse">
						<path d="M4 10 Q10 5 16 10 T28 10" fill="none" stroke="#000" stroke-width="1.6" opacity="0.35" stroke-linecap="round" />
						<path d="M12 22 Q18 17 24 22 T36 22" fill="none" stroke="#000" stroke-width="1.6" opacity="0.35" stroke-linecap="round" />
						<!-- reed tufts -->
						<line x1="6" y1="16" x2="6" y2="8" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
						<line x1="9" y1="15" x2="9" y2="7" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
						<line x1="22" y1="28" x2="22" y2="20" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
						<line x1="25" y1="28" x2="25" y2="20" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
					</pattern>
				</defs>
				<!-- Water -->
				<rect x="0" y="0" width={$game.map.width} height={$game.map.height} fill="#0a2540" />
				<!-- Water hexes (the underlying grid) -->
				{#each $game.map.waterHexes ?? [] as poly}
					<polygon points={polygonPoints(poly)} fill="#0e2a48" stroke="#26527a" stroke-width="0.8" stroke-opacity="0.55" pointer-events="none" />
				{/each}
				<!-- Sea lanes: curved paths arcing through open water -->
				{#each $game.map.seaLanes as [a, b]}
					<path d={seaLanePath(a, b, $game)} fill="none" stroke="#a0d8ff" stroke-width="2.5" stroke-dasharray="6 4" stroke-opacity="0.85" pointer-events="none" />
				{/each}
				<!-- Territory polygons (Voronoi cells clipped to island hulls) -->
				{#each $game.map.grids as g}
					{@const st = $game.states[g.id]}
					{@const sel = isSelectable(g.id, $game)}
					<polygon
						points={polygonPoints(g.cell)}
						class="territory"
						class:selectable={sel}
						class:mountain={g.terrain === 'mountain'}
						class:selected-from={$game.selectedFrom === g.id}
						class:selected-to={$game.selectedTo === g.id}
						class:drag-source={dragFrom === g.id}
						class:drag-attack-target={dragFrom != null && isValidAttackTarget(dragFrom, g.id) && hoveredGrid === g.id}
						class:drag-attack-candidate={dragFrom != null && dragFrom !== g.id && isValidAttackTarget(dragFrom, g.id)}
						class:drag-move-target={dragFrom != null && isValidMoveTarget(dragFrom, g.id) && hoveredGrid === g.id}
						class:drag-move-candidate={dragFrom != null && dragFrom !== g.id && isValidMoveTarget(dragFrom, g.id)}
						class:drag-ferry-target={dragFrom != null && isValidFerryTarget(dragFrom, g.id) && hoveredGrid === g.id}
						class:drag-ferry-candidate={dragFrom != null && dragFrom !== g.id && isValidFerryTarget(dragFrom, g.id)}
						class:drag-invade-target={dragFrom != null && isValidInvasionTarget(dragFrom, g.id) && hoveredGrid === g.id}
						class:drag-invade-candidate={dragFrom != null && dragFrom !== g.id && isValidInvasionTarget(dragFrom, g.id)}
						class:drag-artillery-target={dragFrom != null && isValidArtilleryTarget(dragFrom, g.id) && hoveredGrid === g.id}
						class:drag-artillery-candidate={dragFrom != null && dragFrom !== g.id && isValidArtilleryTarget(dragFrom, g.id)}
						fill={gridFill(g.id, $game)}
						stroke="#0a1420"
						stroke-width="2"
						onclick={() => handleGridClick(g.id)}
						onpointerdown={(e) => onPolyPointerDown(g.id, e)}
						onpointerenter={(e) => onHexPointerEnter(g.id, e)}
						onpointerleave={() => onHexPointerLeave(g.id)}
						role="button"
						tabindex="0"
					/>
				{/each}
				<!-- Terrain overlays: mountains + forests + marshes -->
				{#each $game.map.grids as g}
					{@render hexTerrain(polygonPoints(g.cell), g.terrain)}
				{/each}
				<!-- Rivers: thick layered strokes (dark banks + mid + highlight) with
				     a soft glow, straddling the shared edge between two land hexes. -->
				<defs>
					<filter id="river-glow" x="-30%" y="-30%" width="160%" height="160%">
						<feGaussianBlur stdDeviation="2.5" result="blur" />
						<feMerge>
							<feMergeNode in="blur" />
							<feMergeNode in="SourceGraphic" />
						</feMerge>
					</filter>
				</defs>
				{#each riverPolylines as pts}
					<g pointer-events="none" filter="url(#river-glow)">
						<polyline
							points={polygonPoints(pts)}
							fill="none"
							stroke="#0a2e5c" stroke-width="14"
							stroke-linecap="round" stroke-linejoin="round"
						/>
						<polyline
							points={polygonPoints(pts)}
							fill="none"
							stroke="#3ea0e0" stroke-width="9"
							stroke-linecap="round" stroke-linejoin="round"
						/>
						<polyline
							points={polygonPoints(pts)}
							fill="none"
							stroke="#e0f2ff" stroke-width="3"
							stroke-linecap="round" stroke-linejoin="round"
						/>
					</g>
				{/each}
				<!-- Army count badges, production stars, and city names -->
				{#each $game.map.grids as g}
					{@render hexBadge(g.id, g.x, g.y, 1, true)}
				{/each}
				<!-- Island name labels centered on the island's centroid, with a
				     dark stroked outline so they read on any hex color. -->
				{#each $game.map.islands as isl}
					<text x={isl.labelPos[0]} y={isl.labelPos[1] - 2} class="isle-label isle-label-outline" text-anchor="middle" pointer-events="none">{isl.name.toUpperCase()}</text>
					<text x={isl.labelPos[0]} y={isl.labelPos[1] - 2} class="isle-label" text-anchor="middle" pointer-events="none">{isl.name.toUpperCase()}</text>
					<text x={isl.labelPos[0]} y={isl.labelPos[1] + 17} class="isle-value isle-label-outline" text-anchor="middle" pointer-events="none">+{isl.value}</text>
					<text x={isl.labelPos[0]} y={isl.labelPos[1] + 17} class="isle-value" text-anchor="middle" pointer-events="none">+{isl.value}</text>
				{/each}
				<!-- Named water features: bays and lakes -->
				{#each $game.map.waterFeatures ?? [] as wf}
					<text x={wf.center[0]} y={wf.center[1] + 4} class="water-label water-label-outline" text-anchor="middle" pointer-events="none">{wf.name}</text>
					<text x={wf.center[0]} y={wf.center[1] + 4} class="water-label" text-anchor="middle" pointer-events="none">{wf.name}</text>
				{/each}
				<!-- Drag arrow (attack = gold, move = cyan, no valid drop = dashed white) -->
				{#if dragFrom != null && dragPt}
					{@const src = $game.map.grids[dragFrom]}
					{@const overAttack = hoveredGrid != null && isValidAttackTarget(dragFrom, hoveredGrid)}
					{@const overMove = hoveredGrid != null && isValidMoveTarget(dragFrom, hoveredGrid)}
					{@const overFerry = hoveredGrid != null && isValidFerryTarget(dragFrom, hoveredGrid)}
					{@const overInvade = hoveredGrid != null && isValidInvasionTarget(dragFrom, hoveredGrid)}
					{@const overArt = hoveredGrid != null && isValidArtilleryTarget(dragFrom, hoveredGrid)}
					{@const arrowColor = overAttack ? '#ffe14a' : overMove ? '#7fcfff' : overFerry ? '#c68fff' : overInvade ? '#ff6a6a' : overArt ? '#ff8a00' : '#fff'}
					<defs>
						<marker id="drag-arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
							<path d="M0,0 L10,5 L0,10 Z" fill={arrowColor} />
						</marker>
					</defs>
					<line
						x1={src.x} y1={src.y}
						x2={dragPt.x} y2={dragPt.y}
						stroke={arrowColor}
						stroke-width="4"
						stroke-linecap="round"
						stroke-dasharray={(overAttack || overMove || overFerry || overInvade || overArt) ? 'none' : '8 6'}
						marker-end="url(#drag-arrowhead)"
						pointer-events="none"
					/>
				{/if}
			</svg>
		</div>

		<aside class="side">
			<section class="panel">
				<h3>{PLAYER_NAMES[$game.current]}'s turn — {$game.phase}</h3>
				{#if $game.current === HUMAN && $game.phase === 'placing'}
					<p class="hint">Armies remaining: <strong>{$game.armiesToPlace}</strong>. Click one of your territories.</p>
				{/if}

				{#if $game.current === HUMAN && $game.phase === 'action'}
					<div class="row">
						<button onclick={beginAttack}>Attack</button>
						<button onclick={beginMove}>Move</button>
						<button onclick={endTurn}>Pass</button>
						<button onclick={cancelAction}>Cancel</button>
					</div>
				{/if}

				{#if $game.current === HUMAN && ($game.phase === 'attack_select_from' || $game.phase === 'attack_select_to')}
					<div class="row">
						<button onclick={quitAttack}>Cancel Attack</button>
					</div>
					{#if $game.phase === 'attack_select_to' && $game.selectedFrom != null}
						{@const target = hoveredGrid != null && isSelectable(hoveredGrid, $game) ? hoveredGrid : null}
						{#if target != null}
							{@const atkA = $game.states[$game.selectedFrom].armies}
							{@const defA = $game.states[target].armies}
							{@const defB = defenseBonus($game, target, $game.selectedFrom)}
							{@const atkB = attackerBonus($game, target)}
							{@const wp = Math.round(winProbability(atkA, defA, defB, atkB) * 100)}
							{@const modTxt = defB ? ` +${defB} def` : atkB ? ` (atk +${atkB} 🌲)` : ''}
							<p class="hint">{gridLabelLocal($game.selectedFrom, $game)} ({atkA}) vs {gridLabelLocal(target, $game)} ({defA}{modTxt}) · <strong style="color:{wp >= 65 ? '#7fff7f' : wp >= 35 ? '#ffd67f' : '#ff7f7f'}">{wp}% win</strong></p>
						{:else}
							<p class="hint">Attackable neighbors are outlined in white. Hover to preview odds.</p>
						{/if}
					{/if}
				{/if}

				{#if $game.current === HUMAN && $game.phase === 'attack_rolling'}
					<p class="hint">Roll the dice in the attack modal.</p>
				{/if}

				{#if $game.current === HUMAN && ($game.phase === 'move_select_from' || $game.phase === 'move_select_to' || $game.phase === 'bomb_select' || $game.phase === 'air_from' || $game.phase === 'air_to' || $game.phase === 'reinforce_select' || $game.phase === 'sabotage_select' || $game.phase === 'fortify_select' || $game.phase === 'ferry_from' || $game.phase === 'ferry_to' || $game.phase === 'invasion_from' || $game.phase === 'invasion_to' || $game.phase === 'artillery_from' || $game.phase === 'artillery_to' || $game.phase === 'deforest_select' || $game.phase === 'oasis_select' || $game.phase === 'storm_from' || $game.phase === 'storm_to')}
					<div class="row">
						<button onclick={cancelAction}>Cancel</button>
					</div>
				{/if}

				{#if $game.current !== HUMAN}
					<p class="hint">🤖 {PLAYER_NAMES[$game.current]} is thinking…</p>
				{/if}
			</section>

			<section class="panel">
				{#if $game.current === HUMAN && $game.phase === 'discard'}
					<h3>Discard a card ({$game.hands[HUMAN].length} — over hand limit)</h3>
				{:else}
					<h3>Your cards ({$game.hands[HUMAN].length})</h3>
				{/if}
				{#if $game.hands[HUMAN].length === 0}
					<p class="hint">No cards.</p>
				{:else}
					{#if $game.current === HUMAN && $game.phase === 'discard'}
						<p class="hint">Hand is over the limit — click a card to discard it.</p>
					{/if}
					<div class="card-grid">
						{#each $game.hands[HUMAN] as c, i}
							{@const meta = CARD_META[c]}
							{@const isDiscarding = $game.current === HUMAN && $game.phase === 'discard'}
							{@const disabled = !isDiscarding && $game.cardPlayedThisTurn && c !== 'antibomb'}
							<button
								class="card-tile kind-{meta.kind}"
								class:disabled
								class:discardable={isDiscarding}
								disabled={disabled}
								onclick={() => (isDiscarding ? discardCard(i) : playCard(i))}
								onpointerenter={(e) => onCardHoverEnter(c, e)}
								onpointerleave={onCardHoverLeave}
								onpointermove={(e) => onCardHoverMove(e)}
							>
								<div class="card-icon">{meta.icon}</div>
								<div class="card-name">{CARD_LABELS[c]}</div>
							</button>
						{/each}
					</div>
					{#if $game.cardPlayedThisTurn && !($game.current === HUMAN && $game.phase === 'discard')}
						<p class="hint">Only one card this turn — already played.</p>
					{/if}
				{/if}
			</section>

			<section class="panel">
				<h3>Log</h3>
				<!-- Latest 5 entries render expanded as text rows; older ones collapse
				     to the chip grid. -->
				{#if $game.log.length > 0}
					<ul class="log-recent">
						{#each $game.log.slice(0, 5) as e}
							<li class="kind-{e.kind ?? 'info'}">
								<span class="lr-turn">T{e.turn}</span>
								{#if e.player}
									<span class="lr-dot" style="background:{PLAYER_COLORS[e.player]}"></span>
								{/if}
								<span class="lr-text">{e.text}</span>
							</li>
						{/each}
					</ul>
				{/if}
				<div class="log-grid">
					{#each $game.log.slice(5) as e, j}
						{@const i = j + 5}
						<button
							class="log-chip kind-{e.kind ?? 'info'}"
							style={e.player ? `--player:${PLAYER_COLORS[e.player]}` : ''}
							onpointerenter={(ev) => onLogHoverEnter(i, ev)}
							onpointermove={onLogHoverMove}
							onpointerleave={onLogHoverLeave}
							aria-label={e.text}
						>
							<span class="chip-turn">T{e.turn}</span>
							<span class="chip-icon">{logIcon(e.kind ?? 'info')}</span>
						</button>
					{/each}
				</div>
			</section>
		</aside>
	</div>

	{#if isQtyPhase() && qtySourceHex() != null}
		{@const src = qtySourceHex()!}
		{@const srcArmies = $game.states[src].armies}
		{@const info = qtyInfo(srcArmies)}
		{@const dstId = $game.phase !== 'placing' ? $game.selectedTo : null}
		{@const qtyHR = 62}
		{@const qtyHexPts = [0,1,2,3,4,5]
			.map((i) => {
				const a = (Math.PI / 3) * i - Math.PI / 2;
				return `${100 + qtyHR * Math.cos(a)},${90 + qtyHR * Math.sin(a)}`;
			}).join(' ')}
		<div class="qty-modal-backdrop" onclick={cancelQty} role="presentation">
			<div class="qty-modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-label={info.title}>
				<div class="qty-modal-title">{info.title}</div>
				{#snippet qtyHex(gridId: number)}
					{@const g = $game.map.grids[gridId]}
					{@const owner = $game.states[gridId].owner}
					{@const color = owner ? PLAYER_COLORS[owner] : '#556'}
					<svg class="side-hex" viewBox="0 0 200 180" xmlns="http://www.w3.org/2000/svg">
						<polygon points={qtyHexPts} fill={color} stroke="#0a1420" stroke-width="2" />
						{@render hexTerrain(qtyHexPts, g.terrain)}
						{@render hexBadge(gridId, 100, 90, 1.4, false)}
					</svg>
				{/snippet}
				{#if dstId != null}
					<div class="qty-hex-row">
						{@render qtyHex(src)}
						<div class="qty-arrow" aria-hidden="true">→</div>
						{@render qtyHex(dstId)}
					</div>
					{@const dstG = $game.map.grids[dstId]}
					{#if dstG.terrain === 'desert' || dstG.terrain === 'mountain' || dstG.terrain === 'forest' || dstG.terrain === 'marsh'}
						<ul class="qty-mods">
							{#if dstG.terrain === 'desert'}<li class="warn">🏜 Desert — 1 army lost to heat on arrival</li>{/if}
							{#if dstG.terrain === 'mountain'}<li>⛰ Mountain — defender bonus if attacked from here</li>{/if}
							{#if dstG.terrain === 'forest'}<li>🌲 Forest — attackers get cover on approach</li>{/if}
							{#if dstG.terrain === 'marsh'}<li class="warn">💧 Marsh — can't launch a second attack after using this as a source</li>{/if}
						</ul>
					{/if}
				{:else}
					{@render qtyHex(src)}
				{/if}
				<div class="qty-modal-sub">
					{#if $game.phase === 'placing'}
						On <strong>{gridLabelLocal(src, $game)}</strong>
						· <strong>{$game.armiesToPlace - qtyValue()}</strong> left to place after
					{:else}
						From <strong>{gridLabelLocal(src, $game)}</strong>
						{#if $game.selectedTo != null} → <strong>{gridLabelLocal($game.selectedTo, $game)}</strong>{/if}
						· leaves <strong>{srcArmies - qtyValue()}</strong> behind
					{/if}
				</div>
				<div class="qty-modal-value">{qtyValue()}</div>
				<div class="qty-modal-scale">min {info.min} · max {info.max}</div>
				<div class="qty-modal-grid">
					<button onclick={() => bumpQty(-5)} disabled={qtyValue() <= info.min}>−5</button>
					<button onclick={() => bumpQty(-1)} disabled={qtyValue() <= info.min}>−1</button>
					<button onclick={() => bumpQty(1)} disabled={qtyValue() >= info.max}>+1</button>
					<button onclick={() => bumpQty(5)} disabled={qtyValue() >= info.max}>+5</button>
				</div>
				<div class="qty-modal-grid two">
					<button onclick={() => setQty(info.min)}>{info.min === 0 ? 'None' : 'Min (1)'}</button>
					<button onclick={() => setQty(info.max)}>Max ({info.max})</button>
				</div>
				<div class="qty-modal-actions">
					<button onclick={cancelQty}>Cancel</button>
					<button class="primary" onclick={confirmQty}>{info.confirmLabel}</button>
				</div>
			</div>
		</div>
	{/if}

	{#if $game.current === HUMAN && $game.phase === 'attack_rolling' && $game.selectedFrom != null && $game.selectedTo != null}
		{@const src = $game.selectedFrom}
		{@const tgt = $game.selectedTo}
		{@const srcSt = $game.states[src]}
		{@const tgtSt = $game.states[tgt]}
		{@const srcG = $game.map.grids[src]}
		{@const tgtG = $game.map.grids[tgt]}
		{@const atkA = srcSt.armies}
		{@const defA = tgtSt.armies}
		{@const defB = defenseBonus($game, tgt, src)}
		{@const atkB = attackerBonus($game, tgt)}
		{@const eliteB = $game.eliteAttackActive ? 2 : 0}
		{@const xBonus = crossingDefenseBonus($game, src, tgt)}
		{@const bridgeCancels = $game.bridgeAttackActive && $game.map.rivers.some(([a,b]) => (a===src && b===tgt) || (a===tgt && b===src))}
		{@const wp = Math.round(winProbability(atkA, defA, defB, atkB + eliteB) * 100)}
		<div class="attack-modal-backdrop" role="presentation">
			<div class="attack-modal" role="dialog" aria-label="Attack">
				<div class="attack-title">
					<span>Attack</span>
					<span class="attack-wp" style="color:{wp >= 65 ? '#7fff7f' : wp >= 35 ? '#ffd67f' : '#ff7f7f'}">{wp}% win</span>
				</div>
				<div class="attack-hexes">
					{#snippet attackHex(gridId: number, role: 'attacker' | 'defender', roleLabel: string)}
						{@const g = $game.map.grids[gridId]}
						{@const st = $game.states[gridId]}
						{@const owner = st.owner}
						{@const color = owner ? PLAYER_COLORS[owner] : '#556'}
						{@const cx = 100}
						{@const cy = 90}
						{@const HR = 62}
						{@const hexPts = [0,1,2,3,4,5]
							.map((i) => {
								const a = (Math.PI / 3) * i - Math.PI / 2;
								return `${cx + HR * Math.cos(a)},${cy + HR * Math.sin(a)}`;
							}).join(' ')}
						<div class="attack-side {role}">
							<div class="side-label">{roleLabel}</div>
							<div class="side-name">{gridLabelLocal(gridId, $game)}{g.cityName ? ` · ${g.cityName}` : ''}</div>
							<div class="side-owner" style="color:{color}">{owner ? PLAYER_NAMES[owner] : 'Neutral'}</div>
							<svg class="side-hex" viewBox="0 0 200 180" xmlns="http://www.w3.org/2000/svg">
								<polygon points={hexPts} fill={color} stroke="#0a1420" stroke-width="2" />
								{@render hexTerrain(hexPts, g.terrain)}
								{@render hexBadge(gridId, cx, cy, 1.4, false)}
							</svg>
							<ul class="side-mods">
								<li>Base die 1–{debugDieSides}</li>
								{#if role === 'attacker'}
									{#if atkB > 0}<li class="pos">+{atkB} 🌲 forest cover on target</li>{/if}
									{#if eliteB > 0}<li class="pos">+{eliteB} 🛡 Elite Troops</li>{/if}
									{#if g.terrain === 'marsh'}<li class="warn">Marsh — cannot re-attack from here this turn</li>{/if}
								{:else}
									{#if g.terrain === 'mountain'}<li class="pos">+1 ⛰ mountain</li>{/if}
									{#if st.fortified}<li class="pos">+2 🛡 fortified</li>{/if}
									{#if xBonus === 2}<li class="pos">+2 ⚓ sea-lane crossing</li>{/if}
									{#if xBonus === 1}<li class="pos">+1 💧 river crossing</li>{/if}
									{#if bridgeCancels}<li class="warn">🌉 Bridge cancels river bonus</li>{/if}
									{#if g.terrain === 'forest'}<li class="warn">Forest — attacker gets +1</li>{/if}
									{#if g.terrain === 'desert'}<li class="warn">Desert — heat burns 1 army when moving in</li>{/if}
								{/if}
							</ul>
						</div>
					{/snippet}
					{@render attackHex(src, 'attacker', 'Attacker')}
					<div class="attack-vs">vs</div>
					{@render attackHex(tgt, 'defender', 'Defender')}
				</div>
				<div class="attack-actions">
					{#if autoRolling}
						<button onclick={stopAutoRoll}>Stop</button>
					{:else}
						<button class="primary" onclick={rollAttack}>Roll</button>
						<button onclick={startAutoRoll}>Auto-Roll</button>
					{/if}
					<button onclick={quitAttack} disabled={autoRolling}>Cancel</button>
				</div>
			</div>
		</div>
	{/if}

	{#if $game.history}
	{@const hist = $game.history}
	{@const maxTerr = Math.max(1, ...hist.flatMap((h) => PLAYERS.map((p) => h.territories[p])))}
	{@const maxArm = Math.max(1, ...hist.flatMap((h) => PLAYERS.map((p) => h.armies[p])))}
	{@const chartW = 560}
	{@const chartH = 180}
	{@const xStep = hist.length > 1 ? chartW / (hist.length - 1) : 0}
	<section class="analytics">
		<div class="charts">
			<div class="chart">
				<h3>Territories owned</h3>
				<svg viewBox="0 0 {chartW + 40} {chartH + 30}">
					<line x1="30" y1={chartH + 5} x2={chartW + 35} y2={chartH + 5} stroke="#345" />
					<line x1="30" y1="5" x2="30" y2={chartH + 5} stroke="#345" />
					<text x="26" y="10" text-anchor="end" class="axis">{maxTerr}</text>
					<text x="26" y={chartH + 8} text-anchor="end" class="axis">0</text>
					{#each PLAYERS as p}
						{#if hist.length > 0}
							<polyline
								fill="none"
								stroke={PLAYER_COLORS[p]}
								stroke-width="2"
								points={hist.map((h, i) => `${30 + i * xStep},${5 + (chartH - (h.territories[p] / maxTerr) * chartH)}`).join(' ')}
							/>
						{/if}
					{/each}
				</svg>
			</div>
			<div class="chart">
				<h3>Total armies</h3>
				<svg viewBox="0 0 {chartW + 40} {chartH + 30}">
					<line x1="30" y1={chartH + 5} x2={chartW + 35} y2={chartH + 5} stroke="#345" />
					<line x1="30" y1="5" x2="30" y2={chartH + 5} stroke="#345" />
					<text x="26" y="10" text-anchor="end" class="axis">{maxArm}</text>
					<text x="26" y={chartH + 8} text-anchor="end" class="axis">0</text>
					{#each PLAYERS as p}
						{#if hist.length > 0}
							<polyline
								fill="none"
								stroke={PLAYER_COLORS[p]}
								stroke-width="2"
								points={hist.map((h, i) => `${30 + i * xStep},${5 + (chartH - (h.armies[p] / maxArm) * chartH)}`).join(' ')}
							/>
						{/if}
					{/each}
				</svg>
			</div>
			<div class="chart stat-table">
				<h3>Stats</h3>
				<table class="stats-table">
					<thead>
						<tr>
							<th></th><th>T</th><th>A</th><th>W/L</th><th>+/−</th><th>Cards</th>
						</tr>
					</thead>
					<tbody>
						{#each PLAYERS as p}
							{@const last = hist[hist.length - 1]}
							{@const st = $game.stats[p]}
							<tr>
								<td><span class="dot" style="background:{PLAYER_COLORS[p]}"></span> {PLAYER_NAMES[p]}</td>
								<td>{last?.territories[p] ?? 0}</td>
								<td>{last?.armies[p] ?? 0}</td>
								<td>{st.attacksWon}/{st.attacksLost}</td>
								<td>{st.territoriesCaptured}/{st.territoriesLost}</td>
								<td>{st.cardsDrawn}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	</section>
	{/if}
</main>

{#if hoveredLogIdx != null && logTipPos && $game.log[hoveredLogIdx]}
	{@const le = $game.log[hoveredLogIdx]}
	{@const lp = clampTip(logTipPos.x, logTipPos.y, 300, 100)}
	<div class="log-tooltip kind-{le.kind ?? 'info'}" style="left:{lp.x}px; top:{lp.y}px">
		<div class="lt-header">
			<span class="lt-turn">Turn {le.turn}</span>
			{#if le.player}
				<span class="lt-player-dot" style="background:{PLAYER_COLORS[le.player]}"></span>
				<span class="lt-player-name">{PLAYER_NAMES[le.player]}</span>
			{/if}
			<span class="lt-kind">{logIcon(le.kind ?? 'info')} {le.kind ?? 'info'}</span>
		</div>
		<div class="lt-text">{le.text}</div>
	</div>
{/if}

{#if hoveredCard != null && cardTipPos}
	{@const cm = CARD_META[hoveredCard]}
	{@const cp = clampTip(cardTipPos.x, cardTipPos.y, 280, 140)}
	<div class="card-tooltip kind-{cm.kind}" style="left:{cp.x}px; top:{cp.y}px">
		<div class="ct-header">
			<span class="ct-icon">{cm.icon}</span>
			<strong>{CARD_LABELS[hoveredCard]}</strong>
			<span class="ct-kind">{cm.kind}</span>
		</div>
		<div class="ct-desc">{cm.desc}</div>
		<div class="ct-when">Playable: {cm.when}</div>
	</div>
{/if}

{#if hoveredGrid != null && tooltipPos}
	{@const info = hexInfo(hoveredGrid)}
	{@const hp = clampTip(tooltipPos.x, tooltipPos.y, 280, 180)}
	<div class="hex-tooltip" style="left:{hp.x}px; top:{hp.y}px">
		<div class="tt-title">
			<span class="tt-owner-dot" style="background:{info.ownerColor}"></span>
			<strong>{info.title}</strong>
			<span class="tt-armies">{info.armies}</span>
		</div>
		<div class="tt-owner">{info.owner}</div>
		{#if info.city}<div class="tt-city">★ {info.city}</div>{/if}
		{#each info.modifiers as m}
			<div class="tt-terrain">
				<div class="tt-terrain-name">{m.name}</div>
				{#if m.desc}<div class="tt-terrain-desc">{m.desc}</div>{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	:global(body) {
		background: #0a1420;
		color: #d0e6f5;
		font-family: 'Segoe UI', system-ui, sans-serif;
		margin: 0;
	}
	main {
		max-width: 1400px;
		margin: 0 auto;
		padding: 0.75rem;
	}
	header {
		border: 1px solid #1a3040;
		padding: 0.35rem 0.6rem;
		background: #0f2035;
		margin-bottom: 0.5rem;
	}
	.header-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.scoreboard {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
		flex: 1 1 auto;
	}
	.score {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.15rem 0.45rem;
		border: 1px solid #1a3040;
		background: #081826;
		font-size: 0.82rem;
		border-radius: 4px;
	}
	.score.current { border-color: #7fcfff; box-shadow: 0 0 6px #4a9fcf; }
	.score.dead { opacity: 0.4; text-decoration: line-through; }
	.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
	.score-nums { font-family: monospace; }
	.score-nums .dim { color: #6a9abf; }
	.bonus { color: #ffe14a; font-family: monospace; font-size: 0.78rem; }
	.actions { display: flex; gap: 0.35rem; align-items: center; margin-left: auto; }
	.speed { display: flex; align-items: center; }
	.speed select { width: auto; padding: 0.1rem 0.25rem; font-size: 0.8rem; }
	.turn {
		color: #7fcfff;
		font-family: monospace;
		font-size: 0.85rem;
		padding: 0.15rem 0.4rem;
		border: 1px solid #1a3040;
		border-radius: 4px;
	}
	.icon-btn {
		padding: 0.2rem 0.55rem;
		font-size: 0.8rem;
	}

	.menu {
		padding: 1rem;
		border: 1px solid #1a3040;
		background: #0f2035;
		margin-bottom: 0.75rem;
		display: flex;
		gap: 1rem;
		align-items: end;
		flex-wrap: wrap;
	}
	.menu label { display: flex; flex-direction: column; gap: 0.25rem; }

	.msg {
		padding: 0.5rem;
		background: #0f2035;
		border-left: 3px solid #7fcfff;
		margin-bottom: 0.5rem;
		font-family: monospace;
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr 320px;
		gap: 0.75rem;
	}
	@media (max-width: 1000px) {
		.grid { grid-template-columns: 1fr; }
	}
	.mapwrap { background: #0f2035; border: 1px solid #1a3040; }
	.map { width: 100%; height: auto; display: block; }
	.side { display: flex; flex-direction: column; gap: 0.5rem; }
	.panel {
		border: 1px solid #1a3040;
		background: #0f2035;
		padding: 0.5rem 0.75rem;
	}
	.panel h3 {
		margin: 0 0 0.4rem;
		color: #7fcfff;
		font-size: 0.9rem;
		text-transform: uppercase;
		letter-spacing: 0.1rem;
	}
	.row { display: flex; gap: 0.4rem; align-items: end; flex-wrap: wrap; margin-top: 0.25rem; }
	.qty-panel { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.25rem; }
	.qty-input {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		background: #081826;
		border: 1px solid #1a3040;
		padding: 0.35rem 0.5rem;
	}
	.qty-input span { color: #6a9abf; font-size: 0.85rem; }
	.qty-input input { width: 90px; text-align: right; font-size: 1rem; }
	.qty-buttons {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.35rem;
	}
	.qty-buttons button { padding: 0.4rem 0.5rem; }
	.qty-buttons button.primary { background: #2a5a8a; border-color: #7fcfff; grid-column: span 2; }
	.qty-buttons button.primary:hover:not(:disabled) { background: #3a6a9a; }
	.hint { color: #6a9abf; font-size: 0.85rem; margin: 0.4rem 0 0; }

	button {
		background: #1a3a5a;
		color: #d0e6f5;
		border: 1px solid #2a5a8a;
		padding: 0.3rem 0.6rem;
		cursor: pointer;
		font-family: inherit;
	}
	button:hover:not(:disabled) { background: #2a5a8a; }
	button:disabled { opacity: 0.4; cursor: not-allowed; }
	button.danger { background: #4a1a1a; border-color: #8a3a3a; color: #ffdcdc; }
	button.danger:hover:not(:disabled) { background: #8a3a3a; }
	.tiny { font-size: 0.7rem; padding: 0.15rem 0.4rem; }
	input, select {
		background: #081826;
		color: #d0e6f5;
		border: 1px solid #1a3040;
		padding: 0.2rem 0.35rem;
		font-family: inherit;
		width: 70px;
	}

	.territory { cursor: default; transition: filter 0.15s, stroke 0.15s; outline: none; }
	.territory:focus, .territory:focus-visible { outline: none; }
	/* No custom stroke on mountain hexes — the tiled pattern is enough. */
	.territory.selectable {
		cursor: pointer;
		stroke: #ffffff !important;
		stroke-width: 3 !important;
		filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.65));
	}
	.territory.selectable:hover { filter: brightness(1.4) drop-shadow(0 0 6px #fff); }
	.territory.selected-from { stroke: #fff !important; stroke-width: 4 !important; filter: drop-shadow(0 0 8px #fff) !important; }
	.territory.selected-to { stroke: #ff0 !important; stroke-width: 4 !important; filter: drop-shadow(0 0 8px #ffff7f) !important; }
	.territory.drag-source { stroke: #ffffff !important; stroke-width: 4 !important; filter: drop-shadow(0 0 10px #fff) !important; }
	.territory.drag-attack-candidate { stroke: #ffe14a !important; stroke-width: 3 !important; filter: drop-shadow(0 0 6px rgba(255, 225, 74, 0.7)); }
	.territory.drag-attack-target { stroke: #ffe14a !important; stroke-width: 5 !important; filter: drop-shadow(0 0 14px #ffe14a) !important; }
	.territory.drag-move-candidate { stroke: #7fcfff !important; stroke-width: 3 !important; filter: drop-shadow(0 0 6px rgba(127, 207, 255, 0.7)); }
	.territory.drag-move-target { stroke: #7fcfff !important; stroke-width: 5 !important; filter: drop-shadow(0 0 14px #7fcfff) !important; }
	.territory.drag-ferry-candidate { stroke: #c68fff !important; stroke-width: 3 !important; filter: drop-shadow(0 0 6px rgba(198, 143, 255, 0.7)); }
	.territory.drag-ferry-target { stroke: #c68fff !important; stroke-width: 5 !important; filter: drop-shadow(0 0 14px #c68fff) !important; }
	.territory.drag-invade-candidate { stroke: #ff6a6a !important; stroke-width: 3 !important; filter: drop-shadow(0 0 6px rgba(255, 106, 106, 0.7)); }
	.territory.drag-invade-target { stroke: #ff6a6a !important; stroke-width: 5 !important; filter: drop-shadow(0 0 14px #ff6a6a) !important; }
	.territory.drag-artillery-candidate { stroke: #ff8a00 !important; stroke-width: 3 !important; filter: drop-shadow(0 0 6px rgba(255, 138, 0, 0.7)); }
	.territory.drag-artillery-target { stroke: #ff8a00 !important; stroke-width: 5 !important; filter: drop-shadow(0 0 14px #ff8a00) !important; }
	.map { touch-action: none; user-select: none; }
	.node-label {
		fill: #fff;
		font-size: 20px;
		font-family: monospace;
		pointer-events: none;
		font-weight: bold;
	}
	.prod-star {
		fill: #ffe14a;
		font-size: 18px;
		pointer-events: none;
	}
	.fort-icon {
		font-size: 16px;
		pointer-events: none;
		filter: drop-shadow(0 0 3px #7fcfff);
	}
	.isle-label {
		fill: #e0f0ff;
		font-size: 20px;
		font-family: 'Georgia', 'Times New Roman', serif;
		font-weight: bold;
		letter-spacing: 0.1em;
		opacity: 0.98;
		pointer-events: none;
	}
	.water-label {
		fill: #7aaccc;
		font-size: 15px;
		font-family: 'Georgia', 'Times New Roman', serif;
		font-style: italic;
		letter-spacing: 0.05em;
		opacity: 0.85;
		pointer-events: none;
	}
	.water-label-outline {
		fill: none;
		stroke: #0a1420;
		stroke-width: 2.5px;
		stroke-linejoin: round;
		paint-order: stroke;
	}
	.isle-label-outline {
		fill: none;
		stroke: #0a1420;
		stroke-width: 4px;
		stroke-linejoin: round;
		paint-order: stroke;
	}
	.isle-value {
		fill: #ffe14a;
		font-size: 14px;
		font-family: 'Georgia', 'Times New Roman', serif;
		font-weight: bold;
		opacity: 0.95;
		pointer-events: none;
	}
	.city-label {
		fill: #ffe14a;
		font-size: 11px;
		font-family: 'Georgia', 'Times New Roman', serif;
		font-style: italic;
		font-weight: bold;
		pointer-events: none;
	}
	.city-label-outline {
		fill: none;
		stroke: #0a1420;
		stroke-width: 3px;
		stroke-linejoin: round;
		paint-order: stroke;
	}

	.card-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.4rem;
	}
	.card-tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 0.25rem;
		border-radius: 6px;
		background: linear-gradient(180deg, #0e2a48, #081826);
		border: 1px solid #2a4a6a;
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03), 0 2px 4px rgba(0, 0, 0, 0.35);
		cursor: pointer;
		min-height: 74px;
		transition: transform 0.1s, box-shadow 0.1s;
		color: #d0e6f5;
		font-family: inherit;
	}
	.card-tile:hover:not(.disabled) {
		transform: translateY(-2px);
		box-shadow: 0 4px 12px rgba(74, 159, 207, 0.35);
	}
	.card-tile.disabled { opacity: 0.35; cursor: not-allowed; }
	.card-tile.discardable { outline: 2px dashed #ff8080; outline-offset: -3px; }
	.card-tile.discardable:hover { background: rgba(255, 90, 90, 0.15); }
	.card-tile .card-icon {
		font-size: 1.6rem;
		line-height: 1;
		margin-bottom: 0.3rem;
	}
	.card-tile .card-name {
		font-size: 0.7rem;
		text-align: center;
		font-weight: bold;
		letter-spacing: 0.03em;
		color: #e0f0ff;
		line-height: 1.15;
	}
	/* Category tints */
	.card-tile.kind-attack { border-top: 3px solid #ff6a6a; }
	.card-tile.kind-defense { border-top: 3px solid #7fcfff; }
	.card-tile.kind-boost { border-top: 3px solid #ffe14a; }
	.card-tile.kind-movement { border-top: 3px solid #c68fff; }
	.card-tile.kind-terrain { border-top: 3px solid #7fff7f; }

	.card-tooltip {
		position: fixed;
		z-index: 1000;
		background: #0a1420;
		border: 1px solid #2a4a6a;
		border-radius: 6px;
		padding: 0.6rem 0.75rem;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
		color: #d0e6f5;
		font-size: 0.82rem;
		min-width: 220px;
		max-width: 280px;
		pointer-events: none;
	}
	.card-tooltip.kind-attack { border-top: 3px solid #ff6a6a; }
	.card-tooltip.kind-defense { border-top: 3px solid #7fcfff; }
	.card-tooltip.kind-boost { border-top: 3px solid #ffe14a; }
	.card-tooltip.kind-movement { border-top: 3px solid #c68fff; }
	.card-tooltip.kind-terrain { border-top: 3px solid #7fff7f; }
	.ct-header { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.35rem; }
	.ct-header strong { color: #e0f0ff; font-size: 0.95rem; }
	.ct-icon { font-size: 1.3rem; line-height: 1; }
	.ct-kind {
		margin-left: auto;
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: #7fcfff;
		background: #10304a;
		padding: 2px 6px;
		border-radius: 3px;
	}
	.ct-desc { color: #d0e6f5; line-height: 1.4; margin-bottom: 0.35rem; }
	.ct-when { color: #7fcfff; font-size: 0.72rem; }
	.log-recent {
		list-style: none;
		padding: 0;
		margin: 0 0 0.5rem;
		font-size: 0.8rem;
	}
	.log-recent li {
		display: flex;
		align-items: baseline;
		gap: 0.35rem;
		padding: 0.25rem 0;
		border-bottom: 1px solid #1a3040;
	}
	.log-recent li:last-child { border-bottom: none; }
	.log-recent .lr-turn { color: #4a7a9a; font-family: monospace; font-size: 0.7rem; }
	.log-recent .lr-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; }
	.log-recent .lr-text { flex: 1; line-height: 1.35; color: #d0e6f5; }
	.log-recent li.kind-attack .lr-text { color: #ffbb99; }
	.log-recent li.kind-card .lr-text { color: #ffe14a; }
	.log-recent li.kind-event .lr-text { color: #ff99ff; }
	.log-recent li.kind-defeat .lr-text { color: #ff9999; }

	.log-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		max-height: 260px;
		overflow-y: auto;
		padding: 2px;
	}
	.log-chip {
		--player: #4a7a9a;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 1px solid var(--player);
		border-radius: 4px;
		background: #081826;
		cursor: pointer;
		color: var(--player);
		transition: transform 0.08s, background 0.08s;
	}
	.log-chip:hover { transform: translateY(-1px); background: #10304a; }
	.chip-turn { font-family: monospace; font-size: 0.55rem; line-height: 1; color: #6a9abf; margin-top: 1px; }
	.chip-icon { font-size: 0.95rem; line-height: 1; margin-top: -1px; }
	/* Kind tints for the left bar / icon color */
	.log-chip.kind-attack { border-left: 3px solid #ffbb99; }
	.log-chip.kind-attack .chip-icon { color: #ffbb99; }
	.log-chip.kind-defeat { border-left: 3px solid #ff9999; }
	.log-chip.kind-defeat .chip-icon { color: #ff9999; }
	.log-chip.kind-card { border-left: 3px solid #ffe14a; }
	.log-chip.kind-card .chip-icon { color: #ffe14a; }
	.log-chip.kind-event { border-left: 3px solid #ff99ff; }
	.log-chip.kind-event .chip-icon { color: #ff99ff; }
	.log-chip.kind-info .chip-icon { color: #6a9abf; }

	.log-tooltip {
		position: fixed;
		z-index: 1000;
		background: #0a1420;
		border: 1px solid #2a4a6a;
		border-radius: 6px;
		padding: 0.55rem 0.7rem;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
		color: #d0e6f5;
		font-size: 0.82rem;
		min-width: 220px;
		max-width: 300px;
		pointer-events: none;
	}
	.log-tooltip.kind-attack { border-top: 3px solid #ffbb99; }
	.log-tooltip.kind-defeat { border-top: 3px solid #ff9999; }
	.log-tooltip.kind-card { border-top: 3px solid #ffe14a; }
	.log-tooltip.kind-event { border-top: 3px solid #ff99ff; }
	.log-tooltip.kind-info { border-top: 3px solid #6a9abf; }
	.lt-header {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.72rem;
		margin-bottom: 0.35rem;
	}
	.lt-turn { color: #7fcfff; font-family: monospace; }
	.lt-player-dot { width: 9px; height: 9px; border-radius: 50%; }
	.lt-player-name { color: #d0e6f5; }
	.lt-kind {
		margin-left: auto;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #7a9abf;
	}
	.lt-text { color: #e0f0ff; line-height: 1.35; }

	.analytics {
		border: 1px solid #1a3040;
		background: #0f2035;
		padding: 0.75rem 1rem;
		margin-top: 0.75rem;
	}
	.charts {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: 1rem;
	}
	.chart.stat-table { min-width: 0; }
	.chart.stat-table table { font-size: 0.75rem; }
	.dbg-row { display: flex; align-items: center; gap: 0.5rem; margin: 0.35rem 0; }

	.qty-modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(4, 10, 20, 0.65);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1500;
	}
	.qty-modal {
		background: linear-gradient(180deg, #10304a, #0a1a2c);
		border: 2px solid #4a9fcf;
		border-radius: 10px;
		padding: 1.5rem 1.75rem;
		min-width: 340px;
		max-width: 440px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5), 0 0 30px rgba(74, 159, 207, 0.3);
	}
	.qty-modal-title {
		color: #e0f0ff;
		font-size: 1.05rem;
		font-weight: bold;
		text-align: center;
	}
	.qty-modal-sub {
		color: #a8bfd4;
		font-size: 0.82rem;
		text-align: center;
		margin: 0.25rem 0 0.85rem;
	}
	.qty-modal-value {
		font-size: 3rem;
		font-family: monospace;
		font-weight: bold;
		color: #ffe14a;
		text-align: center;
		line-height: 1;
	}
	.qty-modal-scale {
		color: #6a9abf;
		font-size: 0.72rem;
		font-family: monospace;
		text-align: center;
		margin: 0.2rem 0 1rem;
	}
	.qty-modal-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.4rem;
		margin-bottom: 0.5rem;
	}
	.qty-modal-grid.two { grid-template-columns: repeat(2, 1fr); }
	.qty-modal-grid button {
		padding: 0.55rem 0.4rem;
		font-family: monospace;
		font-weight: bold;
		font-size: 0.95rem;
	}
	.qty-modal-actions {
		display: grid;
		grid-template-columns: 1fr 2fr;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}
	.qty-modal-actions button { padding: 0.7rem 0.5rem; font-size: 0.95rem; font-weight: bold; }
	.qty-hex-row {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		gap: 0.5rem;
	}
	.qty-arrow {
		color: #ffe14a;
		font-size: 2rem;
		font-weight: bold;
		text-align: center;
		user-select: none;
	}
	.qty-mods {
		list-style: none;
		padding: 0;
		margin: 0.35rem 0 0.25rem;
		font-size: 0.82rem;
		color: #c8d8ea;
	}
	.qty-mods li { padding: 0.15rem 0; }
	.qty-mods li.pos { color: #7fff9f; }
	.qty-mods li.warn { color: #ffb37f; }

	.attack-modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(4, 10, 20, 0.7);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1500;
	}
	.attack-modal {
		background: linear-gradient(180deg, #10304a, #0a1a2c);
		border: 2px solid #ffe14a;
		border-radius: 12px;
		padding: 1.25rem 1.5rem;
		min-width: 620px;
		max-width: 780px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 30px rgba(255, 225, 74, 0.2);
	}
	.attack-title {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		color: #e0f0ff;
		font-size: 1.15rem;
		font-weight: bold;
		border-bottom: 1px solid #234;
		padding-bottom: 0.5rem;
		margin-bottom: 0.75rem;
	}
	.attack-wp { font-size: 1.05rem; font-family: monospace; }
	.attack-hexes {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: stretch;
		gap: 0.75rem;
	}
	.attack-side {
		border: 1px solid #234;
		border-radius: 10px;
		padding: 0.75rem 0.85rem;
		background: rgba(0, 0, 0, 0.25);
		display: flex;
		flex-direction: column;
		align-items: stretch;
	}
	.side-hex {
		display: block;
		width: 100%;
		max-width: 220px;
		height: auto;
		margin: 0.35rem auto 0.5rem;
	}
	.side-label {
		color: #8fb0d0;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.side-name { color: #e8f2ff; font-weight: bold; font-size: 1rem; margin-top: 0.1rem; }
	.side-owner { font-size: 0.85rem; font-weight: bold; margin-bottom: 0.35rem; }
	.side-armies {
		font-size: 2.4rem;
		font-family: monospace;
		font-weight: bold;
		color: #ffe14a;
		text-align: center;
		line-height: 1;
		margin-top: 0.15rem;
	}
	.side-armies-label {
		text-align: center;
		color: #7fa0c0;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		margin-bottom: 0.4rem;
	}
	.side-mods {
		list-style: none;
		padding: 0;
		margin: 0;
		font-size: 0.82rem;
		color: #c8d8ea;
	}
	.side-mods li { padding: 0.15rem 0; }
	.side-mods li.pos { color: #7fff9f; }
	.side-mods li.warn { color: #ffb37f; }
	.attack-vs {
		align-self: center;
		color: #6a8ab0;
		font-family: 'Georgia', serif;
		font-style: italic;
		font-size: 1.15rem;
	}
	.attack-actions {
		display: grid;
		grid-template-columns: 2fr 2fr 1fr;
		gap: 0.5rem;
		margin-top: 0.9rem;
	}
	.attack-actions button {
		padding: 0.75rem 0.5rem;
		font-size: 0.95rem;
		font-weight: bold;
	}
	.attack-actions .primary {
		background: #ffe14a;
		color: #1a1a1a;
	}

	.debug-panel {
		border: 1px solid #4a3a1a;
		background: linear-gradient(180deg, #1a1a20, #12121a);
		border-radius: 8px;
		padding: 1rem 1.25rem 0.85rem;
		margin: 0 0 0.75rem;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4), inset 0 0 20px rgba(255, 190, 60, 0.03);
	}
	.debug-header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.75rem;
	}
	.debug-header h2 {
		margin: 0;
		color: #e0e0ea;
		font-size: 1.05rem;
		letter-spacing: 0.05em;
		font-weight: 500;
	}
	.debug-badge {
		background: repeating-linear-gradient(45deg, #ffbe3c, #ffbe3c 5px, #1a1a20 5px, #1a1a20 10px);
		color: #1a1a20;
		font-family: monospace;
		font-size: 0.7rem;
		font-weight: bold;
		padding: 0.2rem 0.55rem;
		border-radius: 3px;
		letter-spacing: 0.15em;
	}
	.close-x {
		margin-left: auto;
		background: transparent;
		border: none;
		color: #7a7a85;
		font-size: 1rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
	}
	.close-x:hover { color: #e0e0ea; background: rgba(255, 255, 255, 0.05); }

	.debug-options {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.7rem;
	}
	@media (max-width: 800px) {
		.debug-options { grid-template-columns: 1fr; }
	}
	.toggle-card {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem 0.85rem;
		background: #0f1218;
		border: 1px solid #2a2a35;
		border-radius: 6px;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
	}
	.toggle-card:hover { border-color: #4a4a5a; background: #14171f; }
	.toggle-card.on { border-color: #ffbe3c; background: #1a1712; }
	.toggle-card input[type='checkbox'] {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.toggle-slot {
		width: 34px;
		height: 20px;
		border-radius: 10px;
		background: #2a2a35;
		position: relative;
		flex: none;
		margin-top: 2px;
		transition: background 0.15s;
	}
	.toggle-card.on .toggle-slot { background: #ffbe3c; }
	.toggle-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 16px;
		height: 16px;
		background: #e0e0ea;
		border-radius: 50%;
		transition: left 0.15s;
	}
	.toggle-card.on .toggle-thumb { left: 16px; background: #1a1a20; }
	.toggle-text { flex: 1; }
	.toggle-title { color: #e0e0ea; font-weight: bold; font-size: 0.9rem; margin-bottom: 0.15rem; }
	.toggle-desc { color: #8a8a95; font-size: 0.78rem; line-height: 1.35; }

	.debug-footer {
		margin-top: 0.65rem;
		color: #7a7a85;
		font-size: 0.75rem;
		font-style: italic;
		text-align: right;
	}
	.die-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		align-items: center;
	}
	.die-btn {
		background: #1a1d26;
		color: #cfd6e2;
		border: 1px solid #33384a;
		border-radius: 6px;
		padding: 0.3rem 0.55rem;
		font-family: monospace;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.die-btn:hover { border-color: #556; }
	.die-btn.on { border-color: #ffbe3c; background: #2a2113; color: #ffdf87; }
	.die-num {
		width: 4.5rem;
		background: #12141a;
		color: #e0e0ea;
		border: 1px solid #33384a;
		border-radius: 6px;
		padding: 0.25rem 0.4rem;
		font-family: monospace;
	}

	.hex-tooltip {
		position: fixed;
		z-index: 1000;
		background: #0a1420;
		border: 1px solid #2a4a6a;
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
		color: #d0e6f5;
		font-size: 0.85rem;
		min-width: 200px;
		max-width: 280px;
		pointer-events: none;
	}
	.tt-title { display: flex; align-items: center; gap: 0.4rem; }
	.tt-title strong { color: #e0f0ff; font-size: 0.95rem; }
	.tt-owner-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
	.tt-armies { margin-left: auto; color: #ffe14a; font-family: monospace; font-weight: bold; }
	.tt-owner { color: #7fcfff; font-size: 0.75rem; margin-top: 2px; }
	.tt-city { color: #ffe14a; font-style: italic; font-size: 0.8rem; margin-top: 3px; }
	.tt-terrain { margin-top: 6px; padding-top: 6px; border-top: 1px solid #1a3040; }
	.tt-terrain-name { color: #ffbb99; font-weight: bold; font-size: 0.85rem; }
	.tt-terrain-desc { color: #a8bfd4; font-size: 0.78rem; margin-top: 2px; line-height: 1.35; }
	.tt-fort { color: #7fcfff; font-size: 0.78rem; margin-top: 6px; }

	.start-prompt {
		display: flex;
		align-items: center;
		gap: 1rem;
		background: linear-gradient(135deg, #10304a, #0a2540);
		border: 2px solid #4a9fcf;
		border-radius: 8px;
		padding: 1rem 1.25rem;
		margin: 0.75rem 0;
		box-shadow: 0 0 20px rgba(74, 159, 207, 0.35);
	}
	.start-prompt h2 { margin: 0 0 0.15rem; color: #e0f0ff; font-size: 1.15rem; }
	.start-prompt p { margin: 0; color: #a8bfd4; font-size: 0.9rem; }
	.start-prompt > div:first-child { flex: 1 1 auto; }
	.start-prompt > button { margin-left: auto; }
	button.big { padding: 0.75rem 1.5rem; font-size: 1rem; font-weight: bold; }
	button.primary { background: #2a5a8a; border-color: #7fcfff; color: #fff; }
	button.primary:hover:not(:disabled) { background: #3a6a9a; }
	.chart {
		background: #081826;
		padding: 0.5rem;
		border: 1px solid #1a3040;
	}
	.chart h3 {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		color: #6a9abf;
		text-transform: uppercase;
		letter-spacing: 0.1rem;
	}
	.chart svg { width: 100%; height: auto; }
	.axis { fill: #6a9abf; font-size: 10px; font-family: monospace; }
	.stats-table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 0.75rem;
		font-size: 0.85rem;
	}
	.stats-table th, .stats-table td {
		text-align: left;
		padding: 0.3rem 0.5rem;
		border-bottom: 1px solid #1a3040;
	}
	.stats-table th {
		color: #6a9abf;
		font-weight: normal;
		text-transform: uppercase;
		font-size: 0.7rem;
	}
	@media (max-width: 1100px) {
		.charts { grid-template-columns: 1fr; }
	}

	.banner {
		padding: 1rem;
		margin-bottom: 0.5rem;
		text-align: center;
		border: 2px solid;
	}
	.banner.win { border-color: #7fcfff; background: #0f3a55; }
	.banner.lose { border-color: #d44; background: #3a0f0f; }
</style>
