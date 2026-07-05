import SwiftUI

enum CardKind: String {
    case attack, defense, boost, movement, terrain

    var color: Color {
        switch self {
        case .attack: Color(red: 0.87, green: 0.31, blue: 0.27)
        case .defense: Color(red: 0.31, green: 0.55, blue: 0.87)
        case .boost: Color(red: 0.31, green: 0.72, blue: 0.36)
        case .movement: Color(red: 0.68, green: 0.45, blue: 0.87)
        case .terrain: Color(red: 0.72, green: 0.58, blue: 0.28)
        }
    }
}

struct CardMeta {
    let kind: CardKind
    let when: String
    let desc: String
}

extension CardType {
    var meta: CardMeta {
        switch self {
        case .air: CardMeta(kind: .movement, when: "Action phase", desc: "Move armies between any two of your territories, ignoring adjacency. Ends the turn.")
        case .bonus5: CardMeta(kind: .boost, when: "Placement phase", desc: "Add 5 armies to your placement pool this turn.")
        case .bonus8: CardMeta(kind: .boost, when: "Placement phase", desc: "Add 8 armies to your placement pool this turn.")
        case .bonus15: CardMeta(kind: .boost, when: "Placement phase", desc: "Add 15 armies to your placement pool this turn.")
        case .double: CardMeta(kind: .boost, when: "Placement phase", desc: "Double the number of armies you place this turn.")
        case .bomb: CardMeta(kind: .attack, when: "Placement or Action phase", desc: "Detonate on any enemy territory to destroy 3–7 of their armies.")
        case .antibomb: CardMeta(kind: .defense, when: "Passive", desc: "Automatically absorbs the next bomb targeting one of your hexes. No action needed.")
        case .reinforce: CardMeta(kind: .boost, when: "Placement or Action phase", desc: "Add 3 armies to any one of your territories immediately.")
        case .elite: CardMeta(kind: .attack, when: "Action phase, before attacking", desc: "Your next attack sequence rolls +2 on every die. Consumed by the first attack.")
        case .sabotage: CardMeta(kind: .attack, when: "Placement or Action phase", desc: "Halve the armies of any enemy territory (rounded down, min 1).")
        case .fortify: CardMeta(kind: .defense, when: "Placement or Action phase", desc: "Give one of your hexes a permanent +2 defense bonus. Lost when the hex is captured.")
        case .ferry: CardMeta(kind: .movement, when: "Placement or Action phase", desc: "Open a permanent sea lane between two of your territories over clear water.")
        case .invasion: CardMeta(kind: .attack, when: "Action phase", desc: "Open a temporary sea lane and launch an attack across it. The lane stays only if you conquer the target.")
        case .deforest: CardMeta(kind: .terrain, when: "Placement or Action phase", desc: "Clear any forest hex on the map. Removes the +1 attacker bonus that forests provide.")
        case .storm: CardMeta(kind: .terrain, when: "Placement or Action phase", desc: "Destroy any existing sea lane. Pick both endpoints of the route to sever.")
        case .artillery: CardMeta(kind: .attack, when: "Action phase (from a city ★)", desc: "Bombard any hex up to 2 steps away, launched from one of your cities. Roll four times — each hit removes one defender. Attackers never lose armies.")
        case .bridge: CardMeta(kind: .attack, when: "Action phase, before attacking", desc: "Bridge a river for your next attack — the defender loses the +1 river-crossing bonus. Consumed by the first attack.")
        case .oasis: CardMeta(kind: .terrain, when: "Placement or Action phase", desc: "Irrigate a desert hex you control, turning it back into plains. Removes the heat attrition.")
        case .rampart: CardMeta(kind: .defense, when: "Placement or Action phase", desc: "Give one of your hexes a permanent +1 defense bonus. Stacks with Fortify. Lost when the hex is captured.")
        }
    }
}
