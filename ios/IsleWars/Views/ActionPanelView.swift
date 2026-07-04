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
        VStack(alignment: .leading, spacing: 8) {
            Text(state.message)
                .font(.callout)
                .foregroundStyle(.secondary)

            switch state.phase {
            case .placing:
                Text("Armies to place: \(state.armiesToPlace)")
                    .font(.headline)
                Text("Tap one of your territories to place armies, or drag from a territory to attack/move.")
                    .font(.caption)

            case .action:
                HStack {
                    Button("Attack") { vm.beginAttack() }
                        .buttonStyle(.borderedProminent)
                    Button("Move") { vm.beginMove() }
                        .buttonStyle(.bordered)
                    Button("Pass / End Turn") { vm.pass() }
                        .buttonStyle(.bordered)
                }

            case .attackSelectFrom, .attackSelectTo, .moveSelectFrom, .moveSelectTo:
                Button("Cancel") { vm.cancelAction() }
                    .buttonStyle(.bordered)

            case .discard:
                Text("Tap a card in your hand to discard.")
                    .font(.caption)

            case .gameOver:
                if let winner = state.winner {
                    Text("\(winner.displayName) wins!")
                        .font(.title2).bold()
                        .foregroundStyle(winner.color)
                }

            case .attackRolling, .attackMoveIn, .moveQty, .airQty:
                EmptyView() // handled by AttackModalView / QuantityPickerSheet

            default:
                Button("Cancel") { vm.cancelAction() }
                    .buttonStyle(.bordered)
            }

            if vm.isAiThinking {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("\(state.current.displayName) is thinking…").font(.caption)
                }
            }
        }
        .padding()
    }
}
