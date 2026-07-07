import Foundation
import JavaScriptCore

/// Hosts the bundled `game-bundle.js` (the existing web game's map/game/ai
/// logic, unmodified, plus a thin bridge shim) inside a JSContext and
/// exposes it as a plain Swift API. See ios/bridge/entry.ts for the JS side.
final class GameEngine {
    private let context: JSContext
    private let decoder = JSONDecoder()

    enum EngineError: Error {
        case bundleNotFound
        case evaluationFailed(String)
        case invalidResult
    }

    init() throws {
        guard let context = JSContext() else {
            throw EngineError.evaluationFailed("Could not create JSContext")
        }
        context.exceptionHandler = { _, exception in
            print("[GameEngine] JS exception: \(exception?.toString() ?? "unknown")")
        }
        self.context = context
        installConsoleShim()
        installTimerShim()
        try loadBundle()
    }

    /// `runAiTurn` (and anything else async) is only async for cosmetic
    /// pacing in the web UI. There is no real event loop backing a plain
    /// JSContext, so a real setTimeout would never fire. Since delay is
    /// meaningless here (Swift owns all animation pacing natively), this
    /// shim invokes the callback synchronously. JavaScriptCore drains the
    /// microtask queue before an `evaluateScript`/`call` returns to the
    /// host, so by the time control comes back to Swift, any async
    /// function whose only awaits were on this shimmed setTimeout has
    /// already run to completion.
    private func installTimerShim() {
        let setTimeoutShim: @convention(block) (JSValue) -> Void = { callback in
            callback.call(withArguments: [])
        }
        context.setObject(setTimeoutShim, forKeyedSubscript: "setTimeout" as NSString)
        context.setObject(setTimeoutShim, forKeyedSubscript: "setInterval" as NSString)
        let clearShim: @convention(block) (JSValue) -> Void = { _ in }
        context.setObject(clearShim, forKeyedSubscript: "clearTimeout" as NSString)
        context.setObject(clearShim, forKeyedSubscript: "clearInterval" as NSString)
    }

    private func installConsoleShim() {
        let log: @convention(block) ([JSValue]) -> Void = { args in
            let parts = args.map { $0.toString() ?? "" }
            print("[JS] " + parts.joined(separator: " "))
        }
        let console = JSValue(newObjectIn: context)
        console?.setObject(log, forKeyedSubscript: "log" as NSString)
        console?.setObject(log, forKeyedSubscript: "warn" as NSString)
        console?.setObject(log, forKeyedSubscript: "error" as NSString)
        context.setObject(console, forKeyedSubscript: "console" as NSString)
    }

    private func loadBundle() throws {
        guard let url = Bundle.main.url(forResource: "game-bundle", withExtension: "js") else {
            throw EngineError.bundleNotFound
        }
        let source = try String(contentsOf: url, encoding: .utf8)
        context.evaluateScript(source)
        if let exception = context.exception {
            throw EngineError.evaluationFailed(exception.toString() ?? "unknown JS load error")
        }
    }

    private func isleWars() throws -> JSValue {
        guard let obj = context.objectForKeyedSubscript("IsleWars"), !obj.isUndefined else {
            throw EngineError.evaluationFailed("IsleWars global not found in bundle")
        }
        return obj
    }

    @discardableResult
    private func rawCall(_ method: String, args: [Any] = []) throws -> JSValue {
        let iw = try isleWars()
        guard let fn = iw.objectForKeyedSubscript(method), fn.isObject else {
            throw EngineError.evaluationFailed("Method \(method) not found on IsleWars")
        }
        let result = fn.call(withArguments: args)
        if let exception = context.exception {
            context.exception = nil
            throw EngineError.evaluationFailed(exception.toString() ?? "unknown error calling \(method)")
        }
        return result ?? JSValue(undefinedIn: context)
    }

