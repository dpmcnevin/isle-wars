import SwiftUI

/// Full card hand: tappable tiles color-coded by `CardKind`, long-press to
/// see the full description (mirrors the web app's hover tooltip, adapted
/// for touch). Tapping plays the card (or discards it, in `.discard`
/// phase); disabled outside of phases where playing a card is legal.
struct CardHandGridView: View {
    let cards: [CardType]
    let phase: Phase
    /// Per-card legality straight from the engine's `canPlayCardNow` (phase/
    /// `cardPlayedThisTurn`/passive rules) — mirrors web's `canPlayCardNow`
    /// check rather than a coarser Swift-side phase approximation.
    let canPlay: (CardType) -> Bool
    let onTap: (Int) -> Void

    @State private var detailIndex: Int?

    private func isPlayable(_ card: CardType) -> Bool {
        phase == .discard || canPlay(card)
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(cards.enumerated()), id: \.offset) { index, card in
                    cardTile(card, index: index)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .frame(height: 72)
    }

    private func cardTile(_ card: CardType, index: Int) -> some View {
        let meta = card.meta
        let playable = isPlayable(card)
        // A plain tile with tap/long-press gestures rather than a `Button` — a
        // Button grabs the touch-down highlight and swallows horizontal drags,
        // which stops the enclosing horizontal ScrollView from panning.
        return VStack(spacing: 3) {
            Text(card.icon).font(.body)
            Text(card.label).font(.system(size: 9)).lineLimit(2).multilineTextAlignment(.center)
        }
        .padding(5)
        .frame(width: 64, height: 58)
        .background(RoundedRectangle(cornerRadius: 8).fill(meta.kind.color.opacity(0.28)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(meta.kind.color, lineWidth: 1.5))
        .contentShape(RoundedRectangle(cornerRadius: 8))
        .opacity(playable ? 1 : 0.45)
        .onTapGesture {
            if playable { onTap(index) }
        }
        .onLongPressGesture(minimumDuration: 0.35) {
            detailIndex = index
        }
        .popover(isPresented: Binding(
            get: { detailIndex == index },
            set: { if !$0 { detailIndex = nil } }
        )) {
            cardDetail(card)
        }
    }

    private func cardDetail(_ card: CardType) -> some View {
        let meta = card.meta
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(card.icon).font(.title)
                Text(card.label).font(.headline)
            }
            Text(meta.when).font(.caption).foregroundStyle(.secondary)
            Text(meta.desc).font(.body)
        }
        .padding()
        .frame(width: 280)
    }
}
