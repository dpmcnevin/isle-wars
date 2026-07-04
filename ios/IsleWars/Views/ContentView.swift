import SwiftUI

struct ContentView: View {
    @StateObject private var vm = GameViewModel()

    var body: some View {
        Group {
            if let state = vm.state {
                if !state.gameStarted {
                    StartGateView(vm: vm)
                } else {
                    GameView(vm: vm, state: state)
                }
            } else {
                NewGameSheet(vm: vm)
            }
        }
        .alert("Error", isPresented: .constant(vm.errorMessage != nil)) {
            Button("OK") { vm.errorMessage = nil }
        } message: {
            Text(vm.errorMessage ?? "")
        }
    }
}

private struct StartGateView: View {
    @ObservedObject var vm: GameViewModel

    var body: some View {
        VStack(spacing: 16) {
            Text("Ready to play").font(.title).bold()
            Button("Start Game →") { vm.startGamePlaying() }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(AppTheme.text)
        .background(AppTheme.sidebarGradient.ignoresSafeArea())
    }
}

private struct GameView: View {
    @ObservedObject var vm: GameViewModel
    let state: GameState

    /// User-initiated placement quantity request (tap on an owned hex
    /// during `.placing`). The other three quantity contexts (move-in,
    /// move, air) are auto-presented straight from `state.phase`.
    @State private var placeRequest: PlaceRequest?

    private struct PlaceRequest: Identifiable {
        let gridId: Int
        var id: Int { gridId }
    }

    @State private var showingQuitConfirm = false
    @State private var showingLog = false

    var body: some View {
        // Full-bleed map with floating HUD overlays (scoreboard/actions/cards)
        // and a right-edge slide-over for the log + history graphs, rather than
        // a fixed sidebar — the map gets the entire screen.
        ZStack {
            MapView(
                state: state,
                onTapHex: handleTap,
                onDragAttack: vm.dragAttack,
                onDragMove: vm.dragMove,
                contentInsets: EdgeInsets(top: 84, leading: 28, bottom: 96, trailing: 28)
            )
            .ignoresSafeArea()
            .background(AppTheme.bg.ignoresSafeArea())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(mapAccessibilitySummary)

            VStack(alignment: .leading, spacing: 0) {
                topBar
                Spacer(minLength: 0)
                HStack(spacing: 0) {
                    bottomBar
                    Spacer(minLength: 0)
                }
            }
            .padding(12)

            if showingLog {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .onTapGesture { withAnimation(.easeInOut(duration: 0.25)) { showingLog = false } }
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    LogSlideOverView(
                        log: state.log,
                        highlightCount: vm.recentLogHighlightCount,
                        history: state.history,
                        stats: state.stats
                    ) { withAnimation(.easeInOut(duration: 0.25)) { showingLog = false } }
                }
                .ignoresSafeArea()
                .transition(.move(edge: .trailing))
            }
        }
        .overlay { modalOverlay }
        .alert("Start a new game?", isPresented: $showingQuitConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("New Game", role: .destructive) { vm.startOver() }
        } message: {
            Text("This abandons your current game in progress.")
        }
    }

    /// All full-screen modals, presented in place over a dimmed scrim (rather
    /// than as system sheets that slide up and add form-sheet chrome/padding).
    @ViewBuilder private var modalOverlay: some View {
        if state.phase == .gameOver {
            PostGameStatsView(state: state, onNewGame: vm.startOver)
        } else if state.phase == .attackRolling || state.phase == .attackMoveIn {
            AttackModalView(vm: vm, state: state)
        } else if let request = placeRequest {
            modalScrim(onTapBackdrop: { placeRequest = nil }) {
                QuantityPickerSheet(
                    title: "Place Armies",
                    subtitle: "How many armies to place on \(gridLabel(request.gridId))?",
                    range: 1...max(1, state.armiesToPlace),
                    initial: 1,
                    confirmLabel: "Place",
                    sourceHex: { qty in
                        HexPreview(state: state, gridId: request.gridId,
                                   armiesOverride: state.states[request.gridId].armies + qty)
                    },
                    onConfirm: { qty in
                        vm.placeArmies(gridId: request.gridId, qty: qty)
                        placeRequest = nil
                    },
                    onCancel: { placeRequest = nil }
                )
            }
        } else if state.phase == .moveQty {
            modalScrim(onTapBackdrop: nil) {
                QuantityPickerSheet(
                    title: "Move Armies",
                    subtitle: "How many armies to move?",
                    range: 1...maxFromArmies,
                    initial: 1,
                    confirmLabel: "Move",
                    endsTurn: true,
                    sourceHex: sourceHexBuilder,
                    destHex: destHexBuilder,
                    onConfirm: { qty in vm.confirmMove(qty) }
                )
            }
        } else if state.phase == .airQty {
            modalScrim(onTapBackdrop: nil) {
                QuantityPickerSheet(
                    title: "Air Move",
                    subtitle: "How many armies to airlift?",
                    range: 1...maxFromArmies,
                    initial: 1,
                    confirmLabel: "Airlift",
                    endsTurn: true,
                    sourceHex: sourceHexBuilder,
                    destHex: destHexBuilder,
                    onConfirm: { qty in vm.confirmAir(qty) }
                )
            }
        }
    }

