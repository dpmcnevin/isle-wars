import SwiftUI

/// Compact recent-log strip with a "show full log" sheet. `state.log` is
/// newest-first; `highlightCount` (from GameViewModel, driven by the last
/// state transition) tints the entries that just appeared so an AI turn's
/// results read as fresh rather than silently updating.
struct EventLogView: View {
    let log: [LogEntry]
    let highlightCount: Int

    @State private var showingFullLog = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(log.prefix(3).enumerated()), id: \.offset) { index, entry in
                    logChip(entry, highlighted: index < highlightCount)
                }
                if log.isEmpty {
                    Text("No events yet.").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("Full Log") { showingFullLog = true }
                .font(.caption)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .padding(.horizontal)
        .sheet(isPresented: $showingFullLog) {
            NavigationStack {
                List {
                    ForEach(Array(log.enumerated()), id: \.offset) { index, entry in
                        logChip(entry, highlighted: index < highlightCount)
                    }
                }
                .navigationTitle("Event Log")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showingFullLog = false }
                    }
                }
            }
        }
    }

    private func logChip(_ entry: LogEntry, highlighted: Bool) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color(for: entry.kind)).frame(width: 8, height: 8)
            Text(entry.text).font(.caption2).lineLimit(2)
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(highlighted ? color(for: entry.kind).opacity(0.22) : Color.clear)
        )
        .animation(.easeOut(duration: 0.6), value: highlighted)
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
