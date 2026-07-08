import SwiftUI

enum MapColors {
    static let attack = Color(red: 1.0, green: 0.88, blue: 0.29)   // #ffe14a
    static let move = Color(red: 0.5, green: 0.81, blue: 1.0)      // #7fcfff
    static let ferry = Color(red: 0.78, green: 0.56, blue: 1.0)    // #c68fff
    static let invade = Color(red: 1.0, green: 0.42, blue: 0.42)   // #ff6a6a
    static let artillery = Color(red: 1.0, green: 0.54, blue: 0.0) // #ff8a00
    static let invalid = Color.white
    static let selectedFrom = Color.white
    static let selectedTo = Color(red: 1.0, green: 1.0, blue: 0.5) // #ffff7f
    static let cityGold = Color(red: 1.0, green: 0.88, blue: 0.29)
    static let fortCyan = Color(red: 0.5, green: 0.81, blue: 1.0)
    static let outline = Color(red: 0.04, green: 0.08, blue: 0.13) // #0a1420
    static let islandLabel = Color(red: 0.88, green: 0.94, blue: 1.0)
    static let waterLabel = Color(red: 0.48, green: 0.67, blue: 0.8)
}

enum DragActionKind {
    case attack, move, ferry, invasion, artillery, invalid

    var color: Color {
        switch self {
        case .attack: MapColors.attack
        case .move: MapColors.move
        case .ferry: MapColors.ferry
        case .invasion: MapColors.invade
        case .artillery: MapColors.artillery
        case .invalid: MapColors.invalid
        }
    }
}

/// Ported from `src/lib/map.ts`'s `seaLanePath`: a quadratic curve between
/// two hex centers, bowed off to one side, that (a) tries a handful of
/// candidate bows to find one whose curve doesn't cut across a third hex's
/// land, and (b) even then only strokes the sampled points that land in open
/// water — a lane's own first/last stretch always overlaps its two endpoint
/// hexes, and a card-opened lane hugging a coastline can still clip land in
/// the middle despite the widest candidate bow. Returns possibly-disjoint
/// subpaths (pen lifted over any land sample) rather than one continuous
/// curve, so lanes never paint over a hex fill regardless of draw order.
func seaLanePath(a: Int, b: Int, map: GameMap, transform: MapTransform) -> Path {
    guard map.grids.indices.contains(a), map.grids.indices.contains(b) else { return Path() }
    let g1 = map.grids[a], g2 = map.grids[b]
    let midX = (g1.x + g2.x) / 2, midY = (g1.y + g2.y) / 2
    let dx = g2.x - g1.x, dy = g2.y - g1.y
    let len = max(1, (dx * dx + dy * dy).squareRoot())
    let perpX = -dy / len, perpY = dx / len
    let defaultSide: Double = (a + b) % 2 == 0 ? 1 : -1

    func control(side: Double, arc: Double) -> Point {
        Point(x: midX + perpX * arc * side, y: midY + perpY * arc * side)
    }
    func quadPoint(_ c: Point, _ t: Double) -> Point {
        let omt = 1 - t
        return Point(
            x: omt * omt * g1.x + 2 * omt * t * c.x + t * t * g2.x,
            y: omt * omt * g1.y + 2 * omt * t * c.y + t * t * g2.y
        )
    }
    func clearsLand(_ c: Point) -> Bool {
        let steps = 14
        for i in 0...steps {
            let t = 0.15 + 0.7 * Double(i) / Double(steps)
            let p = quadPoint(c, t)
            for g in map.grids where g.id != a && g.id != b {
                if pointInPolygon(p, polygon: g.cell) { return false }
            }
        }
        return true
    }

    let defaultArc = min(22, len * 0.06)
    var chosen = control(side: defaultSide, arc: defaultArc)
    var candidates: [(Double, Double)] = [(defaultSide, defaultArc), (-defaultSide, defaultArc)]
    for f in [0.15, 0.28, 0.45] {
        let arc = min(130, len * f)
        candidates.append((defaultSide, arc))
        candidates.append((-defaultSide, arc))
    }
    for (side, arc) in candidates {
        let c = control(side: side, arc: arc)
        if clearsLand(c) { chosen = c; break }
    }

    func overLand(_ p: Point) -> Bool {
        for g in map.grids where pointInPolygon(p, polygon: g.cell) { return true }
        return false
    }

    let steps = 28
    var path = Path()
    var penDown = false
    var anyStroked = false
    for i in 0...steps {
        let p = quadPoint(chosen, Double(i) / Double(steps))
        if overLand(p) {
            penDown = false
            continue
        }
        let vp = transform.point(p)
        if penDown {
            path.addLine(to: vp)
        } else {
            path.move(to: vp)
        }
        penDown = true
        anyStroked = true
    }
    // Degenerate (everything sampled over land): keep the old full curve
    // rather than render nothing at all.
    if !anyStroked {
        var fallback = Path()
        fallback.move(to: transform.point(Point(x: g1.x, y: g1.y)))
        fallback.addQuadCurve(to: transform.point(Point(x: g2.x, y: g2.y)), control: transform.point(chosen))
        return fallback
    }
    return path
}

