import SwiftUI
import Charts

/// Post-game analytics, replacing the web app's hand-rolled SVG line
/// charts with native Swift Charts — built from the same `state.history`
/// (`TurnSnapshot[]`) the web app already accumulates every turn.
struct PostGameStatsView: View {
    let state: GameState
    let onNewGame: () -> Void

    @State private var seedCopied = false

    private struct Point: Identifiable {
        let id = UUID()
        let turn: Int
        let player: Player
        let value: Int
    }

    private var territoryPoints: [Point] {
        state.history.flatMap { snapshot in
            Player.allCases.map { p in Point(turn: snapshot.turn, player: p, value: snapshot.territories[p] ?? 0) }
        }
    }

    private var armyPoints: [Point] {
        state.history.flatMap { snapshot in
            Player.allCases.map { p in Point(turn: snapshot.turn, player: p, value: snapshot.armies[p] ?? 0) }
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                if let winner = state.winner {
                    Text("\(winner.displayName) wins!")
                        .font(.largeTitle).bold()
                        .foregroundStyle(winner.color)
                }

                if !state.history.isEmpty {
                    chart(title: "Territories Owned", points: territoryPoints)
                    chart(title: "Armies", points: armyPoints)
                }

                statsTable

                HStack(spacing: 16) {
                    Button {
                        UIPasteboard.general.string = String(state.seed)
                        seedCopied = true
                    } label: {
                        Label(seedCopied ? "Copied!" : "Copy Seed", systemImage: seedCopied ? "checkmark" : "doc.on.doc")
                    }
                    .buttonStyle(GameButtonStyle(kind: .secondary))

                    Button("New Game") { onNewGame() }
                        .buttonStyle(GameButtonStyle())
                }

                Text("Seed: \(state.seed)")
                    .font(.caption).monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            .padding(32)
        }
        .background(.regularMaterial)
    }

    private func chart(title: String, points: [Point]) -> some View {
        VStack(alignment: .leading) {
            Text(title).font(.headline)
            Chart(points) { point in
                LineMark(
                    x: .value("Turn", point.turn),
                    y: .value(title, point.value)
                )
                .foregroundStyle(by: .value("Player", point.player.displayName))
            }
            .chartForegroundStyleScale([
                Player.blue.displayName: Player.blue.color,
                Player.green.displayName: Player.green.color,
                Player.red.displayName: Player.red.color,
                Player.brown.displayName: Player.brown.color
            ])
            .frame(height: 180)
        }
        .frame(maxWidth: 560)
    }

    private var statsTable: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Final Stats").font(.headline)
            ForEach(Player.allCases) { player in
                if let stats = state.stats[player] {
                    HStack {
                        Circle().fill(player.color).frame(width: 10, height: 10)
                        Text(player.displayName).frame(width: 70, alignment: .leading)
                        Text("W:\(stats.attacksWon) L:\(stats.attacksLost)").font(.caption).monospacedDigit()
                        Text("Captured:\(stats.territoriesCaptured)").font(.caption).monospacedDigit()
                        Text("Cards:\(stats.cardsPlayed)").font(.caption).monospacedDigit()
                    }
                }
            }
        }
        .frame(maxWidth: 560)
    }
}
