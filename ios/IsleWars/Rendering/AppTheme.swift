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

    static var sidebarGradient: LinearGradient {
        LinearGradient(colors: [sidebarTop, sidebarBottom], startPoint: .top, endPoint: .bottom)
    }
}
