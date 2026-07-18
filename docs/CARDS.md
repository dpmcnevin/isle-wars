# Card system

All cards are defined by one **registry** — `CARD_DEFS` in `src/lib/cards.ts`. It is the
single source of truth for a card's display metadata, its draw-pool weight, and its
behaviour. Everything else (labels, the draw pool, the play/select flow, the web
highlight, the iOS card tiles) is derived from it.

`cards.ts` and `game.ts` import each other on purpose: the card closures call `game.ts`
helpers (`consumeCard`, `log`, `resolveBomb`, …) at runtime, and `game.ts`'s dispatch
imports the registry. That cycle is safe because the closures only *call* those helpers
at runtime (never at module load), and ES modules finish evaluating `cards.ts` before
`game.ts`'s own body runs. The `CardType` and `Phase` unions live in `game.ts` (imported
by `cards.ts`); `game.ts` re-exports the registry's public API so consumers still import
everything from `$lib/game`.

This document explains the structure and how to add a card.

## The shape of a card

```ts
interface SelectStep {
  phase: Phase;                    // the phase the game enters for this pick
  prompt: string;                  // the message shown while waiting for the pick
  // Returns an error message if `id` is NOT a legal pick, or null if it is.
  // This one predicate drives BOTH engine validation and UI highlighting.
  check: (s: GameState, id: number, from: number | null) => string | null;
}

interface CardDef {
  id: CardType;                    // matches a name in the CardType union
  label: string;                   // e.g. 'Water Invasion'
  icon: string;                    // emoji/glyph shown on the card tile
  kind: 'attack' | 'defense' | 'boost' | 'movement' | 'terrain';
  when: string;                    // human-readable "when playable" hint
  desc: string;                    // tooltip / rules text
  weight: number;                  // number of copies in the draw pool
  passive?: boolean;               // never actively played (e.g. antibomb)
  playableIn: Phase[];             // phases the card may be started from
  onPlay?: (s, idx) => void;       // IMMEDIATE cards do their work here
  steps?: SelectStep[];            // TARGETING cards: 1–2 selection steps
  onResolve?: (s, picks, idx) => void; // applies the effect after the last pick
}
```

Derived automatically from `CARD_DEFS`:

- `CARD_LABELS: Record<CardType, string>`
- `CARD_META: Record<CardType, CardMeta>` (`icon`, `kind`, `when`, `desc`)
- `CARD_POOL: CardType[]` — each card repeated `weight` times (the weighted draw bag)
- `PHASE_TO_STEP` — maps each step's `phase` back to `{ def, stepIdx }` for dispatch

## The three card shapes

Every card fits one of these (armies are bought directly with gold — see
"The gold economy" below — so there's no longer an "immediate, adds armies"
shape; every card is either a flag/passive or a targeting card):

| Shape | Uses | Examples |
|---|---|---|
| **Immediate flag/passive** | `onPlay` sets a flag; or `passive` | elite, bridge, antibomb |
| **1-step target** | `steps: [1]` + `onResolve` | bomb, sabotage, reinforce, fortify, rampart, deforest, oasis |
| **2-step from→to** | `steps: [2]` + `onResolve` | air, ferry, invasion, storm, artillery, wall |

### Immediate card example (rampart is 1-step; here's an immediate one)

```ts
{
  id: 'elite', label: 'Elite Troops', icon: '⚔', kind: 'attack', weight: 1,
  when: 'Action phase, before attacking',
  desc: 'Your next attack sequence rolls +2 on every die. Consumed by the first attack.',
  playableIn: ACTION_OR_ATTACK,
  onPlay: (s, idx) => {
    s.phase = 'action'; s.selectedFrom = null; s.selectedTo = null;
    s.eliteAttackActive = true; consumeCard(s, idx);
    log(s, `${PLAYER_NAMES[s.current]} rallied Elite Troops (+2 attack next battle).`, 'card');
    s.message = 'Elite Troops active. Attack now (+2 to each roll) — consumed by first attack.';
  }
}
```

