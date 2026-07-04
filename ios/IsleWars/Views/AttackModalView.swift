import SwiftUI

/// Full-screen overlay shown during `attack_rolling` (roll/auto-roll/quit)
/// and `attack_move_in` (post-conquest move-in stepper). Mirrors the web
/// app's attack modal: attacker/defender hex previews, live win%, and a
/// bullet list of active modifiers.
struct AttackModalView: View {
    @ObservedObject var vm: GameViewModel
    let state: GameState

    @State private var moveInExtra: Int = 0
    @State private var autoRolling = false

    private var fromId: Int? { state.selectedFrom }
    private var toId: Int? { state.selectedTo }

    private var attackerGrid: Grid? { fromId.flatMap { id in state.map.grids.indices.contains(id) ? state.map.grids[id] : nil } }
    private var defenderGrid: Grid? { toId.flatMap { id in state.map.grids.indices.contains(id) ? state.map.grids[id] : nil } }
    private var attackerState: GridState? { fromId.flatMap { id in state.states.indices.contains(id) ? state.states[id] : nil } }
    private var defenderState: GridState? { toId.flatMap { id in state.states.indices.contains(id) ? state.states[id] : nil } }

    private var defenderBonus: Int {
        guard let toId, let fromId else { return 0 }
        return vm.defenseBonus(gridId: toId, fromId: fromId)
    }
    private var attackerTerrainBonus: Int {
        guard let toId else { return 0 }
        return vm.attackerBonus(gridId: toId)
    }
    private var eliteBonus: Int { state.eliteAttackActive ? 2 : 0 }
    private var totalAttackerBonus: Int { attackerTerrainBonus + eliteBonus }

    private var winPct: Double {
        guard let atk = attackerState?.armies, let def = defenderState?.armies else { return 0.5 }
        return vm.winProbability(atkArmies: atk, defArmies: def, defenderBonus: defenderBonus, attackerBonus: totalAttackerBonus)
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea()
                .onTapGesture { /* swallow taps behind the modal */ }

            VStack(spacing: 16) {
                if state.phase == .attackRolling {
                    rollingContent
                } else {
                    moveInContent
                }
            }
            .padding(24)
            .frame(maxWidth: 480)
            .background(RoundedRectangle(cornerRadius: 16).fill(.regularMaterial))
            .shadow(radius: 20)
        }
        .onChange(of: state.phase) { _, newPhase in
            if newPhase == .attackMoveIn {
                moveInExtra = 0
            }
            if newPhase != .attackRolling {
                autoRolling = false
            }
        }
        .task(id: autoRolling) {
            guard autoRolling else { return }
            while autoRolling, state.phase == .attackRolling {
                vm.rollAttack()
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
        }
    }

