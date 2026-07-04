import Foundation

struct Island: Codable, Identifiable {
    let id: Int
    let name: String
    let value: Int
    let center: Point
    let labelPos: Point
    let shape: [Point]
}

struct Grid: Codable, Identifiable {
    let id: Int
    let island: Int
    let x: Double
    let y: Double
    let production: Bool
    let terrain: Terrain
    let cityName: String?
    let cell: [Point]
}

struct WaterFeature: Codable {
    let kind: String // "lake" | "bay"
    let name: String
    let center: Point
    let hexes: [[Point]]
}

struct ViewBox: Codable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

struct GameMap: Codable {
    let islands: [Island]
    let grids: [Grid]
    let adj: [[Int]]
    let seaLanes: [[Int]]
    let waterHexes: [[Point]]
    let waterFeatures: [WaterFeature]
    let rivers: [[Int]]
    let width: Double
    let height: Double
    let viewBox: ViewBox
    let winThreshold: Int
}
