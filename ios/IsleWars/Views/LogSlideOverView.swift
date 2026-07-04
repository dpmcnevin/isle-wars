import SwiftUI

/// Right-edge slide-over panel: the full event log plus the history graphs
/// (territories/armies over time) and a stats table — mirroring the web app's
/// sidebar log and the analytics charts at the bottom of the page.
struct LogSlideOverView: View {
    let log: [LogEntry]
    let highlightCount: Int
    let history: [TurnSnapshot]
    let stats: [String: PlayerStats]
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Event Log").font(.headline)
                Spacer()
                Button {
                    onClose()
                } label: {
                    Image(systemName: "xmark.circle.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            .padding()

            Divider().overlay(AppTheme.border)

            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    if log.isEmpty {
                        Text("No events yet.").font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(Array(log.enumerated()), id: \.offset) { index, entry in
                        logChip(entry, highlighted: index < highlightCount)
                    }

                    if !history.isEmpty {
                        Divider().overlay(AppTheme.border).padding(.vertical, 10)
                        HistoryChartsView(history: history, stats: stats)
                    }
                }
                .padding()
            }
        }
        .frame(width: 380)
        .frame(maxHeight: .infinity)
        .background(AppTheme.sidebarGradient)
        .overlay(alignment: .leading) {
            Rectangle().frame(width: 1).foregroundStyle(AppTheme.border)
        }
        .foregroundStyle(AppTheme.text)
    }

    private func logChip(_ entry: LogEntry, highlighted: Bool) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Circle().fill(color(for: entry.kind)).frame(width: 8, height: 8).padding(.top, 4)
            Text(entry.text).font(.caption).lineLimit(nil)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(highlighted ? color(for: entry.kind).opacity(0.22) : Color.clear)
        )
    }

    private func color(for kind: LogKind?) -> Color {
        switch kind {
        case .attack: .orange
        case .defeat: .red
        case .card: .purple
        case .event: .blue
        case .info, .none: .gray
        }
    }
}

/// The web app's two analytics line charts (territories/armies per player over
/// each turn) plus the summary stats table.
struct HistoryChartsView: View {
    let history: [TurnSnapshot]
    let stats: [String: PlayerStats]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            chart(title: "Territories owned") { $0.territories }
            chart(title: "Total armies") { $0.armies }
            statsTable
        }
    }

    private func chart(title: String, series: @escaping (TurnSnapshot) -> [String: Int]) -> some View {
        let maxV = max(1, history.flatMap { snap in
            Player.allCases.map { series(snap)[$0.rawValue] ?? 0 }
        }.max() ?? 1)
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(.caption).foregroundStyle(AppTheme.accent)
                Spacer()
                Text("\(maxV)").font(.caption2).foregroundStyle(.secondary)
            }
            Canvas { ctx, size in
                let plotH = size.height - 2
                let plotW = size.width - 2
                let originX: CGFloat = 1
                // Axes.
                var axes = Path()
                axes.move(to: CGPoint(x: originX, y: 0))
                axes.addLine(to: CGPoint(x: originX, y: plotH))
                axes.addLine(to: CGPoint(x: size.width, y: plotH))
                ctx.stroke(axes, with: .color(AppTheme.border), lineWidth: 1)

                let n = history.count
                guard n > 0 else { return }
                let xStep = n > 1 ? plotW / CGFloat(n - 1) : 0
                for player in Player.allCases {
                    if n == 1 {
                        let v = CGFloat(series(history[0])[player.rawValue] ?? 0)
                        let y = plotH - (v / CGFloat(maxV)) * plotH
                        let r: CGFloat = 2.5
                        ctx.fill(Path(ellipseIn: CGRect(x: originX - r, y: y - r, width: r * 2, height: r * 2)),
                                 with: .color(player.color))
                        continue
                    }
                    var path = Path()
                    for (i, snap) in history.enumerated() {
                        let v = CGFloat(series(snap)[player.rawValue] ?? 0)
                        let x = originX + CGFloat(i) * xStep
                        let y = plotH - (v / CGFloat(maxV)) * plotH
                        if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
                    }
                    ctx.stroke(path, with: .color(player.color), lineWidth: 2)
                }
            }
            .frame(height: 110)
        }
    }

    private var statsTable: some View {
        let last = history.last
        return VStack(alignment: .leading, spacing: 6) {
            Text("Stats").font(.caption).foregroundStyle(AppTheme.accent)
            SwiftUI.Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 4) {
                GridRow {
                    Text("").gridColumnAlignment(.leading)
                    Text("T"); Text("A"); Text("W/L"); Text("+/−"); Text("Cards")
                }
                .font(.caption2.bold())
                .foregroundStyle(.secondary)
                ForEach(Player.allCases) { p in
                    let st = stats[p.rawValue]
                    GridRow {
                        HStack(spacing: 5) {
                            Circle().fill(p.color).frame(width: 8, height: 8)
                            Text(p.displayName)
                        }
                        Text("\(last?.territories[p.rawValue] ?? 0)")
                        Text("\(last?.armies[p.rawValue] ?? 0)")
                        Text("\(st?.attacksWon ?? 0)/\(st?.attacksLost ?? 0)")
                        Text("\(st?.territoriesCaptured ?? 0)/\(st?.territoriesLost ?? 0)")
                        Text("\(st?.cardsDrawn ?? 0)")
                    }
                    .font(.caption2)
                }
            }
        }
    }
}
