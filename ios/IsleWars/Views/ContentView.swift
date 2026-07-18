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

/// `.labelStyle(isCompact ? .iconOnly : .automatic)` doesn't type-check —
/// the two style types aren't equivalent — so branch as a view modifier
/// instead of inline in the static-member ternary.
private struct CompactLabelStyle: ViewModifier {
    let isCompact: Bool
    func body(content: Content) -> some View {
        if isCompact {
            content.labelStyle(.iconOnly)
        } else {
            content.labelStyle(.automatic)
        }
    }
}

private struct GameView: View {
    @ObservedObject var vm: GameViewModel
    let state: GameState
    /// iPhone landscape is `.compact` vertically (short/wide), vs. iPad
    /// landscape's `.regular` (tall/wide) — the HUD's fixed iPad-tuned
    /// insets/padding/fonts leave too little vertical room on iPhone, so a
    /// compact variant trims them rather than reflowing the whole layout.
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    private var isCompact: Bool { verticalSizeClass == .compact }

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
    @State private var showingCareer = false

    var body: some View {
        ZStack {
            if isCompact {
                compactLayout
            } else {
                regularLayout
            }

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

            if showingCareer {
                LifetimeStatsView(vm: vm) { showingCareer = false }
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

    /// iPad: full-bleed map with floating HUD pills in the four corners —
    /// the map's own aspect ratio (~1.4-1.6:1, see map.ts's tight viewBox)
    /// is close enough to iPad landscape's that this wastes very little
    /// space, so there's no reason to give up the simpler floating design.
    private var regularLayout: some View {
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
        }
    }

    /// iPhone: every generated map is ~1.4-1.6:1 (map.ts's tight viewBox),
    /// while an iPhone's landscape drawing area is ~2.3-2.9:1 — no amount of
    /// trimming top/bottom bars fixes that mismatch, since width is always
    /// the binding constraint (see MapTransform's aspect-preserving fit).
    /// All the HUD chrome lives in a single rail on one side (rather than
    /// splitting it across both) so the map gets the most possible width —
    /// past a certain point, extra width doesn't even matter (once the map
    /// is comfortably height-bound it can't get any taller), but giving up
    /// the least width guarantees that for every seed, not just most.
    private var compactLayout: some View {
        // The whole layout ignores the safe area (full-bleed background,
        // full map width) except the rail, which gets exactly the measured
        // notch/Dynamic-Island inset added as extra padding on whichever
        // edge it's actually on — the app allows both landscape rotations,
        // so the cutout can land on either side of the rail depending on
        // how the device is held.
        GeometryReader { geo in
            // The reported safe-area insets under-report the actual notch/
            // Dynamic-Island clearance needed in this ignoresSafeArea
            // configuration (measured empirically), so both edges get a
            // flat floor rather than trusting whichever raw value comes
            // back — the app allows both landscape rotations, so the
            // cutout can land on either side (rail or map) depending on
            // how the device is held, and only a fixed floor is reliable
            // regardless of which one it turns out to be.
            let notchFloor: CGFloat = 60
            let railNotchInset = max(geo.safeAreaInsets.trailing, geo.safeAreaInsets.leading, notchFloor)
            HStack(spacing: 0) {
                MapView(
                    state: state,
                    selectableHexes: vm.selectableHexes,
                    onTapHex: handleTap,
                    onDragAttack: vm.dragAttack,
                    onDragMove: vm.dragMove,
                    onDragFerry: vm.dragFerry,
                    contentInsets: EdgeInsets(top: 6, leading: 6 + notchFloor, bottom: 6, trailing: 6)
                )
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(mapAccessibilitySummary)

                hudRail
                    .padding(.trailing, railNotchInset)
                    .frame(width: 150 + railNotchInset)
            }
        }
        .background(AppTheme.bg.ignoresSafeArea())
        .ignoresSafeArea()
    }

    /// The single rail: turn/player status (a compact 2x2 grid instead of 4
    /// stacked rows), icon-only log/career/new-game, the card hand (as a
    /// vertical grid — see `CardHandGridView`'s `.vertical` axis), and the
    /// action panel, all stacked top to bottom so none of it competes with
    /// the map for width.
    private var hudRail: some View {
        let total = state.states.count
        let playerColumns = [GridItem(.flexible()), GridItem(.flexible())]

        return VStack(spacing: 8) {
            Text("Turn \(state.turn)").font(.subheadline).bold()
                .frame(maxWidth: .infinity, alignment: .leading)

            LazyVGrid(columns: playerColumns, spacing: 4) {
                ForEach(Player.allCases) { p in
                    let count = state.states.filter { $0.owner == p }.count
                    let alive = state.alive[p.rawValue] ?? true
                    HStack(spacing: 4) {
                        Circle().fill(p.color).frame(width: 9, height: 9).opacity(alive ? 1 : 0.3)
                        Text("\(count)/\(total)").font(.caption2).monospacedDigit().strikethrough(!alive)
                    }
                    .padding(.horizontal, 4).padding(.vertical, 3)
                    .frame(maxWidth: .infinity)
                    .background(
                        RoundedRectangle(cornerRadius: 5)
                            .fill(state.current == p ? Color.yellow.opacity(0.25) : .clear)
                    )
                }
            }

            HStack(spacing: 6) {
                Button {
                    withAnimation(.easeInOut(duration: 0.25)) { showingLog.toggle() }
                } label: {
                    Image(systemName: "list.bullet.rectangle.portrait")
                }
                .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
                Button {
                    showingCareer = true
                } label: {
                    Image(systemName: "trophy")
                }
                .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
                Button {
                    showingQuitConfirm = true
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                }
                .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
            }

            Divider().overlay(AppTheme.border)

            let hand = state.humanHand
            let isHumanTurn = state.current == .human
            if hand.isEmpty {
                VStack(spacing: 4) {
                    Image(systemName: "rectangle.stack.badge.minus")
                    Text("No cards").font(.caption2)
                }
                .foregroundStyle(AppTheme.textDim)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            } else {
                CardHandGridView(
                    cards: hand,
                    phase: state.phase,
                    canPlay: { vm.playableCards.contains($0) },
                    onTap: { index in
                        if state.phase == .discard {
                            vm.discardCard(index)
                        } else {
                            vm.playCard(index)
                        }
                    },
                    axis: .vertical
                )
                .disabled(!isHumanTurn)
                .opacity(isHumanTurn ? 1 : 0.55)
            }

            Spacer(minLength: 0)

            if state.phase != .gameOver {
                ActionPanelView(vm: vm, state: state)
                    .foregroundStyle(AppTheme.text)
            }
        }
        .foregroundStyle(AppTheme.text)
        .padding(10)
        .padding(.top, 8)
    }

    /// All full-screen modals, presented in place over a dimmed scrim (rather
    /// than as system sheets that slide up and add form-sheet chrome/padding).
    @ViewBuilder private var modalOverlay: some View {
        if state.phase == .gameOver {
            PostGameStatsView(state: state, onNewGame: vm.startOver, vm: vm)
        } else if state.phase == .attackRolling || state.phase == .attackMoveIn {
            AttackModalView(vm: vm, state: state)
        } else if state.phase == .buy {
            // No tap-outside-to-cancel here (unlike the other modals) — there's
            // no "cancel" concept for shopping, only "done" (finishShopping),
            // which the view's own button drives.
            modalScrim(onTapBackdrop: nil) {
                MarketView(vm: vm, state: state)
            }
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
        return HStack(spacing: isCompact ? 8 : 12) {
            Text("Turn \(state.turn)").font(isCompact ? .subheadline : .headline).bold()
            ForEach(Player.allCases) { p in
                let count = state.states.filter { $0.owner == p }.count
                let alive = state.alive[p.rawValue] ?? true
                HStack(spacing: 5) {
                    Circle().fill(p.color).frame(width: isCompact ? 10 : 13, height: isCompact ? 10 : 13).opacity(alive ? 1 : 0.3)
                    Text("\(count)/\(total)").font(isCompact ? .caption : .subheadline).monospacedDigit().strikethrough(!alive)
                }
                .padding(.horizontal, isCompact ? 5 : 7).padding(.vertical, isCompact ? 2 : 4)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(state.current == p ? Color.yellow.opacity(0.25) : .clear)
                )
            }
        }
        .foregroundStyle(AppTheme.text)
        .padding(.horizontal, isCompact ? 9 : 14).padding(.vertical, isCompact ? 5 : 9)
        .background(hudBackground)
    }

    // Top-right: log + career + new game.
    private var topRightPill: some View {
        HStack(spacing: isCompact ? 6 : 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.25)) { showingLog.toggle() }
            } label: {
                Label("Log", systemImage: "list.bullet.rectangle.portrait")
            }
            .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
            Button {
                showingCareer = true
            } label: {
                Label("Career", systemImage: "trophy")
            }
            .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
            Button("New Game") { showingQuitConfirm = true }
                .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
        }
        .modifier(CompactLabelStyle(isCompact: isCompact))
        .foregroundStyle(AppTheme.text)
        .padding(.horizontal, isCompact ? 7 : 10).padding(.vertical, isCompact ? 4 : 6)
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
                CardHandGridView(cards: hand, phase: state.phase, canPlay: { vm.playableCards.contains($0) }) { index in
                    if state.phase == .discard {
                        vm.discardCard(index)
                    } else {
                        vm.playCard(index)
                    }
                }
                .frame(maxWidth: isCompact ? 260 : 380)
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
    /// armies added, tinted to the mover's color if it's currently a neutral
    /// hex. (Desert heat is no longer paid on arrival — it's a start-of-turn
    /// attrition now, so the preview shows the full arriving count.)
    private var destHexBuilder: ((Int) -> HexPreview)? {
        guard let from = state.selectedFrom, let to = state.selectedTo,
              state.states.indices.contains(from), state.states.indices.contains(to),
              state.map.grids.indices.contains(to) else { return nil }
        let base = state.states[to].armies
        let destOwner = state.states[to].owner
        let moverColor = state.states[from].owner?.color
        return { qty in
            let fill: Color? = (destOwner == nil && qty > 0) ? moverColor : nil
            return HexPreview(state: state, gridId: to,
                              armiesOverride: max(0, base + qty),
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
