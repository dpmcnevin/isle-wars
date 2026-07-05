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

    // MARK: - Modifier breakdown (mirrors the web attack modal's per-side lists)

    private var dieSides: Int { vm.debugSettings?.dieSides ?? 10 }
    private var mountainBonus: Int { defenderGrid?.terrain == .mountain ? 1 : 0 }
    private var fortifiedBonus: Int { defenderState?.fortified == true ? 2 : 0 }
    private var rampartBonus: Int { defenderState?.rampart == true ? 1 : 0 }
    /// True when this attack is the in-progress Water Invasion (crossing the
    /// temporary lane), which grants only +1 defense rather than a sea lane's +2.
    private var isInvasionCrossing: Bool {
        guard let f = fromId, let t = toId, let lane = state.pendingInvasionLane, lane.count == 2 else { return false }
        return (lane[0] == f && lane[1] == t) || (lane[0] == t && lane[1] == f)
    }
    /// Sea-lane (2) / river (1) crossing bonus — the same authoritative engine
    /// call the web modal uses, rather than inferred from the total.
    private var crossingBonus: Int {
        guard let f = fromId, let t = toId else { return 0 }
        return vm.crossingBonus(from: f, to: t)
    }
    private var isRiverCrossing: Bool {
        guard let f = fromId, let t = toId else { return false }
        return state.map.rivers.contains { $0.count == 2 && (($0[0] == f && $0[1] == t) || ($0[0] == t && $0[1] == f)) }
    }
    private var bridgeCancels: Bool { state.bridgeAttackActive && isRiverCrossing }

    private enum ModStyle {
        case bonus, warn, neutral
        var color: Color {
            switch self {
            case .bonus: .green
            case .warn: .orange
            case .neutral: .secondary
            }
        }
    }
    private struct AttackMod: Identifiable { let id = UUID(); let text: String; let style: ModStyle }

    private func modifiers(attacker: Bool) -> [AttackMod] {
        var mods: [AttackMod] = [AttackMod(text: "Base die 1–\(dieSides)", style: .neutral)]
        if attacker {
            if attackerTerrainBonus > 0 { mods.append(.init(text: "+\(attackerTerrainBonus) 🌲 forest cover on target", style: .bonus)) }
            if eliteBonus > 0 { mods.append(.init(text: "+\(eliteBonus) 🛡 Elite Troops", style: .bonus)) }
            if attackerGrid?.terrain == .marsh { mods.append(.init(text: "🥾 Marsh — can't re-attack from here this turn", style: .warn)) }
        } else {
            if mountainBonus > 0 { mods.append(.init(text: "+1 ⛰ mountain", style: .bonus)) }
            if fortifiedBonus > 0 { mods.append(.init(text: "+2 🛡 fortified", style: .bonus)) }
            if rampartBonus > 0 { mods.append(.init(text: "+1 🏰 rampart", style: .bonus)) }
            if isInvasionCrossing { mods.append(.init(text: "+1 ⚓ sea invasion", style: .bonus)) }
            else if crossingBonus == 2 { mods.append(.init(text: "+2 ⚓ sea-lane crossing", style: .bonus)) }
            else if crossingBonus == 1 { mods.append(.init(text: "+1 💧 river crossing", style: .bonus)) }
            if bridgeCancels { mods.append(.init(text: "🌉 Bridge cancels river bonus", style: .warn)) }
            if defenderGrid?.terrain == .forest { mods.append(.init(text: "🌲 Forest — attacker gets +1", style: .warn)) }
            if defenderGrid?.terrain == .desert { mods.append(.init(text: "🏜 Desert — heat burns 1 army on move-in", style: .warn)) }
        }
        return mods
    }

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
            .frame(maxWidth: 560)
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

            HStack(alignment: .top, spacing: 20) {
                attackSide(title: "Attacker", grid: attackerGrid, gridState: attackerState, mods: modifiers(attacker: true))
                Image(systemName: "arrow.right").font(.title).padding(.top, 38)
                attackSide(title: "Defender", grid: defenderGrid, gridState: defenderState, mods: modifiers(attacker: false))
            }

            winProbabilityBar

            Text(state.message).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)

            HStack {
                Button("Roll") { vm.rollAttack() }
                    .buttonStyle(GameButtonStyle())
                Button(autoRolling ? "Stop Auto" : "Auto-Roll") { autoRolling.toggle() }
                    .buttonStyle(GameButtonStyle(kind: .success))
                Button("Quit Attack") { vm.quitAttack() }
                    .buttonStyle(GameButtonStyle(kind: .danger))
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
                    Button("None") { moveInExtra = 0 }.buttonStyle(GameButtonStyle(kind: .secondary, small: true))
                    Button("Max (\(maxExtra))") { moveInExtra = maxExtra }.buttonStyle(GameButtonStyle(kind: .secondary, small: true))
                }
            }

            Button("Confirm") {
                vm.confirmMoveIn(moveInExtra)
                moveInExtra = 0
            }
            .buttonStyle(GameButtonStyle())
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
                .frame(width: 124, height: 112)
            } else {
                Color.clear.frame(width: 124, height: 112)
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

    private func attackSide(title: String, grid: Grid?, gridState: GridState?, mods: [AttackMod]) -> some View {
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
                .frame(width: 138, height: 124)
            } else {
                Color.clear.frame(width: 138, height: 124)
            }
            Text(gridState?.owner?.displayName ?? "Neutral")
                .font(.caption2)
                .foregroundStyle(gridState?.owner?.color ?? .secondary)
            if let cityName = grid?.cityName {
                Text(cityName).font(.caption2).italic().foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                ForEach(mods) { mod in
                    Text(mod.text).font(.caption2).foregroundStyle(mod.style.color)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
        .frame(width: 190)
    }
}
