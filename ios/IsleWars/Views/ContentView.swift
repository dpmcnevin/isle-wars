import SwiftUI

struct ContentView: View {
    @StateObject private var vm = GameViewModel()

    var body: some View {
        Group {
            if let state = vm.state {
                GameView(vm: vm, state: state)
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
                selectableHexes: vm.selectableHexes,
                onTapHex: handleTap,
                onDragAttack: vm.dragAttack,
                onDragMove: vm.dragMove,
                onDragFerry: vm.dragFerry,
                contentInsets: EdgeInsets(top: 68, leading: 16, bottom: 104, trailing: 16)
            )
            .ignoresSafeArea()
            .background(AppTheme.bg.ignoresSafeArea())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(mapAccessibilitySummary)

            // Compact HUD in the four corners; the open center/edges between the
            // pills stay tappable so the map underneath is reachable.
            VStack(spacing: 0) {
                HStack(alignment: .top, spacing: 8) {
                    topLeftPill
                    Spacer(minLength: 8)
                    topRightPill
                }
                Spacer(minLength: 0)
                HStack(alignment: .bottom, spacing: 8) {
                    cardsPill
                    Spacer(minLength: 8)
                    bottomBar
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
            PostGameStatsView(state: state, onNewGame: vm.startOver, vm: vm)
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
            modalScrim(onTapBackdrop: { vm.cancelAction() }) {
                QuantityPickerSheet(
                    title: "Move Armies",
                    subtitle: "How many armies to move?",
                    range: 1...maxFromArmies,
                    initial: 1,
                    confirmLabel: "Move",
                    endsTurn: true,
                    sourceHex: sourceHexBuilder,
                    destHex: destHexBuilder,
                    onConfirm: { qty in vm.confirmMove(qty) },
                    onCancel: { vm.cancelAction() }
                )
            }
        } else if state.phase == .airQty {
            modalScrim(onTapBackdrop: { vm.cancelAction() }) {
                QuantityPickerSheet(
                    title: "Air Move",
                    subtitle: "How many armies to airlift?",
                    range: 1...maxFromArmies,
                    initial: 1,
                    confirmLabel: "Airlift",
                    endsTurn: true,
                    sourceHex: sourceHexBuilder,
                    destHex: destHexBuilder,
                    onConfirm: { qty in vm.confirmAir(qty) },
                    onCancel: { vm.cancelAction() }
                )
            }
        } else if state.phase == .paratroopQty {
            modalScrim(onTapBackdrop: { vm.cancelAction() }) {
                QuantityPickerSheet(
                    title: "Paratroop Attack",
                    subtitle: "How many armies to drop?",
                    range: 1...maxFromArmies,
                    initial: 1,
                    confirmLabel: "Drop",
                    sourceHex: sourceHexBuilder,
                    destHex: destHexBuilder,
                    onConfirm: { qty in vm.confirmParatroop(qty) },
                    onCancel: { vm.cancelAction() }
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

    // Top-left: turn + per-player territory counts.
    private var topLeftPill: some View {
        let total = state.states.count
        return HStack(spacing: 12) {
            Text("Turn \(state.turn)").font(.headline).bold()
            ForEach(Player.allCases) { p in
                let count = state.states.filter { $0.owner == p }.count
                let alive = state.alive[p.rawValue] ?? true
                HStack(spacing: 5) {
                    Circle().fill(p.color).frame(width: 13, height: 13).opacity(alive ? 1 : 0.3)
                    Text("\(count)/\(total)").font(.subheadline).monospacedDigit().strikethrough(!alive)
                }
                .padding(.horizontal, 7).padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(state.current == p ? Color.yellow.opacity(0.25) : .clear)
                )
            }
        }
        .foregroundStyle(AppTheme.text)
        .padding(.horizontal, 14).padding(.vertical, 9)
        .background(hudBackground)
    }

    // Top-right: log + new game.
    private var topRightPill: some View {
        HStack(spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.25)) { showingLog.toggle() }
            } label: {
                Label("Log", systemImage: "list.bullet.rectangle.portrait")
            }
            .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
            Button("New Game") { showingQuitConfirm = true }
                .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
        }
        .foregroundStyle(AppTheme.text)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(hudBackground)
    }

    // Bottom-left: compact action panel (message + phase controls).
    @ViewBuilder private var bottomBar: some View {
        if state.phase != .gameOver {
            ActionPanelView(vm: vm, state: state)
                .foregroundStyle(AppTheme.text)
                .background(hudBackground)
        }
    }

    // Bottom-right: the player's card hand. Always shown (empty placeholder
    // when the hand is empty), and only interactive on the human's own turn.
    private var cardsPill: some View {
        let hand = state.humanHand
        let isHumanTurn = state.current == .human
        return Group {
            if hand.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "rectangle.stack.badge.minus")
                    Text("No cards").font(.caption)
                }
                .foregroundStyle(AppTheme.textDim)
                .frame(height: 72)
                .padding(.horizontal, 18)
            } else {
                CardHandGridView(cards: hand, phase: state.phase, canPlay: vm.canPlayCardNow) { index in
                    if state.phase == .discard {
                        vm.discardCard(index)
                    } else {
                        vm.playCard(index)
                    }
                }
                .frame(maxWidth: 380)
                .disabled(!isHumanTurn)
                .opacity(isHumanTurn ? 1 : 0.55)
            }
        }
        .background(hudBackground)
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
