import SwiftUI

struct ScoreboardView: View {
    let state: GameState

    private var totalTerritories: Int { state.states.count }

    private func territoryCount(for player: Player) -> Int {
        state.states.filter { $0.owner == player }.count
    }

    var body: some View {
        HStack(spacing: 8) {
            ForEach(Player.allCases) { player in
                let count = territoryCount(for: player)
                let alive = state.alive[player] ?? true
                VStack(spacing: 2) {
                    Circle()
                        .fill(player.color)
                        .frame(width: 12, height: 12)
                        .opacity(alive ? 1 : 0.3)
                    Text("\(count)/\(totalTerritories)")
                        .font(.caption2).monospacedDigit()
                        .strikethrough(!alive)
                }
                .frame(maxWidth: .infinity)
                .padding(4)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(state.current == player ? Color.yellow.opacity(0.25) : .clear)
                )
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(player.displayName): \(count) of \(totalTerritories) territories\(state.current == player ? ", current turn" : "")\(alive ? "" : ", eliminated")")
            }
        }
        .padding(.horizontal, 8)
    }
}
