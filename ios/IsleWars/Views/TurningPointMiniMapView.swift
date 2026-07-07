import SwiftUI

/// Read-only mini-map for one side (before or after) of a turning-point
/// compare — mirrors the web recap's `tpView()` render
/// (`src/routes/recap/+page.svelte:194-258`). Deliberately simpler than the
/// live `MapView` (flat owner fills, no terrain patterns/rivers/drag
/// gestures): this renders once per turning point and is never interacted
/// with.
struct TurningPointMiniMapView: View {
    let map: GameMap
    let owners: [Player?]
    let walls: [[Int]]
    let seaLanes: [[Int]]
    /// Hexes whose owner differs between the before/after pair — outlined.
    var changedGrids: Set<Int> = []
    /// Capture arrows to draw on this side (typically only the "after" map).
    var arrows: [(from: Int, to: Int, color: Color)] = []
    /// Per-hex army label (capture size, or a signed army-swing delta).
    var armyLabels: [Int: Int] = [:]

    var body: some View {
        GeometryReader { geo in
            let transform = MapTransform(viewBox: map.viewBox, containerSize: geo.size)
            Canvas { context, size in
                context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(red: 0.09, green: 0.22, blue: 0.35)))

                for lane in seaLanes where lane.count == 2 {
                    let path = seaLanePath(a: lane[0], b: lane[1], map: map, transform: transform)
                    context.stroke(
                        path,
                        with: .color(Color(red: 0.63, green: 0.85, blue: 1.0).opacity(0.7)),
                        style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])
                    )
                }

                for grid in map.grids {
                    let path = transform.polygonPath(grid.cell)
                    let owner = owners.indices.contains(grid.id) ? owners[grid.id] : nil
                    context.fill(path, with: .color(owner?.color ?? Color(white: 0.55)))
                    let changed = changedGrids.contains(grid.id)
                    context.stroke(
                        path,
                        with: .color(changed ? .white : MapColors.outline),
                        lineWidth: changed ? 2.5 : 0.75
                    )
                }

                drawWalls(context: context, transform: transform)

                for (from, to, color) in arrows {
                    guard map.grids.indices.contains(from), map.grids.indices.contains(to) else { continue }
                    drawDragArrow(
                        in: context,
                        from: transform.point(map.grids[from].cellCenter),
                        to: transform.point(map.grids[to].cellCenter),
                        color: color,
                        solid: true
                    )
                }

                for (grid, label) in armyLabels {
                    guard map.grids.indices.contains(grid) else { continue }
                    let center = transform.point(map.grids[grid].cellCenter)
                    let text = label > 0 ? "+\(label)" : "\(label)"
                    drawOutlinedLabel(
                        text, in: context, at: center,
                        font: .system(size: 12, weight: .bold), fillColor: .white
                    )
                }
            }
        }
        .aspectRatio(map.viewBox.w / map.viewBox.h, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func drawWalls(context: GraphicsContext, transform: MapTransform) {
        for wall in walls where wall.count == 2 {
            guard let (a, b) = sharedEdge(wall[0], wall[1]) else { continue }
            var path = Path()
            path.move(to: transform.point(a))
            path.addLine(to: transform.point(b))
            context.stroke(
                path,
                with: .color(Color(red: 0.60, green: 0.56, blue: 0.51)),
                style: StrokeStyle(lineWidth: 5, lineCap: .round)
            )
        }
    }

    /// The two vertices shared by two adjacent hexes — the edge a wall sits on.
    private func sharedEdge(_ a: Int, _ b: Int) -> (Point, Point)? {
        guard map.grids.indices.contains(a), map.grids.indices.contains(b) else { return nil }
        func key(_ p: Point) -> String { "\(Int((p.x * 10).rounded())),\(Int((p.y * 10).rounded()))" }
        let bKeys = Set(map.grids[b].cell.map(key))
        let shared = map.grids[a].cell.filter { bKeys.contains(key($0)) }
        guard shared.count == 2 else { return nil }
        return (shared[0], shared[1])
    }
}
