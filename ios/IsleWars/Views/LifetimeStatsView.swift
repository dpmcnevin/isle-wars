import SwiftUI

/// Career (lifetime, cross-game) stats modal — mirrors the web's
/// `LifetimeStatsModal.svelte`, sourced from `LifetimeStore` (Swift-native
/// persistence via UserDefaults, since there's no localStorage under JSC).
struct LifetimeStatsView: View {
    let vm: GameViewModel
    let onDismiss: () -> Void

    @State private var stats: LifetimeStats
    @State private var showingResetConfirm = false

    init(vm: GameViewModel, onDismiss: @escaping () -> Void) {
        self.vm = vm
        self.onDismiss = onDismiss
        _stats = State(initialValue: vm.lifetimeStats())
    }

    private var winRatePct: Int {
        guard stats.gamesPlayed > 0 else { return 0 }
        let ratio: Double = Double(stats.wins) / Double(stats.gamesPlayed)
        let pct: Double = ratio * 100
        return Int(pct.rounded())
    }

    private var avgTurns: Int {
        guard stats.gamesPlayed > 0 else { return 0 }
        let avg: Double = Double(stats.totalTurns) / Double(stats.gamesPlayed)
        return Int(avg.rounded())
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea()
                .onTapGesture(perform: onDismiss)

            VStack(spacing: 16) {
                Text("Career").font(.title).bold()

                if stats.gamesPlayed == 0 {
                    Text("No games recorded yet — finish a game to start your career stats.")
                        .foregroundStyle(AppTheme.textDim)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 320)
                } else {
                    statsGrid
                }

                HStack(spacing: 16) {
                    Button("Reset") { showingResetConfirm = true }
                        .buttonStyle(GameButtonStyle(kind: .secondary))
                        .disabled(stats.gamesPlayed == 0)
                    Button("Close", action: onDismiss)
                        .buttonStyle(GameButtonStyle())
                }
            }
            .padding(28)
            .frame(maxWidth: 420)
            .background(RoundedRectangle(cornerRadius: 16).fill(AppTheme.panelDark))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(AppTheme.border, lineWidth: 1))
            .foregroundStyle(AppTheme.text)
        }
        .alert("Reset career stats?", isPresented: $showingResetConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Reset", role: .destructive) { stats = vm.resetLifetimeStats() }
        } message: {
            Text("This clears all lifetime totals. This can't be undone.")
        }
    }

    private var statsGrid: some View {
        VStack(spacing: 10) {
            row("Games Played", "\(stats.gamesPlayed)")
            row("Wins", "\(stats.wins) (\(winRatePct)%)")
            row("Current Streak", "\(stats.currentStreak)")
            row("Best Streak", "\(stats.bestStreak)")
            row("Avg. Game Length", "\(avgTurns) turns")
            if let fastest = stats.fastestWinTurns {
                row("Fastest Win", "\(fastest) turns")
            }
            row("Attacks Won / Lost", "\(stats.attacksWon) / \(stats.attacksLost)")
            row("Territories Captured / Lost", "\(stats.territoriesCaptured) / \(stats.territoriesLost)")
            row("Cards Drawn / Played", "\(stats.cardsDrawn) / \(stats.cardsPlayed)")
            row("Armies Lost to Events", "\(stats.armiesLostToEvents)")
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(AppTheme.textDim)
            Spacer()
            Text(value).monospacedDigit().bold()
        }
    }
}