    private var rollingContent: some View {
        VStack(spacing: 16) {
            Text("Attack").font(.title2).bold()

            HStack(spacing: 24) {
                hexPreview(title: "Attacker", grid: attackerGrid, gridState: attackerState, owner: attackerState?.owner)
                Image(systemName: "arrow.right").font(.title)
                hexPreview(title: "Defender", grid: defenderGrid, gridState: defenderState, owner: defenderState?.owner)
            }

            winProbabilityBar

            modifiersList

            Text(state.message).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)

            HStack {
                Button("Roll") { vm.rollAttack() }
                    .buttonStyle(.borderedProminent)
                Button(autoRolling ? "Stop Auto" : "Auto-Roll") { autoRolling.toggle() }
                    .buttonStyle(.bordered)
                Button("Quit Attack") { vm.quitAttack() }
                    .buttonStyle(.bordered)
                    .tint(.red)
            }
        }
    }

    private var moveInContent: some View {
        let maxExtra = max(0, (attackerState?.armies ?? 1) - 1)
        return VStack(spacing: 16) {
            Text("Conquered!").font(.title2).bold()

            HStack(spacing: 16) {
                hexColumn(title: "From", grid: attackerGrid, gridState: attackerState,
                          armies: max(0, (attackerState?.armies ?? 0) - moveInExtra))
                Image(systemName: "arrow.right").font(.title2).foregroundStyle(.secondary)
                hexColumn(title: "To", grid: defenderGrid, gridState: defenderState,
                          armies: (defenderState?.armies ?? 0) + moveInExtra)
            }

            HStack(spacing: 20) {
                Button {
                    moveInExtra = max(0, moveInExtra - 1)
                } label: {
                    Image(systemName: "minus.circle.fill").font(.system(size: 32))
                }
                .disabled(moveInExtra <= 0)

                Text("Move in +\(moveInExtra)")
                    .font(.headline).monospacedDigit().frame(minWidth: 130)

                Button {
                    moveInExtra = min(maxExtra, moveInExtra + 1)
                } label: {
                    Image(systemName: "plus.circle.fill").font(.system(size: 32))
                }
                .disabled(moveInExtra >= maxExtra)
            }

            if maxExtra > 0 {
                HStack(spacing: 12) {
                    Button("None") { moveInExtra = 0 }.buttonStyle(.bordered)
                    Button("Max (\(maxExtra))") { moveInExtra = maxExtra }.buttonStyle(.bordered)
                }
            }

            Button("Confirm") {
                vm.confirmMoveIn(moveInExtra)
                moveInExtra = 0
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func hexColumn(title: String, grid: Grid?, gridState: GridState?, armies: Int) -> some View {
        VStack(spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            if let grid, let gridState {
                HexPreview(
                    terrain: grid.terrain,
                    owner: gridState.owner,
                    armies: armies,
                    production: grid.production,
                    fortified: gridState.fortified == true
                )
                .frame(width: 92, height: 83)
            } else {
                Color.clear.frame(width: 92, height: 83)
            }
            if let cityName = grid?.cityName {
                Text(cityName).font(.caption2).italic().foregroundStyle(.secondary)
            }
        }
    }

    private var winProbabilityBar: some View {
        let pct = Int((winPct * 100).rounded())
        let color: Color = winPct > 0.6 ? .green : winPct > 0.4 ? .yellow : .red
        return VStack(spacing: 4) {
            Text("\(pct)% win chance").font(.headline).foregroundStyle(color)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4).fill(.gray.opacity(0.25))
                    RoundedRectangle(cornerRadius: 4).fill(color).frame(width: geo.size.width * winPct)
                }
            }
            .frame(height: 8)
        }
    }

    private var modifiersList: some View {
        VStack(alignment: .leading, spacing: 2) {
            if attackerTerrainBonus > 0 {
                Label("+\(attackerTerrainBonus) attacker (forest)", systemImage: "leaf.fill").font(.caption)
            }
            if eliteBonus > 0 {
                Label("+\(eliteBonus) attacker (elite troops)", systemImage: "bolt.fill").font(.caption)
            }
            if let terrain = defenderGrid?.terrain, terrain == .mountain {
                Label("+1 defender (mountain)", systemImage: "mountain.2.fill").font(.caption)
            }
            if defenderState?.fortified == true {
                Label("+2 defender (fortified)", systemImage: "shield.fill").font(.caption)
            }
            if state.bridgeAttackActive {
                Label("Bridge active — river crossing bonus cancelled", systemImage: "figure.walk").font(.caption)
            }
            if defenderGrid?.terrain == .desert {
                Label("Desert: attacker loses 1 extra army on conquest", systemImage: "sun.max.fill").font(.caption).foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func hexPreview(title: String, grid: Grid?, gridState: GridState?, owner: Player?) -> some View {
        VStack(spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            if let grid, let gridState {
                HexPreview(
                    terrain: grid.terrain,
                    owner: gridState.owner,
                    armies: gridState.armies,
                    production: grid.production,
                    fortified: gridState.fortified == true
                )
                .frame(width: 100, height: 90)
            } else {
                Color.clear.frame(width: 100, height: 90)
            }
            Text(owner?.displayName ?? "Neutral")
                .font(.caption2)
                .foregroundStyle(owner?.color ?? .secondary)
            if let cityName = grid?.cityName {
                Text(cityName).font(.caption2).italic().foregroundStyle(.secondary)
            }
        }
    }
}