### 1-step targeting example

```ts
{
  id: 'rampart', label: 'Rampart (+1)', icon: '🏰', kind: 'defense', weight: 2,
  when: 'Placement or Action phase', desc: '…',
  playableIn: ['placing', 'action'],
  steps: [{
    phase: 'rampart_select',
    prompt: 'Rampart: click one of your territories to reinforce it (+1 defense).',
    check: (s, id) => s.states[id].owner !== s.current ? 'Raise a rampart on one of your territories.'
      : s.states[id].rampart ? 'Already has a rampart.' : null,
  }],
  onResolve: (s, [id], idx) => {
    s.states[id].rampart = true; consumeCard(s, idx);
    log(s, `…raised a rampart on ${gridLabel(s, id)} (+1 defense).`, 'card');
    s.phase = 'action'; s.message = 'Attack, move, or pass.';
  }
}
```

### 2-step targeting example (wall)

```ts
{
  id: 'wall', label: 'Wall', icon: '🧱', kind: 'defense', weight: 2, /* … */
  playableIn: ['placing', 'action'],
  steps: [
    { phase: 'wall_from', prompt: 'Wall: click one of your territories …',
      check: (s, id) => s.states[id].owner !== s.current ? 'Build the wall on a hex you own.' : null },
    { phase: 'wall_to', prompt: 'Wall: click an adjacent hex to seal that edge.',
      check: (s, id, from) => {
        if (id === from) return 'Pick a neighbouring hex to wall off.';
        if (!s.map.adj[from!].includes(id) || s.map.grids[id].island !== s.map.grids[from!].island)
          return 'Must be a bordering hex on the same island.';
        if (crossesRiver(s.map, from!, id)) return 'That edge already has a river …';
        if (wallBetween(s.map, from!, id)) return 'There is already a wall on that edge.';
        return null;
      } },
  ],
  onResolve: (s, [from, to], idx) => { /* push the wall edge, consumeCard, set phase */ }
}
```

## How dispatch works

**Playing a card** (`playCard(idx)`):
1. Reject if a card was already played this turn (except `passive`).
2. `passive` cards print their "works automatically" message and stop.
3. Reject if `s.phase` isn't in `playableIn`.
4. `onPlay` cards run and finish.
5. Targeting cards stash `_pendingCardIdx = idx`, clear selection, and enter `steps[0].phase`
   with `steps[0].prompt`.

**Selecting a hex** (`selectGrid(gridId)`):
1. If `s.phase` is a card step (via `PHASE_TO_STEP`):
   - run the step's `check`; a non-null result is shown as the error message and the pick is rejected.
   - if there are more steps, store the pick in `selectedFrom` and advance to the next step;
   - otherwise call `onResolve(s, picks, _pendingCardIdx)`.
2. Otherwise fall through to the core **attack / move / placement** cases in the switch.

### Consuming the card

`consumeCard(s, idx)` removes the card from the hand **and** clears `_pendingCardIdx`.
Most `onResolve` implementations call it. The exception is **air**, which ends in a
quantity picker (`air_qty`); it does *not* consume in `onResolve` — `confirmAir()` calls
`consumeCard` once the amount is chosen. `invasion` resolves straight into
`attack_rolling`, and `artillery` runs its dice loop inline (`resolveArtillery`).

### The `check` predicate is the one source of truth

Because `check` returns "why this pick is illegal" (or null), the same function backs:

- **engine validation** in `selectGrid`,
- **web highlighting** — `isSelectableHex` / `cardSelectableAt` (used by `+page.svelte`),
- **iOS highlighting** — via the bridge's `selectableHexes()` (see below).

Never write selection rules in the UI. Put them in `check`.

## iOS (the bridge)

iOS runs the same engine in JavaScriptCore and reads cards over the bridge, so a new
**non-visual** selection card needs **zero Swift changes**:

