import SwiftUI

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
    /// Capture arrows, drawn on the "after" map: white for the winner's own
    /// captures, red for losses.
    let arrows: [(from: Int, to: Int, color: Color)]
    /// Per-hex army count to label a changed hex with — falls back to
    /// `hexArmyDeltas` swings when there's no capture that turn (a pure
    /// army-swing turning point).
    let armyLabels: [Int: Int]

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

        let turnConquests = state.conquests?.filter { $0.turn == point.turn } ?? []
        let arrows: [(from: Int, to: Int, color: Color)] = turnConquests.compactMap { c in
            guard let from = c.from, changed.contains(c.grid),
                  c.attacker == winner || c.defender == winner else { return nil }
            let color: Color = c.attacker == winner ? .white : Color(red: 1.0, green: 0.35, blue: 0.35)
            return (from: from, to: c.grid, color: color)
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

        return TurningPointCompare(
            ownersBefore: ownersBefore,
            ownersAfter: ownersAfter,
            edgesBefore: edgesBefore,
            edgesAfter: edgesAfter,
            changedGrids: changed,
            arrows: arrows,
            armyLabels: armyLabels
        )
    }
}
