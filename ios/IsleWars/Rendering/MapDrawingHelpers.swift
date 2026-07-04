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

/// `M ${g1.x} ${g1.y} Q ${cx} ${cy} ${g2.x} ${g2.y}` from +page.svelte's
/// `seaLanePath`: control point = segment midpoint offset by
/// `min(22, 0.06 * len)` along the unit perpendicular, side flipped by
/// `(a+b) % 2` parity.
func seaLanePath(a: Int, b: Int, map: GameMap, transform: MapTransform) -> Path {
    guard map.grids.indices.contains(a), map.grids.indices.contains(b) else { return Path() }
    let g1 = map.grids[a], g2 = map.grids[b]
    let midX = (g1.x + g2.x) / 2, midY = (g1.y + g2.y) / 2
    let dx = g2.x - g1.x, dy = g2.y - g1.y
    let len = max(1, (dx * dx + dy * dy).squareRoot())
    let perpX = -dy / len, perpY = dx / len
    let arc = min(22, len * 0.06)
    let side: Double = (a + b) % 2 == 0 ? 1 : -1
    let cx = midX + perpX * arc * side
    let cy = midY + perpY * arc * side
    var path = Path()
    path.move(to: transform.point(Point(x: g1.x, y: g1.y)))
    path.addQuadCurve(
        to: transform.point(Point(x: g2.x, y: g2.y)),
        control: transform.point(Point(x: cx, y: cy))
    )
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
