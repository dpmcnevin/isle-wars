import SwiftUI

/// Read-only mini-map for one side (before or after) of a turning-point
/// compare — mirrors the web recap's `TpMiniMap.svelte`. Deliberately
/// simpler than the live `MapView` (no terrain patterns/rivers/drag
/// gestures): this renders once per turning point and is never interacted
/// with.
struct TurningPointMiniMapView: View {
    let map: GameMap
    let owners: [Player?]
    let walls: [[Int]]
    let seaLanes: [[Int]]
    /// Hexes whose owner differs between the before/after pair — solid gold
    /// outline (the "after" pane).
    var changedGrids: Set<Int> = []
    /// Same set of hexes, but drawn as a faint dashed echo instead (the
    /// "before" pane) so the eye lands on the same spot in both maps.
    var ghostGrids: Set<Int> = []
    /// Fade hexes that didn't change hands so the changed cluster is the
    /// only saturated thing on the map (the "after" pane only).
    var dimUnchanged: Bool = false
    /// The previous owner of each changed hex — draws a "captured from"
    /// wedge in that color, mirroring web's `capturedFrom`.
    var capturedFrom: [Int: Player?] = [:]
    /// Capture arrows to draw on this side (typically only the "after" map).
    var arrows: [TurningPointArrow] = []
    /// Per-hex army label (capture size, or a signed army-swing delta).
    var armyLabels: [Int: Int] = [:]
    /// The single largest `armyLabels` entry — drawn bigger/bolder.
    var biggestGrid: Int? = nil

