import Foundation

@MainActor
final class GameViewModel: ObservableObject {
    @Published private(set) var state: GameState?
    @Published var errorMessage: String?
    @Published private(set) var isAiThinking = false
    @Published private(set) var debugSettings: DebugSettings?
    /// Number of the newest `state.log` entries (log is newest-first) to
    /// render with a highlight, so an AI turn's results read as "just
    /// happened" for a couple seconds rather than silently appearing.
    @Published private(set) var recentLogHighlightCount = 0

    private let engine: GameEngine
    private var aiTask: Task<Void, Never>?
    private var logHighlightTask: Task<Void, Never>?

    init() {
        do {
            engine = try GameEngine()
        } catch {
            fatalError("Failed to initialize GameEngine: \(error)")
        }
        debugSettings = try? engine.getDebugSettings()
        if let seedString = ProcessInfo.processInfo.environment["ISLEWARS_AUTOSTART_SEED"], let seed = Int(seedString) {
            startNewGame(seed: seed)
            startGamePlaying()
        } else {
            loadSavedGameIfPresent()
        }
    }

    // MARK: - Lifecycle

    func startNewGame(difficulty: Int = 2, startingArmies: Int = 3, seed: Int? = nil) {
        run { try $0.startGame(difficulty: difficulty, startingArmies: startingArmies, seed: seed) }
    }

    func startGamePlaying() {
        run { try $0.startGamePlaying() }
    }

    /// Abandons the current game and clears its save, returning to the
    /// new-game screen. Distinct from a plain `startNewGame` call so the
    /// user has to explicitly confirm (wired to a confirmation alert in
    /// the UI) before losing in-progress state.
    func startOver() {
        aiTask?.cancel()
        SaveStore.clear()
        state = nil
    }

    private func loadSavedGameIfPresent() {
        guard debugSettings?.disableSave != true, let json = SaveStore.loadJSON() else { return }
        do {
            let loaded = try engine.loadState(json: json)
            state = loaded
            scheduleAiTurnIfNeeded()
        } catch {
            // Corrupt or incompatible save (e.g. from an older schema) —
            // drop it silently and fall back to the new-game screen rather
            // than surfacing an alert for something the user can't act on.
            SaveStore.clear()
        }
    }

    // MARK: - Intents

    /// The universal hex-tap handler. During placement it places one army
    /// per tap (a real quantity picker lands in a later milestone); in every
    /// other phase it forwards to `selectGrid`, which is itself a big
    /// switch over `phase` on the JS side (attack/move/card-target
    /// selection all funnel through it there).
    func tapHex(_ gridId: Int) {
        guard let state else { return }
        if state.phase == .placing {
            run { try $0.placeArmies(gridId: gridId, qty: 1) }
        } else {
            run { try $0.selectGrid(gridId) }
        }
    }

    func placeArmies(gridId: Int, qty: Int) {
        run { try $0.placeArmies(gridId: gridId, qty: qty) }
    }

    func beginAttack() { run { try $0.beginAttack() } }
    func beginMove() { run { try $0.beginMove() } }

    /// Fired when a drag from an owned hex is released over a valid
    /// adjacent target during the `action` phase — skips the
    /// press-Attack-button step, mirroring the web app's drag-to-attack.
    func dragAttack(from: Int, to: Int) {
        run { engine in
            _ = try engine.beginAttack()
            _ = try engine.selectGrid(from)
            return try engine.selectGrid(to)
        }
    }

    func dragMove(from: Int, to: Int) {
        run { engine in
            _ = try engine.beginMove()
            _ = try engine.selectGrid(from)
            return try engine.selectGrid(to)
        }
    }

    /// Ferry drag: we're already in `ferry_from` (a Ferry card was played), so
    /// select the source then the destination; the engine handles connectivity.
    func dragFerry(from: Int, to: Int) {
        run { engine in
            _ = try engine.selectGrid(from)
            return try engine.selectGrid(to)
        }
    }
    func cancelAction() { run { try $0.cancelAction() } }
    func pass() { run { try $0.endTurn() } }
    func rollAttack() { run { try $0.rollAttack() } }
    func quitAttack() { run { try $0.quitAttack() } }
    func confirmMoveIn(_ extra: Int) { run { try $0.confirmMoveInAfterConquest(extra) } }
    func confirmMove(_ qty: Int) { run { try $0.confirmMove(qty) } }
    func confirmAir(_ qty: Int) { run { try $0.confirmAir(qty) } }
    func playCard(_ index: Int) { run { try $0.playCard(index) } }
    func discardCard(_ index: Int) { run { try $0.discardCard(index: index) } }

    // MARK: - Read-only helpers (attack modal)

    func winProbability(atkArmies: Int, defArmies: Int, defenderBonus: Int, attackerBonus: Int) -> Double {
        (try? engine.winProbability(atkArmies: atkArmies, defArmies: defArmies, defenderBonus: defenderBonus, attackerBonus: attackerBonus)) ?? 0.5
    }

    func defenseBonus(gridId: Int, fromId: Int?) -> Int {
        (try? engine.defenseBonus(gridId: gridId, fromId: fromId)) ?? 0
    }

    func attackerBonus(gridId: Int) -> Int {
        (try? engine.attackerBonus(gridId: gridId)) ?? 0
    }

    // MARK: - Debug settings

    func updateDebugSettings(_ patch: DebugSettings) {
        debugSettings = (try? engine.updateDebugSettings(patch)) ?? debugSettings
    }

    // MARK: - Plumbing

    private func run(_ action: (GameEngine) throws -> GameState) {
        do {
            let newState = try action(engine)
            apply(newState)
        } catch {
            errorMessage = "\(error)"
        }
    }

    private func apply(_ newState: GameState) {
        let previousLogCount = state?.log.count ?? newState.log.count
        let delta = max(0, newState.log.count - previousLogCount)
        state = newState
        if delta > 0 {
            recentLogHighlightCount = min(delta, newState.log.count)
            logHighlightTask?.cancel()
            logHighlightTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                guard let self, !Task.isCancelled else { return }
                self.recentLogHighlightCount = 0
            }
        }
        if debugSettings?.disableSave != true, newState.gameStarted, newState.winner == nil {
            if let json = try? engine.getStateJSON() {
                SaveStore.saveJSON(json)
            }
        } else if newState.winner != nil {
            SaveStore.clear()
        }
        scheduleAiTurnIfNeeded()
    }

    /// AI turns run to completion in one JS call (see GameEngine.runAiTurn).
    /// A short delay before triggering gives the human a beat to see the
    /// board settle; true move-by-move AI animation is a later milestone
    /// (log-diff replay), so for now the board just snaps to the AI's
    /// final state.
    private func scheduleAiTurnIfNeeded() {
        guard let state, state.gameStarted, state.phase != .gameOver, state.current != .human else {
            aiTask?.cancel()
            isAiThinking = false
            return
        }
        aiTask?.cancel()
        isAiThinking = true
        let player = state.current
        aiTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard let self, !Task.isCancelled else { return }
            self.runAiTurn(for: player)
        }
    }

    private func runAiTurn(for player: Player) {
        do {
            let newState = try engine.runAiTurn(player: player)
            isAiThinking = false
            apply(newState)
        } catch {
            isAiThinking = false
            errorMessage = "\(error)"
        }
    }
}
