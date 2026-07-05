import Foundation

enum Phase: String, Codable {
    case placing, action
    case attackSelectFrom = "attack_select_from"
    case attackSelectTo = "attack_select_to"
    case attackRolling = "attack_rolling"
    case attackMoveIn = "attack_move_in"
    case moveSelectFrom = "move_select_from"
    case moveSelectTo = "move_select_to"
    case moveQty = "move_qty"
    case bombSelect = "bomb_select"
    case airFrom = "air_from"
    case airTo = "air_to"
    case airQty = "air_qty"
    case reinforceSelect = "reinforce_select"
    case sabotageSelect = "sabotage_select"
    case fortifySelect = "fortify_select"
    case ferryFrom = "ferry_from"
    case ferryTo = "ferry_to"
    case invasionFrom = "invasion_from"
    case invasionTo = "invasion_to"
    case deforestSelect = "deforest_select"
    case oasisSelect = "oasis_select"
    case stormFrom = "storm_from"
    case stormTo = "storm_to"
    case artilleryFrom = "artillery_from"
    case artilleryTo = "artillery_to"
    case rampartSelect = "rampart_select"
    case wallFrom = "wall_from"
    case wallTo = "wall_to"
    case discard
    case gameOver = "game_over"
    /// Any phase the engine introduces that this build doesn't know about
    /// (e.g. a new card's selection step). The map highlights it via the
    /// engine's `selectableHexes`, and card taps still funnel through
    /// `selectGrid`, so an unknown phase stays fully playable without a crash.
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Phase(rawValue: raw) ?? .unknown
    }
}

enum Terrain: String, Codable {
    case plain, mountain, forest, marsh, desert
}
