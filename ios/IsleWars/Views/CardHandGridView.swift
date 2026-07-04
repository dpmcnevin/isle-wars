import SwiftUI

/// Full card hand: tappable tiles color-coded by `CardKind`, long-press to
/// see the full description (mirrors the web app's hover tooltip, adapted
/// for touch). Tapping plays the card (or discards it, in `.discard`
/// phase); disabled outside of phases where playing a card is legal.
struct CardHandGridView: View {
    let cards: [CardType]
    let phase: Phase
    let onTap: (Int) -> Void

    @State private var detailIndex: Int?

    private var isPlayable: Bool {
        phase == .action || phase == .placing || phase == .discard
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(Array(cards.enumerated()), id: \.offset) { index, card in
                    cardTile(card, index: index)
                }
            }
            .padding(.horizontal)
        }
        .frame(height: 92)
    }

    private func cardTile(_ card: CardType, index: Int) -> some View {
        let meta = card.meta
        return Button {
            onTap(index)
        } label: {
            VStack(spacing: 4) {
                Text(card.icon).font(.title2)
                Text(card.label).font(.caption2).lineLimit(2).multilineTextAlignment(.center)
            }
            .padding(8)
            .frame(width: 84, height: 76)
            .background(RoundedRectangle(cornerRadius: 10).fill(meta.kind.color.opacity(0.28)))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(meta.kind.color, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .opacity(isPlayable ? 1 : 0.45)
        .disabled(!isPlayable)
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
