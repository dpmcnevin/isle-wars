import Foundation

/// Swift-side save/load, replacing the web app's `localStorage`-based save
/// (which is a silent no-op under JSC — `typeof window === 'undefined'`).
/// Persists the raw `GameState` JSON so it can be fed straight back into
/// the JS engine via `IsleWars.loadState` on next launch.
enum SaveStore {
    /// Serial so save/clear keep their caller order; saves happen after every
    /// single action (see GameViewModel.apply), so the disk write stays off
    /// the main thread rather than adding I/O latency to each tap/AI turn.
    private static let queue = DispatchQueue(label: "isle-wars.save", qos: .utility)

    private static var fileURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("isle-wars-save.json")
    }

    static func saveJSON(_ json: String) {
        queue.async {
            try? json.data(using: .utf8)?.write(to: fileURL, options: .atomic)
        }
    }

    /// Synchronous (only called once, at launch, before any writes are queued).
    static func loadJSON() -> String? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func clear() {
        queue.async {
            try? FileManager.default.removeItem(at: fileURL)
        }
    }
}
