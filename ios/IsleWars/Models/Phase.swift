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
    case discard
    case gameOver = "game_over"
}

enum Terrain: String, Codable {
    case plain, mountain, forest, marsh, desert
}
