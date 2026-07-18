import SwiftUI

/// Phase-driven controls. Quantity-needing phases (placement, move-in,
/// move, air) are now handled by `QuantityPickerSheet` (presented from
/// `ContentView`) and the attack-rolling/move-in phases by
/// `AttackModalView` — this panel just shows message text, the
/// action/cancel buttons, and terminal-state banners.
struct ActionPanelView: View {
    @ObservedObject var vm: GameViewModel
    let state: GameState

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Text(state.message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 260, alignment: .trailing)

            switch state.phase {
            case .action:
                // Attack/move are done by dragging on the map, so this only
                // needs the end-turn action.
                Button("End Turn") { vm.pass() }
                    .buttonStyle(GameButtonStyle(small: true))

            case .buy, .placing, .attackRolling, .attackMoveIn, .moveQty, .airQty, .paratroopQty, .discard, .gameOver:
                EmptyView() // guidance is in the message; modals handle the rest

            default:
                Button("Cancel") { vm.cancelAction() }
                    .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
            }

            if vm.isAiThinking {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("\(state.current.displayName) is thinking…").font(.caption2)
                }
            }
        }
        .padding(10)
    }
}
