import SwiftUI

/// The per-hex detail shown on hover (pointer/Pencil) or long-press (touch),
/// replicating the web app's `hexInfo` tooltip: territory name, owner, army
/// count, city, and the terrain/fortification modifiers with their effects.
struct HexInfo {
    let title: String
    let owner: String
    let ownerColor: Color
    let armies: Int
    let city: String?
    let modifiers: [Modifier]

    struct Modifier: Identifiable {
        let id = UUID()
        let name: String
        let desc: String
    }

    private static let neutralColor = Color(hex: 0x555566)

    static func make(gridId: Int, state: GameState) -> HexInfo? {
        let map = state.map
        let states = state.states
        guard map.grids.indices.contains(gridId), states.indices.contains(gridId) else { return nil }
        let g = map.grids[gridId]
        let st = states[gridId]

        // `island-localIndex`, matching the web's `gridLabelLocal`.
        let island = map.islands.first { $0.id == g.island }
        let localIdx = (map.grids.filter { $0.island == g.island }.firstIndex { $0.id == gridId } ?? 0) + 1
        let title = "\(island?.name ?? "Isle")-\(localIdx)"

        var modifiers: [Modifier] = []
        if g.production {
            modifiers.append(Modifier(
                name: "City",
                desc: "Production center (★) — grants extra reinforcements to its owner and is the only launchpad for Artillery."
            ))
        }
        let terrainInfo: [Terrain: (String, String)] = [
            .plain: ("Plain", "Open ground. No combat modifier."),
            .mountain: ("Mountain", "Defender rolls +1 on every die."),
            .forest: ("Forest", "Attacker rolls +1 (cover on approach)."),
            .marsh: ("Marsh", "After attacking from here, cannot launch another attack from this hex this turn."),
            .desert: ("Desert", "Heat attrition — any move into a desert (conquest, regular move, or air move) burns 1 army. Cannot host a production center.")
        ]
        let (tName, tDesc) = terrainInfo[g.terrain] ?? ("Plain", "")
        // Only surface terrain when it has an effect; plain adds nothing unless
        // it's the only thing to show.
        if g.terrain != .plain || modifiers.isEmpty {
            modifiers.append(Modifier(name: tName, desc: tDesc))
        }
        if st.fortified == true {
            modifiers.append(Modifier(name: "🛡 Fortified", desc: "+2 defense on this hex. Lost when the hex is captured."))
        }
        if st.rampart == true {
            modifiers.append(Modifier(name: "🧱 Rampart", desc: "+1 defense on this hex. Lost when the hex is captured."))
        }
        if let capitalOwner = state.capitalOwner(at: gridId) {
            let desc = capitalOwner == st.owner
                ? "Pays \(capitalOwner.displayName) +3 reinforcements per turn while they hold it."
                : "Currently occupied — just a normal city for its occupier. \(capitalOwner.displayName) regains +3 reinforcements per turn by retaking it."
            modifiers.append(Modifier(name: "★ \(capitalOwner.displayName)'s capital", desc: desc))
        }

        return HexInfo(
            title: title,
            owner: st.owner?.displayName ?? "Neutral",
            ownerColor: st.owner?.color ?? neutralColor,
            armies: st.armies,
            city: g.cityName,
            modifiers: modifiers
        )
    }
}

struct HexInfoCard: View {
    let info: HexInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(info.ownerColor).frame(width: 10, height: 10)
                Text(info.title).font(.subheadline).bold()
                Spacer(minLength: 8)
                Text("\(info.armies)").font(.subheadline.monospaced()).bold()
            }
            Text(info.owner).font(.caption).foregroundStyle(info.ownerColor)
            if let city = info.city {
                Text("★ \(city)").font(.caption).italic().foregroundStyle(AppTheme.gold)
            }
            ForEach(info.modifiers) { m in
                VStack(alignment: .leading, spacing: 1) {
                    Text(m.name).font(.caption2).bold().foregroundStyle(AppTheme.accent)
                    if !m.desc.isEmpty {
                        Text(m.desc).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(10)
        .frame(width: 240, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(AppTheme.panelDark.opacity(0.97)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppTheme.border, lineWidth: 1))
        .foregroundStyle(AppTheme.text)
        .shadow(radius: 8)
    }
}