/// Straight line + triangular arrowhead from source to the live drag point,
/// matching the web app's drag-to-attack/move arrow.
func drawDragArrow(in context: GraphicsContext, from: CGPoint, to: CGPoint, color: Color, solid: Bool) {
    let dx = to.x - from.x, dy = to.y - from.y
    let len = max(1, (dx * dx + dy * dy).squareRoot())
    let ux = dx / len, uy = dy / len
    let angle = atan2(dy, dx)

    var line = Path()
    line.move(to: from)
    line.addLine(to: to)
    let style = StrokeStyle(
        lineWidth: 4,
        lineCap: .round,
        dash: solid ? [] : [8, 6]
    )
    context.stroke(line, with: .color(color), style: style)

    let arrowLen: CGFloat = 14
    let arrowHalfWidth: CGFloat = 7
    let tip = to
    let backCenter = CGPoint(x: tip.x - ux * arrowLen, y: tip.y - uy * arrowLen)
    let perp = CGPoint(x: -uy, y: ux)
    var arrow = Path()
    arrow.move(to: tip)
    arrow.addLine(to: CGPoint(x: backCenter.x + perp.x * arrowHalfWidth, y: backCenter.y + perp.y * arrowHalfWidth))
    arrow.addLine(to: CGPoint(x: backCenter.x - perp.x * arrowHalfWidth, y: backCenter.y - perp.y * arrowHalfWidth))
    arrow.closeSubpath()
    context.fill(arrow, with: .color(color))
    _ = angle
}

/// Poor-man's text outline: draw the string offset in a ring underneath the
/// filled pass, since GraphicsContext can't stroke `Text` glyph paths
/// directly. Close enough at map scale to read as an outlined label.
func drawOutlinedLabel(
    _ text: String,
    in context: GraphicsContext,
    at point: CGPoint,
    font: Font,
    fillColor: Color,
    outlineColor: Color = MapColors.outline,
    outlineRadius: CGFloat = 1.2
) {
    let resolved = context.resolve(Text(text).font(font))
    let outlineOffsets: [(CGFloat, CGFloat)] = [
        (-outlineRadius, 0), (outlineRadius, 0), (0, -outlineRadius), (0, outlineRadius),
        (-outlineRadius, -outlineRadius), (outlineRadius, -outlineRadius),
        (-outlineRadius, outlineRadius), (outlineRadius, outlineRadius)
    ]
    var outlineResolved = resolved
    outlineResolved.shading = .color(outlineColor)
    for (dx, dy) in outlineOffsets {
        context.draw(outlineResolved, at: CGPoint(x: point.x + dx, y: point.y + dy))
    }
    var fillResolved = resolved
    fillResolved.shading = .color(fillColor)
    context.draw(fillResolved, at: point)
}
