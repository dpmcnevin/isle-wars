# Isle Wars — ML Training Data

Isle Wars can emit a structured game log while running under `vite dev`.
The log is JSONL (one JSON object per line) and captures every decision
point and outcome — everything you need for supervised imitation learning,
reinforcement learning, or plain analytics.

## Getting the log

### Location

```
$(node -e "console.log(require('os').tmpdir())")/isle-wars-events.jsonl
```

On Linux this is usually `/tmp/isle-wars-events.jsonl`. **On macOS it is NOT
`/tmp`** — `os.tmpdir()` resolves to a per-session directory under
`/var/folders/...` (driven by the `TMPDIR` env var). Don't guess the path —
use one of the npm scripts below, which resolve it for you:

```bash
npm run log:path    # print the full path to the log file
npm run log:tail    # tail -f it live
npm run log:clear   # delete it (clean slate for the next run)
```

The Vite dev server also exposes three HTTP endpoints for managing it (dev
only — these do not exist in the static production build), if you'd rather
hit it directly (e.g. from a script that needs the exact path back):

| Method | URL | Effect |
|---|---|---|
| `POST` | `/api/log` | Append a JSON body as a line (the game itself calls this); response body includes `path` |
| `GET` | `/api/log` | Stream the file contents |
| `DELETE` | `/api/log` | Truncate the log |

### Clean-slate a run

```bash
npm run log:clear
npm run dev            # or however you launch it
# ... play a game / turn on auto-play in the Debug menu ...
```

### Watch live

```bash
npm run log:tail | jq -c '{type, turn, actor, kind: .action.kind}'
```

## Event schema

Every event has `ts` (ISO timestamp) and a `type` discriminator. All game-scoped
events also carry `game_id` — a random string minted at game start — so you can
filter events for a single game with `jq 'select(.game_id == "…")'`.

### `game_start`

Fires once at the start of every new game (including when you press "New Game"
in the UI or trigger a fresh save-disabled reload).

```jsonc
{
  "ts": "...",
  "type": "game_start",
  "game_id": "l7q1x...",
  "seed": 736669392,
  "difficulty": 2,
  "players": ["blue", "green", "red", "brown"],
  "map": {
    "width": 1400,
    "height": 900,
    "islands": [{"id": 1, "name": "Iceland", "value": 6}, ...],
    "grids": [
      {"id": 0, "island": 1, "terrain": "plain",   "production": false, "city": null},
      {"id": 1, "island": 1, "terrain": "mountain", "production": true,  "city": "Highkeep"},
      ...
    ],
    "adj": [[1, 4, 7], [0, 2, 5], ...],   // adjacency list per grid id
    "sea_lanes_initial": [[3, 21], ...]
  },
  "initial_state": { ...same shape as state_before below... }
}
```

### `action`

Fires for every decision made by any player.

```jsonc
{
  "type": "action",
  "game_id": "l7q1x...",
  "turn": 5,
  "actor": "green",
  "phase": "action",
  "action": {
    "kind": "attack_begin",       // one of: place | attack_begin | move | play_card | end_turn
    "from": 12, "to": 34
  },
  "state_before": { ... }
}
```

`action.kind` payloads:

| kind | fields |
|---|---|
| `place` | `grid` (int), `qty` (int) |
| `attack_begin` | `from` (int), `to` (int) |
| `move` | `from` (int), `to` (int), `qty` (int) |
| `play_card` | `card` (string), `index` (int position in hand) |
| `end_turn` | — |

### `attack_roll`

Fires once per die roll during an attack. Use to compute win rates, mine dice
distributions, or reconstruct combat trajectories.

```jsonc
{
  "type": "attack_roll",
  "game_id": "l7q1x...",
  "turn": 5,
  "actor": "green",
  "from": 12, "to": 34,
  "attacker_armies_before": 8,
  "defender_armies_before": 5,
  "dice_atk": 5,             // includes forest + elite bonuses
  "dice_def": 3,             // includes mountain + fortify bonuses
  "atk_bonus": 1,            // forest cover
  "def_bonus": 0,
  "elite_bonus": 2,          // Elite Troops card contribution
  "defender": "red"          // may be null for neutral
}
```

### `random_event`

Earthquakes, floods, rebellions, rebel-flips.

```jsonc
{
  "type": "random_event",
  "game_id": "l7q1x...",
  "turn": 12,
  "event_type": "earthquake"   // earthquake | flood | rebellion | rebels_flip
}
```

### `game_end`

Fires once when the game resolves.

```jsonc
{
  "type": "game_end",
  "game_id": "l7q1x...",
  "turn": 68,
  "winner": "green",           // or null on rare degenerate draw
  "final_state": { ... },
  "stats": {
    "blue":  { "attacksWon": ..., "attacksLost": ..., "territoriesCaptured": ..., "territoriesLost": ..., "cardsDrawn": ..., "cardsPlayed": ..., "armiesLostToEvents": ... },
    "green": { ... },
    "red":   { ... },
    "brown": { ... }
  }
}
```

## `state_before` — the observation

All `action` events (and the initial state on `game_start`, the final state on
`game_end`) carry a compact `state_before` snapshot designed for direct tensor
conversion. Per-grid arrays are indexed by grid `id` (0-based, dense).

