import SwiftUI
import Charts

/// Post-game analytics, replacing the web app's hand-rolled SVG line
/// charts with native Swift Charts — built from the same `state.history`
/// (`TurnSnapshot[]`) the web app already accumulates every turn.
struct PostGameStatsView: View {
    let state: GameState
    let onNewGame: () -> Void
    /// Supplies turning points / the share link lazily rather than baking
    /// them into `state` — both are derived, on-demand engine calls (see
    /// GameViewModel.turningPoints/recapShareURL), not stored game state.
    var vm: GameViewModel?

    @State private var seedCopied = false
    @State private var turningPointIndex = 0

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

                if let vm {
                    turningPointsSection(vm)
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

                    if let vm, let url = vm.recapShareURL() {
                        ShareLink(item: url) {
                            Label("Share Recap", systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(GameButtonStyle(kind: .secondary))
                    }

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

    /// Moment stepper over the game's turning points — mirrors the web
    /// recap page's chip stepper, minus its before/after mini-map compare
    /// (a bigger lift: replaying `reconstructOwnersAtTurn` into a second
    /// rendered map), which is left for a follow-up.
    private func turningPointsSection(_ vm: GameViewModel) -> some View {
        let points = vm.turningPoints()
        return Group {
            if !points.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Turning Points").font(.headline)

                    let idx = min(turningPointIndex, points.count - 1)
                    let point = points[idx]

                    HStack(spacing: 6) {
                        ForEach(Array(points.enumerated()), id: \.offset) { i, p in
                            Button {
                                turningPointIndex = i
                            } label: {
                                Text(p.isFinal ? "★" : "\(i + 1)")
                                    .font(.caption2.bold())
                                    .frame(width: 22, height: 22)
                                    .background(Circle().fill(i == idx ? AppTheme.accent : AppTheme.panelDark))
                                    .foregroundStyle(i == idx ? Color.black : AppTheme.textDim)
                            }
                        }
                    }

                    HStack {
                        Button {
                            turningPointIndex = max(0, idx - 1)
                        } label: { Image(systemName: "chevron.left") }
                            .disabled(idx == 0)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Turn \(point.turn)").font(.caption).foregroundStyle(.secondary)
                            Text(point.headline).font(.subheadline)
                            HStack(spacing: 12) {
                                Text("Territories: \(point.territoriesAfter) (\(point.delta >= 0 ? "+" : "")\(point.delta))")
                                Text("Armies: \(point.armyDelta >= 0 ? "+" : "")\(point.armyDelta)")
                            }
                            .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button {
                            turningPointIndex = min(points.count - 1, idx + 1)
                        } label: { Image(systemName: "chevron.right") }
                            .disabled(idx == points.count - 1)
                    }
                }
                .frame(maxWidth: 560)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(AppTheme.panelDark.opacity(0.6)))
            }
        }
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