    /// Calls a method on `globalThis.IsleWars` and decodes its JSON-string
    /// return value into `T`.
    private func call<T: Decodable>(_ method: String, args: [Any] = [], as type: T.Type) throws -> T {
        let result = try rawCall(method, args: args)
        guard let jsonString = result.toString(), let data = jsonString.data(using: .utf8) else {
            throw EngineError.invalidResult
        }
        return try decoder.decode(T.self, from: data)
    }

    private func callState(_ method: String, args: [Any] = []) throws -> GameState {
        try call(method, args: args, as: GameState.self)
    }

    // MARK: - Game lifecycle

    func startGame(difficulty: Int = 2, startingArmies: Int = 3, seed: String? = nil) throws -> GameState {
        // JS default parameters only kick in for `undefined`, not `null`, so
        // omit the argument entirely rather than passing NSNull() when unset.
        var args: [Any] = [difficulty, startingArmies]
        if let seed { args.append(seed) }
        return try callState("startGame", args: args)
    }

    func getState() throws -> GameState {
        try callState("getState")
    }

    /// Raw JSON, used by SaveStore so persistence round-trips through the
    /// exact bytes the JS engine produced rather than re-encoding via
    /// Swift's JSONEncoder.
    func getStateJSON() throws -> String {
        try rawCall("getState").toString() ?? ""
    }

    func startGamePlaying() throws -> GameState {
        try callState("startGamePlaying")
    }

    /// Hydrates the JS game store from a Swift-persisted save (see
    /// SaveStore) — Swift owns save/load since JSC has no localStorage.
    func loadState(json: String) throws -> GameState {
        try callState("loadState", args: [json])
    }

    func getDebugSettings() throws -> DebugSettings {
        try call("getDebugSettings", as: DebugSettings.self)
    }

    func updateDebugSettings(_ patch: DebugSettings) throws -> DebugSettings {
        let data = try JSONEncoder().encode(patch)
        let json = String(data: data, encoding: .utf8) ?? "{}"
        return try call("updateDebugSettings", args: [json], as: DebugSettings.self)
    }

    // MARK: - Placement / turn flow

    func placeArmies(gridId: Int, qty: Int) throws -> GameState {
        try callState("placeArmies", args: [gridId, qty])
    }

    func beginAttack() throws -> GameState { try callState("beginAttack") }
    func beginMove() throws -> GameState { try callState("beginMove") }
    func cancelAction() throws -> GameState { try callState("cancelAction") }
    func selectGrid(_ gridId: Int) throws -> GameState { try callState("selectGrid", args: [gridId]) }
    func endTurn() throws -> GameState { try callState("endTurn") }
    func forceEndTurn() throws -> GameState { try callState("forceEndTurn") }
    func discardCard(index: Int) throws -> GameState { try callState("discardCard", args: [index]) }

    func rollAttack() throws -> GameState { try callState("rollAttack") }
    func quitAttack() throws -> GameState { try callState("quitAttack") }
    func confirmMoveInAfterConquest(_ extra: Int) throws -> GameState {
        try callState("confirmMoveInAfterConquest", args: [extra])
    }
    func confirmMove(_ qty: Int) throws -> GameState { try callState("confirmMove", args: [qty]) }
    func confirmAir(_ qty: Int) throws -> GameState { try callState("confirmAir", args: [qty]) }
    func confirmParatroop(_ qty: Int) throws -> GameState { try callState("confirmParatroop", args: [qty]) }
    func playCard(_ index: Int) throws -> GameState { try callState("playCard", args: [index]) }

    /// Fire-and-forget: relies on the setTimeout shim (see above) so the
    /// whole AI turn completes before this returns. A subsequent
    /// `getState()` reads the result.
    func runAiTurn(player: Player) throws -> GameState {
        try rawCall("runAiTurn", args: [player.rawValue])
        return try getState()
    }

    // MARK: - Read-only helpers (attack modal, targeting rules)

    func winProbability(atkArmies: Int, defArmies: Int, defenderBonus: Int = 0, attackerBonus: Int = 0) throws -> Double {
        try rawCall(
            "winProbability",
            args: [atkArmies, defArmies, defenderBonus, attackerBonus]
        ).toDouble()
    }

