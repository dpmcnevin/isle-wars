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
    /// Backs the gallery ScrollView's `.scrollPosition(id:)` — the source of
    /// truth for which page is centered while the user is actively swiping;
    /// synced into `turningPointIndex` (used by the chips/charts elsewhere on
    /// this screen) via `.onChange` in `turningPointsSection`.
    @State private var turningPointScrollTarget: Int?

    // Identity must be stable across renders — a per-init UUID would hand
    // Swift Charts a "completely new" dataset on every body evaluation,
    // forcing it to rebuild both charts each time anything on screen changes.
    private struct Point: Identifiable {
        let turn: Int
        let player: Player
        let value: Int
        var id: String { "\(turn)-\(player.rawValue)" }
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

    private enum ChartField { case territories, armies }

    /// The turn the currently-selected turning point "reached" — everything
    /// at or before this turn draws in full color, everything after greys
    /// out, mirroring the web recap's clipPath-based "you are here" chart.
    private func reachedTurn(_ turningPoints: [TurningPoint]) -> Int {
        guard !turningPoints.isEmpty else { return state.turn }
        return turningPoints[min(turningPointIndex, turningPoints.count - 1)].turn
    }

    var body: some View {
        let turningPoints = vm?.turningPoints() ?? []
        let reached = reachedTurn(turningPoints)

        ScrollView {
            VStack(spacing: 16) {
                if let winner = state.winner {
                    Text("\(winner.displayName) wins!")
                        .font(.title).bold()
                        .foregroundStyle(winner.color)
                }

                if !state.history.isEmpty {
                    HStack(alignment: .top, spacing: 16) {
                        chart(title: "Territories Owned", points: territoryPoints, field: .territories, turningPoints: turningPoints, reachedTurn: reached)
                        chart(title: "Armies", points: armyPoints, field: .armies, turningPoints: turningPoints, reachedTurn: reached)
                    }
                }

                if let vm {
                    turningPointsSection(vm, points: turningPoints)
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
            .padding(.horizontal, 32)
            .padding(.top, 20)
            // Extra bottom padding beyond the symmetric 32pt: without it the
            // last stats row sits flush with (or behind) the safe-area/home
            // indicator at the very bottom of the scroll content, reading as
            // "cut off" even though the ScrollView technically reaches it.
            .padding(.bottom, 64)
        }
        .background(.regularMaterial)
        .ignoresSafeArea(edges: .bottom)
    }

    /// Where each turning point's numbered dot sits on a chart — on the
    /// winner's line, at the snapshot right after the turn (history is
    /// start-of-turn, so turn+1 is where the swing has landed). Falls back
    /// to `territoriesAfter`/the last snapshot + `armyDelta` for the final
    /// turn, which has no following snapshot (mirrors web's `tpMarker`).
    private func turningPointMarkers(_ turningPoints: [TurningPoint], field: ChartField) -> [(turn: Int, value: Int)] {
        guard let winner = state.winner else { return [] }
        return turningPoints.map { tp in
            if let snap = state.history.first(where: { $0.turn == tp.turn + 1 }) {
                let value = field == .territories ? (snap.territories[winner] ?? 0) : (snap.armies[winner] ?? 0)
                return (tp.turn, value)
            }
            if field == .territories {
                return (tp.turn, tp.territoriesAfter)
            }
            let lastArmies = state.history.last?.armies[winner] ?? 0
            return (tp.turn, lastArmies + tp.armyDelta)
        }
    }

    private func chart(title: String, points: [Point], field: ChartField, turningPoints: [TurningPoint], reachedTurn: Int) -> some View {
        let markers = turningPointMarkers(turningPoints, field: field)
        let selectedIdx = turningPoints.isEmpty ? nil : min(turningPointIndex, turningPoints.count - 1)
        // A single `ForEach(points)` grouped by `foregroundStyle(by:)` is the
        // pattern Swift Charts joins correctly (verified against the working
        // pre-recap version of this chart); layering a second, differently
        // grouped LineMark series to hand-color a "past" sub-range fought
        // Charts' own series joining and drew garbled lines. Grey-out is done
        // with a `.chartOverlay` scrim instead — same visual intent ("what
        // hasn't happened yet is dimmed"), without touching how the real
        // data lines are grouped/colored. Sized in actual plot-area pixels
        // (not data values) so it covers the full remaining height/width
        // instead of stopping at the data's own max value.
        let maxTurn = points.map(\.turn).max() ?? reachedTurn
        return VStack(alignment: .leading) {
            Text(title).font(.headline)
            Chart {
                ForEach(points) { point in
                    LineMark(
                        x: .value("Turn", point.turn),
                        y: .value(title, point.value)
                    )
                    .foregroundStyle(by: .value("Player", point.player.displayName))
                    .lineStyle(StrokeStyle(lineWidth: 2))
                }

                RuleMark(x: .value("Now", reachedTurn))
                    .foregroundStyle(AppTheme.accent.opacity(0.8))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [5, 4]))

                ForEach(Array(markers.enumerated()), id: \.offset) { i, marker in
                    PointMark(
                        x: .value("Turn", marker.turn),
                        y: .value(title, marker.value)
                    )
                    .foregroundStyle(i == selectedIdx ? AppTheme.accent : Color.black.opacity(0.85))
                    .symbolSize(i == selectedIdx ? 130 : 60)
                    .annotation(position: .top) {
                        Text(turningPoints[i].isFinal ? "★" : "\(i + 1)")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(i == selectedIdx ? .black : AppTheme.accent)
                    }
                }
            }
            .chartForegroundStyleScale([
                Player.blue.displayName: Player.blue.color,
                Player.green.displayName: Player.green.color,
                Player.red.displayName: Player.red.color,
                Player.brown.displayName: Player.brown.color
            ])
            .chartLegend(position: .bottom, spacing: 4)
            .chartOverlay { proxy in
                GeometryReader { geo in
                    if reachedTurn < maxTurn, let xPos = proxy.position(forX: reachedTurn) {
                        let plotRect = geo[proxy.plotAreaFrame]
                        let scrimX = plotRect.minX + xPos
                        let scrimWidth = max(0, plotRect.maxX - scrimX)
                        Rectangle()
                            .fill(AppTheme.bg.opacity(0.6))
                            .frame(width: scrimWidth, height: plotRect.height)
                            .position(x: scrimX + scrimWidth / 2, y: plotRect.midY)
                    }
                }
            }
            .frame(height: 160)
        }
        .frame(maxWidth: .infinity)
    }

    /// Moment stepper over the game's turning points — mirrors the web
    /// recap page's chip stepper. Each moment (headline/stats + before/after
    /// mini-map compare) is one page in a real horizontally-paging gallery
    /// (iOS 17's ScrollView + .paging behavior + .scrollPosition — the native
    /// primitive behind Photos-style swiping), so a swipe left/right steps
    /// through turning points with the same feel as tapping a chip or a
    /// chevron button, and the system handles the drag/snap physics rather
    /// than a hand-rolled gesture.
    ///
    /// An earlier version tried a plain `TabView(.page)`: it built every
    /// page (~15 × 2 mini-map Canvases) eagerly, which read as scroll lag on
    /// the whole screen, and lazily swapping far pages for placeholders
    /// changed page identity mid-swipe, freezing the page turn mid-flight.
    /// `LazyHStack` inside a `ScrollView` is genuinely lazy (only the
    /// visible page plus a small neighbor buffer are ever instantiated), so
    /// there's no eager build-up and no manual placeholder-swap needed.
    private func turningPointsSection(_ vm: GameViewModel, points: [TurningPoint]) -> some View {
        Group {
            if !points.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Turning Points").font(.headline)

                    HStack(spacing: 6) {
                        ForEach(Array(points.enumerated()), id: \.offset) { i, p in
                            Button {
                                withAnimation { turningPointScrollTarget = i }
                                turningPointIndex = i
                            } label: {
                                Text(p.isFinal ? "★" : "\(i + 1)")
                                    .font(.caption2.bold())
                                    .frame(width: 22, height: 22)
                                    .background(Circle().fill(i == turningPointIndex ? AppTheme.accent : AppTheme.panelDark))
                                    .foregroundStyle(i == turningPointIndex ? Color.black : AppTheme.textDim)
                            }
                        }
                    }

                    ScrollView(.horizontal) {
                        LazyHStack(spacing: 0) {
                            ForEach(Array(points.enumerated()), id: \.offset) { i, p in
                                turningPointPage(vm, point: p, index: i, count: points.count)
                                    .containerRelativeFrame(.horizontal)
                                    .id(i)
                            }
                        }
                        .scrollTargetLayout()
                    }
                    .scrollTargetBehavior(.paging)
                    .scrollPosition(id: $turningPointScrollTarget)
                    .scrollIndicators(.hidden)
                    .frame(height: 440)
                    .onChange(of: turningPointScrollTarget) { _, newValue in
                        if let newValue { turningPointIndex = newValue }
                    }
                }
                .frame(maxWidth: modalWidth)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(AppTheme.panelDark.opacity(0.6)))
                .onAppear {
                    turningPointScrollTarget = turningPointIndex
                }
                .onChange(of: points.count) { _, newCount in
                    let clamped = min(turningPointIndex, max(0, newCount - 1))
                    turningPointIndex = clamped
                    turningPointScrollTarget = clamped
                }
            }
        }
    }

    /// One swipeable turning-point page: prev/next + headline/stats row on
    /// top, before/after mini-maps filling the rest of the page.
    private func turningPointPage(_ vm: GameViewModel, point: TurningPoint, index: Int, count: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button {
                    let newIndex = max(0, index - 1)
                    withAnimation { turningPointScrollTarget = newIndex }
                    turningPointIndex = newIndex
                } label: { Image(systemName: "chevron.left") }
                    .disabled(index == 0)
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
                    let newIndex = min(count - 1, index + 1)
                    withAnimation { turningPointScrollTarget = newIndex }
                    turningPointIndex = newIndex
                } label: { Image(systemName: "chevron.right") }
                    .disabled(index == count - 1)
            }

            if let compare = vm.turningPointCompare(for: point) {
                HStack(alignment: .top, spacing: 16) {
                    VStack(spacing: 4) {
                        Text("Before").font(.caption2).foregroundStyle(.secondary)
                        TurningPointMiniMapView(
                            map: state.map,
                            owners: compare.ownersBefore,
                            walls: compare.edgesBefore.walls,
                            seaLanes: compare.edgesBefore.seaLanes,
                            ghostGrids: compare.changedGrids
                        )
                    }
                    VStack(spacing: 4) {
                        Text("After").font(.caption2).foregroundStyle(.secondary)
                        TurningPointMiniMapView(
                            map: state.map,
                            owners: compare.ownersAfter,
                            walls: compare.edgesAfter.walls,
                            seaLanes: compare.edgesAfter.seaLanes,
                            changedGrids: compare.changedGrids,
                            dimUnchanged: true,
                            capturedFrom: compare.capturedFrom,
                            arrows: compare.arrows,
                            armyLabels: compare.armyLabels,
                            biggestGrid: compare.biggestGrid
                        )
                    }
                }
                .frame(maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 4)
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
        .frame(maxWidth: modalWidth)
    }

    /// The endgame screen's content column width — wide enough on iPad for
    /// the turning-point mini-maps to read clearly side by side, while still
    /// leaving a sliver of the live board visible at the edges as a scrim cue.
    private let modalWidth: CGFloat = 1100
}
