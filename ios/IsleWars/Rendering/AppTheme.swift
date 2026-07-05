import SwiftUI

extension Color {
    /// Build a color from a 24-bit RGB hex literal (e.g. `0x0f2035`), matching
    /// the way the web app specifies its palette in CSS.
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}

/// The web app's dark palette (from +page.svelte's CSS), mirrored here so the
/// iPad chrome — sidebar, panels, text, accents — reads the same navy/cyan/gold
/// as the browser build rather than the default iOS light/gray look.
enum AppTheme {
    static let bg = Color(hex: 0x0a1420)          // app background
    static let panel = Color(hex: 0x0f2035)       // panel fill
    static let panelDark = Color(hex: 0x081826)   // darker panel / score bg
    static let sidebarTop = Color(hex: 0x0e2a48)  // sidebar gradient top
    static let sidebarBottom = Color(hex: 0x081826)
    static let border = Color(hex: 0x1a3040)
    static let text = Color(hex: 0xd0e6f5)        // primary text
    static let textDim = Color(hex: 0x6a9abf)     // muted text / hints
    static let accent = Color(hex: 0x7fcfff)      // cyan accent
    static let gold = Color(hex: 0xffe14a)        // production / value gold
    static let primaryFill = Color(hex: 0x2a5a8a) // primary button bg (web .primary)
    static let primaryFillHi = Color(hex: 0x3a6a9a)
    static let secondaryFill = Color(hex: 0x1a3a5a) // default button bg (web button)
    static let secondaryFillHi = Color(hex: 0x2a5a8a)
    static let dangerFill = Color(hex: 0x4a1a1a)     // danger button bg (web .danger)
    static let dangerFillHi = Color(hex: 0x8a3a3a)
    static let dangerBorder = Color(hex: 0x8a3a3a)
    static let dangerText = Color(hex: 0xffdcdc)
    static let successFill = Color(hex: 0x1a4a2a)    // green / positive action
    static let successFillHi = Color(hex: 0x2a6a3a)
    static let successBorder = Color(hex: 0x4fcf7f)
    static let successText = Color(hex: 0xdcffe4)

    static var sidebarGradient: LinearGradient {
        LinearGradient(colors: [sidebarTop, sidebarBottom], startPoint: .top, endPoint: .bottom)
    }
}

/// Rectangular game button matching the web app's button styles. Replaces the
/// default `.bordered`/`.borderedProminent` (which are pill-shaped and, for
/// prominent, render white text on the light-cyan accent — unreadable). Three
/// variants mirror the web CSS: `.primary` (blue fill, cyan border, white
/// text), `.secondary` (dark-blue fill), `.danger` (dark-red fill).
struct GameButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, danger, success }
    @Environment(\.isEnabled) private var isEnabled
    var kind: Kind = .primary
    var small = false

    private var fill: Color {
        switch kind {
        case .primary: AppTheme.primaryFill
        case .secondary: AppTheme.secondaryFill
        case .danger: AppTheme.dangerFill
        case .success: AppTheme.successFill
        }
    }
    private var fillHi: Color {
        switch kind {
        case .primary: AppTheme.primaryFillHi
        case .secondary: AppTheme.secondaryFillHi
        case .danger: AppTheme.dangerFillHi
        case .success: AppTheme.successFillHi
        }
    }
    private var border: Color {
        switch kind {
        case .primary: AppTheme.accent
        case .secondary: AppTheme.primaryFill
        case .danger: AppTheme.dangerBorder
        case .success: AppTheme.successBorder
        }
    }
    private var textColor: Color {
        switch kind {
        case .primary: .white
        case .secondary: AppTheme.text
        case .danger: AppTheme.dangerText
        case .success: AppTheme.successText
        }
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(small ? .subheadline.weight(.semibold) : .body.weight(.semibold))
            .foregroundStyle(textColor)
            .padding(.horizontal, small ? 12 : 16)
            .padding(.vertical, small ? 6 : 10)
            .background(
                RoundedRectangle(cornerRadius: 9)
                    .fill(configuration.isPressed ? fillHi : fill)
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(border, lineWidth: 1))
            )
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(RoundedRectangle(cornerRadius: 9))
    }
}
