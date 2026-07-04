import SwiftUI

/// Draws terrain overlays for mountain/forest/marsh/desert hexes. The web
/// app tiles small SVG `<pattern>` motifs (peaks, trees, dunes, reeds)
/// across each hex; here we draw a handful of the same motifs directly
/// scaled to the hex's bounding box rather than true infinite tiling —
/// visually equivalent at map scale, much cheaper to draw, and avoids
/// needing a tiling/clip abstraction Canvas doesn't offer for free.
enum TerrainPatterns {
    static func draw(terrain: Terrain, in context: GraphicsContext, hexPath: Path, bounds: CGRect) {
        guard terrain != .plain else { return }
        context.drawLayer { layer in
            layer.clip(to: hexPath)
            switch terrain {
            case .mountain: drawMountain(in: layer, bounds: bounds)
            case .forest: drawForest(in: layer, bounds: bounds)
            case .desert: drawDesert(in: layer, bounds: bounds)
            case .marsh: drawMarsh(in: layer, bounds: bounds)
            case .plain: break
            }
        }
    }

    private static func drawMountain(in ctx: GraphicsContext, bounds: CGRect) {
        let w = bounds.width, h = bounds.height
        let peaks: [(CGFloat, CGFloat)] = [(0.32, 0.62), (0.62, 0.68), (0.5, 0.38)]
        for (px, py) in peaks {
            let apex = CGPoint(x: bounds.minX + w * px, y: bounds.minY + h * py)
            let baseW = w * 0.32
            let baseY = apex.y + h * 0.28
            var tri = Path()
            tri.move(to: CGPoint(x: apex.x - baseW / 2, y: baseY))
            tri.addLine(to: apex)
            tri.addLine(to: CGPoint(x: apex.x + baseW / 2, y: baseY))
            tri.closeSubpath()
            ctx.fill(tri, with: .color(.black.opacity(0.28)))

            var cap = Path()
            let capW = baseW * 0.3
            let capY = apex.y + h * 0.09
            cap.move(to: apex)
            cap.addLine(to: CGPoint(x: apex.x - capW / 2, y: capY))
            cap.addLine(to: CGPoint(x: apex.x + capW / 2, y: capY))
            cap.closeSubpath()
            ctx.fill(cap, with: .color(.white.opacity(0.35)))
        }
    }

    private static func drawForest(in ctx: GraphicsContext, bounds: CGRect) {
        let w = bounds.width, h = bounds.height
        let trees: [(CGFloat, CGFloat, CGFloat)] = [(0.32, 0.55, 1.0), (0.62, 0.42, 0.85), (0.48, 0.68, 0.75)]
        for (tx, ty, s) in trees {
            let base = CGPoint(x: bounds.minX + w * tx, y: bounds.minY + h * ty)
            let trunkW = w * 0.045 * s
            let trunkH = h * 0.22 * s
            let trunkRect = CGRect(x: base.x - trunkW / 2, y: base.y, width: trunkW, height: trunkH)
            ctx.fill(Path(trunkRect), with: .color(Color(red: 0.29, green: 0.18, blue: 0.09).opacity(0.6)))

            let crownR = w * 0.16 * s
            let crownCenter = CGPoint(x: base.x, y: base.y - crownR * 0.3)
            let crown = Path(ellipseIn: CGRect(x: crownCenter.x - crownR, y: crownCenter.y - crownR, width: crownR * 2, height: crownR * 2))
            ctx.fill(crown, with: .color(.black.opacity(0.28)))

            let hlR = crownR * 0.3
            let hlCenter = CGPoint(x: crownCenter.x - crownR * 0.15, y: crownCenter.y - crownR * 0.2)
            let hl = Path(ellipseIn: CGRect(x: hlCenter.x - hlR, y: hlCenter.y - hlR, width: hlR * 2, height: hlR * 2))
            ctx.fill(hl, with: .color(Color(red: 0.36, green: 0.72, blue: 0.36).opacity(0.32)))
        }
    }

