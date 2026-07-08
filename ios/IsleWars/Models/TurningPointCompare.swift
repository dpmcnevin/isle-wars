import SwiftUI

/// One capture/loss arrow on a turning-point mini-map — mirrors web's
/// `TpMiniMap.svelte` `Path` prop.
struct TurningPointArrow {
    let from: Int
    let to: Int
    let armies: Int?
    let color: Color
    let forfeited: Bool
    /// Set when the capture bypassed normal adjacency (Paratroop Attack) —
    /// mirrors web's `Path.via`; drawn with a 🪂 marker instead of looking
    /// like an unexplained cross-map line.
    let via: String?
}

/// View-model for one turning point's before/after mini-map compare —
/// mirrors the web recap's `tpView()` (`src/routes/recap/+page.svelte:194-258`).
struct TurningPointCompare {
    let ownersBefore: [Player?]
    let ownersAfter: [Player?]
    let edgesBefore: ReconstructedEdges
    let edgesAfter: ReconstructedEdges
    /// Hexes whose owner actually differs before vs. after — not just "had a
    /// conquest event" (a hex can be captured then recaptured within the
    /// same turn and net out unchanged).
    let changedGrids: Set<Int>
    /// The previous owner of each changed hex, for the "captured from" wedge
    /// (mirrors web's `capturedFrom`).
    let capturedFrom: [Int: Player?]
    /// Capture arrows, drawn on the "after" map: white for the winner's own
    /// captures, red for losses.
    let arrows: [TurningPointArrow]
    /// Per-hex army count to label a changed hex with — falls back to
    /// `hexArmyDeltas` swings when there's no capture that turn (a pure
    /// army-swing turning point).
    let armyLabels: [Int: Int]
    /// The single largest `armyLabels` entry, called out bigger/bolder —
    /// mirrors web's `biggestGrid` (nil when there are fewer than 2 labels,
    /// since there's nothing to call out among 0-1).
    let biggestGrid: Int?

    /// Builds the compare view-model for `point`, given the full final
    /// `GameState` (for `conquests`/`hexArmyDeltas`) and the engine-computed
    /// owner/edge snapshots bracketing the turn.
    static func build(
        point: TurningPoint,
        winner: Player?,
        state: GameState,
        ownersBefore: [Player?],
        ownersAfter: [Player?],
        edgesBefore: ReconstructedEdges,
        edgesAfter: ReconstructedEdges
    ) -> TurningPointCompare {
        let count = min(ownersBefore.count, ownersAfter.count)
        var changed: Set<Int> = []
        for id in 0..<count where ownersBefore[id] != ownersAfter[id] {
            changed.insert(id)
        }
        let capturedFrom = Dictionary(uniqueKeysWithValues: changed.map { ($0, ownersBefore[$0]) })

        let turnConquests = state.conquests?.filter { $0.turn == point.turn } ?? []
        let arrows: [TurningPointArrow] = turnConquests.compactMap { c in
            guard let from = c.from, changed.contains(c.grid),
                  c.attacker == winner || c.defender == winner else { return nil }
            let color: Color = c.attacker == winner ? .white : Color(red: 1.0, green: 0.35, blue: 0.35)
            return TurningPointArrow(from: from, to: c.grid, armies: c.armies, color: color, forfeited: c.forfeited ?? false, via: c.via)
        }

        let captureLabels = Dictionary(
            turnConquests.filter { changed.contains($0.grid) }.map { ($0.grid, $0.armies) },
            uniquingKeysWith: { _, new in new }
        )
        let swingLabels = Dictionary(
            (state.hexArmyDeltas ?? []).filter { $0.turn == point.turn }.map { ($0.grid, $0.delta) },
            uniquingKeysWith: { _, new in new }
        )
        let armyLabels = captureLabels.isEmpty ? swingLabels : captureLabels
        let biggestGrid = armyLabels.count < 2 ? nil : armyLabels.max(by: { $0.value < $1.value })?.key

        return TurningPointCompare(
            ownersBefore: ownersBefore,
            ownersAfter: ownersAfter,
            edgesBefore: edgesBefore,
            edgesAfter: edgesAfter,
            changedGrids: changed,
            capturedFrom: capturedFrom,
            arrows: arrows,
            armyLabels: armyLabels,
            biggestGrid: biggestGrid
        )
    }
}
