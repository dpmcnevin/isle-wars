# Isle Wars

A turn-based strategy game of conquest across a sea of procedurally generated
islands. Place armies, storm your neighbours across hex borders and sea lanes,
and bend the battle with a deck of tactical cards. Plays against up to three AI
rivals.

Ships as a **web app** (SvelteKit) and a **native iPad app** (SwiftUI) that share
the exact same game engine.

> Inspired by the classic **Isle Wars** by [Soleau Software](https://www.soleau.com/).
> This is an independent, from-scratch reimagining — not affiliated with or
> endorsed by Soleau Software.

---

## Objective

Win by being the **last commander standing** — eliminate every opponent — or by
**conquering the entire map**. You're **Blue**; Green, Red, and Brown are the AI.

## The map

Every game is a fresh cluster of islands built from a hex grid: 3–7 landmasses,
~46–55 territories, wired together by sea lanes so the whole world is reachable.
Islands carry terrain (mountains, forests, marsh, desert), rivers, lakes and
bays, and the occasional fortified **city (★)**. Each new game rolls a new map;
enter or share a **seed** to replay a specific one.

## A turn, step by step

1. **Reinforce.** You receive income and place it on your territories.
   Income = `max(2, floor(territories ÷ 3))` **plus a full-island bonus** — hold
   every hex of an island and you collect that island's value each turn.
2. **Act.** Any number of attacks and card plays, then optionally **one move**.
   Moving armies between two of your territories **ends your turn**.
3. **End turn.** You **draw a card** — unless your turn ended on a *lost* battle.
   (It's the outcome of your *last* attack that matters.)

## Combat

Attack from one of your hexes (needs **2+ armies**) into an **adjacent** enemy or
neutral hex. Each round both sides roll a **d10** plus modifiers; **higher roll
wins**, **ties go to the defender**, and the loser removes one army. Keep rolling
until you take the hex, **Quit**, or drop to a single defender-less army. Take a
hex and you choose how many armies to march in.

Empty (neutral, 0-army) hexes are simply walked into — no dice.

### Modifiers

| Source | Effect |
|---|---|
| **Mountain** (defender) | +1 to the defender's die |
| **Forest** (defender's hex) | +1 to the **attacker's** die (cover) |
| **River** on the crossed edge | +1 defender (negated by a **Bridge** card) |
| **Sea lane** crossing | +2 defender (a **Water Invasion**'s temporary lane is only +1) |
| **Fortify** card | +2 defender, permanent until the hex is lost |
| **Rampart** card | +1 defender, stacks with Fortify |
| **Wall** card | **Blocks** all movement and attacks across one hex edge entirely |
| **Elite Troops** card | +2 to your attack rolls for the next battle |

### Terrain quirks

- **Marsh** — a hex used as an attack source can't attack again that turn.
- **Desert** — moving or airlifting armies in costs **1 army** (heat), and deserts
  never host cities. An **Oasis** card converts one back to plains.
- **City (★)** — a production centre. Some turns its garrison **doubles** on its
  own (capped, then grows steadily), so contested cities snowball. Cities are also
  the only launch sites for **Artillery**.

## Crossing water

Islands connect through **sea lanes**. You can attack and move along them like any
border (at the defensive penalty above). Cards reshape the seas: **Ferry Route**
opens a permanent lane over open water, **Water Invasion** opens a one-shot lane to
strike a beachhead, and **Storm** severs an existing lane.

## Cards

You hold up to **5** cards; draw one at the end of most turns. You may play **one
non-passive card per turn**. Cards come in five flavours:

| Kind | Cards |
|---|---|
| **Boost** | +5 / +8 / +15 Armies, Double (placement pool), Reinforce (+3 to a hex) |
| **Attack** | Bomb, Sabotage, Elite Troops, Bridge, Water Invasion, Artillery |
| **Defense** | Fortify (+2), Rampart (+1), Wall (seal an edge), Anti-Bomb (passive) |
| **Movement** | Air Move (fly armies anywhere you own), Ferry Route |
| **Terrain** | Deforestation, Oasis, Storm |

A few highlights: **Bomb** destroys 3–7 armies on any enemy hex (**Anti-Bomb**
auto-absorbs it); **Sabotage** halves a hex; **Artillery** bombards up to 2 hexes
from a city without risking your own troops; **Air Move** ignores adjacency but
ends your turn.

See **[docs/CARDS.md](docs/CARDS.md)** for the full card reference and the (very
short) recipe for adding new cards.

## Events

The world isn't static — roughly once every few turns a **random event** shakes
things up, and city production fires on its own. Watch the log.

## Controls

- **Place armies:** during reinforcement, click/tap one of your hexes and choose
  how many.
- **Attack / move:** drag from one of your hexes to an **adjacent** one — onto an
  enemy to attack, onto a friendly hex to move.
- **Cards:** click/tap a card to play it; targeting cards then prompt you to click
  the hex(es) they act on. Legal targets glow.
- **New game:** pick difficulty (1–4), starting armies, and optionally a seed to
  share or replay a map.

---

## Running it

**Web:**

```bash
npm install
npm run dev        # local dev server
npm run build      # static production build
```

**iPad (needs Xcode):**

```bash
cd ios && xcodegen generate
open ios/IsleWars.xcodeproj    # build & run on an iPad or simulator
```

The iPad app runs the web game's engine inside JavaScriptCore. After changing
game logic in `src/lib`, rebuild the bridge bundle with `npm run build:ios-bridge`
(the Xcode build also does this automatically).

For architecture, conventions, and the web ↔ iOS bridge, see **[CLAUDE.md](CLAUDE.md)**.

---

## Credits

Inspired by **Isle Wars** by [Soleau Software](https://www.soleau.com/), William
Soleau's classic strategy game. This project is an independent reimagining built
from scratch and is not affiliated with or endorsed by Soleau Software.
