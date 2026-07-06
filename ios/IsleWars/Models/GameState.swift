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

struct HexArmyDelta: Codable {
    let turn: Int
    let grid: Int
    let delta: Int
}

enum ArmyEventCause: String, Codable {
    case bomb, sabotage, artillery, rebellion, earthquake, flood, production
}

struct ArmyEvent: Codable {
    let turn: Int
    let grid: Int
    let player: Player
    let delta: Int
    let cause: ArmyEventCause
    let by: Player?
}

struct TerrainEvent: Codable {
    let turn: Int
    let grid: Int
    let prev: Terrain
    let terrain: Terrain
}

enum EdgeEventKind: String, Codable {
    case wall, seaLane
}

struct EdgeEvent: Codable {
    let turn: Int
    let kind: EdgeEventKind
    let edge: [Int]
    let added: Bool
}

/// A single post-game "key moment" — mirrors `TurningPoint` from
/// `src/lib/summary.ts`'s `computeTurningPoints`. The headline is already a
/// finished sentence computed engine-side (`describeForWinner`), so Swift
/// just displays it rather than re-deriving cause/effect text.
struct TurningPoint: Codable, Identifiable {
    let turn: Int
    let delta: Int
    let territoriesAfter: Int
    let armyDelta: Int
    let conquests: [ConquestEvent]
    let headline: String
    let isFinal: Bool

    var id: Int { turn }
}

struct ConquestEvent: Codable {
    let turn: Int
    let grid: Int
    let attacker: Player
    let defender: Player?
    let from: Int?
    let armies: Int
    let forfeited: Bool?
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
    let startingArmies: Int?
    let mountainAttackActive: Bool?
    let capitals: [String: Int]?
    let conquests: [ConquestEvent]?
    let edgeEvents: [EdgeEvent]?
    let hexArmyDeltas: [HexArmyDelta]?
    let armyEvents: [ArmyEvent]?
    let terrainEvents: [TerrainEvent]?

    enum CodingKeys: String, CodingKey {
        case map, seed, difficulty, states, hands, alive, current, turn, phase
        case armiesToPlace, doubleActive, selectedFrom, selectedTo, pendingArmies
        case defeatedThisTurn, turnCardAwarded, lastAttackResult, pendingDiscard
        case eliteAttackActive, bridgeAttackActive, pendingInvasionLane
        case cardPlayedThisTurn, usedMarshHexes, gameStarted, log, message, winner
        case history, stats
        case pendingCardIdx = "_pendingCardIdx"
        case startingArmies, mountainAttackActive, capitals
        case conquests, edgeEvents, hexArmyDeltas, armyEvents, terrainEvents
    }

    /// Convenience: this player's hand, defaulting to empty if absent.
    func hand(for player: Player) -> [CardType] {
        hands[player] ?? []
    }

    var isHumanTurn: Bool { current == .human }

    var humanHand: [CardType] { hand(for: .human) }

    /// The grid id of `player`'s capital, if the map/save has capitals.
    func capital(for player: Player) -> Int? {
        capitals?[player]
    }

    /// The player whose capital sits on `grid`, if any.
    func capitalOwner(at grid: Int) -> Player? {
        guard let capitals else { return nil }
        return Player.allCases.first { capitals[$0] == grid }
    }
}
