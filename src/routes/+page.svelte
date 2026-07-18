<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { get } from 'svelte/store';
	import {
		game,
		newGame,
		forceEndTurn,
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
		confirmParatroop,
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
		canTunnelConnect,
		countryCount,
		armyCount,
		fullIslandBonus,
		isSelectableHex,
		buyArmies,
		buyCard,
		rerollMarket,
		rerollCost,
		finishShopping,
		cardPrice,
		CARD_BY_ID,
		PLAYERS,
		PLAYER_COLORS,
		PLAYER_NAMES,
		CARD_LABELS,
		CARD_META,
		CARD_DEFS,
		canPlayCardNow,
		setHumanPlayers,
		type Player,
		type Phase,
		type CardType,
		type GameState,
		type DebugSettings,
		type EventIntensity
	} from '$lib/game';
	import { PHASE_TO_STEP } from '$lib/cards';
	import { wallBetween, polygonPoints, wallSegmentsFor, seaLanePath, type GameMap } from '$lib/map';
	import { runAiTurn, setValueNetPlayers } from '$lib/ai';
	import { loadLifetimeStats, recordFinishedGame, resetLifetimeStats, type LifetimeStats } from '$lib/lifetime';
	import LifetimeStatsModal from '$lib/components/LifetimeStatsModal.svelte';
	import ShortcutsModal from '$lib/components/ShortcutsModal.svelte';
	import { computeTurningPoints } from '$lib/summary';
	import { buildRecap, encodeRecap } from '$lib/recap';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';

	// Game over has its own dedicated page (see routes/recap) so both a
	// just-finished local game and a shared link render the same turning
	// points/stats/mini-map view. This redirects there the moment the game
	// ends — see the $effect further down for the actual navigation.

	let placeQty = $state(1);
	let moveQty = $state(1);
	let airQty = $state(1);
	let paratroopQty = $state(1);
	let moveInQty = $state(0);
	// The hex the human clicked during placement — opens the qty modal.
	let placeTargetHex = $state<number | null>(null);

	// Qty modal helpers — covers placement, post-conquest move-in, move, air, and paratroop.
	function isQtyPhase(): boolean {
		if ($game.current !== HUMAN) return false;
		if ($game.phase === 'placing' && placeTargetHex != null) return true;
		return $game.phase === 'attack_move_in' || $game.phase === 'move_qty' || $game.phase === 'air_qty' || $game.phase === 'paratroop_qty';
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
				title: 'Move how many armies? (ends your turn)',
				min: 1,
				max: Math.max(1, srcArmies - 1),
				confirmLabel: 'Move & End Turn'
			};
		}
		if ($game.phase === 'paratroop_qty') {
			return {
				title: 'Commit how many armies to the drop?',
				min: 1,
				max: Math.max(1, srcArmies - 1),
				confirmLabel: 'Drop & Attack'
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
		if ($game.phase === 'attack_move_in') return moveInQty;
		if ($game.phase === 'move_qty') return moveQty;
		if ($game.phase === 'paratroop_qty') return paratroopQty;
		return airQty;
	}
	function setQty(n: number) {
		const src = qtySourceHex();
		if (!isQtyPhase() || src == null) return;
		const info = qtyInfo($game.states[src].armies);
		const v = Math.max(info.min, Math.min(info.max, Math.round(Number.isFinite(n) ? n : 0)));
		if ($game.phase === 'placing') placeQty = v;
		else if ($game.phase === 'attack_move_in') moveInQty = v;
		else if ($game.phase === 'move_qty') moveQty = v;
		else if ($game.phase === 'paratroop_qty') paratroopQty = v;
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
		else if ($game.phase === 'paratroop_qty') confirmParatroop(v);
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
		} else if ($game.phase === 'paratroop_qty') {
			paratroopQty = Math.max(info.min, Math.min(info.max, Math.round(Number.isFinite(paratroopQty) ? paratroopQty : 1)));
		}
	});
	// The page became genuinely scrollable once the compact-landscape mobile
	// layout put the turn/cards/log panel below the first-screen map (see
	// the (max-height: 600px) and (orientation: landscape) media query) —
	// before that, the page's own height never exceeded the viewport, so a
	// modal's fixed backdrop never had page content to accidentally drag-
	// scroll underneath it. Lock body scroll for the duration of any modal
	// or full-panel overlay so touch drags on/through it don't scroll the
	// board behind it. showDebug is referenced here even though it's
	// declared further down — fine, since this effect body only runs once
	// per-frame after the whole <script> top level has finished setting up.
	$effect(() => {
		if (typeof document === 'undefined') return;
		const open = isQtyPhase() || ($game.current === HUMAN && $game.phase === 'attack_rolling') || showMenu || showDebug;
		// overflow:hidden alone doesn't reliably stop iOS Safari's rubber-band
		// touch scroll bleeding through a fixed-position backdrop; pairing it
		// with touch-action:none on <body> does.
		document.body.style.overflow = open ? 'hidden' : '';
		document.body.style.touchAction = open ? 'none' : '';
		return () => {
			document.body.style.overflow = '';
			document.body.style.touchAction = '';
		};
	});
	let difficulty = $state(2);
	let startingArmies = $state(3);
	let eventIntensity = $state<EventIntensity>('mild');
	let showMenu = $state(false);

	const HUMAN: Player = 'blue';
	// Register the human with the engine (the discard-pause rule keys off it)
	// instead of the rules hardcoding blue.
	setHumanPlayers([HUMAN]);
	// Trained value-network evaluator (see ml/, src/lib/valueNet.ts) beat the
	// original hand-tuned heuristic ~55% vs ~25% in head-to-head sims, so the
	// AI opponents use it here. It's a module-level switch in ai.ts, not tied
	// to a particular game, so setting it once at startup covers every
	// newGame() call (new game, restart, shared-seed load) below.
	setValueNetPlayers(PLAYERS.filter((p) => p !== HUMAN));

	// Every card-targeting selection phase, derived from the registry — used to
	// decide when the generic Cancel button applies (instead of a hand-written
	// phase list that goes stale every time a card is added).
	const CARD_SELECT_PHASES = new Set(CARD_DEFS.flatMap((d) => d.steps?.map((st) => st.phase) ?? []));

	let aiRunning = $state(false);
	// AI speed: 1× (deliberate) | 2× (fast) | 0 (instant, no ticks)
	const AI_SPEED_KEY = 'isle-wars-ai-speed';
	function loadAiSpeed(): 1 | 2 | 0 {
		if (typeof window === 'undefined') return 1;
		try {
			const raw = localStorage.getItem(AI_SPEED_KEY);
			const v = raw != null ? Number(raw) : 1;
			return v === 0 || v === 2 ? v : 1;
		} catch { return 1; }
	}
	let aiSpeed = $state<1 | 2 | 0>(loadAiSpeed());
	$effect(() => {
		if (typeof window === 'undefined') return;
		try { localStorage.setItem(AI_SPEED_KEY, String(aiSpeed)); } catch { /* ignore */ }
	});
	function aiTickMs() { return aiSpeed === 0 ? 0 : aiSpeed === 2 ? 20 : 60; }

	// Friendly names for the side panel's phase indicator — never show a raw
	// Phase value like "game_over" or "bomb_select" in the UI. Card-targeting
	// phases fall back to their card's display label via PHASE_TO_STEP, and
	// anything still unmapped just gets its underscores stripped.
	const PHASE_LABELS: Partial<Record<Phase, string>> = {
		buy: 'shop for armies & cards',
		placing: 'place armies',
		action: 'attack, move, or pass',
		attack_select_from: 'attack — choose source',
		attack_select_to: 'attack — choose target',
		attack_rolling: 'battle',
		attack_move_in: 'move armies in',
		move_select_from: 'move — choose source',
		move_select_to: 'move — choose destination',
		move_qty: 'move — choose how many',
		air_qty: 'Air Move — choose how many',
		paratroop_qty: 'Paratroop — choose how many',
		discard: 'discard a card',
		game_over: 'game over'
	};
	function phaseLabel(phase: Phase): string {
		const label = PHASE_LABELS[phase];
		if (label) return label;
		const step = PHASE_TO_STEP[phase];
		if (step) return step.def.label;
		return phase.replace(/_/g, ' ');
	}

	let showShortcuts = $state(false);
	// The '?' help content — keep in sync with onKey's actual bindings.
	const SHORTCUT_SECTIONS = [
		{ title: 'Before the game starts', rows: [{ keys: ['Enter'], desc: 'Start the game' }] },
		{ title: 'Action phase', rows: [
			{ keys: ['A'], desc: 'Attack — then click source and target' },
			{ keys: ['M'], desc: 'Move armies (ends your turn)' },
			{ keys: ['P'], desc: 'Pass — end your turn' }
		] },
		{ title: 'During a battle', rows: [{ keys: ['Enter', 'Space'], desc: 'Roll the dice' }] },
		{ title: 'Quantity picker', rows: [
			{ keys: ['↑', '+'], desc: 'More armies' },
			{ keys: ['↓', '−'], desc: 'Fewer armies' },
			{ keys: ['Enter'], desc: 'Confirm' }
		] },
		{ title: 'Game over', rows: [
			{ keys: ['S'], desc: 'View the game summary' },
			{ keys: ['N'], desc: 'New game on a fresh random map' }
		] },
		{ title: 'Anywhere', rows: [
			{ keys: ['Esc'], desc: 'Cancel the current selection / close dialogs' },
			{ keys: ['C'], desc: 'Career — lifetime stats' },
			{ keys: ['?'], desc: 'Show or hide this help' }
		] }
	];
	let autoRolling = $state(false);
	let hoveredGrid = $state<number | null>(null);
	let tooltipPos = $state<{ x: number; y: number } | null>(null);
	// Touch devices have no hover, so the hex-info tooltip above (which only
	// ever shows on pointerenter) is unreachable on mobile. Inspect mode
	// repurposes taps for that instead of gameplay actions: tap a hex to
	// pin its info tooltip, tap it again (or tap empty water) to dismiss,
	// tap a different hex to switch. Off by default so normal play (attack/
	// move taps) isn't disrupted.
	let inspectMode = $state(false);
	let pinnedInfoHex = $state<number | null>(null);
	let pinnedInfoPos = $state<{ x: number; y: number } | null>(null);
	function toggleInspectMode() {
		inspectMode = !inspectMode;
		pinnedInfoHex = null;
		pinnedInfoPos = null;
	}
	function dismissPinnedInfo() {
		pinnedInfoHex = null;
		pinnedInfoPos = null;
	}
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
	// Compact-landscape mobile: the map fills the first screen and the rest
	// of the game info (turn panel/cards/log) sits below it in normal flow,
	// reached by scrolling — this ref backs the floating card-count badge's
	// "jump to cards" tap target (see .cards-fab in the landscape media query).
	let cardsPanelEl: HTMLElement | undefined = $state();
	function scrollToCards() {
		cardsPanelEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
	let marketPanelEl: HTMLElement | undefined = $state();
	function scrollToMarket() {
		marketPanelEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
	// Same breakpoint: the header (scoreboard/actions) and message bar are
	// collapsed by default so they don't eat into the map's first screen —
	// toggled open via .chrome-toggle. Starts closed since maximizing the
	// map is the point; irrelevant outside the landscape breakpoint, where
	// the toggle button itself is hidden via CSS and the header always shows.
	let landscapeChromeOpen = $state(false);
	let dragFrom = $state<number | null>(null);
	let dragPt = $state<{ x: number; y: number } | null>(null);
	let pointerDownGrid: number | null = null;
	let pointerDownAt: { x: number; y: number } | null = null;

	function canStartAttackDrag(id: number): boolean {
		if (inspectMode) return false;
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
		if (s.phase === 'tunnel_from') {
			return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
		}
		return false;
	}

	function isValidAttackTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'action') return false;
		if (from === to) return false;
		if (!s.map.adj[from].includes(to)) return false;
		if (wallBetween(s.map, from, to)) return false;
		if (s.states[to].owner === HUMAN) return false;
		return true;
	}

	function isValidMoveTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'action') return false;
		if (from === to) return false;
		if (!s.map.adj[from].includes(to)) return false;
		if (wallBetween(s.map, from, to)) return false;
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

	function isValidTunnelTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'tunnel_from' && s.phase !== 'tunnel_to') return false;
		return canTunnelConnect(s, from, to);
	}

	function isValidDragTarget(from: number, to: number): boolean {
		return isValidAttackTarget(from, to) || isValidMoveTarget(from, to)
			|| isValidFerryTarget(from, to) || isValidInvasionTarget(from, to)
			|| isValidArtilleryTarget(from, to) || isValidTunnelTarget(from, to);
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
			// Touch pointers are implicitly captured by the hex under the
			// finger on pointerdown, which stops pointerenter/pointerleave
			// from firing on the other hexes the finger drags across —
			// hoveredGrid would never update and the drag-to-attack drop
			// target would never be found. Releasing capture restores
			// normal hover-style dispatch during the drag. No effect on
			// mouse, which isn't auto-captured this way.
			const target = e.currentTarget as Element;
			if (target.hasPointerCapture?.(e.pointerId)) {
				target.releasePointerCapture(e.pointerId);
			}
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
			} else if (isValidTunnelTarget(from, to)) {
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
		// A shared map link (?seed=...) always wins over any saved game — the
		// whole point is to reproduce that exact game. The seed itself packs
		// difficulty/startingArmies/debug settings (see map.ts's encodeSeed),
		// so startGame() applies those over whatever's passed in here; a
		// hand-typed seed that isn't in that packed format just falls back to
		// this browser's current menu defaults.
		const url = new URL(window.location.href);
		const sharedSeed = url.searchParams.get('seed');
		if (sharedSeed != null && sharedSeed.trim() !== '') {
			loadSavedGame(); // still registers the auto-save subscription
			newGame(difficulty, startingArmies, sharedSeed, eventIntensity);
			loadDebugUi(); // reflect any debug settings the seed just applied
			url.searchParams.delete('seed');
			window.history.replaceState({}, '', url.toString());
		} else {
			loadSavedGame();
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	function onKey(e: KeyboardEvent) {
		const tag = (e.target as HTMLElement | null)?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA') return;
		// Shortcut help works at any time — even during the AI's turn or when
		// the game is over — so it's handled before the current-player gate.
		if (e.key === '?') { showShortcuts = !showShortcuts; e.preventDefault(); return; }
		if (e.key === 'c' || e.key === 'C') { showLifetime = !showLifetime; e.preventDefault(); return; }
		if (e.key === 'Escape' && showShortcuts) { showShortcuts = false; return; }
		if (e.key === 'Escape' && showLifetime) { showLifetime = false; return; }
		if (showLifetime) return; // don't drive the game from behind the Career modal
		// Pre-game "Start Game" gate — Enter starts the game. Before the
		// current-player gate, since another player may open the game.
		if (!$game.gameStarted && $game.phase !== 'game_over' && !showShortcuts) {
			if (e.key === 'Enter') { startGamePlaying(); e.preventDefault(); }
			return;
		}
		// Game-over banner shortcuts — before the current-player gate, since
		// the winner is usually not the human.
		if ($game.phase === 'game_over' && !showShortcuts) {
			if (e.key === 's' || e.key === 'S') { viewSummary(); e.preventDefault(); }
			else if (e.key === 'n' || e.key === 'N') { playAgain(); e.preventDefault(); }
			return;
		}
		if ($game.current !== HUMAN || $game.phase === 'game_over') return;
		if (showShortcuts) return; // don't drive the game from behind the help modal
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
			// Pause at the forfeit brink: with 2 armies left, one more lost roll
			// forfeits the source hex to an enemy defender and ends the turn.
			// That decision belongs to the player, not the auto-roller.
			const s = $game;
			if (
				s.selectedFrom != null && s.selectedTo != null &&
				s.states[s.selectedFrom].armies <= 2 && s.states[s.selectedTo].owner != null
			) break;
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
			try {
				await new Promise((r) => setTimeout(r, aiSpeed === 0 ? 40 : 200));
				await runAiTurn(s.current, aiTickMs());
			} catch (err) {
				// An uncaught exception here used to leave `aiRunning` stuck
				// true forever — this $effect's guard (`if (aiRunning) return`)
				// then permanently blocked every future AI turn, freezing the
				// game mid-turn with no error shown (e.g. stuck on "place N
				// armies" with the "is thinking" hint spinning indefinitely).
				console.error('AI turn threw; ending its turn to avoid a permanent freeze.', err);
				if (get(game).current === s.current) forceEndTurn();
			} finally {
				aiRunning = false;
			}
		})();
	});

	function gridFill(id: number, s: typeof $game) {
		const st = s.states[id];
		return st.owner ? PLAYER_COLORS[st.owner] : '#334';
	}

	// Highlighting shares the engine's single selection authority (which covers
	// both core attack/move phases and every card's targeting rules) instead of
	// re-deriving per-phase logic here.
	function isSelectable(id: number, s: typeof $game): boolean {
		if (inspectMode) return false;
		if (s.current !== HUMAN) return false;
		return isSelectableHex(s, id);
	}

	function handleGridClick(id: number, e?: MouseEvent) {
		if (inspectMode) {
			if (pinnedInfoHex === id) {
				dismissPinnedInfo();
			} else {
				pinnedInfoHex = id;
				pinnedInfoPos = e ? { x: e.clientX, y: e.clientY } : null;
			}
			return;
		}
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

	let seedInput = $state('');

	function parseSeedInput(): string | undefined {
		const trimmed = seedInput.trim();
		return trimmed === '' ? undefined : trimmed.toUpperCase();
	}

	function startNewGame() {
		newGame(difficulty, startingArmies, parseSeedInput(), eventIntensity);
		showMenu = false;
	}

	function confirmClearSave() {
		const ok = confirm(
			'Clear the saved game and start a fresh one?\n\nThis wipes your current progress in this browser and cannot be undone.'
		);
		if (!ok) return;
		clearSavedGame();
		newGame(difficulty, startingArmies, parseSeedInput(), eventIntensity);
	}

	let seedCopied = $state(false);
	function copyShareLink() {
		const url = new URL(window.location.href);
		url.search = '';
		// The seed itself packs difficulty/startingArmies/debug settings (see
		// map.ts's encodeSeed) — no separate query params needed for the
		// recipient to get the exact same map AND rules.
		url.searchParams.set('seed', $game.seed);
		navigator.clipboard.writeText(url.toString()).then(() => {
			seedCopied = true;
			setTimeout(() => (seedCopied = false), 1500);
		});
	}

	// Builds the same recap payload the shareable /recap page decodes — used
	// to redirect there the moment a game ends (see the $effect below). The
	// map itself isn't embedded (the recap page rebuilds it from the seed —
	// generateMap for procedural games, decodeCustomMapSeed for editor maps),
	// so conquests/edgeEvents/final owners+edges are what's needed to
	// replay the turning-point compare view against that rebuilt map.
	async function recapUrl(): Promise<string> {
		const recap = buildRecap({
			seed: $game.seed,
			winner: $game.winner,
			turn: $game.turn,
			turningPoints: computeTurningPoints($game, 15),
			history: $game.history,
			stats: $game.stats,
			finalArmies: Object.fromEntries(PLAYERS.map((p) => [p, armyCount($game, p)])) as Record<Player, number>,
			finalOwners: $game.states.map((st) => st.owner),
			conquests: $game.conquests,
			edgeEvents: $game.edgeEvents,
			hexArmyDeltas: $game.hexArmyDeltas,
			finalWalls: $game.map.walls ?? [],
			finalSeaLanes: $game.map.seaLanes,
			finalTunnels: $game.map.tunnels ?? [],
			terrainEvents: $game.terrainEvents ?? []
		});
		return `${base}/recap/#d=${await encodeRecap(recap)}`;
	}

	// Game over shows a banner (see the .start-prompt.game-over block below)
	// with links to the recap page and a new game, instead of yanking the
	// player away from the final board the instant the game ends.
	function viewSummary() {
		recapUrl().then((url) => goto(url));
	}
	// "New game" on the game-over banner: straight into a fresh random map
	// with the current settings — no menu detour.
	function playAgain() {
		newGame(difficulty, startingArmies, undefined, eventIntensity);
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}

	// Lifetime stats: fold each finished game into localStorage exactly once.
	// The flag lives in the (auto-saved) game state, so reloading a finished
	// game doesn't double-count it. Auto-play games are spectator games —
	// blue was AI-driven — so they're skipped unless the "count auto-played
	// games in Career" debug option is on.
	let lifetimeStats = $state<LifetimeStats>(loadLifetimeStats());
	let showLifetime = $state(false);
	$effect(() => {
		if ($game.phase === 'game_over' && !$game.lifetimeRecorded && $game.gameStarted) {
			const dbg = getDebugSettings();
			if (!dbg.autoPlay || dbg.careerAutoPlay) {
				lifetimeStats = recordFinishedGame($game, HUMAN);
			}
			game.update((s) => { s.lifetimeRecorded = true; return s; });
		}
	});



	// Lanes opened by cards during play (Ferry / Water Invasion) — every card
	// lane pushes a seaLane edge event; map-generated lanes don't. Drawn in a
	// distinct color so player-built routes stand out from natural ones.
	const createdLaneKeys = $derived(
		new Set($game.edgeEvents.filter((e) => e.kind === 'seaLane' && e.added).map((e) => `${e.edge[0]},${e.edge[1]}`))
	);

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

	const wallSegments = $derived(wallSegmentsFor($game.map.walls ?? [], $game.map.grids));

	// Debug menu
	let showDebug = $state(false);
	let debugDisableSave = $state(false);
	let debugStarterCards = $state(false);
	let debugAutoPlay = $state(false);
	let debugCareerAutoPlay = $state(false);
	let debugDieSides = $state(10);
	// The "free card each turn" debug checkboxes — barrier cards (build/destroy
	// pairs for walls, rivers, tunnels, sea lanes) plus Water Invasion. Table-
	// driven so adding another checkbox is one row here, not a new pair of
	// state var + toggle function.
	const TURN_CARD_DEBUG_OPTIONS: { key: keyof DebugSettings; card: CardType; label: string }[] = [
		{ key: 'turnCardTunnel', card: 'tunnel', label: 'Tunnel' },
		{ key: 'turnCardInvasion', card: 'invasion', label: 'Water Invasion' },
		{ key: 'turnCardCanal', card: 'canal', label: 'Canal' },
		{ key: 'turnCardWall', card: 'wall', label: 'Wall' },
		{ key: 'turnCardBreach', card: 'breach', label: 'Breach' },
		{ key: 'turnCardLevee', card: 'levee', label: 'Levee' },
		{ key: 'turnCardCollapse', card: 'collapse', label: 'Collapse' },
		{ key: 'turnCardFerry', card: 'ferry', label: 'Ferry Route' },
		{ key: 'turnCardStorm', card: 'storm', label: 'Storm' }
	];
	let debugTurnCards = $state<Record<string, boolean>>(
		Object.fromEntries(TURN_CARD_DEBUG_OPTIONS.map((o) => [o.key, false]))
	);
	// Not part of DebugSettings/the shareable seed (those are about map
	// generation + game rules) — this is a pure AI-implementation switch, so
	// it just resets to the default (on) every reload rather than round-
	// tripping through localStorage or seed-packing for one dev toggle.
	let debugUseValueNet = $state(true);

	function loadDebugUi() {
		const d = getDebugSettings();
		debugDisableSave = d.disableSave;
		debugStarterCards = d.starterCards;
		debugAutoPlay = d.autoPlay;
		debugCareerAutoPlay = d.careerAutoPlay;
		debugDieSides = d.dieSides;
		for (const opt of TURN_CARD_DEBUG_OPTIONS) debugTurnCards[opt.key] = d[opt.key] as boolean;
	}

	function toggleDebugUseValueNet() {
		debugUseValueNet = !debugUseValueNet;
		setValueNetPlayers(debugUseValueNet ? PLAYERS.filter((p) => p !== HUMAN) : []);
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

	function toggleDebugCareerAutoPlay() {
		debugCareerAutoPlay = !debugCareerAutoPlay;
		updateDebugSettings({ careerAutoPlay: debugCareerAutoPlay });
	}

	function toggleDebugTurnCard(key: keyof DebugSettings) {
		debugTurnCards[key] = !debugTurnCards[key];
		updateDebugSettings({ [key]: debugTurnCards[key] });
	}

	function setAllDebugTurnCards(on: boolean) {
		for (const opt of TURN_CARD_DEBUG_OPTIONS) debugTurnCards[opt.key] = on;
		updateDebugSettings(Object.fromEntries(TURN_CARD_DEBUG_OPTIONS.map((o) => [o.key, on])));
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
			desert: ['Desert', 'Heat attrition — whoever holds this hex loses 1 army here at the start of each of their turns (can drop to 0). Cannot host a production center.']
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
		if (st.rampart) {
			modifiers.push({
				name: '🧱 Rampart',
				desc: '+1 defense on this hex. Lost when the hex is captured.'
			});
		}
		const capitalOf = PLAYERS.find((p) => $game.capitals?.[p] === gridId);
		if (capitalOf) {
			modifiers.push({
				name: `★ ${PLAYER_NAMES[capitalOf]}'s capital`,
				desc:
					capitalOf === st.owner
						? `Pays ${PLAYER_NAMES[capitalOf]} +3 reinforcements per turn while they hold it.`
						: `Currently occupied — just a normal city for its occupier. ${PLAYER_NAMES[capitalOf]} regains +3 reinforcements per turn by retaking it.`
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

<svelte:head><title>Isle Wars</title></svelte:head>

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
{#snippet hexBadge(gridId: number, cx: number, cy: number, scale: number, showCityLabel: boolean, armiesOverride: number | null)}
	{@const g = $game.map.grids[gridId]}
	<!-- Primitives, NOT the GridState object: the engine mutates states[] in
	     place, so an object-valued {@const} keeps the same reference across
	     store updates and Svelte's derived-equality check stops downstream
	     {#if}s from ever re-running — a freshly played Rampart/Fortify ring
	     would not appear on the live map until a full remount. -->
	{@const fortified = !!$game.states[gridId].fortified}
	{@const rampart = !!$game.states[gridId].rampart}
	{@const capitalOf = PLAYERS.find((p) => $game.capitals?.[p] === gridId) ?? null}
	{@const shownArmies = armiesOverride ?? $game.states[gridId].armies}
	{@const badgeR = 20 * scale}
	{@const fortR1 = 30 * scale}
	{@const fortR2 = 34 * scale}
	<g pointer-events="none">
		{#if fortified}
			<circle cx={cx} cy={cy} r={fortR1} fill="none" stroke="#7fcfff" stroke-width={3 * scale} stroke-dasharray="{6 * scale} {4 * scale}" opacity="0.95" />
			<circle cx={cx} cy={cy} r={fortR2} fill="none" stroke="#7fcfff" stroke-width={1.5 * scale} opacity="0.55" />
		{/if}
		{#if rampart}
			<circle cx={cx} cy={cy} r={(fortified ? 38 : 30) * scale} fill="none" stroke="#4fcf7f" stroke-width={2 * scale} opacity="0.85" />
		{/if}
		<circle cx={cx} cy={cy} r={badgeR} fill="#000" fill-opacity="0.6"
			stroke={fortified ? '#7fcfff' : g.production ? '#ffe14a' : '#fff'}
			stroke-width={(fortified ? 3 : g.production ? 2.5 : 1.5) * scale} />
		<text x={cx} y={cy + 7 * scale} text-anchor="middle"
			font-family="monospace" font-weight="bold"
			font-size={20 * scale} fill="#fff">{shownArmies}</text>
		{#if fortified}
			<text x={cx - 18 * scale} y={cy - 14 * scale} text-anchor="middle"
				font-size={16 * scale} style="filter: drop-shadow(0 0 {3 * scale}px #7fcfff);">🛡</text>
		{/if}
		{#if rampart}
			<text x={cx - 18 * scale} y={cy + 24 * scale} text-anchor="middle"
				font-size={14 * scale} style="filter: drop-shadow(0 0 {3 * scale}px #4fcf7f);">🏰</text>
		{/if}
		<!-- Only capitals get a star, in the home player's color (whose capital
		     it IS, not who currently occupies it). Regular cities are marked by
		     the yellow badge ring + name alone. The star sits on a dark disc
		     with a light ring so it stays visible when the hex fill is the
		     same color as the star (e.g. Green's capital on a green hex). -->
		{#if capitalOf}
			<circle cx={cx + 20 * scale} cy={cy - 22 * scale} r={13 * scale}
				fill="#0a1420" fill-opacity="0.9" stroke="#e6f0fa" stroke-width={1.5 * scale} />
			<text x={cx + 20 * scale} y={cy - 15 * scale} text-anchor="middle"
				font-size={20 * scale} fill={PLAYER_COLORS[capitalOf]}>★</text>
		{/if}
		{#if g.production && showCityLabel && g.cityName}
			<text x={cx} y={cy + 34 * scale} class="city-label city-label-outline" text-anchor="middle">{g.cityName}</text>
			<text x={cx} y={cy + 34 * scale} class="city-label" text-anchor="middle">{g.cityName}</text>
		{/if}
	</g>
{/snippet}

<main>
	<!-- Groups the header/menu/message chrome with the map+side grid so the
	     short-landscape media query below can flex just this region to fill
	     the viewport, without the (always-in-the-DOM) analytics section past
	     it competing for that space. -->
	<div class="board-frame" class:chrome-open={landscapeChromeOpen}>
	<header>
		<div class="header-row">
			<div class="scoreboard">
				{#each PLAYERS as p}
					<div class="score" class:current={$game.current === p} class:dead={!$game.alive[p]}
						class:coalition-target={$game.coalitionTarget === p}
						title={$game.coalitionTarget === p ? `Coalition: everyone gets +1 attacking ${PLAYER_NAMES[p]} until ${PLAYER_NAMES[$game.coalitionCaster ?? p]}'s next turn.` : ''}>
						<span class="dot" style="background:{PLAYER_COLORS[p]}"></span>
						<strong>{PLAYER_NAMES[p]}</strong>
						<span class="score-nums">{countryCount($game, p)}<span class="dim">/{$game.map.grids.length}</span></span>
						<span class="bonus">+{fullIslandBonus($game, p)}</span>
						{#if $game.coalitionTarget === p}<span class="coalition-badge" aria-label="Coalition target">🤝</span>{/if}
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
				<button class="icon-btn" title="Copy a link to this exact game — map and settings (seed {$game.seed})" onclick={copyShareLink}>{seedCopied ? 'Copied!' : 'Share'}</button>
				<button class="icon-btn" title="Lifetime stats across all your games" onclick={() => (showLifetime = true)}>Career</button>
				<button class="icon-btn debug-btn" title="Debug" onclick={() => (showDebug = !showDebug)}>Debug</button>
				<button class="icon-btn danger" title="Clear Save" onclick={confirmClearSave}>Clear</button>
			</div>
		</div>
	</header>

	{#if showMenu}
		<section class="menu">
			<h2>New Game</h2>
			<div class="menu-fields">
				<label>
					<span class="field-label">Difficulty</span>
					<select bind:value={difficulty}>
						<option value={1}>1 — Easy</option>
						<option value={2}>2 — Normal (default)</option>
						<option value={3}>3 — Hard</option>
						<option value={4}>4 — Hardest</option>
					</select>
				</label>
				<label>
					<span class="field-label">Starting armies per country</span>
					<input type="number" min="1" max="10" bind:value={startingArmies} />
				</label>
				<label>
					<span class="field-label">World events</span>
					<select bind:value={eventIntensity}>
						<option value="off">Off — no random events</option>
						<option value="mild">Mild (default) — occasional, announced a turn ahead</option>
						<option value="wild">Wild — frequent, announced a turn ahead</option>
					</select>
				</label>
				<label>
					<span class="field-label">Map seed</span>
					<input type="text" placeholder="random" style="text-transform: uppercase" bind:value={seedInput} />
					<span class="menu-hint">optional — same seed = same game &amp; settings</span>
				</label>
			</div>
			<div class="menu-actions">
				<button class="primary" onclick={startNewGame}>Start</button>
				<button class="ghost" onclick={() => goto('/editor')}>Custom Map…</button>
				<span class="share-label">Current map's seed: <strong>{$game.seed}</strong></span>
			</div>
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
				<div class="toggle-card">
					<div class="toggle-text" style="flex:1">
						<div class="toggle-title">Current seed</div>
						<div class="toggle-desc">Packs this game's map, difficulty, starting armies, and these debug settings — paste it into "Map seed" on a New Game to reproduce it exactly.</div>
					</div>
					<code class="current-seed">{$game.seed}</code>
				</div>
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
				<label class="toggle-card" class:on={debugCareerAutoPlay}>
					<input type="checkbox" checked={debugCareerAutoPlay} onchange={toggleDebugCareerAutoPlay} />
					<div class="toggle-slot"><div class="toggle-thumb"></div></div>
					<div class="toggle-text">
						<div class="toggle-title">Count auto-played games in Career</div>
						<div class="toggle-desc">Normally spectator (auto-play) games don't touch your lifetime stats — Blue was AI-driven. Turn on to record them anyway.</div>
					</div>
				</label>
				<label class="toggle-card" class:on={debugUseValueNet}>
					<input type="checkbox" checked={debugUseValueNet} onchange={toggleDebugUseValueNet} />
					<div class="toggle-slot"><div class="toggle-thumb"></div></div>
					<div class="toggle-text">
						<div class="toggle-title">Value-net AI</div>
						<div class="toggle-desc">AI opponents use the trained value network for attacks/placement (~55% vs. the plain heuristic's ~25% in sims). Turn off to fall back to the original hand-tuned heuristic.</div>
					</div>
				</label>
				<div class="toggle-card">
					<div class="toggle-text" style="flex:1">
						<div class="toggle-title">Free card each turn</div>
						<div class="toggle-desc">Every player draws the checked card type(s) at the start of their turn, on top of their normal turn-end draw. Handy for testing specific cards without waiting for the RNG.</div>
						<div class="turn-card-checks">
							{#each TURN_CARD_DEBUG_OPTIONS as opt (opt.key)}
								<label class="turn-card-check" class:on={debugTurnCards[opt.key]}>
									<input type="checkbox" checked={debugTurnCards[opt.key]} onchange={() => toggleDebugTurnCard(opt.key)} />
									{opt.label}
								</label>
							{/each}
						</div>
						<div class="turn-card-actions">
							<button class="link-btn" onclick={() => setAllDebugTurnCards(true)}>Select all</button>
							<button class="link-btn" onclick={() => setAllDebugTurnCards(false)}>Select none</button>
						</div>
					</div>
				</div>
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

	{#if $game.phase === 'game_over'}
		{@const winColor = $game.winner ? PLAYER_COLORS[$game.winner] : '#ffe14a'}
		<div class="start-prompt game-over" style="border-color: {winColor}; box-shadow: 0 0 20px {winColor}59, 0 8px 30px rgba(0, 0, 0, 0.45)">
			<div>
				<h2 style="color: {winColor}">{$game.winner ? `${PLAYER_NAMES[$game.winner]} wins!` : 'Game over'}</h2>
				<p>Conquered in {$game.turn} turns. Browse the final board, or dive into the recap.</p>
			</div>
			<button class="primary big" onclick={viewSummary}>Game summary →</button>
			<button class="big ghost" onclick={playAgain}>New game</button>
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
				<rect x="0" y="0" width={$game.map.width} height={$game.map.height} fill="#0a2540" onclick={dismissPinnedInfo} />
				<!-- Water hexes (the underlying grid) -->
				{#each $game.map.waterHexes ?? [] as poly}
					<polygon points={polygonPoints(poly)} fill="#0e2a48" stroke="#26527a" stroke-width="0.8" stroke-opacity="0.55" pointer-events="none" />
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
						onclick={(e) => handleGridClick(g.id, e)}
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
				<!-- Sea lanes: curved dashed paths. Drawn ABOVE the territory
				     polygons, not under them — a lane between two coastal hexes
				     of the same island (e.g. a Water Invasion around a wall)
				     runs mostly over land and would be painted over below. -->
				{#each $game.map.seaLanes as [a, b]}
					{@const created = createdLaneKeys.has(a < b ? `${a},${b}` : `${b},${a}`)}
					<path d={seaLanePath(a, b, $game.map.grids)} fill="none" stroke={created ? '#c68fff' : '#a0d8ff'} stroke-width="2.5" stroke-dasharray="6 4" stroke-opacity="0.85" pointer-events="none" />
				{/each}
				<!-- Tunnels (Tunnel card): a bold underground channel straight between
				     the two linked hex centers — a dark casing under a bright amber
				     dashed core with capped ends, so it reads clearly as a tunnel and
				     not a sea lane or river. -->
				{#each ($game.map.tunnels ?? []) as [a, b]}
					{@const ga = $game.map.grids[a]}
					{@const gb = $game.map.grids[b]}
					<g pointer-events="none">
						<line x1={ga.x} y1={ga.y} x2={gb.x} y2={gb.y} stroke="#241206" stroke-width="9" stroke-linecap="round" stroke-opacity="0.95" />
						<line x1={ga.x} y1={ga.y} x2={gb.x} y2={gb.y} stroke="#ffb454" stroke-width="4" stroke-dasharray="7 6" stroke-linecap="round" />
						<circle cx={ga.x} cy={ga.y} r="4.5" fill="#241206" stroke="#ffb454" stroke-width="2" />
						<circle cx={gb.x} cy={gb.y} r="4.5" fill="#241206" stroke="#ffb454" stroke-width="2" />
					</g>
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
				<!-- Wall barriers: stone slab on the shared hex edge that fully
				     blocks movement and attacks across it. -->
				{#each wallSegments as w}
					<g pointer-events="none">
						<line
							x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]}
							stroke="#2b2622" stroke-width="13" stroke-linecap="round"
						/>
						<line
							x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]}
							stroke="#9a8f83" stroke-width="9" stroke-linecap="round"
						/>
						<line
							x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]}
							stroke="#4a423b" stroke-width="9" stroke-linecap="butt"
							stroke-dasharray="2 9"
						/>
					</g>
				{/each}
				<!-- Army count badges, production stars, and city names -->
				{#each $game.map.grids as g (g.id)}
					{@render hexBadge(g.id, g.x, g.y, 1, true, $game.states[g.id].armies)}
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
					{@const overTunnel = hoveredGrid != null && isValidTunnelTarget(dragFrom, hoveredGrid)}
					{@const arrowColor = overAttack ? '#ffe14a' : overMove ? '#7fcfff' : overFerry ? '#c68fff' : overInvade ? '#ff6a6a' : overArt ? '#ff8a00' : overTunnel ? '#c98a4b' : '#fff'}
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
						stroke-dasharray={(overAttack || overMove || overFerry || overInvade || overArt || overTunnel) ? 'none' : '8 6'}
						marker-end="url(#drag-arrowhead)"
						pointer-events="none"
					/>
				{/if}
			</svg>
		</div>

		<aside class="side">
			<section class="panel">
				<h3>{PLAYER_NAMES[$game.current]}'s turn — {phaseLabel($game.phase)}</h3>
				{#if $game.current === HUMAN && $game.phase === 'placing'}
					<p class="hint">Armies to place: <strong>{$game.armiesToPlace}</strong>. Click one of your territories.</p>
				{/if}

				{#if $game.current === HUMAN && $game.phase === 'action'}
					<div class="row">
						<button class="primary" onclick={endTurn}>End Turn</button>
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
							{@const modTxt = `${defB ? ` +${defB} def` : ''}${atkB ? ` (atk +${atkB})` : ''}`}
							<p class="hint">{gridLabelLocal($game.selectedFrom, $game)} ({atkA}) vs {gridLabelLocal(target, $game)} ({defA}{modTxt}) · <strong style="color:{wp >= 65 ? '#7fff7f' : wp >= 35 ? '#ffd67f' : '#ff7f7f'}">{wp}% win</strong></p>
						{:else}
							<p class="hint">Attackable neighbors are outlined in white. Hover to preview odds.</p>
						{/if}
					{/if}
				{/if}

				{#if $game.current === HUMAN && $game.phase === 'attack_rolling'}
					<p class="hint">Roll the dice in the attack modal.</p>
				{/if}

				{#if $game.current === HUMAN && ($game.phase === 'move_select_from' || $game.phase === 'move_select_to' || CARD_SELECT_PHASES.has($game.phase))}
					<div class="row">
						<button onclick={cancelAction}>Cancel</button>
					</div>
				{/if}

				{#if $game.current !== HUMAN}
					<p class="hint">🤖 {PLAYER_NAMES[$game.current]} is thinking…</p>
				{/if}
			</section>

			{#if $game.current === HUMAN && $game.phase === 'buy'}
				<section class="panel" bind:this={marketPanelEl}>
					<h3>Shop — {$game.gold[HUMAN]} gold <span class="hint-inline">(+{$game.goldIncomeThisTurn} this turn)</span></h3>
					<div class="row buy-armies-row">
						<button onclick={() => buyArmies(1)} disabled={$game.gold[HUMAN] < 1}>+1 army</button>
						<button onclick={() => buyArmies(5)} disabled={$game.gold[HUMAN] < 1}>+5 armies</button>
						<button onclick={() => buyArmies($game.gold[HUMAN])} disabled={$game.gold[HUMAN] < 1}>Max armies</button>
					</div>
					{#if $game.armiesToPlace > 0}
						<p class="hint">{$game.armiesToPlace} armies bought so far.</p>
					{/if}
					<div class="card-grid">
						{#each $game.marketOffer as c, i}
							{#if c}
								{@const meta = CARD_META[c]}
								{@const price = cardPrice(CARD_BY_ID[c].weight)}
								{@const disabled = $game.gold[HUMAN] < price || $game.hands[HUMAN].length >= 5}
								<button
									class="card-tile kind-{meta.kind}"
									class:disabled
									disabled={disabled}
									onclick={() => buyCard(i)}
									onpointerenter={(e) => onCardHoverEnter(c, e)}
									onpointerleave={onCardHoverLeave}
									onpointermove={(e) => onCardHoverMove(e)}
								>
									<div class="card-icon">{meta.icon}</div>
									<div class="card-name">{CARD_LABELS[c]}</div>
									<div class="card-price">{price}g</div>
								</button>
							{:else}
								<div class="card-tile card-tile-empty">
									<div class="card-name">sold</div>
								</div>
							{/if}
						{/each}
					</div>
					{#if $game.hands[HUMAN].length >= 5}
						<p class="hint">Hand is full — discard before buying more cards.</p>
					{/if}
					<div class="row">
						<button onclick={rerollMarket} disabled={$game.gold[HUMAN] < rerollCost($game)}>
							Reroll ({rerollCost($game)}g)
						</button>
						<button class="primary" onclick={finishShopping}>Done Shopping</button>
					</div>
				</section>
			{/if}

			<section class="panel" bind:this={cardsPanelEl}>
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
							<!-- Greyed whenever the card can't be started right now — most
							     visibly during placement, where only army cards are legal
							     (playing anything else used to silently forfeit the armies
							     still waiting to be placed). -->
							{@const disabled = !isDiscarding && ($game.current !== HUMAN || !canPlayCardNow($game, c))}
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
	</div>

	<!-- Compact-landscape mobile only (see .cards-fab in the media query):
	     the side panel isn't floated over the map here, it's normal content
	     below the first screen — this fixed badge is the tap target that
	     jumps down to it, so playing a card is still reachable without
	     scrolling blind. Hidden outside that breakpoint via CSS. -->
	<button class="cards-fab" onclick={scrollToCards} aria-label="Jump to your cards">
		🎴<span class="cards-fab-count">{$game.hands[HUMAN].length}</span>
	</button>

	<!-- Same breakpoint: mirrors .cards-fab on the opposite corner, toggling
	     the header/message bar (collapsed by default) instead of scrolling
	     to something below the fold. -->
	<button class="chrome-toggle" onclick={() => (landscapeChromeOpen = !landscapeChromeOpen)} aria-label={landscapeChromeOpen ? 'Hide status bar' : 'Show status bar'}>
		{#if landscapeChromeOpen}
			✕
		{:else}
			<span class="chrome-toggle-dot" style="background:{PLAYER_COLORS[$game.current]}"></span>
			<span class="chrome-toggle-turn">T{$game.turn}</span>
		{/if}
	</button>

	<!-- Always visible (not gated to the landscape breakpoint like the two
	     buttons above) — touch has no hover anywhere, portrait included, so
	     the toggle to swap taps from gameplay actions to "show hex info"
	     needs to be reachable regardless of orientation or header state.
	     Left edge, vertically centered, so it never collides with
	     .chrome-toggle (bottom-left) or .cards-fab (bottom-right). -->
	<button class="inspect-toggle" class:active={inspectMode} onclick={toggleInspectMode} aria-label={inspectMode ? 'Exit inspect mode' : 'Enter inspect mode — tap a hex to see its info'}>
		{inspectMode ? '✕' : 'i'}
	</button>

	<!-- Same reasoning as .inspect-toggle: the real End Turn button lives in
	     the side panel, which is below the fold (compact landscape) or a
	     scroll away (portrait) — this floating shortcut is reachable without
	     hunting for it. During placing it can't act yet (armies have to go
	     down first), so it shows a disabled count instead of pretending
	     you can end the turn early — same information as the side panel's
	     "Armies remaining" hint, just reachable from here too. -->
	{#if $game.current === HUMAN && $game.phase === 'action'}
		<button class="end-turn-fab" onclick={endTurn}>End Turn</button>
	{:else if $game.current === HUMAN && $game.phase === 'placing'}
		<button class="end-turn-fab placing" disabled>{$game.armiesToPlace} to place</button>
	{:else if $game.current === HUMAN && $game.phase === 'buy'}
		<button class="end-turn-fab buy" onclick={scrollToMarket}>{$game.gold[HUMAN]}g — Shop</button>
	{/if}

	{#if showShortcuts}
		<ShortcutsModal sections={SHORTCUT_SECTIONS} onclose={() => (showShortcuts = false)} />
	{/if}

	{#if showLifetime}
		<LifetimeStatsModal
			stats={lifetimeStats}
			onclose={() => (showLifetime = false)}
			onreset={() => (lifetimeStats = resetLifetimeStats())}
		/>
	{/if}

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
				{#snippet qtyHex(gridId: number, armiesOverride: number | null, fillOverride: string | null)}
					{@const g = $game.map.grids[gridId]}
					{@const owner = $game.states[gridId].owner}
					{@const color = fillOverride ?? (owner ? PLAYER_COLORS[owner] : '#556')}
					<svg class="side-hex" viewBox="0 0 200 180" xmlns="http://www.w3.org/2000/svg">
						<polygon points={qtyHexPts} fill={color} stroke="#0a1420" stroke-width="2" />
						{@render hexTerrain(qtyHexPts, g.terrain)}
						{@render hexBadge(gridId, 100, 90, 1.4, false, armiesOverride)}
					</svg>
				{/snippet}
				{#if dstId != null}
					{@const dstG = $game.map.grids[dstId]}
					{@const q = qtyValue()}
					{@const dstOwner = $game.states[dstId].owner}
					{@const srcOwner = $game.states[src].owner}
					{@const dstAfter = Math.max(0, $game.states[dstId].armies + q)}
					{@const srcAfter = Math.max(0, srcArmies - q)}
					{@const dstFillOverride = dstOwner == null && q > 0 && srcOwner ? PLAYER_COLORS[srcOwner] : null}
					<div class="qty-hex-row">
						{@render qtyHex(src, srcAfter, null)}
						<div class="qty-arrow" aria-hidden="true">→</div>
						{@render qtyHex(dstId, dstAfter, dstFillOverride)}
					</div>
					{#if dstG.terrain === 'desert' || dstG.terrain === 'mountain' || dstG.terrain === 'forest' || dstG.terrain === 'marsh'}
						<ul class="qty-mods">
							{#if dstG.terrain === 'desert'}<li class="warn">🏜 Desert — loses 1 army at the start of each of its owner's turns</li>{/if}
							{#if dstG.terrain === 'mountain'}<li>⛰ Mountain — defender bonus if attacked from here</li>{/if}
							{#if dstG.terrain === 'forest'}<li>🌲 Forest — attackers get cover on approach</li>{/if}
							{#if dstG.terrain === 'marsh'}<li class="warn">💧 Marsh — can't launch a second attack after using this as a source</li>{/if}
						</ul>
					{/if}
				{:else}
					{@render qtyHex(src, srcArmies + qtyValue(), null)}
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
				{#if $game.phase === 'move_qty'}
					<div class="qty-modal-warn">⚠ Confirming this move ends your turn.</div>
				{/if}
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
		{@const forestB = tgtG.terrain === 'forest' ? 1 : 0}
		{@const coalitionB = $game.coalitionTarget != null && $game.coalitionTarget === tgtSt.owner ? 1 : 0}
		{@const eliteB = $game.eliteAttackActive ? 2 : 0}
		{@const xBonus = crossingDefenseBonus($game, src, tgt)}
		{@const isInvasion = $game.pendingInvasionLane != null && (($game.pendingInvasionLane[0] === src && $game.pendingInvasionLane[1] === tgt) || ($game.pendingInvasionLane[0] === tgt && $game.pendingInvasionLane[1] === src))}
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
								{@render hexBadge(gridId, cx, cy, 1.4, false, $game.states[gridId].armies)}
							</svg>
							<ul class="side-mods">
								<li>Base die 1–{debugDieSides}</li>
								{#if role === 'attacker'}
									{#if forestB > 0}<li class="pos">+{forestB} 🌲 forest cover on target</li>{/if}
									{#if coalitionB > 0}<li class="pos">+{coalitionB} 🤝 Coalition vs {PLAYER_NAMES[tgtSt.owner!]}</li>{/if}
									{#if eliteB > 0}<li class="pos">+{eliteB} 🛡 Elite Troops</li>{/if}
									{#if g.terrain === 'marsh'}<li class="warn">Marsh — cannot re-attack from here this turn</li>{/if}
									{#if atkA <= 2}<li class="warn">⚠ One more lost roll {tgtSt.owner ? 'FORFEITS this territory to the defender and ends your turn' : 'aborts the attack'}!</li>{/if}
								{:else}
									{#if g.terrain === 'mountain'}<li class="pos">+1 ⛰ mountain</li>{/if}
									{#if st.fortified}<li class="pos">+2 🛡 fortified</li>{/if}
									{#if st.rampart}<li class="pos">+1 🏰 rampart</li>{/if}
									{#if isInvasion}<li class="pos">+1 ⚓ sea invasion</li>
									{:else if xBonus === 2}<li class="pos">+2 ⚓ sea-lane crossing</li>
									{:else if xBonus === 1}<li class="pos">+1 💧 river crossing</li>{/if}
									{#if bridgeCancels}<li class="warn">🌉 Bridge cancels river bonus</li>{/if}
									{#if g.terrain === 'forest'}<li class="warn">Forest — attacker gets +1</li>{/if}
									{#if g.terrain === 'desert'}<li class="warn">🏜 Desert — loses 1 army at the start of each of its owner's turns</li>{/if}
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
		<section class="analytics">
			{@render analyticsCharts($game.history)}
		</section>
	{/if}
</main>

{#snippet analyticsCharts(hist: GameState['history'])}
	{@const maxTerr = Math.max(1, ...hist.flatMap((h) => PLAYERS.map((p) => h.territories[p])))}
	{@const maxArm = Math.max(1, ...hist.flatMap((h) => PLAYERS.map((p) => h.armies[p])))}
	{@const chartW = 560}
	{@const chartH = 180}
	{@const xStep = hist.length > 1 ? chartW / (hist.length - 1) : 0}
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
{/snippet}

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

{#if (pinnedInfoHex ?? hoveredGrid) != null && (pinnedInfoPos ?? tooltipPos)}
	{@const shownHex = (pinnedInfoHex ?? hoveredGrid)!}
	{@const pinned = pinnedInfoHex != null}
	{@const info = hexInfo(shownHex)}
	{@const pos = (pinnedInfoPos ?? tooltipPos)!}
	{@const hp = clampTip(pos.x, pos.y, 280, 180)}
	<div class="hex-tooltip" class:pinned style="left:{hp.x}px; top:{hp.y}px">
		<div class="tt-title">
			<span class="tt-owner-dot" style="background:{info.ownerColor}"></span>
			<strong>{info.title}</strong>
			<span class="tt-armies">{info.armies}</span>
			{#if pinned}
				<button class="tt-close" onclick={dismissPinnedInfo} aria-label="Close">✕</button>
			{/if}
		</div>
		<div class="tt-owner" style="color:{info.ownerColor}">{info.owner}</div>
		{#if info.city}<div class="tt-city">★ {info.city}</div>{/if}
		{#each info.modifiers as m}
			<div class="tt-terrain">
				<div class="tt-terrain-name">{m.name}</div>
				{#if m.desc}<div class="tt-terrain-desc">{m.desc}</div>{/if}
			</div>
		{/each}
		{#if pinned}<div class="tt-hint">Tap this hex again, or elsewhere, to close</div>{/if}
	</div>
{/if}

<style>
	:global(html, body) {
		background: #0a1420;
		color: #d0e6f5;
		font-family: 'Segoe UI', system-ui, sans-serif;
		margin: 0;
		overflow-x: hidden;
	}
	main {
		max-width: 1400px;
		margin: 0 auto;
		padding: 0.75rem;
		box-sizing: border-box;
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
	/* Everyone's ganging up on this player — a warm ring distinct from the
	   blue "current turn" glow, plus a pulse so it reads at a glance even
	   when it's not this player's turn (the common case, since the bonus
	   is meant to be visible to whoever's deciding what to attack). */
	.score.coalition-target { border-color: #ff8a3d; box-shadow: 0 0 6px #ff8a3d; animation: coalition-pulse 1.6s ease-in-out infinite; }
	@keyframes coalition-pulse {
		0%, 100% { box-shadow: 0 0 4px #ff8a3d; }
		50% { box-shadow: 0 0 10px #ff8a3d; }
	}
	.coalition-badge { font-size: 0.8rem; line-height: 1; }
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
	.debug-btn {
		background: #ffbe3c;
		color: #1a1712;
		border-color: #ffbe3c;
		font-weight: bold;
	}
	.debug-btn:hover {
		background: #ffcc63;
		border-color: #ffcc63;
	}

	.menu {
		padding: 1.25rem 1.5rem;
		border: 2px solid #2a5a8a;
		border-radius: 12px;
		background: linear-gradient(135deg, #10304a, #0a2540);
		margin-bottom: 0.75rem;
		box-shadow: 0 0 20px rgba(74, 159, 207, 0.2);
	}
	.menu h2 {
		margin: 0 0 1rem;
		color: #e0f0ff;
		font-size: 1.15rem;
	}
	.menu-fields {
		display: flex;
		gap: 2rem;
		flex-wrap: wrap;
		margin-bottom: 1.15rem;
	}
	.menu label {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: #a8bfd4;
	}
	.menu input, .menu select {
		width: 100%;
		min-width: 150px;
		border-radius: 6px;
		padding: 0.4rem 0.6rem;
		border-color: #2a5a8a;
	}
	.menu-hint { font-weight: normal; color: #6a80a0; font-size: 0.72rem; }
	.menu-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding-top: 1rem;
		border-top: 1px solid rgba(127, 207, 255, 0.15);
		flex-wrap: wrap;
	}
	.menu-actions button {
		border-radius: 6px;
		padding: 0.5rem 1.1rem;
	}
	button.ghost {
		background: transparent;
		border: 1px solid #4a9fcf;
		color: #7fcfff;
	}
	button.ghost:hover:not(:disabled) { background: rgba(74, 159, 207, 0.15); }
	.share-label { font-size: 0.8rem; color: #7a8fa8; margin-left: auto; }
	.share-label strong { font-family: monospace; color: #ffe14a; }

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
		/* Map and side panel stack here, so the panel's own End Turn button
		   can scroll out of view — show the floating one again (higher-
		   specificity .placing/.buy rules elsewhere still override this for
		   their own cases regardless of source order). */
		.end-turn-fab { display: block; }
	}
	/* Phones and small tablets: tighten spacing, avoid horizontal scroll,
	   and give tap targets enough room for fingers instead of a mouse cursor. */
	@media (max-width: 640px) {
		main { padding: 0.4rem; }
		header { padding: 0.3rem 0.4rem; }
		.header-row { gap: 0.4rem; }
		.scoreboard { gap: 0.3rem; }
		.score { font-size: 0.72rem; padding: 0.15rem 0.35rem; }
		.actions { gap: 0.3rem; }
		.icon-btn { padding: 0.35rem 0.55rem; font-size: 0.78rem; }
		.menu { padding: 0.9rem 1rem; }
		.menu-fields { gap: 1rem; }
		.grid { gap: 0.5rem; }
		.card-grid { grid-template-columns: repeat(4, 1fr); }
		.qty-modal-actions button,
		.attack-actions button,
		.card-tile,
		button {
			min-height: 40px;
		}
		.log-chip { width: 38px; height: 38px; }
	}
	@media (max-width: 400px) {
		.card-grid { grid-template-columns: repeat(3, 1fr); }
	}
	.mapwrap { background: #0f2035; border: 1px solid #1a3040; }
	.map { width: 100%; height: auto; display: block; }
	/* Short/landscape viewports (phone rotated): mirror the iPad app's
	   layout (see ios/IsleWars/Views/ContentView.swift) — a full-bleed map
	   with the header/status/side-panel floating as translucent HUD pills
	   on top, instead of a docked sidebar that eats width from the board.
	   Portrait phones keep the normal stacked block layout; this only
	   kicks in when height is the scarce dimension. */
	@media (max-height: 600px) and (orientation: landscape) {
		main { padding: 0; }
		/* min-height, not height — the map fills exactly one screen (below)
		   but .side now flows normally after it instead of being absolutely
		   filled/clipped to this box, so the frame needs to grow with it. */
		.board-frame { position: relative; min-height: 100dvh; }
		header {
			position: absolute;
			top: max(0.4rem, env(safe-area-inset-top));
			left: max(0.4rem, env(safe-area-inset-left));
			right: max(0.4rem, env(safe-area-inset-right));
			z-index: 30;
			margin: 0;
			background: rgba(15, 32, 53, 0.88);
			backdrop-filter: blur(6px);
			border-radius: 8px;
			padding: 0.2rem 0.4rem;
		}
		.header-row { flex-wrap: nowrap; gap: 0.35rem; }
		.scoreboard { gap: 0.25rem; flex-wrap: nowrap; overflow-x: auto; }
		.score { font-size: 0.62rem; padding: 0.1rem 0.3rem; gap: 0.2rem; white-space: nowrap; }
		.bonus { display: none; }
		.actions { gap: 0.25rem; }
		.icon-btn { padding: 0.15rem 0.4rem; font-size: 0.68rem; }
		.turn { font-size: 0.68rem; padding: 0.1rem 0.3rem; }
		.speed select { font-size: 0.68rem; padding: 0.05rem 0.15rem; }
		/* New Game / Debug panels float below the header instead of pushing
		   the board down, same as everything else here — scrollable since
		   they're taller than a HUD pill should be. */
		.menu, .debug-panel {
			position: absolute;
			top: 2.5rem;
			left: max(0.4rem, env(safe-area-inset-left));
			right: max(0.4rem, env(safe-area-inset-right));
			z-index: 35;
			max-height: calc(100dvh - 3rem);
			overflow-y: auto;
			margin: 0;
		}
		.start-prompt, .msg {
			position: absolute;
			top: 2.5rem;
			left: max(0.4rem, env(safe-area-inset-left));
			right: max(0.4rem, env(safe-area-inset-right));
			z-index: 25;
			margin: 0;
			background: rgba(15, 32, 53, 0.85);
			backdrop-filter: blur(6px);
			border-radius: 6px;
		}
		.start-prompt { padding: 0.4rem 0.6rem; gap: 0.6rem; }
		.start-prompt h2 { font-size: 0.9rem; margin: 0; }
		.start-prompt p { font-size: 0.75rem; }
		.start-prompt button.big { padding: 0.4rem 0.8rem; font-size: 0.85rem; }
		/* This duplicates the phase hint already shown atop the floating side
		   panel (e.g. "Blue's turn — placing / Armies remaining: N…") — safe
		   to shrink hard since it's not the only place that info shows. */
		.msg { padding: 0.2rem 0.4rem; font-size: 0.75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		/* The map claims the entire first screen; the turn/cards/log column
		   (.side, unstyled here — it keeps its normal block layout) sits
		   right below in ordinary document flow, reached by scrolling rather
		   than fighting for space alongside or on top of the board. */
		.grid { display: block; }
		.mapwrap {
			height: 100dvh;
			display: flex;
			align-items: center;
			justify-content: center;
			overflow: hidden;
		}
		/* Fit the map to the full screen instead of sharing width with a
		   docked sidebar — the SVG's default preserveAspectRatio (xMidYMid
		   meet) scales it to fill without distortion. */
		.map { width: 100%; height: 100%; }
	}
	/* Shortest landscape phones (SE/mini-class, ~375-390px tall): even the
	   compacted qty-modal above doesn't quite fit under ~400px available
	   height with the hex illustration included — drop it entirely rather
	   than fine-tune margins further, since it's decorative (the actual hex
	   being placed on is already visible, blurred, behind the modal). */
	/* Small fixed badge that jumps down to the card hand — the tap target
	   for reaching cards once they're normal below-the-fold content instead
	   of an always-visible panel. Hidden outside the landscape breakpoint,
	   where the side panel is already on-screen alongside the map. */
	.cards-fab {
		display: none;
		position: fixed;
		right: max(0.75rem, env(safe-area-inset-right));
		bottom: max(0.75rem, env(safe-area-inset-bottom));
		z-index: 40;
		width: 52px;
		height: 52px;
		border-radius: 50%;
		background: rgba(15, 32, 53, 0.9);
		border: 1px solid #4a9fcf;
		backdrop-filter: blur(6px);
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
		font-size: 1.3rem;
		align-items: center;
		justify-content: center;
	}
	.cards-fab-count {
		position: absolute;
		top: -4px;
		right: -4px;
		background: #ffe14a;
		color: #1a1a1a;
		font-family: monospace;
		font-weight: bold;
		font-size: 0.7rem;
		min-width: 18px;
		height: 18px;
		border-radius: 9px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 3px;
	}
	/* Mirrors .cards-fab on the opposite bottom corner — toggles the
	   collapsed header/message bar instead of scrolling to below-the-fold
	   content, so it never has to fight the header itself for screen space
	   regardless of open/closed state. */
	.chrome-toggle {
		display: none;
		position: fixed;
		left: max(0.75rem, env(safe-area-inset-left));
		bottom: max(0.75rem, env(safe-area-inset-bottom));
		z-index: 40;
		height: 36px;
		min-width: 36px;
		border-radius: 18px;
		background: rgba(15, 32, 53, 0.9);
		border: 1px solid #4a9fcf;
		backdrop-filter: blur(6px);
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
		color: #d0e6f5;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		padding: 0 0.6rem;
		font-size: 0.8rem;
	}
	.chrome-toggle-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
	.chrome-toggle-turn { font-family: monospace; }
	/* Left edge, vertically centered — always visible (touch has no hover
	   in portrait either, not just landscape), and clear of .chrome-toggle/
	   .cards-fab, which only appear in the landscape breakpoint and sit at
	   the bottom corners. */
	.inspect-toggle {
		position: fixed;
		left: max(0.6rem, env(safe-area-inset-left));
		top: 50%;
		transform: translateY(-50%);
		z-index: 40;
		width: 38px;
		height: 38px;
		border-radius: 50%;
		background: rgba(15, 32, 53, 0.9);
		border: 1px solid #4a9fcf;
		backdrop-filter: blur(6px);
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
		color: #7fcfff;
		font-family: Georgia, serif;
		font-style: italic;
		font-weight: bold;
		font-size: 1.05rem;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		padding: 0;
	}
	.inspect-toggle.active {
		background: #4a9fcf;
		border-color: #7fcfff;
		color: #fff;
		font-style: normal;
	}
	/* Inspect mode exists because touch has no hover — on a device whose
	   primary pointer CAN hover (desktop mouse/trackpad), the tooltip already
	   works and this toggle is just clutter, so hide it there. (After the
	   base rule so its display: none beats the base display: flex.) */
	@media (hover: hover) and (pointer: fine) {
		.inspect-toggle {
			display: none;
		}
	}
	/* Top-right, mirroring .inspect-toggle's left-edge treatment — the side
	   panel's own End Turn button (in the "action" phase card) sits right
	   beside the map on any normal desktop-width window (see .grid's
	   1000px breakpoint below), so showing this too is a plain duplicate
	   there. Below that width the map and side panel stack vertically and
	   the panel button can scroll out of view, which is what this exists
	   to cover — so it's hidden by default and only shown under 1000px. */
	.end-turn-fab {
		display: none;
		position: fixed;
		right: max(0.6rem, env(safe-area-inset-right));
		/* Clears the header, which is visible by default everywhere except
		   the landscape-compact breakpoint (where it's collapsed to start —
		   see the override below) — without this, the fab sits directly on
		   top of the header's own Debug/Clear buttons and blocks clicks on
		   them, on any normal desktop-sized window. */
		top: max(3.5rem, calc(env(safe-area-inset-top) + 3.2rem));
		z-index: 40;
		background: #2a5a8a;
		border: 1px solid #7fcfff;
		color: #fff;
		border-radius: 20px;
		padding: 0.5rem 1rem;
		font-weight: bold;
		font-size: 0.85rem;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
		cursor: pointer;
	}
	.end-turn-fab:hover { background: #3a6a9a; }
	/* Informational, not actionable — muted like the other floating badges
	   (.cards-fab/.chrome-toggle) instead of the bright "primary" action
	   look, and no hover/pointer affordance since tapping it does nothing.
	   Unlike the actionable "End Turn" fab above, this one is pure
	   duplication of the side panel's own "Armies remaining" line whenever
	   that panel is actually on screen — hidden by default like
	   .cards-fab/.chrome-toggle, and only surfaced in the same compact-
	   landscape breakpoint where the header/message bar collapses. */
	.end-turn-fab.placing {
		display: none;
		background: rgba(15, 32, 53, 0.9);
		border-color: #4a9fcf;
		color: #a8bfd4;
		cursor: default;
		font-family: monospace;
	}
	.end-turn-fab.placing:hover { background: rgba(15, 32, 53, 0.9); }
	/* Actionable (unlike .placing above) — scrolls to the shop panel, so it
	   keeps the bright look/hover affordance of the base .end-turn-fab, just
	   in the gold-ish color of the shop itself. */
	.end-turn-fab.buy {
		display: none;
		background: #8a6a1a;
		border-color: #d4a83a;
	}
	.end-turn-fab.buy:hover { background: #a67f22; }
	@media (max-height: 600px) and (orientation: landscape) {
		.cards-fab { display: flex; }
		.chrome-toggle { display: flex; }
		.end-turn-fab.placing { display: block; }
		.end-turn-fab.buy { display: block; }
		/* .end-turn-fab sits at top-right too, same corner as the header's
		   own New/Share/Debug/Clear cluster. Everywhere else the header is
		   always visible, so the fab's default top offset clears it — but
		   here the header is collapsed by default (see landscapeChromeOpen),
		   so it can sit right at the top with nothing to avoid, UNLESS the
		   header is manually opened (.chrome-toggle) mid-action-phase, in
		   which case it drops back below it. Sibling selector: they're DOM
		   siblings, not nested. */
		.end-turn-fab { top: max(0.6rem, env(safe-area-inset-top)); }
		.board-frame.chrome-open ~ .end-turn-fab { top: 3rem; }
		/* Collapsed by default (see landscapeChromeOpen) — hide the header
		   and message bar until the toggle opens them. Not .start-prompt:
		   that's the "Start Game" CTA on a fresh game, and it's the only
		   way in — hiding it behind this same toggle would mean tapping the
		   toggle to find the button that reveals the toggle. */
		.board-frame:not(.chrome-open) header,
		.board-frame:not(.chrome-open) .msg {
			display: none;
		}
		/* .start-prompt normally sits below the header (top: 2.5rem); with
		   the header collapsed by default there's nothing above it to clear. */
		.board-frame:not(.chrome-open) .start-prompt {
			top: max(0.4rem, env(safe-area-inset-top));
		}
	}
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

	.card-price {
		margin-top: 0.25rem;
		font-size: 0.65rem;
		font-family: monospace;
		color: #ffd67f;
	}
	.card-tile-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 74px;
		border-radius: 6px;
		border: 1px dashed #2a4a6a;
		color: #4a6a8a;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.hint-inline {
		font-size: 0.75rem;
		font-weight: normal;
		color: #6a9abf;
	}
	.buy-armies-row { margin-bottom: 0.5rem; }

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
		padding: 0.75rem;
		box-sizing: border-box;
	}
	.qty-modal {
		background: linear-gradient(180deg, #10304a, #0a1a2c);
		border: 2px solid #4a9fcf;
		border-radius: 10px;
		padding: 1.5rem 1.75rem;
		width: 100%;
		max-width: 440px;
		max-height: 100%;
		overflow-y: auto;
		box-sizing: border-box;
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
	.qty-modal-warn {
		text-align: center;
		color: #ffb37f;
		font-size: 0.82rem;
		margin-top: 0.35rem;
		font-weight: bold;
	}

	.attack-modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(4, 10, 20, 0.7);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1500;
		padding: 0.75rem;
		box-sizing: border-box;
	}
	.attack-modal {
		background: linear-gradient(180deg, #10304a, #0a1a2c);
		border: 2px solid #ffe14a;
		border-radius: 12px;
		padding: 1.25rem 1.5rem;
		width: 100%;
		max-width: 780px;
		max-height: 100%;
		overflow-y: auto;
		box-sizing: border-box;
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

	@media (max-width: 640px) {
		.attack-hexes { grid-template-columns: 1fr; }
		.attack-vs { padding: 0.15rem 0; }
		.side-hex { max-width: 170px; }
		.attack-actions { grid-template-columns: 1fr 1fr; }
		.attack-actions button:last-child { grid-column: span 2; }
	}
	/* Short/landscape mobile modal compacting lives here — after all the
	   base qty-modal/attack-modal/side-hex rules above — rather than up
	   near the rest of the landscape layout CSS. CSS resolves same-specificity
	   conflicts by source order, not by whether a media query currently
	   matches, so an override positioned BEFORE the rule it targets loses
	   even when its condition is true; that silently broke every one of
	   these overrides (hex sizing, the text-overlay layout, even this same
	   attack-hexes stacking rule) until moved down here. */
	@media (max-height: 600px) and (orientation: landscape) {
		.qty-modal-backdrop, .attack-modal-backdrop { padding: 0.3rem; }
		.qty-modal, .attack-modal { padding: 0.35rem 0.6rem; }
		/* The hex is the one thing that matters most here (it's what you're
		   actually placing on/moving between) — shrink the title/value/
		   button chrome around it instead of the hex itself. */
		.qty-modal .side-hex { max-width: 132px; margin: 0.05rem auto 0.1rem; }
		.qty-modal-title { font-size: 0.78rem; margin: 0; }
		.qty-modal-sub { font-size: 0.66rem; margin: 0.05rem 0 0.15rem; }
		.qty-modal-value { font-size: 1.1rem; }
		.qty-modal-scale { font-size: 0.6rem; margin: 0.05rem 0 0.2rem; }
		.qty-modal-grid { gap: 0.2rem; margin-bottom: 0.2rem; }
		.qty-modal-grid button { padding: 0.22rem 0.25rem; font-size: 0.75rem; }
		.qty-modal-actions { margin-top: 0.2rem; }
		.qty-modal-actions button { padding: 0.3rem 0.4rem; font-size: 0.8rem; }
		.qty-hex-row { gap: 0.25rem; }
		.qty-mods { font-size: 0.68rem; margin: 0.15rem 0 0.1rem; }
		.qty-modal-warn { font-size: 0.68rem; margin-top: 0.15rem; }
		/* Overlay label/name/bonus text directly on the hex (same idea as
		   the army-count badge already drawn ON the hex, not stacked below
		   it) instead of stacking separate rows around it — that frees
		   enough height for the hex to be BIGGER than its old default size,
		   not smaller. Owner is dropped outright: the hex's own fill color
		   already says who owns it, once it's this size. */
		.attack-title { font-size: 0.9rem; padding-bottom: 0.3rem; margin-bottom: 0.4rem; }
		.attack-wp { font-size: 0.85rem; }
		.attack-side { position: relative; padding: 0.3rem; min-height: 0; }
		.attack-modal .side-hex { max-width: 190px; width: 100%; height: auto; margin: 0 auto; }
		.side-owner { display: none; }
		.side-label, .side-name, .side-mods {
			position: absolute;
			left: 0.5rem;
			right: 0.5rem;
			z-index: 2;
			margin: 0;
			text-shadow: 0 1px 3px #000, 0 0 6px #000, 0 0 6px #000;
		}
		/* .side-name's top must clear .side-label's own line box (top +
		   line-height), not just its top — these are absolutely positioned
		   with hand-picked offsets rather than normal stacking flow (that's
		   what lets them overlay the hex instead of pushing it down), so
		   the gap has to be spelled out explicitly or the two text lines
		   overlap. Doesn't affect the modal's height either way: it's
		   .side-hex (a normal-flow element) that drives .attack-side's
		   size, not where this absolutely-positioned text lands within it. */
		.side-label { top: 0.3rem; font-size: 0.6rem; }
		.side-name { top: 1.15rem; font-size: 0.85rem; }
		.side-mods { bottom: 0.3rem; font-size: 0.66rem; }
		.side-mods li { padding: 0; }
		.attack-actions { margin-top: 0.5rem; }
		.attack-actions button { padding: 0.45rem 0.4rem; font-size: 0.82rem; }
	}
	@media (max-height: 400px) and (orientation: landscape) {
		/* Safari's own collapsible toolbar means the effective viewport
		   here can be noticeably shorter than the device's full landscape
		   height, so this tier is reachable even on larger phones. */
		.qty-modal .side-hex { max-width: 92px; margin: 0.05rem auto 0.1rem; }
		.qty-modal-sub { margin-top: 0; }
		.attack-modal .side-hex { max-width: 150px; }
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
	.current-seed {
		flex: none;
		align-self: center;
		background: #1a1d26;
		border: 1px solid #345;
		border-radius: 4px;
		padding: 0.3rem 0.55rem;
		font-size: 0.9rem;
		letter-spacing: 0.05em;
		color: #ffd54a;
	}
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
	.turn-card-checks {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.turn-card-check {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		background: #1a1d26;
		color: #cfd6e2;
		border: 1px solid #33384a;
		border-radius: 6px;
		padding: 0.3rem 0.55rem;
		font-size: 0.82rem;
		cursor: pointer;
	}
	.turn-card-check:hover { border-color: #556; }
	.turn-card-check.on { border-color: #ffbe3c; background: #2a2113; color: #ffdf87; }
	.turn-card-actions {
		display: flex;
		gap: 0.75rem;
		margin-top: 0.4rem;
	}
	.link-btn {
		background: none;
		border: none;
		color: #8fb4ff;
		font-size: 0.78rem;
		cursor: pointer;
		padding: 0;
		text-decoration: underline;
	}
	.link-btn:hover { color: #b6cdff; }

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
	/* The hover variant is pointer-events:none so it never steals the mouse
	   from whatever's underneath — but the inspect-mode (tap-pinned) variant
	   needs its own close button to be tappable, since touch has no "move
	   the pointer away" equivalent to dismiss it. */
	.hex-tooltip.pinned { pointer-events: auto; }
	.tt-title { display: flex; align-items: center; gap: 0.4rem; }
	.tt-title strong { color: #e0f0ff; font-size: 0.95rem; }
	.tt-owner-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
	.tt-armies { margin-left: auto; color: #ffe14a; font-family: monospace; font-weight: bold; }
	.tt-close {
		margin-left: auto;
		background: none;
		border: none;
		color: #7fa0c0;
		font-size: 0.85rem;
		line-height: 1;
		padding: 0.15rem;
		cursor: pointer;
	}
	.tt-close:hover { color: #e0f0ff; }
	.tt-hint { color: #5a7a9a; font-size: 0.68rem; font-style: italic; margin-top: 0.5rem; text-align: center; }
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
		margin: 0;
		box-shadow: 0 0 20px rgba(74, 159, 207, 0.35), 0 8px 30px rgba(0, 0, 0, 0.45);
		flex-wrap: wrap;
	}
	/* Same banner treatment as Start Game, but gold — it marks the end of the
	   game rather than the way in. */
	.start-prompt.game-over {
		border-color: #ffe14a;
		box-shadow: 0 0 20px rgba(255, 225, 74, 0.35), 0 8px 30px rgba(0, 0, 0, 0.45);
	}
	/* On desktop, float the banner (fixed, centered at the BOTTOM of the
	   viewport — over the analytics strip, not the board) instead of sitting
	   in flow, so the map and side panel don't jump down and back up when it
	   appears/disappears. Only ≥1001px: below that the single-column layout
	   keeps it in flow, and the compact-landscape breakpoint (declared
	   earlier) has its own absolute placement this must not override. */
	@media (min-width: 1001px) and (min-height: 601px) {
		.start-prompt {
			position: fixed;
			bottom: 1rem;
			left: 50%;
			transform: translateX(-50%);
			width: auto;
			max-width: calc(100vw - 1.5rem);
			z-index: 30;
			/* Single slim line: title and hint run inline, button at the end. */
			flex-wrap: nowrap;
			white-space: nowrap;
			padding: 0.5rem 0.9rem;
		}
		.start-prompt > div:first-child { flex: 0 0 auto; }
		.start-prompt h2 { display: inline; font-size: 1rem; margin: 0 0.5rem 0 0; }
		.start-prompt p { display: inline; }
		.start-prompt button.big { padding: 0.45rem 1rem; font-size: 0.9rem; }
	}
	.start-prompt h2 { margin: 0 0 0.15rem; color: #e0f0ff; font-size: 1.15rem; }
	.start-prompt p { margin: 0; color: #a8bfd4; font-size: 0.9rem; }
	.start-prompt > div:first-child { flex: 1 1 auto; }
	.start-prompt > button { margin-left: auto; }
	@media (max-width: 480px) {
		.start-prompt { flex-direction: column; align-items: stretch; text-align: center; }
		.start-prompt > button { margin-left: 0; }
	}
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

	/* Game-over/turning-point UI now lives entirely on routes/recap — see
	   TurningPointCompareModal.svelte and TpMiniMap.svelte. */

</style>