```jsonc
{
  "grid_owners":      [-1, 0, 0, 2, 3, 3, 1, ...],   // -1 = neutral, 0..3 = player index (blue,green,red,brown)
  "grid_armies":      [ 0, 3, 5, 2, 4, 1, 3, ...],
  "grid_terrain":     [ 0, 1, 0, 2, 3, 0, 1, ...],   // 0 plain, 1 mountain, 2 forest, 3 marsh
  "grid_fortified":   [ 0, 0, 0, 0, 1, 0, 0, ...],   // 0/1
  "grid_production":  [ 0, 1, 0, 0, 0, 0, 1, ...],   // 0/1
  "sea_lanes":        [[3, 21], [14, 39]],           // dynamic — can grow (Ferry / Water Invasion) or shrink (Storm)
  "hands": {
    "blue":  ["reinforce", "ferry"],
    "green": [],
    "red":   ["bomb"],
    "brown": []
  },
  "scores": {
    "blue":  { "territories": 12, "armies": 34, "alive": true  },
    "green": { "territories":  7, "armies": 21, "alive": true  },
    "red":   { "territories":  0, "armies":  0, "alive": false },
    "brown": { "territories":  9, "armies": 27, "alive": true  }
  },
  "current": "green",
  "phase": "action",
  "armies_to_place": 0,
  "card_played_this_turn": false,
  "last_attack_result": null      // "win" | "loss" | null
}
```

The map topology in `game_start` is **static** for a game. State evolves via
`action` events; you only need `game_start.map.adj` + the sea-lane list in each
snapshot to know the full connectivity graph at that point in time.

## Recipes

The commands below use the literal path `/tmp/isle-wars-events.jsonl` for
brevity — substitute the real path from `npm run log:path` (e.g. via
`LOG=$(npm run log:path --silent)`) if you're on macOS.

### Extract (state, action) pairs for imitation learning

```bash
jq -c 'select(.type == "action") | {
  game:   .game_id,
  turn:   .turn,
  player: .actor,
  phase:  .phase,
  action,
  x:      .state_before
}' /tmp/isle-wars-events.jsonl > pairs.jsonl
```

### Attach terminal reward to every action

```bash
# 1) build a lookup {game_id → winner}
jq -c 'select(.type == "game_end") | {game_id, winner}' \
   /tmp/isle-wars-events.jsonl > winners.jsonl

# 2) join
python3 - <<'PY'
import json
winners = {}
with open('winners.jsonl') as f:
    for line in f:
        r = json.loads(line)
        winners[r['game_id']] = r['winner']

with open('/tmp/isle-wars-events.jsonl') as src, open('pairs_rewarded.jsonl', 'w') as dst:
    for line in src:
        e = json.loads(line)
        if e.get('type') != 'action':
            continue
        w = winners.get(e['game_id'])
        reward = 1 if w == e['actor'] else -1 if w and w != e['actor'] else 0
        dst.write(json.dumps({
            'game': e['game_id'],
            'turn': e['turn'],
            'player': e['actor'],
            'phase': e['phase'],
            'action': e['action'],
            'state': e['state_before'],
            'terminal_reward': reward,
        }) + '\n')
PY
```

### Per-roll dice statistics

```bash
jq -c 'select(.type == "attack_roll") | {
  actor,
  hit: (.dice_atk > .dice_def),
  margin: (.attacker_armies_before - .defender_armies_before),
  atk_bonus, def_bonus, elite_bonus
}' /tmp/isle-wars-events.jsonl > attacks.jsonl
```

### Convert to NumPy for PyTorch/JAX

```python
import json, numpy as np

def load_pairs(path):
    xs, actions, players = [], [], []
    with open(path) as f:
        for line in f:
            e = json.loads(line)
            s = e['state_before']
            # concatenate per-grid features
            g = np.stack([
                np.array(s['grid_owners']),
                np.array(s['grid_armies']),
                np.array(s['grid_terrain']),
                np.array(s['grid_fortified']),
                np.array(s['grid_production']),
            ])                                     # shape (5, num_grids)
            xs.append(g)
            actions.append(e['action'])
            players.append(e['actor'])
    return xs, actions, players
```

Grid IDs are stable within a game (the map is fixed), so a fixed-size per-hex
tensor works for any game with the same `seed`. For cross-game training you
usually want to build a graph/GNN over `game_start.map.adj`.

### Generate lots of games with the AI-vs-AI setup

1. Open the app in dev mode (`npm run dev`).
2. Click **Debug** in the header.
3. Enable **Auto-play the whole game**.
4. (Optional) Enable **Disable local save** so each reload starts a fresh map.
5. (Optional) Set the AI-speed selector to **⚡ instant** in the header.
6. Sit back — each finished game emits a `game_end` line and the next one
   auto-starts if you reload.

For a truly automated batch, add a small script (or use a browser-automation
tool like Playwright) that reloads the page after each `game_end`.

## Notes and caveats

- **Dev only.** The `configureServer` hook in `vite.config.ts` only runs under
  `vite dev`. Static production builds ship without the endpoint, and
  `import.meta.env.DEV` is inlined as `false` — the client-side `devLog(...)`
  calls are dead-code eliminated.
- **Persistence.** The log accumulates across runs. `npm run log:clear`
  (or `DELETE /api/log`) clears it. The file is at
  `os.tmpdir() + '/isle-wars-events.jsonl'` — run `npm run log:path` to get
  the exact path for your machine (macOS and Linux differ here).
- **File writes are not atomic** across concurrent tabs. If you spin up
  parallel auto-play instances, use separate ports or interleave — the file
  is written line-by-line but with no locking.
- **Turn boundaries.** Every human/AI turn ends with an `action` of kind
  `end_turn` (unless the game ends first) — a clean sentinel for chunking.