    private func modalScrim<Content: View>(
        onTapBackdrop: (() -> Void)?,
        @ViewBuilder content: () -> Content
    ) -> some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea()
                .onTapGesture { onTapBackdrop?() }
            content()
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Text("Turn \(state.turn)").font(.headline).bold()
            ScoreboardView(state: state).frame(maxWidth: 460)
            Spacer(minLength: 8)
            Button {
                withAnimation(.easeInOut(duration: 0.25)) { showingLog.toggle() }
            } label: {
                Label("Log", systemImage: "list.bullet.rectangle.portrait")
            }
            .buttonStyle(.bordered)
            Button("New Game") { showingQuitConfirm = true }
                .buttonStyle(.bordered)
        }
        .foregroundStyle(AppTheme.text)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(hudBackground)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var bottomBar: some View {
        if state.phase != .gameOver {
            VStack(alignment: .leading, spacing: 6) {
                ActionPanelView(vm: vm, state: state)
                if state.current == .human, !state.humanHand.isEmpty {
                    CardHandGridView(cards: state.humanHand, phase: state.phase) { index in
                        if state.phase == .discard {
                            vm.discardCard(index)
                        } else {
                            vm.playCard(index)
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
            .foregroundStyle(AppTheme.text)
            .frame(maxWidth: 560, alignment: .leading)
            .background(hudBackground)
        }
    }

    private var hudBackground: some View {
        RoundedRectangle(cornerRadius: 14)
            .fill(AppTheme.panelDark.opacity(0.92))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(AppTheme.border, lineWidth: 1))
    }

    private func handleTap(_ gridId: Int) {
        if state.phase == .placing, state.states.indices.contains(gridId), state.states[gridId].owner == .human {
            placeRequest = PlaceRequest(gridId: gridId)
        } else {
            vm.tapHex(gridId)
        }
    }

    private func gridLabel(_ gridId: Int) -> String {
        guard state.map.grids.indices.contains(gridId) else { return "this territory" }
        let grid = state.map.grids[gridId]
        return grid.cityName ?? "hex \(grid.id)"
    }

    private var maxFromArmies: Int {
        guard let from = state.selectedFrom, state.states.indices.contains(from) else { return 1 }
        return max(1, state.states[from].armies - 1)
    }

    /// Live source-hex preview for the move/air quantity sheets: the origin
    /// territory with its army count reduced by the amount being sent.
    private var sourceHexBuilder: ((Int) -> HexPreview)? {
        guard let from = state.selectedFrom, state.states.indices.contains(from) else { return nil }
        let base = state.states[from].armies
        return { qty in HexPreview(state: state, gridId: from, armiesOverride: max(0, base - qty)) }
    }

    /// Live destination-hex preview: the target territory with the arriving
    /// armies added (minus 1 for desert heat, matching the web modal), and
    /// tinted to the mover's color if it's currently a neutral hex.
    private var destHexBuilder: ((Int) -> HexPreview)? {
        guard let from = state.selectedFrom, let to = state.selectedTo,
              state.states.indices.contains(from), state.states.indices.contains(to),
              state.map.grids.indices.contains(to) else { return nil }
        let base = state.states[to].armies
        let isDesert = state.map.grids[to].terrain == .desert
        let destOwner = state.states[to].owner
        let moverColor = state.states[from].owner?.color
        return { qty in
            let desertLoss = (isDesert && qty > 0) ? 1 : 0
            let fill: Color? = (destOwner == nil && qty > 0) ? moverColor : nil
            return HexPreview(state: state, gridId: to,
                              armiesOverride: max(0, base + qty - desertLoss),
                              fillOverride: fill)
        }
    }

    /// The hex map is a `Canvas` with ~50 tappable regions — giving every
    /// hex its own VoiceOver element/action is a larger undertaking than
    /// fits here, so this is a scope trim: one spoken summary of overall
    /// board state per redraw, rather than full hex-by-hex navigation.
    private var mapAccessibilitySummary: String {
        let counts = Player.allCases.map { player in
            "\(player.displayName) \(state.states.filter { $0.owner == player }.count)"
        }.joined(separator: ", ")
        return "Map. Turn \(state.turn). \(state.current.displayName)'s turn. Territories: \(counts)."
    }
}

#Preview {
    ContentView()
}
