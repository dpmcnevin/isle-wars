# Adding Multiplayer to Isle Wars

This document lays out how to evolve Isle Wars — currently a single-device
SvelteKit app with local AI opponents — into a game that supports real human
opponents over a network. It's written against the current codebase, not in
the abstract, so it references real files and functions you'll touch.

## 1. What we have today

- **Stack**: SvelteKit (Svelte 5 runes) + TypeScript + Vite, built as a static
  SPA (`@sveltejs/adapter-static`), deployed to GitHub Pages. No backend.
- **State**: a single global store, `game = writable<GameState>(...)` in
  `src/lib/game.ts`. Every screen subscribes to this one object via `$game`.
- **Mutation**: state never changes ad hoc from the UI. All changes go
  through exported functions in `game.ts` — `placeArmies`, `beginAttack`,
  `rollAttack`, `confirmMove`, `confirmAir`, `playCard`, `discardCard`,
  `endTurn`, `selectGrid`, etc. — each of which calls `game.update(...)`
  internally. **This is the single most important existing seam**: it's
  already shaped like a command/action dispatch layer, even though it was
  built for a local, single-process game.
- **AI**: `src/lib/ai.ts`'s `runAiTurn()` drives a bot by calling the exact
  same dispatch functions a human uses, either async with animation pauses
  (web) or fully synchronously in one tick (iOS's JSContext, via
  `setAiSynchronous`, added because the JSCore environment has no real event
  loop and awaited `setTimeout`s could hang forever).
- **Randomness**: map generation is properly seeded (`mulberry32` in
  `src/lib/map.ts`, exposed via `?seed=` for sharing a starting layout).
  **Gameplay randomness is not seeded** — dice rolls (`rollDie()`), card
  draws, and random events all call `Math.random()` directly. Today's "share"
  feature only replays the same starting map; it does not reproduce a match.
- **No networking code exists at all** — no WebSocket, no fetch-based
  matchmaking, no server directory.

## 2. Pick an architecture

There are three broad ways to make a turn-based hex game multiplayer. Given
the shape of this codebase, they are not equally good fits.

### Option A — Host-authoritative server (recommended)

