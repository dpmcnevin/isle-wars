import SwiftUI

@main
struct IsleWarsApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark) // match the web app's dark navy theme
                .tint(AppTheme.accent)
                .statusBarHidden(true) // full-bleed map — reclaim the status-bar strip
        }
    }
}
