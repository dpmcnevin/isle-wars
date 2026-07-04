import Foundation
import CoreGraphics

/// Mirrors a TypeScript `[number, number]` tuple, which serializes as a
/// 2-element JSON array rather than an object.
struct Point: Codable, Hashable {
    var x: Double
    var y: Double

    init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        x = try container.decode(Double.self)
        y = try container.decode(Double.self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.unkeyedContainer()
        try container.encode(x)
        try container.encode(y)
    }

    var cgPoint: CGPoint { CGPoint(x: x, y: y) }
}
