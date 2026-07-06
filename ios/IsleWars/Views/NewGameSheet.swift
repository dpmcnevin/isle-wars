import SwiftUI

struct NewGameSheet: View {
    @ObservedObject var vm: GameViewModel
    @State private var difficulty: Int = 2
    @State private var startingArmies: Int = 3
    @State private var seedText: String = ""
    @State private var showingDebug = false

    private let difficultyLabels = ["", "Easy", "Normal", "Hard", "Brutal"]
    private let difficultyBlurbs = [
        "",
        "The AI plays it safe — a gentle warm-up.",
        "A balanced fight for the archipelago.",
        "Opponents coordinate and punish mistakes.",
        "Ruthless, relentless, and out for blood."
    ]

    private func difficultyColor(_ level: Int) -> Color {
        switch level {
        case 1: return Color(hex: 0x3ac055)   // green
        case 2: return AppTheme.accent        // cyan
        case 3: return Color(hex: 0xff8a00)    // orange
        default: return Color(hex: 0xdd4444)   // red
        }
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [AppTheme.sidebarTop, AppTheme.bg],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 28) {
                    hero
                    settingsCard
                    startButton
                    Button("Debug Settings…") { showingDebug = true }
                        .font(.caption)
                        .tint(AppTheme.accent)
                }
                .padding(40)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
        }
        .foregroundStyle(AppTheme.text)
        .sheet(isPresented: $showingDebug) {
            DebugSettingsSheet(vm: vm)
        }
    }

    private var hero: some View {
        VStack(spacing: 12) {
            Text("ISLE WARS")
                .font(.system(size: 54, weight: .heavy, design: .serif))
                .foregroundStyle(
                    LinearGradient(colors: [AppTheme.gold, Color(hex: 0xffcf6a)],
                                   startPoint: .top, endPoint: .bottom)
                )
                .shadow(color: .black.opacity(0.5), radius: 6, y: 3)
            Text("Conquer the archipelago, one isle at a time.")
                .font(.callout)
                .foregroundStyle(AppTheme.textDim)
            HStack(spacing: 12) {
                ForEach(Player.allCases) { p in
                    Circle()
                        .fill(p.color)
                        .frame(width: 16, height: 16)
                        .overlay(Circle().stroke(.white.opacity(0.25), lineWidth: 1))
                        .shadow(color: p.color.opacity(0.6), radius: 4)
                }
            }
            .padding(.top, 4)
        }
    }

    private var settingsCard: some View {
        VStack(alignment: .leading, spacing: 20) {
            difficultySection
            themedDivider
            startingArmiesSection
            themedDivider
            seedSection
        }
        .padding(20)
        .background(
            RoundedRectangle(cornerRadius: 18)
                .fill(AppTheme.panel.opacity(0.85))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(AppTheme.border, lineWidth: 1))
        )
    }

    private var difficultySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("DIFFICULTY")
            HStack(spacing: 8) {
                ForEach(1...4, id: \.self) { level in
                    let selected = difficulty == level
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) { difficulty = level }
                    } label: {
                        Text(difficultyLabels[level])
                            .font(.subheadline.weight(selected ? .bold : .regular))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(
                                RoundedRectangle(cornerRadius: 10)
                                    .fill(selected ? difficultyColor(level).opacity(0.30) : Color.white.opacity(0.04))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .stroke(selected ? difficultyColor(level) : AppTheme.border,
                                            lineWidth: selected ? 2 : 1)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            Text(difficultyBlurbs[difficulty])
                .font(.caption)
                .foregroundStyle(AppTheme.textDim)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var startingArmiesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("STARTING ARMIES")
            HStack {
                Text("\(startingArmies) per territory").font(.body)
                Spacer()
                HStack(spacing: 0) {
                    stepperButton(systemName: "minus") {
                        startingArmies = max(1, startingArmies - 1)
                    }
                    Divider().frame(height: 22).overlay(AppTheme.border)
                    stepperButton(systemName: "plus") {
                        startingArmies = min(10, startingArmies + 1)
                    }
                }
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.06)))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppTheme.border, lineWidth: 1))
            }
        }
    }

    private var seedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("SEED (OPTIONAL)")
            HStack(spacing: 10) {
                TextField("Random", text: $seedText)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.06)))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppTheme.border, lineWidth: 1))
                Button {
                    seedText = Self.randomSeed()
                } label: {
                    Label("Randomize", systemImage: "dice.fill")
                }
                .buttonStyle(GameButtonStyle(kind: .secondary, small: true))
            }
        }
    }

    // Mirrors src/lib/map.ts's randomSeed(): a 12-char uppercase-alphanumeric
    // seed, for the same "more variety, unambiguous when shared" reasons.
    private static func randomSeed(length: Int = 12) -> String {
        let chars = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        return String((0..<length).map { _ in chars.randomElement()! })
    }

    private var startButton: some View {
        Button {
            let seed = seedText.trimmingCharacters(in: .whitespaces)
            vm.startNewGame(difficulty: difficulty, startingArmies: startingArmies, seed: seed.isEmpty ? nil : seed.uppercased())
        } label: {
            Text("Start New Game  →")
                .font(.title3.bold())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
        }
        .buttonStyle(.plain)
        .foregroundStyle(AppTheme.bg)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(LinearGradient(colors: [AppTheme.accent, Color(hex: 0x4aa8e0)],
                                     startPoint: .top, endPoint: .bottom))
        )
        .shadow(color: AppTheme.accent.opacity(0.4), radius: 10, y: 4)
        .frame(maxWidth: 320)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.bold))
            .tracking(1.2)
            .foregroundStyle(AppTheme.accent)
    }

    private var themedDivider: some View {
        Rectangle().fill(AppTheme.border).frame(height: 1)
    }

    private func stepperButton(systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.headline)
                .frame(width: 44, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(AppTheme.accent)
    }
}
