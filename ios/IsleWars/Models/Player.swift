import SwiftUI

enum Player: String, Codable, CaseIterable, Identifiable, Hashable {
    case blue, green, red, brown

    var id: String { rawValue }

    /// Matches the web app's `HUMAN` constant in +page.svelte.
    static let human: Player = .blue

    var displayName: String {
        switch self {
        case .blue: "Blue"
        case .green: "Green"
        case .red: "Red"
        case .brown: "Brown"
        }
    }

    var color: Color {
        switch self {
        case .blue: Color(red: 0x3a / 255, green: 0x7f / 255, blue: 0xd5 / 255)
        case .green: Color(red: 0x3a / 255, green: 0xc0 / 255, blue: 0x55 / 255)
        case .red: Color(red: 0xdd / 255, green: 0x44 / 255, blue: 0x44 / 255)
        case .brown: Color(red: 0xa0 / 255, green: 0x6a / 255, blue: 0x3a / 255)
        }
    }
}

/// Convenience accessors for the `Record<Player, T>`-shaped dictionaries
/// (`hands`, `alive`, `stats`, and the per-turn snapshot fields) that decode
/// as `[String: T]` since JSON object keys are always strings.
extension Dictionary where Key == String {
    subscript(player: Player) -> Value? {
        self[player.rawValue]
    }
}
