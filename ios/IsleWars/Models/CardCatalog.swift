import Foundation

/// Display metadata for a single card, provided by the engine's `cardCatalog()`
/// (see src/lib/game.ts CARD_DEFS). The native client renders cards from this
/// instead of hardcoding labels/icons, so adding a card to the engine requires
/// no Swift changes.
struct CardInfo: Codable, Hashable {
    let id: String
    let label: String
    let icon: String
    let kind: String
    let when: String
    let desc: String
}

/// Process-wide card catalog, loaded once from the engine at startup. Keyed by
/// card id (the raw string that appears in `hands`).
enum CardCatalog {
    // Written once from the engine at startup (GameViewModel.init) and only read
    // thereafter, all on the main thread, so the unchecked global is safe.
    nonisolated(unsafe) private(set) static var entries: [String: CardInfo] = [:]

    static func load(from engine: GameEngine) {
        guard let list = try? engine.cardCatalog() else { return }
        entries = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    static func info(for id: String) -> CardInfo? { entries[id] }
}
