// Hand-written forward pass for the trained value network (see ml/README.md).
// Deliberately not using tfjs/onnxruntime: this file is imported by ai.ts,
// which runs unmodified inside the iOS JSContext bridge (CLAUDE.md's "written
// once in src/lib" rule), so it can't depend on a runtime with native/WASM
// assets. The model is a tiny DeepSets-style MLP, so plain arithmetic here
// is both simpler and exactly reproducible from the exported weights.
//
// Feature extraction MUST exactly match ml/dataset.py (hex_features /
// global_features) -- this is the JS mirror of that Python code, not an
// independent reimplementation. If you change one, change both, then
// retrain + re-export (`python ml/export_weights.py`).

import type { GameState, Player } from './game';
import { PLAYERS } from './game';
import type { Terrain } from './map';
import {
	hexB1,
	hexB2,
	hexW1,
	hexW2,
	headB1,
	headB2,
	headW1,
	headW2
} from './valueNetWeights.generated';

const TERRAIN_INDEX: Record<Terrain, number> = { plain: 0, mountain: 1, forest: 2, marsh: 3, desert: 4 };
const HEX_FEATURE_DIM = 3 + 1 + 5 + 1; // owner-rel(3) + armies(1) + terrain(5) + production(1)

function linear(x: readonly number[], weight: readonly (readonly number[])[], bias: readonly number[]): number[] {
	const out = new Array<number>(bias.length);
	for (let o = 0; o < weight.length; o++) {
		let sum = bias[o];
		const row = weight[o];
		for (let i = 0; i < row.length; i++) sum += row[i] * x[i];
		out[o] = sum;
	}
	return out;
}

function reluInPlace(x: number[]): number[] {
	for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0;
	return x;
}

function sigmoid(x: number): number {
	return 1 / (1 + Math.exp(-x));
}

/** Predicts P(actor wins) from the board state at the start of their turn. */
export function predictWinProb(s: GameState, actor: Player): number {
	const hexHidden = hexB1.length;
	const pooled = new Array<number>(hexHidden).fill(0);
	const feat = new Array<number>(HEX_FEATURE_DIM).fill(0);

	for (const g of s.map.grids) {
		feat.fill(0);
		const st = s.states[g.id];
		if (st.owner === actor) feat[0] = 1;
		else if (st.owner == null) feat[2] = 1;
		else feat[1] = 1;
		feat[3] = Math.log1p(st.armies) / 4; // matches the training-time squash of the army-count tail
		feat[4 + TERRAIN_INDEX[g.terrain]] = 1;
		feat[9] = g.production ? 1 : 0;

		const h1 = reluInPlace(linear(feat, hexW1, hexB1));
		const h2 = reluInPlace(linear(h1, hexW2, hexB2));
		for (let i = 0; i < hexHidden; i++) pooled[i] += h2[i];
	}
	const n = s.map.grids.length || 1;
	for (let i = 0; i < hexHidden; i++) pooled[i] /= n;

	const opponents = PLAYERS.filter((p) => p !== actor);
	const aliveEnemies = opponents.filter((p) => s.alive[p]).length;
	const myHand = (s.hands[actor] ?? []).length;
	const enemyHandAvg = opponents.length
		? opponents.reduce((sum, p) => sum + (s.hands[p] ?? []).length, 0) / opponents.length
		: 0;
	const glob = [s.turn / 200, n / 60, aliveEnemies / 3, myHand / 5, enemyHandAvg / 5];

	const combined = pooled.concat(glob);
	const h = reluInPlace(linear(combined, headW1, headB1));
	const logit = linear(h, headW2, headB2)[0];
	return sigmoid(logit);
}