One party (a small Node/WebSocket server, or one of the players acting as
"host") owns the canonical `GameState` and is the only one who executes the
dispatch functions in `game.ts`. Every client sends *intents* ("I attack from
grid 12 to grid 15"); the host validates and applies them, then broadcasts
the resulting diffs or the new authoritative action log to all clients, who
replay it locally by calling the same dispatch functions.

**Why this fits**: the dispatch layer already exists and is pure enough
(inputs: grid ids / card ids; outputs: mutated `GameState`) that it can run
identically on a server as it does in the browser today. You get cheat
resistance for free (a client can't just set `armies = 999`), and you sidestep
the `Math.random()` determinism problem entirely — the host rolls the dice
once and tells everyone the result.

**Cost**: you need an actual server process (or a serverless relay) and a
protocol. Deployment stops being "static files on GitHub Pages" for anyone
who wants to host a match, though the static site can still serve the client
and just talk to a small separate multiplayer service.

### Option B — Deterministic lockstep (peer-to-peer, no server)

Every client runs the full simulation locally. Instead of sending state, players
send only their *inputs* (moves/attacks), and all clients apply them in the
same order using the same RNG seed, so every peer's `GameState` stays in
sync without ever transmitting it.

**Why this is tempting**: no server to run or pay for; fits the "static site"
deployment story perfectly, and the seeded-map precedent (`?seed=`) already
points this direction.

**Why it's risky here**: it requires *strict* determinism, and right now the
codebase is not deterministic — `Math.random()` is used directly in dice
rolls, card draws, AI tie-breaks, and random events (storms, sabotage
targets, deck reshuffles) in `game.ts`. Any floating-point or iteration-order
difference between two browsers/devices (the iOS JSContext bridge makes this
especially real) causes silent, hard-to-debug desyncs. You'd need to:
1. Replace every `Math.random()` call site with draws from a single shared
   `mulberry32`-style seeded stream stored in `GameState`.
2. Guarantee iteration order is stable everywhere state is derived from
   object/Map iteration (JS engines usually agree, but don't rely on it).
3. Add a periodic state-hash checksum exchange between peers so a desync is
   *detected* (players see "out of sync" instead of silently diverging
   forever) since lockstep has no authority to correct drift.

This is the classic approach for RTS games (age-of-empires-style) but it's
considerably more engineering than Option A for a project this size, and the
payoff (no server) matters less if you're fine running a small relay.

### Option C — Full state sync, no dispatch replay

Host (or one client) runs the game, and simply serializes and pushes the
*entire* `GameState` object to all clients after every action. Clients don't
run any game logic at all — they're pure renderers.

**Why it's simple**: zero risk of desync, since there's only ever one copy of
truth and everyone else just displays it.

**Why it's a poor fit here**: `GameState` is not small (full hex map + per-
grid state + hands + log + stats), so this wastes bandwidth on every single
click, and it throws away the nice local dispatch/animation flow the UI
already has (`+page.svelte` currently drives its own animations off local
state transitions). It also doesn't reuse the AI's existing pattern of
"calling dispatch functions," so it's the least aligned with current code.

**Recommendation: Option A.** It reuses the existing dispatch-function layer
almost unchanged, avoids the determinism minefield of Option B, and is far
more bandwidth-efficient than Option C. It also gives you a natural place to
keep running the existing AI (`runAiTurn`) for filling empty seats — the host
just calls it like it does today.

## 3. Concrete plan for Option A

### 3.1 Define a network protocol around existing dispatch calls

Introduce a typed `Action` union that mirrors the dispatch function
signatures already in `game.ts`, e.g.:

```ts
type Action =
  | { type: 'placeArmies'; player: Player; gridId: number; count: number }
  | { type: 'beginAttack'; from: number; to: number }
  | { type: 'rollAttack' }
  | { type: 'confirmMove'; count: number }
  | { type: 'playCard'; player: Player; cardId: string; /* card-specific payload */ }
  | { type: 'endTurn' }
  // ... one variant per exported dispatch fn you want networked
```

Add one small `applyAction(state, action)` switch that calls the matching
`game.ts` function. Both the host (authoritative) and the clients
(optimistic/replay) call through this same switch, so there's exactly one
place that maps wire messages to game logic.

### 3.2 Route all gameplay randomness through the host

Before any client trusts an outcome, the *host* must be the one to call
`rollDie()`, pick the next card, and resolve random events — never the
client. Two ways to implement:
- Simplest: dice/card/event dispatch functions run only on the host; the
  result (e.g. "attacker rolled 4,3,2; defender rolled 5,1") is broadcast as
  part of the action, and clients replay `rollAttack` with the *given* result
  rather than rolling again. This means adding an optional "predetermined
  outcome" parameter to the relevant `game.ts` functions instead of having
  them always call `Math.random()` — a small, surgical change, not a full
  seeded-RNG rewrite.
- More thorough (also fixes replay/spectator/reconnect for free): move to a
  single seeded RNG stream inside `GameState` (extending the existing
  `mulberry32` pattern used for the map) and have the host advance it; ship
  the resulting values in the action payload the same way.

Either way, **clients should never independently call `Math.random()` or
`rollDie()` for anything that affects shared state.**

### 3.3 Networking transport

A small WebSocket relay is the natural choice for a turn-based game like
this (low frequency of messages, need for low-latency delivery of turn
results, easy to add a "room code" flow). A lightweight Node/Bun WebSocket
server (or a hosted service like Supabase Realtime / PartyKit / Cloudflare
Durable Objects) can hold:
- one authoritative `GameState` per room,
- the list of connected players and which `Player` slot (blue/green/red/
  brown) each socket controls,
- fallback to `runAiTurn` for any slot with no connected human, exactly like
  local play does today.

This is intentionally decoupled from the static SPA: the built site still
deploys to GitHub Pages unchanged; it just also opens a WebSocket connection
to `wss://<your-relay>` when a multiplayer room is joined.

### 3.4 UI changes

- `+page.svelte`'s local dispatch calls (`placeArmies(...)`, `beginAttack
  (...)`, etc.) become "send `Action` to the host" instead of "mutate `game`
  directly," when in networked mode. A thin wrapper module
  (`src/lib/net.ts`) can expose the same function names/signatures as
  `game.ts` so the UI code barely changes — it just imports from `net.ts`
  instead of `game.ts` when a room is active.
- The client still applies the action locally as soon as the host confirms
  it (or optimistically, then reconciles) so the existing local animation
  code keeps working unchanged.
- Turn/phase gating (`current`, `phase` in `GameState`) already exists and
  should be enforced both client-side (for UX — disable controls when it's
  not your turn) and host-side (for correctness — reject actions from the
  wrong player).
- Reuse the existing AI freeze fix pattern: on the host, when filling an
  empty seat with `runAiTurn`, keep it synchronous/async-aware the same way
  `setAiSynchronous` does today, since the host is just another JS runtime
  running the same code.

### 3.5 Suggested build order

1. Extract `applyAction`/`Action` type in `game.ts` (or a new `actions.ts`)
   with no networking yet — refactor the UI to go through this single
   dispatcher. This is useful on its own (undo/redo, replay, better testing)
   and de-risks the rest.
2. Add the "predetermined outcome" parameters to the RNG-touching functions
   (`rollAttack`, card draw, random events) so determinism is possible
   without networking yet. Verify local play still works identically.
3. Stand up a minimal WebSocket relay (can start as a single Node process,
   in-memory rooms, no persistence) that just echoes validated actions
   between a room's clients, with one designated "host" client owning
   authority initially — this avoids writing full server-side game logic on
   day one.
4. Move authority fully server-side once the protocol is proven: the server
   imports `game.ts`/`applyAction` (it's already framework-agnostic
   TypeScript, not Svelte-coupled) and becomes the sole executor, clients
   become thin replayers.
5. Add reconnect/spectator support: since the server holds the canonical
   `GameState`, a reconnecting client just needs the current state snapshot,
   not the whole action history.

## 4. Things to explicitly decide before building

- **Do humans get to "host"** (peer acting as authority, simplest to ship,
  but that peer can cheat/crash the game) **or do you run a real server**
  (fair, needs infra/hosting cost)? Recommended: real server, even if tiny.
- **Room/matchmaking model**: invite-link/room-code (fits the existing
  `?seed=` sharing pattern well) vs. a lobby/matchmaking queue.
- **Reconnection**: what happens if a player's tab closes mid-match? Suggest
  falling back to `runAiTurn` for that seat after a timeout, letting them
  rejoin and reclaim it if they return before the match ends.
- **Card randomness** and hidden information (opponents' hands, if any are
  hidden in this game's rules) need the host to be the only party that knows
  the "true" deck order — check `game.ts`'s card-drawing logic for what's
  currently visible to all players locally versus what should become
  server-only knowledge once players are on separate machines.