    private static func drawDesert(in ctx: GraphicsContext, bounds: CGRect) {
        ctx.fill(Path(bounds), with: .color(Color(red: 0.91, green: 0.75, blue: 0.48).opacity(0.32)))
        let w = bounds.width, h = bounds.height
        func dune(atYFrac yFrac: CGFloat, opacity: Double, lineWidth: CGFloat) -> Path {
            var p = Path()
            let y = bounds.minY + h * yFrac
            let amp = h * 0.08
            p.move(to: CGPoint(x: bounds.minX - w * 0.1, y: y + amp))
            p.addQuadCurve(
                to: CGPoint(x: bounds.minX + w * 0.5, y: y + amp),
                control: CGPoint(x: bounds.minX + w * 0.2, y: y - amp)
            )
            p.addQuadCurve(
                to: CGPoint(x: bounds.minX + w * 1.1, y: y + amp),
                control: CGPoint(x: bounds.minX + w * 0.8, y: y - amp)
            )
            return p
        }
        ctx.stroke(dune(atYFrac: 0.68, opacity: 0.55, lineWidth: 1.3),
                    with: .color(Color(red: 0.54, green: 0.35, blue: 0.13).opacity(0.55)),
                    style: StrokeStyle(lineWidth: 1.3, lineCap: .round))
        ctx.stroke(dune(atYFrac: 0.32, opacity: 0.4, lineWidth: 1.1),
                    with: .color(Color(red: 0.54, green: 0.35, blue: 0.13).opacity(0.4)),
                    style: StrokeStyle(lineWidth: 1.1, lineCap: .round))
        let pebbles: [(CGFloat, CGFloat, CGFloat)] = [(0.18, 0.84, 1.1), (0.68, 0.47, 1.0), (0.82, 0.9, 1.1)]
        for (px, py, r) in pebbles {
            let c = CGPoint(x: bounds.minX + w * px, y: bounds.minY + h * py)
            let dot = Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
            ctx.fill(dot, with: .color(Color(red: 0.36, green: 0.23, blue: 0.07).opacity(0.6)))
        }
    }

    private static func drawMarsh(in ctx: GraphicsContext, bounds: CGRect) {
        let w = bounds.width, h = bounds.height
        func ripple(yFrac: CGFloat) -> Path {
            var p = Path()
            let y = bounds.minY + h * yFrac
            let amp = h * 0.06
            p.move(to: CGPoint(x: bounds.minX + w * 0.1, y: y))
            p.addQuadCurve(to: CGPoint(x: bounds.minX + w * 0.4, y: y), control: CGPoint(x: bounds.minX + w * 0.25, y: y - amp))
            p.addQuadCurve(to: CGPoint(x: bounds.minX + w * 0.7, y: y), control: CGPoint(x: bounds.minX + w * 0.55, y: y + amp))
            return p
        }
        ctx.stroke(ripple(yFrac: 0.3), with: .color(.black.opacity(0.35)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
        ctx.stroke(ripple(yFrac: 0.65), with: .color(.black.opacity(0.35)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))

        let reedColor = Color(red: 0.23, green: 0.35, blue: 0.23).opacity(0.55)
        let reedTufts: [(CGFloat, CGFloat)] = [(0.18, 0.45), (0.26, 0.45), (0.6, 0.82), (0.68, 0.82)]
        for (rx, ry) in reedTufts {
            var line = Path()
            let x = bounds.minX + w * rx
            let yBottom = bounds.minY + h * ry
            let yTop = yBottom - h * 0.24
            line.move(to: CGPoint(x: x, y: yBottom))
            line.addLine(to: CGPoint(x: x, y: yTop))
            ctx.stroke(line, with: .color(reedColor), style: StrokeStyle(lineWidth: 1.4))
        }
    }
}
