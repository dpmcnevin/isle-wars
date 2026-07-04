import SwiftUI

struct DebugSettingsSheet: View {
    @ObservedObject var vm: GameViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                if let settings = vm.debugSettings {
                    Toggle("Disable Save", isOn: Binding(
                        get: { settings.disableSave },
                        set: { vm.updateDebugSettings(DebugSettings(disableSave: $0, starterCards: settings.starterCards, autoPlay: settings.autoPlay, dieSides: settings.dieSides)) }
                    ))
                    Toggle("Starter Cards (Blue gets every card)", isOn: Binding(
                        get: { settings.starterCards },
                        set: { vm.updateDebugSettings(DebugSettings(disableSave: settings.disableSave, starterCards: $0, autoPlay: settings.autoPlay, dieSides: settings.dieSides)) }
                    ))
                    Toggle("Auto-Play (AI controls all 4)", isOn: Binding(
                        get: { settings.autoPlay },
                        set: { vm.updateDebugSettings(DebugSettings(disableSave: settings.disableSave, starterCards: settings.starterCards, autoPlay: $0, dieSides: settings.dieSides)) }
                    ))
                    Stepper("Die sides: \(settings.dieSides)", value: Binding(
                        get: { settings.dieSides },
                        set: { vm.updateDebugSettings(DebugSettings(disableSave: settings.disableSave, starterCards: settings.starterCards, autoPlay: settings.autoPlay, dieSides: $0)) }
                    ), in: 2...100)
                } else {
                    Text("Debug settings unavailable.").foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Debug Settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