- `cardCatalog()` returns every card's `{ id, label, icon, kind, when, desc }`.
  Swift's `CardType` is a string wrapper whose display comes from `CardCatalog`.
- `selectableHexes()` returns the grid ids the active player can select right now,
  so `MapView` highlights without knowing any per-card rules.
- Swift's `Phase` enum decodes unknown phase strings to `.unknown`, so a brand-new
  card selection phase can't crash JSON decoding.

Both bridge functions are declared in `ios/bridge/entry.ts` and consumed in
`ios/IsleWars/Engine/GameEngine.swift`.

## What is NOT data-driven

- **Map rendering.** A card that draws something on the map (walls, rivers, sea lanes)
  needs custom drawing in **both** `src/routes/+page.svelte` and
  `ios/IsleWars/Views/MapView.swift`. Most cards draw nothing and need neither.
- **The AI.** Heuristics live in `src/lib/ai.ts`: `runAiMarket` decides what to buy
  during the `'buy'` phase, `tryPlayAttackBuffCard` handles Elite/Bridge/Mountaineering
  right before the attack loop, and `tryPlayCardAction` scores everything else. A new
  card won't be bought or played by the AI until you add it to the relevant one. The
  AI drives the same public functions (`buyCard`, `playCard`, `selectGrid`), so it
  automatically respects `check` validation.

## The gold economy

Cards are never handed out for free. Each turn's `beginTurn` credits gold (the old
free-army-placement formula, renamed `computeGoldIncome`) and draws 3 cards from the
shared deck into `marketOffer`, priced by rarity (`cardPrice(weight)` in cards.ts —
rarer/lower-weight cards cost more). The `'buy'` phase lets a player spend gold on
`buyArmies` (1 gold = 1 army, added to `armiesToPlace`) and `buyCard` (straight into
hand) any number of times, plus `rerollMarket` at an escalating per-turn cost, before
calling `finishShopping` to move on to `'placing'` (if armies were bought) or `'action'`
directly. Gold carries over unspent. See `computeGoldIncome`, `marketFill`,
`buyArmies`, `buyCard`, `rerollMarket`, and `finishShopping` in game.ts.

## Placement gating

Only `reinforce` (a targeting card, not `onPlay`) is playable during the placement
phase (`TURN = ['placing', 'action']`) — everything else uses `ACTION_ONLY` (or
`ACTION_OR_ATTACK`): card resolution lands in the action phase, so a card played
mid-placement would silently forfeit the armies still waiting to be placed. The web
hand greys unplayable cards via `canPlayCardNow` (cards.ts) — the same predicate
`playCard` enforces. Reinforce returns to `placing` in its `onResolve` when armies
remain.

## Terrain-changing cards

Any card that mutates `map.grids[].terrain` (Deforestation, Oasis, Scorched Earth)
must call `pushTerrainEvent(s, id, prev, next)` before mutating, so the shareable
recap — whose map is regenerated from the seed with the *original* terrain — can
replay terrain to any turn (`reconstructTerrainAtTurn` in summary.ts).

## Checklist: adding a card

1. **`CardType` union** (`src/lib/game.ts`) — add the id.
2. **`Phase` union** (`src/lib/game.ts`) — add the new selection phase string(s), for
   targeting cards. (Swift's `Phase` does *not* need updating — unknown decodes safely.)
3. **`CARD_DEFS`** (`src/lib/cards.ts`) — add one entry (metadata, `weight`, `playableIn`,
   and either `onPlay` or `steps` + `onResolve`).
4. **AI** (optional) — add a heuristic in `src/lib/ai.ts` if the AI should play it.
5. **Rendering** (only if it draws map art) — `+page.svelte` and `MapView.swift`.
6. **Rebuild the iOS bundle** — `npm run build:ios-bridge`.
7. **Verify** — `npm run check`; drive the bundle headlessly in Node; `xcodebuild` if iOS changed.

Steps 1–3 are usually the whole change.
