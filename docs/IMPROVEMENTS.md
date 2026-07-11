# Isle Wars — Web App Improvement Ideas

Suggestions for the web app only (`src/lib` + `src/routes`), grounded in the
current code. iOS/macOS follow-through is deliberately out of scope here,
but remember the golden rule: anything that changes `src/lib` flows into the
iOS bundle, so rule changes below are "web-first" only in the sense that the
web UI is where we'd surface them first.

Rough priority within each section: top = highest impact / lowest effort.

---

## 1. Bugs & broken promises (do these first)

> **Status (July 2026): sections 1 and 2 are implemented**, with these choices:
> difficulty now gates AI attacks on a per-difficulty `winProbability` floor
> (`ATTACK_PROB_FLOOR` in ai.ts); the human-player seam is
> `setHumanPlayers`/`isHumanPlayer` in game.ts (UI still registers just blue);
> AI discard drops the most common card by draw-pool weight; the production
> surge was replaced by deterministic city income (`cityIncome`: +1/city,
> +2 for any capital — which also gives capital occupiers their reward, 2.5);
> events got an Off/Mild(12%)/Wild(25%) setting encoded in the seed and are
> telegraphed one turn ahead; Lose-All is 1% and only fires on hands of 3+;
> card pacing was deliberately left unchanged; the attack modal warns at the
> forfeit brink and auto-roll pauses there.

### 1.1 Difficulty does nothing
`GameState.difficulty` (1–4) is chosen in the UI, packed into seeds, and
logged — but `src/lib/ai.ts` never reads it. The comment in `startGame`
("it just changes how aggressively the AI plays (see ai.ts)") describes an
intent, not reality. Every game plays at the same difficulty.

Cheap, meaningful wiring options (pick one or combine):
- Scale the AI's attack-commitment threshold in `findBestAttack` (e.g. only
  attack at ≥55% / ≥50% / ≥45% / ≥40% estimated win chance by difficulty).
- Gate the value-net policy behind difficulty 3–4 (`setValueNetPlayers`),
  keeping the hand-tuned heuristic for 1–2.
- Give higher difficulties smarter card usage (today the AI's card play is
  the weakest part of its game — see 3.4).

### 1.2 Human player is hardcoded to blue
`HUMAN` is a constant in `+page.svelte` and blue is special-cased in
`awardTurnCardIfDue` (discard flow). Fine for now, but it blocks two cheap
features people will want: choosing your color, and hotseat play (5.2).
Replacing the constant with a `humanPlayers: Set<Player>` in one place would
unblock both.

### 1.3 Forced discard is inconsistent between human and AI
Humans over `HAND_MAX` get a discard modal; the AI silently discards its
*oldest* card (`enforceHandLimit` shifts). Oldest-first is a bad heuristic —
the AI will toss a hoarded +15 Armies to keep a Levee. Even
"discard the lowest-weight card" (rarer = keep) would be better; smarter is
a small per-card keep-score.

---

## 2. Balance

The dice/terrain core is in good shape (single die, ties to defender,
transparent bonuses, live win% preview). Most balance pain comes from the
random-event layer, which is high-variance and mostly outside player control.

### 2.1 Production surges are the biggest swing in the game
`beginTurn`: 10% chance per *turn* that every owned city **doubles** (up to
40, then +8). Compounding problems:
- It fires on the *current player's* turn but boosts **everyone's** cities,
  so it reads as random noise rather than something you earned.
- Doubling scales with what's already there — the leader benefits most
  (rich-get-richer), and a lucky early surge can decide the game.
- 10%/turn in a 4-player game ≈ 34% chance per round. It's frequent.

Suggestions:
- Make it deterministic and per-player: **each city produces +1 army on its
  owner's turn** (or +2 for the capital). Cities become a strategy ("take
  and hold cities") instead of a lottery ticket. This also makes the
  reinforcement math legible — players can count what a city is worth.
- If keeping the surge flavor, cap it additively (+50% not ×2) and announce
  it a round ahead ("Harvest coming next round!") so players can fight over
  cities before it lands.

### 2.2 Random events: frequency and counterplay
25% per turn (= ~1 event per round) of earthquake/flood/rebellion/flip. The
rebellion halving one stack and the rebels-flip are pure feel-bad with zero
counterplay. Options:
- Drop to ~12–15% per turn, or roll once per **round** instead of per turn.
- Telegraph one turn ahead ("Storm clouds gather over Kestrel…") so events
  become playable information instead of ambushes.
- Bias event targets away from the losing player (rubber-banding), or make
  rebellion scale with stack size only above a threshold (a 4-army hex
  losing 2 is noise; a 40-army capital stack losing 20 is a rage-quit).
