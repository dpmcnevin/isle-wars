import SwiftUI

struct NewGameSheet: View {
    @ObservedObject var vm: GameViewModel
    @State private var difficulty: Int = 2
    @State private var startingArmies: Int = 3
    @State private var seedText: String = ""
    @State private var showingDebug = false

    private let difficultyLabels = ["", "Easy", "Normal", "Hard", "Brutal"]

    var body: some View {
        VStack(spacing: 24) {
            Text("Isle Wars").font(.system(size: 44, weight: .bold, design: .serif))

            Form {
                Section("Difficulty") {
                    Picker("Difficulty", selection: $difficulty) {
                        ForEach(1...4, id: \.self) { level in
                            Text(difficultyLabels[level]).tag(level)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                Section("Starting Armies") {
                    Stepper("Starting armies per territory: \(startingArmies)", value: $startingArmies, in: 1...10)
                }
                Section("Seed (optional)") {
                    HStack {
                        TextField("Random", text: $seedText)
                            .keyboardType(.numberPad)
                        Button("Randomize") { seedText = "\(Int.random(in: 1...999_999_999))" }
                            .buttonStyle(.bordered)
                    }
                }
            }
            .frame(maxHeight: 320)
            .scrollContentBackground(.hidden)

            Button("New Game") {
                vm.startNewGame(difficulty: difficulty, startingArmies: startingArmies, seed: Int(seedText))
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            Button("Debug Settings…") { showingDebug = true }
                .font(.caption)
        }
        .padding()
        .frame(maxWidth: 520)
        .sheet(isPresented: $showingDebug) {
            DebugSettingsSheet(vm: vm)
        }
    }
}
