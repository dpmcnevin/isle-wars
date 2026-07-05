# CLAUDE.md

Guidance for working in this repo. Read this first.

## What this is

**Isle Wars** — a turn-based strategy game (Risk-like: place armies, attack across
adjacent hexes, play cards) on a procedurally generated island map. It ships as:

- **Web app** — SvelteKit + Svelte 5 (runes) + TypeScript. All game logic lives here.
- **Native iPad app** — SwiftUI (`ios/`). It does **not** reimplement the game; it
  runs the exact web logic inside a JavaScriptCore engine and renders natively.

## Architecture

```
src/lib/game.ts      Core game state, rules, turn flow, card dispatch (the svelte store `game`)
src/lib/cards.ts     The card registry: CARD_DEFS + card metadata/selection helpers
src/lib/map.ts       Procedural map generation + geometry helpers (rivers, walls, adjacency)
src/lib/ai.ts        AI opponent (drives the same public functions the UI calls)
src/routes/+page.svelte   The entire web UI (map SVG, HUD, card hand, modals)

ios/bridge/entry.ts  Bridge: imports src/lib unchanged, exposes a JSON-in/JSON-out
                     `globalThis.IsleWars` API. Bundled to game-bundle.js by esbuild.
ios/IsleWars/         SwiftUI app. Engine/GameEngine.swift hosts the JS bundle in a
                     JSContext; Models/ mirror the JSON shapes; Views/ render natively.
```

**The golden rule of the iOS port:** game logic is written **once**, in `src/lib`.
Swift never re-implements a rule — it calls the engine and renders the result. When
you change `src/lib`, you must rebuild the JS bundle for iOS to see it:

```bash
npm run build:ios-bridge      # regenerates ios/IsleWars/Resources/game-bundle.js
```

If you add or remove a Swift file, regenerate the Xcode project (it uses xcodegen and
an explicit file list, not a synchronized folder):

```bash
cd ios && xcodegen generate   # IsleWars.xcodeproj is gitignored, generated from project.yml
```

The Xcode build also runs `build:ios-bridge` as a pre-build step, so building from
Xcode picks up `src/lib` changes automatically. From the CLI you must run it yourself.

## Commands

```bash
npm run dev              # web dev server
npm run check            # svelte-check typecheck (run this after editing TS/Svelte)
npm run build            # static web build
npm run build:ios-bridge # rebuild the iOS JS bundle after any src/lib change

# iOS (needs Xcode):
cd ios && xcodegen generate
cd ios && xcodebuild -project IsleWars.xcodeproj -scheme IsleWars \
  -destination 'generic/platform=iOS Simulator' -configuration Debug \
  build CODE_SIGNING_ALLOWED=NO
```

## Cards

Cards are defined by a single **registry** (`CARD_DEFS` in `src/lib/cards.ts`). Adding a
card is normally one object there — no switch edits, and no Swift changes for
selection-based cards (iOS reads card metadata and selectable hexes over the bridge).
`cards.ts` and `game.ts` import each other by design; see **[docs/CARDS.md](docs/CARDS.md)**
for the full structure, why that cycle is safe, and an add-a-card checklist.

## Conventions & gotchas

- **Svelte 5 runes** (`$state`, `$derived`, `$props`) — not the old `$:`/stores-in-markup style.
- The game state is one big object in the `game` writable store; mutate inside
  `game.update((s) => { … return s; })`. It is serialized wholesale for save/load and
  for the iOS bridge, so **any field you add flows to iOS automatically** as JSON.
- `SAVE_KEY` (e.g. `isle-wars-save-v12`) versions the localStorage save; new optional
  fields decode fine, but a breaking state-shape change should bump it. Swift models
  use optionals for fields that may be absent in old saves.
- Adjacency lives in `map.adj` (includes sea lanes). Rivers and walls are stored as
  unordered hex-pair edges (`map.rivers`, `map.walls`); see `crossesRiver` / `wallBetween`.
- The AI runs synchronously on iOS (`setAiSynchronous(true)` in the bridge) because a
  JSContext has no event loop; the web keeps it async for animation pacing.

## Verifying changes

There's no unit-test harness. To exercise game logic headlessly, eval the built bundle
in Node and drive `globalThis.IsleWars` (start a game, `runAiTurn`, assert on state).
This is the fastest way to confirm a rules change end-to-end without launching either UI.
Always run `npm run check` and, for iOS-affecting changes, an `xcodebuild`.
