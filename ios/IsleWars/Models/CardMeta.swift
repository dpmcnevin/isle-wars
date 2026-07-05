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

/// Display fields for a card, derived from the engine catalog (see
/// `CardType.meta`). Card metadata lives in the engine registry, not here.
struct CardMeta {
    let kind: CardKind
    let when: String
    let desc: String
}