    var body: some View {
        GeometryReader { geo in
            let transform = MapTransform(viewBox: map.viewBox, containerSize: geo.size)
            Canvas { context, size in
                context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(red: 0.04, green: 0.145, blue: 0.25)))

                let shouldDim = dimUnchanged && !changedGrids.isEmpty
                for grid in map.grids {
                    let path = transform.polygonPath(grid.cell)
                    let owner = owners.indices.contains(grid.id) ? owners[grid.id] : nil
                    let dimmed = shouldDim && !changedGrids.contains(grid.id)
                    context.fill(path, with: .color((owner?.color ?? Color(red: 0.2, green: 0.2, blue: 0.27)).opacity(dimmed ? 0.4 : 1)))
                    context.stroke(path, with: .color(MapColors.outline), lineWidth: 1)
                }

                // "Captured from" wedge: one sixth of the hex filled with the
                // previous owner's color, on the side the winning attack came
                // in from, so a captured hex shows whose color it was taken
                // from (mirrors web's wedgePoints).
                for (gridId, prevOwner) in capturedFrom {
                    guard map.grids.indices.contains(gridId) else { continue }
                    let poly = wedgePoints(gridId: gridId)
                    guard poly.count >= 3 else { continue }
                    var path = Path()
                    path.move(to: transform.point(poly[0]))
                    for p in poly.dropFirst() { path.addLine(to: transform.point(p)) }
                    path.closeSubpath()
                    context.fill(path, with: .color(prevOwner?.color ?? Color(red: 0.79, green: 0.84, blue: 0.89)))
                    context.stroke(path, with: .color(MapColors.outline), lineWidth: 1)
                }

                for grid in map.grids where changedGrids.contains(grid.id) {
                    let path = transform.polygonPath(grid.cell)
                    context.stroke(path, with: .color(Color(red: 1.0, green: 0.91, blue: 0.5)), lineWidth: 2.5)
                }
                for grid in map.grids where ghostGrids.contains(grid.id) {
                    let path = transform.polygonPath(grid.cell)
                    context.stroke(
                        path, with: .color(Color(red: 1.0, green: 0.91, blue: 0.5).opacity(0.6)),
                        style: StrokeStyle(lineWidth: 1.8, dash: [5, 4])
                    )
                }

                for lane in seaLanes where lane.count == 2 {
                    let path = seaLanePath(a: lane[0], b: lane[1], map: map, transform: transform)
                    context.stroke(
                        path,
                        with: .color(Color(red: 0.63, green: 0.85, blue: 1.0).opacity(0.85)),
                        style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])
                    )
                }

                drawWalls(context: context, transform: transform)

                for arrow in arrows {
                    guard map.grids.indices.contains(arrow.from), map.grids.indices.contains(arrow.to) else { continue }
                    drawArrow(arrow, context: context, transform: transform)
                }

                for (grid, label) in armyLabels {
                    guard map.grids.indices.contains(grid) else { continue }
                    drawArmyBadge(gridId: grid, label: label, context: context, transform: transform)
                }
            }
        }
        .aspectRatio(map.viewBox.w / map.viewBox.h, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Army badges

    /// Radius (map-space units, matching web's r=34/44 against a
    /// circumradius-70 hex) of the badge at `gridId`, scaled to view space.
    private func badgeRadius(_ gridId: Int, scale: CGFloat) -> CGFloat {
        (gridId == biggestGrid ? 44 : 34) * scale
    }

    private func drawArmyBadge(gridId: Int, label: Int, context: GraphicsContext, transform: MapTransform) {
        let grid = map.grids[gridId]
        let center = transform.point(Point(x: grid.x, y: grid.y))
        let scale = transform.scale
        let isBiggest = gridId == biggestGrid
        let isLoss = label < 0
        let r = badgeRadius(gridId, scale: scale)
        let ringColor: Color = isLoss ? Color(red: 1.0, green: 0.35, blue: 0.35) : Color(red: 1.0, green: 0.69, blue: 0.23)

        context.fill(
            Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)),
            with: .color(MapColors.outline.opacity(0.88))
        )
        if isBiggest {
            context.stroke(
                Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)),
                with: .color(ringColor),
                lineWidth: 3 * scale
            )
        }
        let textColor: Color = isBiggest ? ringColor : (isLoss ? Color(red: 1.0, green: 0.6, blue: 0.6) : .white)
        let text = "\(label > 0 ? "+" : "")\(label)"
        // Web sizes these at 26/34 (map-space units, same scale as the 34/44
        // badge radius) — matching that 1:1 instead of the much smaller
        // constants used here previously, plus a floor so a small mini-map
        // still reads at a glance rather than shrinking to a dot.
        let fontSize = max(12, (isBiggest ? 34 : 26) * scale)
        context.draw(
            Text(text).font(.system(size: fontSize, weight: isBiggest ? .heavy : .bold)).foregroundStyle(textColor),
            at: center
        )
    }

    // MARK: - Arrows

    /// Web's `tpArrowWidth`: scales with the committed force so a 20-army
    /// rout reads differently from a 2-army skirmish.
    private func arrowWidth(_ armies: Int?) -> CGFloat {
        max(2, min(3 + CGFloat(armies ?? 0) * 0.4, 12))
    }

    /// Conquest arrows run hex-center to hex-center, but army badges sit
    /// exactly there — trim each end back to the badge's rim (plus room for
    /// the arrowhead) instead of burying it under the badge circle.
    private func drawArrow(_ arrow: TurningPointArrow, context: GraphicsContext, transform: MapTransform) {
        let scale = transform.scale
        let from = map.grids[arrow.from]
        let to = map.grids[arrow.to]
        let dx = to.x - from.x, dy = to.y - from.y
        let dist = max(1, (dx * dx + dy * dy).squareRoot())
        let w = arrowWidth(arrow.armies)
        let startTrim = armyLabels[arrow.from] == nil ? 0 : (badgeRadius(arrow.from, scale: 1) + 3)
        let endTrim = armyLabels[arrow.to] == nil ? 0 : (badgeRadius(arrow.to, scale: 1) + Double(w) + 3)
        let trimScale = min(1, (dist - 8) / max(startTrim + endTrim, 1))
        let s = (startTrim * trimScale) / dist
        let e = (endTrim * trimScale) / dist
        let p1 = transform.point(Point(x: from.x + dx * s, y: from.y + dy * s))
        let p2 = transform.point(Point(x: to.x - dx * e, y: to.y - dy * e))

        let color = arrow.forfeited ? Color(red: 1.0, green: 0.23, blue: 0.23) : arrow.color
        var line = Path()
        line.move(to: p1)
        line.addLine(to: p2)
        context.stroke(
            line, with: .color(color.opacity(0.9)),
            style: StrokeStyle(lineWidth: w * scale, lineCap: .round, dash: arrow.forfeited ? [5, 4] : [])
        )

        // Arrowhead: a filled triangle at the target end (or an X for a
        // forfeited/failed attack, matching web's marker defs).
        let angle = atan2(p2.y - p1.y, p2.x - p1.x)
        if arrow.forfeited {
            let s2 = w * scale * 1.4
            var x1 = Path(); x1.move(to: CGPoint(x: p2.x - s2, y: p2.y - s2)); x1.addLine(to: CGPoint(x: p2.x + s2, y: p2.y + s2))
            var x2 = Path(); x2.move(to: CGPoint(x: p2.x + s2, y: p2.y - s2)); x2.addLine(to: CGPoint(x: p2.x - s2, y: p2.y + s2))
            context.stroke(x1, with: .color(color), lineWidth: max(1.5, w * scale * 0.55))
            context.stroke(x2, with: .color(color), lineWidth: max(1.5, w * scale * 0.55))
        } else {
            let len = w * scale * 3.2, half = w * scale * 1.6
            let tip = p2
            let back = CGPoint(x: tip.x - cos(angle) * len, y: tip.y - sin(angle) * len)
            let perp = CGPoint(x: -sin(angle), y: cos(angle))
            var head = Path()
            head.move(to: tip)
            head.addLine(to: CGPoint(x: back.x + perp.x * half, y: back.y + perp.y * half))
            head.addLine(to: CGPoint(x: back.x - perp.x * half, y: back.y - perp.y * half))
            head.closeSubpath()
            context.fill(head, with: .color(color))
        }
    }

    // MARK: - Wedge geometry

    /// The "captured from" wedge polygon for a captured hex, facing the
    /// winning attack when there's an incoming arrow (top-left otherwise).
    /// Mirrors web's `wedgePoints` exactly (12 sub-hex directional sectors).
    private func wedgePoints(gridId: Int) -> [Point] {
        let g = map.grids[gridId]
        let center = Point(x: g.x, y: g.y)
        func vtx(_ i: Int) -> Point { g.cell[((i % 6) + 6) % 6] }
        guard let inc = arrows.first(where: { $0.to == gridId && !$0.forfeited }),
              map.grids.indices.contains(inc.from) else {
            return [center, vtx(4), vtx(5)]
        }
        let from = map.grids[inc.from]
        let deg = atan2(from.y - g.y, from.x - g.x) * 180 / .pi
        let s = ((Int((deg / 30).rounded()) % 12) + 12) % 12
        if s % 2 == 0 {
            return [center, vtx(s / 2), vtx(s / 2 + 1)]
        }
        func mid(_ a: Point, _ b: Point) -> Point { Point(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2) }
        let j = ((s + 1) / 2) % 6
        let v = g.cell[j]
        return [center, mid(g.cell[(j + 5) % 6], v), vtx(j), mid(v, g.cell[(j + 1) % 6])]
    }

    // MARK: - Walls

    private func drawWalls(context: GraphicsContext, transform: MapTransform) {
        for wall in walls where wall.count == 2 {
            guard let (a, b) = sharedEdge(wall[0], wall[1]) else { continue }
            var path = Path()
            path.move(to: transform.point(a))
            path.addLine(to: transform.point(b))
            context.stroke(path, with: .color(Color(red: 0.17, green: 0.15, blue: 0.13)), style: StrokeStyle(lineWidth: 6, lineCap: .round))
            context.stroke(path, with: .color(Color(red: 0.60, green: 0.56, blue: 0.51)), style: StrokeStyle(lineWidth: 4, lineCap: .round))
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
