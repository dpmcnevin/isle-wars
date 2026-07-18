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
    /// Live horizontal drag offset for the turning-point page, tracked while
    /// the finger is down so the swipe visibly follows it — see
    /// `turningPointsSection`'s gesture for why this doesn't go through a
    /// full page-swap transition.
    @State private var turningPointDragOffset: CGFloat = 0

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
    /// mini-map compare) is a `TabView` page, so a swipe left/right steps
    /// through turning points same as tapping a chip or a chevron button.
    private func turningPointsSection(_ vm: GameViewModel, points: [TurningPoint]) -> some View {
        Group {
            if !points.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Turning Points").font(.headline)

                    HStack(spacing: 6) {
                        ForEach(Array(points.enumerated()), id: \.offset) { i, p in
                            Button {
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

                    // One rendered page + an explicit swipe gesture, instead
                    // of a page-style TabView. The TabView built every page
                    // (~15 × 2 mini-map Canvases) eagerly, which read as
                    // scroll lag on the whole screen — and lazily swapping
                    // far pages for placeholders changed page identity
                    // mid-swipe, making the page turn bounce back. A single
                    // page with a drag handler keeps the swipe interaction
                    // and only ever draws the selected moment's mini-maps.
                    // No .id()/transition-based page swap (an animated
                    // identity swap left the old and new page frozen
                    // mid-flight, verified via simulator screenshots) — the
                    // content itself still swaps in place the instant the
                    // index changes. What DOES animate is turningPointDragOffset,
                    // applied as a plain .offset below: it tracks the finger
                    // 1:1 while dragging (so the swipe is visibly happening,
                    // not just a snap on release) and springs back to 0 once
                    // the gesture ends, whether or not the index changed —
                    // cheap because it never touches which mini-maps are
                    // rendered, only where the existing page sits on screen.
                    let selected = min(turningPointIndex, points.count - 1)
                    turningPointPage(vm, point: points[selected], index: selected, count: points.count)
                        .frame(height: 440)
                        .contentShape(Rectangle())
                        .offset(x: turningPointDragOffset)
                        // Plain .gesture (not highPriority) so the enclosing
                        // vertical ScrollView still wins vertical pans; only
                        // clearly-horizontal swipes step the moment.
                        .gesture(
                            DragGesture(minimumDistance: 15)
                                .onChanged { value in
                                    guard abs(value.translation.width) > abs(value.translation.height) else { return }
                                    // Deliberately NOT wrapped in withAnimation —
                                    // this needs to track the finger 1:1 with no
                                    // lag; only the release/snap below animates.
                                    turningPointDragOffset = value.translation.width
                                }
                                .onEnded { value in
                                    let dx = value.translation.width
                                    let advance = abs(dx) > 50 && abs(dx) > abs(value.translation.height)
                                    if advance {
                                        // Swipe left = advance (content moves left).
                                        turningPointIndex = dx < 0
                                            ? min(points.count - 1, selected + 1)
                                            : max(0, selected - 1)
                                    }
                                    withAnimation(.interactiveSpring(response: 0.3, dampingFraction: 0.8)) {
                                        turningPointDragOffset = 0
                                    }
                                }
                        )
                }
                .frame(maxWidth: modalWidth)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(AppTheme.panelDark.opacity(0.6)))
                .onChange(of: points.count) { _, newCount in
                    turningPointIndex = min(turningPointIndex, max(0, newCount - 1))
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
                    turningPointIndex = max(0, index - 1)
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
                    turningPointIndex = min(count - 1, index + 1)
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
