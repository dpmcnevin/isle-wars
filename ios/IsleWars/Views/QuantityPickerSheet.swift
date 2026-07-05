import SwiftUI

/// Shared quantity picker used by all four contexts that need "how many
/// armies" from the player: placement, post-conquest move-in, a regular
/// move, and an Air Move card. One sheet design, parameterized by range
/// and copy, rather than four bespoke ones.
struct QuantityPickerSheet: View {
    let title: String
    let subtitle: String
    let range: ClosedRange<Int>
    let confirmLabel: String
    let endsTurn: Bool
    let onConfirm: (Int) -> Void
    var onCancel: (() -> Void)?
    /// Optional live hex previews (source, and destination for move/air),
    /// built from the current quantity — mirrors the web quantity modal's
    /// source → dest hex row showing armies after the action.
    let sourceHex: ((Int) -> HexPreview)?
    let destHex: ((Int) -> HexPreview)?

    @State private var qty: Int

    init(
        title: String,
        subtitle: String,
        range: ClosedRange<Int>,
        initial: Int,
        confirmLabel: String = "Confirm",
        endsTurn: Bool = false,
        sourceHex: ((Int) -> HexPreview)? = nil,
        destHex: ((Int) -> HexPreview)? = nil,
        onConfirm: @escaping (Int) -> Void,
        onCancel: (() -> Void)? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.range = range
        self.confirmLabel = confirmLabel
        self.endsTurn = endsTurn
        self.sourceHex = sourceHex
        self.destHex = destHex
        self.onConfirm = onConfirm
        self.onCancel = onCancel
        _qty = State(initialValue: min(max(initial, range.lowerBound), range.upperBound))
    }

    var body: some View {
        VStack(spacing: 20) {
            Text(title).font(.title2).bold()

            if let sourceHex {
                HStack(spacing: 16) {
                    sourceHex(qty).frame(width: 150, height: 135)
                    if let destHex {
                        Image(systemName: "arrow.right").font(.title2).foregroundStyle(.secondary)
                        destHex(qty).frame(width: 150, height: 135)
                    }
                }
            }

            Text(subtitle).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)

            HStack(spacing: 24) {
                Button {
                    qty = max(range.lowerBound, qty - 1)
                } label: {
                    Image(systemName: "minus.circle.fill").font(.system(size: 36))
                }
                .disabled(qty <= range.lowerBound)

                Text("\(qty)")
                    .font(.system(size: 44, weight: .bold, design: .monospaced))
                    .frame(minWidth: 90)

                Button {
                    qty = min(range.upperBound, qty + 1)
                } label: {
                    Image(systemName: "plus.circle.fill").font(.system(size: 36))
                }
                .disabled(qty >= range.upperBound)
            }

            if range.upperBound > range.lowerBound {
                Slider(
                    value: Binding(get: { Double(qty) }, set: { qty = Int($0.rounded()) }),
                    in: Double(range.lowerBound)...Double(range.upperBound),
                    step: 1
                )
                .frame(maxWidth: 280)

                HStack(spacing: 12) {
                    Button(range.lowerBound == 0 ? "None" : "Min (\(range.lowerBound))") {
                        qty = range.lowerBound
                    }
                    .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
                    Button("Max (\(range.upperBound))") {
                        qty = range.upperBound
                    }
                    .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
                }
            }

            if endsTurn {
                Label("This will end your turn.", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            HStack(spacing: 16) {
                if let onCancel {
                    Button("Cancel", role: .cancel) { onCancel() }
                        .buttonStyle(GameButtonStyle(kind: .danger))
                }
                Button(confirmLabel) { onConfirm(qty) }
                    .buttonStyle(GameButtonStyle())
            }
        }
        .padding(24)
        .frame(minWidth: 360)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(AppTheme.panel)
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(AppTheme.border, lineWidth: 1))
        )
        .foregroundStyle(AppTheme.text)
        .shadow(radius: 24)
    }
}