    func defenseBonus(gridId: Int, fromId: Int? = nil) throws -> Int {
        var args: [Any] = [gridId]
        if let fromId { args.append(fromId) }
        return Int(try rawCall("defenseBonus", args: args).toInt32())
    }

    func attackerBonus(gridId: Int) throws -> Int {
        Int(try rawCall("attackerBonus", args: [gridId]).toInt32())
    }

    func crossingDefenseBonus(fromId: Int, toId: Int) throws -> Int {
        Int(try rawCall("crossingDefenseBonus", args: [fromId, toId]).toInt32())
    }

    func hasClearWaterPath(fromId: Int, toId: Int) throws -> Bool {
        try rawCall("hasClearWaterPath", args: [fromId, toId]).toBool()
    }

    func canFerryConnect(fromId: Int, toId: Int) throws -> Bool {
        try rawCall("canFerryConnect", args: [fromId, toId]).toBool()
    }

    func canInvasionConnect(fromId: Int, toId: Int) throws -> Bool {
        try rawCall("canInvasionConnect", args: [fromId, toId]).toBool()
    }

    func canArtilleryTarget(fromId: Int, toId: Int) throws -> Bool {
        try rawCall("canArtilleryTarget", args: [fromId, toId]).toBool()
    }

    func countryCount(player: Player) throws -> Int {
        Int(try rawCall("countryCount", args: [player.rawValue]).toInt32())
    }

    /// Every card's display metadata, straight from the engine registry, so the
    /// native client never re-declares labels/icons in Swift (Tier 3).
    func cardCatalog() throws -> [CardInfo] {
        try call("cardCatalog", as: [CardInfo].self)
    }

    /// Grid ids the active player can select right now — drives the map's
    /// selection highlight without reimplementing per-phase rules in Swift.
    func selectableHexes() throws -> [Int] {
        try call("selectableHexes", as: [Int].self)
    }

    func fullIslandBonus(player: Player) throws -> Int {
        Int(try rawCall("fullIslandBonus", args: [player.rawValue]).toInt32())
    }

    /// Whether `card` is legal to play right now — the same `playableIn`/
    /// `cardPlayedThisTurn`/passive rules the engine uses to gate `playCard`,
    /// so Swift never re-derives a coarser approximation of this check.
    func canPlayCardNow(card: CardType) throws -> Bool {
        try rawCall("canPlayCardNow", args: [card.rawValue]).toBool()
    }

    /// Post-game "key moments" — same picks (territory/army swing, always
    /// including the final turn) the web recap page uses.
    func computeTurningPoints(count: Int = 15) throws -> [TurningPoint] {
        try call("computeTurningPoints", args: [count], as: [TurningPoint].self)
    }

    /// The full shareable recap payload (turning points, history, stats,
    /// final board state) as raw JSON — nil if the game hasn't been won.
    /// Swift base64url-encodes this itself with the 'r' (uncompressed) tag
    /// the web's `encodeRecap` also emits, so a link built here still decodes
    /// on the web `/recap` page (JavaScriptCore has no CompressionStream to
    /// match the web's gzip path, so this always takes the larger, raw form).
    func buildRecapJSON() throws -> String? {
        let result = try rawCall("buildRecapJSON")
        return result.isNull ? nil : result.toString()
    }

    /// Hex ownership as of the end of `turn`, for a turning point's
    /// before/after mini-map compare (see `reconstructOwnersAtTurn` in
    /// `src/lib/summary.ts`).
    func reconstructOwnersAtTurn(_ turn: Int) throws -> [Player?] {
        try call("reconstructOwnersAtTurn", args: [turn], as: [Player?].self)
    }

    /// Walls/sea-lanes as of the end of `turn`, for the same compare view.
    func reconstructEdgesAtTurn(_ turn: Int) throws -> ReconstructedEdges {
        try call("reconstructEdgesAtTurn", args: [turn], as: ReconstructedEdges.self)
    }
}
