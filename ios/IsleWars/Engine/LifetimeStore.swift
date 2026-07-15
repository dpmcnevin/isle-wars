import Foundation

/// Lifetime (cross-game) stats for the local player, persisted via
/// `UserDefaults` (there's no localStorage under JSC, so unlike most engine
/// state this is Swift-native rather than routed through the bridge) — a
/// straight port of `src/lib/lifetime.ts`'s `LifetimeStats`.
struct LifetimeStats: Codable, Equatable {
    var gamesPlayed = 0
    var wins = 0
    var currentStreak = 0
    var bestStreak = 0
    var totalTurns = 0
    var fastestWinTurns: Int?
    var attacksWon = 0
    var attacksLost = 0
    var territoriesCaptured = 0
    var territoriesLost = 0
    var cardsDrawn = 0
    var cardsPlayed = 0
    var armiesLostToEvents = 0
}

enum LifetimeStore {
    private static let key = "isle-wars-lifetime-v1"

    static func load() -> LifetimeStats {
        guard let data = UserDefaults.standard.data(forKey: key),
              let stats = try? JSONDecoder().decode(LifetimeStats.self, from: data)
        else { return LifetimeStats() }
        return stats
    }

    private static func save(_ stats: LifetimeStats) {
        guard let data = try? JSONEncoder().encode(stats) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    /// Folds a finished game into the lifetime totals and persists them.
    /// Callers are responsible for invoking this exactly once per finished
    /// game (see `GameViewModel`'s game-over guard).
    @discardableResult
    static func record(state: GameState, human: Player) -> LifetimeStats {
        var stats = load()
        let ps = state.stats[human]
        let won = state.winner == human
        stats.gamesPlayed += 1
        stats.totalTurns += state.turn
        if won {
            stats.wins += 1
            stats.currentStreak += 1
            stats.bestStreak = max(stats.bestStreak, stats.currentStreak)
            if stats.fastestWinTurns == nil || state.turn < stats.fastestWinTurns! {
                stats.fastestWinTurns = state.turn
            }
        } else {
            stats.currentStreak = 0
        }
        if let ps {
            stats.attacksWon += ps.attacksWon
            stats.attacksLost += ps.attacksLost
            stats.territoriesCaptured += ps.territoriesCaptured
            stats.territoriesLost += ps.territoriesLost
            stats.cardsDrawn += ps.cardsDrawn
            stats.cardsPlayed += ps.cardsPlayed
            stats.armiesLostToEvents += ps.armiesLostToEvents
        }
        save(stats)
        return stats
    }

    @discardableResult
    static func reset() -> LifetimeStats {
        let stats = LifetimeStats()
        save(stats)
        return stats
    }
}
