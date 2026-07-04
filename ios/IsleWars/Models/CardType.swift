import Foundation

enum CardType: String, Codable, CaseIterable {
    case air, bonus5, bonus8, bonus15, double, bomb, antibomb, reinforce, elite
    case sabotage, fortify, ferry, invasion, deforest, storm, artillery, bridge, oasis

    var label: String {
        switch self {
        case .air: "Air Move"
        case .bonus5: "+5 Armies"
        case .bonus8: "+8 Armies"
        case .bonus15: "+15 Armies"
        case .double: "Double"
        case .bomb: "Bomb"
        case .antibomb: "Anti-Bomb"
        case .reinforce: "Reinforce (+3)"
        case .elite: "Elite Troops"
        case .sabotage: "Sabotage"
        case .fortify: "Fortify"
        case .ferry: "Ferry Route"
        case .invasion: "Water Invasion"
        case .deforest: "Deforestation"
        case .storm: "Storm"
        case .artillery: "Artillery"
        case .bridge: "Bridge"
        case .oasis: "Oasis"
        }
    }

    var icon: String {
        switch self {
        case .air: "✈"
        case .bonus5: "+5"
        case .bonus8: "+8"
        case .bonus15: "+15"
        case .double: "×2"
        case .bomb: "💣"
        case .antibomb: "🛡"
        case .reinforce: "➕"
        case .elite: "⚔"
        case .sabotage: "☠"
        case .fortify: "⛩"
        case .ferry: "⚓"
        case .invasion: "🚢"
        case .deforest: "🪓"
        case .storm: "🌩"
        case .artillery: "💥"
        case .bridge: "🌉"
        case .oasis: "🌴"
        }
    }
}
