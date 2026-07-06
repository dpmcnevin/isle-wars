import Foundation

struct GridState: Codable {
    let owner: Player?
    let armies: Int
    let fortified: Bool?
    let rampart: Bool?
}

enum LogKind: String, Codable {
    case info, attack, event, card, defeat
}

struct LogEntry: Codable, Identifiable {
    let turn: Int
    let player: Player?
    let text: String
    let kind: LogKind?

    // Synthesized identity for SwiftUI lists; log entries have no id in the
    // JS model, and the array is prepended-to over time.
    var id: String { "\(turn)-\(player?.rawValue ?? "-")-\(text)" }
}

struct PlayerStats: Codable {
    let attacksWon: Int
    let attacksLost: Int
    let territoriesCaptured: Int
    let territoriesLost: Int
    let cardsDrawn: Int
    let cardsPlayed: Int
    let armiesLostToEvents: Int
}

struct TurnSnapshot: Codable {
    let turn: Int
    let territories: [String: Int]
    let armies: [String: Int]
    let islands: [String: Int]
}

enum AttackResult: String, Codable {
    case win, loss
}

struct GameState: Codable {
    let map: GameMap
    let seed: String
    let difficulty: Int
    let states: [GridState]
    let hands: [String: [CardType]]
    let alive: [String: Bool]
    let current: Player
    let turn: Int
    let phase: Phase
    let armiesToPlace: Int
    let doubleActive: Bool
    let selectedFrom: Int?
    let selectedTo: Int?
    let pendingArmies: Int
    let defeatedThisTurn: Bool
    let turnCardAwarded: Bool
    let lastAttackResult: AttackResult?
    let pendingDiscard: Bool
    let eliteAttackActive: Bool
    let bridgeAttackActive: Bool
    let pendingInvasionLane: [Int]?
    let cardPlayedThisTurn: Bool
    let usedMarshHexes: [Int]
    let gameStarted: Bool
    let log: [LogEntry]
    let message: String
    let winner: Player?
    let history: [TurnSnapshot]
    let stats: [String: PlayerStats]
    let pendingCardIdx: Int?

    enum CodingKeys: String, CodingKey {
        case map, seed, difficulty, states, hands, alive, current, turn, phase
        case armiesToPlace, doubleActive, selectedFrom, selectedTo, pendingArmies
        case defeatedThisTurn, turnCardAwarded, lastAttackResult, pendingDiscard
        case eliteAttackActive, bridgeAttackActive, pendingInvasionLane
        case cardPlayedThisTurn, usedMarshHexes, gameStarted, log, message, winner
        case history, stats
        case pendingCardIdx = "_pendingCardIdx"
    }

    /// Convenience: this player's hand, defaulting to empty if absent.
    func hand(for player: Player) -> [CardType] {
        hands[player] ?? []
    }

    var isHumanTurn: Bool { current == .human }

    var humanHand: [CardType] { hand(for: .human) }
}
