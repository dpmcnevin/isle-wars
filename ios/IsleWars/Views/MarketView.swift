import SwiftUI

/// The 'buy' phase: spend this turn's gold (which carries over unspent) on
/// armies and/or up to 3 offered cards, optionally rerolling the offer at an
/// escalating cost, then confirm to move on to placement/action. Mirrors
/// routes/+page.svelte's market panel — see docs/CARDS.md's "The gold
/// economy" section for the underlying rules.
struct MarketView: View {
    @ObservedObject var vm: GameViewModel
    let state: GameState

    private var gold: Int { state.gold(for: .human) }
    private var income: Int { state.goldIncomeThisTurn ?? 0 }
    /// Mirrors the engine's HAND_MAX (src/lib/game.ts) — buying past this
    /// just triggers an auto-discard for a human same as any other overflow,
    /// but disabling the tile avoids a purchase that silently bumps another
    /// card right back out.
    private let handMax = 5

    var body: some View {
        VStack(spacing: 16) {
            VStack(spacing: 2) {
                Text("Shop").font(.title2).bold()
                Text("\(gold) gold  ·  +\(income) this turn")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.textDim)
            }

            armiesRow

            cardGrid

            if state.armiesToPlace > 0 {
                Text("\(state.armiesToPlace) armies bought so far.")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textDim)
            }

            if state.hands[.human]?.count ?? 0 >= handMax {
                Label("Hand is full — discard before buying more cards.", systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            HStack(spacing: 16) {
                let reroll = vm.rerollCost()
                Button("Reroll (\(reroll)g)") { vm.rerollMarket() }
                    .buttonStyle(GameButtonStyle(kind: .secondary))
                    .disabled(gold < reroll)
                Button("Done Shopping") { vm.finishShopping() }
                    .buttonStyle(GameButtonStyle())
            }
        }
        .padding(24)
        .frame(minWidth: 360, maxWidth: 460)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(AppTheme.panel)
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(AppTheme.border, lineWidth: 1))
        )
        .foregroundStyle(AppTheme.text)
        .shadow(radius: 24)
    }

    private var armiesRow: some View {
        HStack(spacing: 10) {
            Button("+1 army") { vm.buyArmies(1) }
                .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
                .disabled(gold < 1)
            Button("+5 armies") { vm.buyArmies(5) }
                .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
                .disabled(gold < 1)
            Button("Max armies") { vm.buyArmies(gold) }
                .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
                .disabled(gold < 1)
        }
    }

    private var cardGrid: some View {
        HStack(spacing: 10) {
            ForEach(Array(state.marketSlots.enumerated()), id: \.offset) { index, card in
                if let card {
                    marketTile(card, offerIndex: index)
                } else {
                    emptySlot
                }
            }
        }
    }

    private func marketTile(_ card: CardType, offerIndex: Int) -> some View {
        let meta = card.meta
        let price = vm.cardPrice(card)
        let disabled = gold < price || (state.hands[.human]?.count ?? 0) >= handMax
        return Button {
            vm.buyCard(offerIndex: offerIndex)
        } label: {
            VStack(spacing: 4) {
                Text(card.icon).font(.title2)
                Text(card.label).font(.system(size: 10)).lineLimit(2).multilineTextAlignment(.center)
                Text("\(price)g").font(.system(size: 10, weight: .bold)).foregroundStyle(AppTheme.gold)
            }
            .padding(6)
            .frame(width: 88, height: 84)
            .background(RoundedRectangle(cornerRadius: 8).fill(meta.kind.color.opacity(0.28)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(meta.kind.color, lineWidth: 1.5))
        }
        .opacity(disabled ? 0.4 : 1)
        .disabled(disabled)
    }

    private var emptySlot: some View {
        VStack {
            Text("sold").font(.system(size: 10)).foregroundStyle(AppTheme.textDim)
        }
        .frame(width: 88, height: 84)
        .background(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.border, style: StrokeStyle(lineWidth: 1, dash: [4])))
    }
}