- Make events a **game setting** (Off / Mild / Wild) in the new-game panel.
  It's a `startGame` arg + seed-encoding away, and the map editor already
  proves the settings plumbing works.

### 2.3 "Lose-All Cards" on draw (7%) is too punishing for its randomness
You did everything right (won your last battle), then lose a 5-card hand you
built over 5 turns. If the game needs a hand-reset valve, make it an event
card the *opponent* plays, or cap it at "discard 2". At minimum drop it to
~3% and never fire it on a hand of 1–2 cards (currently it wastes the
no-draw on small hands too — the draw is skipped even when there's nothing
to lose).

### 2.4 Card draw pacing and the one-card-per-turn rule
- You draw a card ~every turn but may play only one — hands hit `HAND_MAX`
  fast and the discard flow becomes routine. Consider: draw only when you
  **conquered at least one territory** this turn (Risk-style; the code
  already tracks `defeatedThisTurn` but doesn't use it for this), or raise
  the play limit to 2 with "max 1 attack-kind card".
- The `bonus15` (weight 1) is worth ~5 turns of base reinforcements on turn
  2 and merely nice on turn 30. Consider scaling bonuses ("+3 per territory
  you own, max 15") or weighting big bonuses into a "late deck".

### 2.5 Capital stakes are asymmetric in a dull way
Losing your capital costs you 3/turn, but the occupier gains nothing — so
capitals are worth defending but not attacking. Giving the occupier +1 or 
+2/turn (less than the owner's 3, still asymmetric) makes capitals
map-wide objectives. The `allCapitalsBonus` (+3 for all four) is almost
never reachable before the game is decided anyway.

### 2.6 Forfeit-on-1 rule surprises new players
The attacker being ground to 1 army *forfeits the source hex and ends the
turn* — a big hidden penalty behind an innocuous "Roll again" button. The
win% preview helps, but the UI should warn explicitly when attacker armies
get low mid-battle ("1 more loss forfeits this territory and ends your
turn!") — the auto-roll feature (`startAutoRoll`) makes it very easy to
grind yourself into a forfeit without noticing.

---

## 3. AI

### 3.1 Difficulty wiring — see 1.1.

### 3.2 The AI doesn't respect win probability enough
`winProbability` is exact and memoized, and the human sees it in the UI —
but `findBestAttack`'s heuristic and the value net don't obviously gate on
it. AI attacks that a human can see are <40% make it look dumb. A hard
floor ("never open an attack below X% except when desperate") is cheap and
makes the AI *feel* competent even if net strength barely changes.

### 3.3 Rage-quit stalemates
In long games, AIs with big stacks facing fortified positions can churn.
Consider: AI evaluates "turtle" (bank armies, take islands for bonuses) vs
"strike" postures based on relative army share, instead of always looking
for the best single attack.

### 3.4 AI card play
Worth an audit pass: does the AI ever play Wall/Canal defensively at a
chokepoint, or Tunnel to bypass a fortified hex it keeps failing against?
The nasty-interaction cards are the game's most distinctive content, and if
only the human uses them well, difficulty ceilings stay low. Even a rule
list ("if repeatedly failing vs a fortified hex and holding Tunnel, tunnel
it") beats generic play.

---

## 4. UX / design

### 4.1 Onboarding: there is no tutorial
The game has ~30 cards, 5 terrains, marsh/desert attrition rules, rivers,
walls, sea lanes, tunnels, capitals, island bonuses, forfeit rules — and a
new player learns them via error messages. Cheapest wins, in order:
1. **A rules/help modal** (static content, one evening of work): terrain
   table, combat modifiers, turn structure, card gallery generated from
   `CARD_DEFS` (label/icon/desc are already data — render the registry).
2. **First-game hint toasts** keyed off phase transitions ("Moving ends
   your turn!" the first time move_qty opens), stored in localStorage.
3. A guided scripted first game is the deluxe version; not necessary if 1–2
   exist.

### 4.2 Combat modifier breakdown *before* the fight
The win% chip is great. Next step: on attack-target hover, show the full
ledger the log shows after the fact ("+1 ⛰ mountain, +2 fort, +1 river →
you need 5+ to win a roll"). All the pieces exist (`defenseBonus`,
`attackerBonus`); it's presentation only.

### 4.3 Undo for placement
Misclicking a 12-army placement onto the wrong hex is unrecoverable.
Placement is the one phase where undo is trivially safe (no information
revealed, no dice rolled): keep a small undo stack during `placing` only.

### 4.4 Colorblind accessibility
Blue/green/red/brown ownership is only encoded by fill color. Add an
optional pattern/glyph overlay per player (stripes/dots, or the player
initial letter) and/or a colorblind-safe palette toggle. Also check the
red/green pairing specifically — that's the most common CVD axis.

### 4.5 Sound (optional, off by default)
Dice roll, conquest, card draw, event stinger. Web Audio, no assets needed
if synthesized; huge feel improvement for near-zero payload. Persist the
toggle in localStorage like `aiSpeed`.

### 4.6 Log usability
The log is capped at 100 entries and mixes everything. Add kind filters
(the `kind` field already exists: attacks / cards / events) and a per-turn
divider. Consider raising the cap — the recap page already proves the
analytics data survives; the in-game log is the only lossy view.

### 4.7 Break up `+page.svelte`
3,363 lines and growing. Not user-visible, but every UX item above costs
more than it should because map SVG, HUD, hand, modals, tooltips, debug
panel, and share links all live in one file. Extract at least: `MapView`,
`CardHand`, `QtyModal`, `DebugPanel`, `NewGamePanel`. (Svelte 5 component
extraction is mechanical; the `game` store is global so almost no props
need threading.)

---

## 5. New additions

### 5.1 Daily challenge (high leverage, small build)
The seed system already reproduces an exact game *setup*. A "Daily Isle"
mode — everyone plays the same seed, share your result — needs only:
- A date→seed function (`ISLE-YYYYMMDD` hashed through the existing seed
  path).
- A share-string of the result (turns taken, territories, seed link) like
  Wordle. The recap page already computes everything needed.
- Optionally, seeded gameplay RNG (5.4) so runs are fully comparable.

### 5.2 Hotseat / pass-and-play
Cheapest form of multiplayer and a natural fit for a turn-based game that
already runs entirely client-side: mark 2–4 players as human (see 1.2), show
a "pass the device to Green" interstitial between turns that hides the
outgoing player's hand. No networking, no docs/MULTIPLAYER.md scope.

### 5.3 Game modes / win conditions
Total conquest makes the last third of many games a formality. Cheap
alternates, all expressible as `checkWin` variants + a new-game setting:
- **Capital rush**: hold all four capitals for one full round.
- **Domination**: first to X% of territories or Y islands.
- **Turn-limited**: highest score at turn N (score = territories + island
  bonuses) — makes shorter sessions possible.

### 5.4 Seeded gameplay RNG
Today only the map is seeded; dice, card draws, and events use
`Math.random()` (docs/MULTIPLAYER.md already flags this). Threading one
mulberry32 stream through `rollDie`, `drawCard`, and `applyRandomEvent`:
- makes bug reports reproducible ("seed X, turn 12"),
- makes daily-challenge runs comparable,
- is a prerequisite for replays and networked play later,
- makes the test suite's `withFixedRolls` monkey-patching unnecessary.
The tricky part is save/load (persist the RNG cursor in `GameState`) — do
it behind a version bump of `SAVE_KEY`.

### 5.5 Match replay
`conquests`, `edgeEvents`, `terrainEvents`, `armyEvents`, `history` — the
recap page already reconstructs board state at any turn. A "replay" scrubber
(turn slider on the recap map, play button) is mostly UI over data that
already exists. This is the showpiece feature the analytics layer has been
quietly building toward.

### 5.6 Persistent profile stats & achievements
Cross-game stats in localStorage (games played/won, favorite card, biggest
comeback — computable from the final `GameState` at game_over). Light
achievements ("win without losing a battle", "win via Tunnel conquest")
give replay incentive for zero backend cost.

### 5.7 New card ideas (respect the registry's one-entry pattern)
Only if the deck feels stale — the current 30 are a lot already. Ideas that
create *interactions* with existing systems rather than new systems:
- **Embargo** (counter-card): target player draws no card this round —
  pairs with the draw economy.
- **Landslide**: turn a plain into a mountain (terrain counterpart to
  Deforestation; makes Mountaineering/Collapse more relevant).
- **Militia**: neutral hexes adjacent to a chosen enemy hex gain +2 armies
  (indirect harassment, no direct damage).
- **Diplomat**: peek at an opponent's hand (information counterpart to
  Spy's theft; trivially bridge-safe since hands are already in state).

### 5.8 Map variety settings
`generateMap` presumably has tunables (island count/size, river frequency).
Exposing 2–3 as new-game options (Archipelago / One big island / Riverlands
presets) multiplies perceived content for little code — and the seed
encoding already carries settings, so shared seeds keep working.

---

## 6. Suggested first batch

If picking five things to actually do next:

1. **Wire difficulty into the AI** (1.1) — it's advertised and absent.
2. **Tame production surges + event frequency** (2.1, 2.2) — biggest
   balance feel-bads, small diffs.
3. **Rules/help modal generated from `CARD_DEFS`** (4.1) — biggest
   new-player win, pure UI.
4. **Placement undo + forfeit warning** (4.3, 2.6) — the two most common
   "I hate this game" moments.
5. **Daily challenge** (5.1) — the retention feature the seed system
   already 90% supports.
