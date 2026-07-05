import Foundation

/// A card id as it appears in the engine's `hands`. Backed by the raw string so
/// unknown/newly-added cards decode without crashing; all display metadata
/// (label/icon/kind/when/desc) comes from the engine-provided `CardCatalog`.
/// Nothing in the native layer branches on specific card ids — the engine owns
/// all card behaviour — so a plain string wrapper is sufficient.
struct CardType: RawRepresentable, Codable, Hashable {
    let rawValue: String

    init(rawValue: String) { self.rawValue = rawValue }

    init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    private var info: CardInfo? { CardCatalog.info(for: rawValue) }

    var label: String { info?.label ?? rawValue.capitalized }
    var icon: String { info?.icon ?? "🎴" }

    var meta: CardMeta {
        CardMeta(
            kind: CardKind(rawValue: info?.kind ?? "") ?? .boost,
            when: info?.when ?? "",
            desc: info?.desc ?? ""
        )
    }
}
