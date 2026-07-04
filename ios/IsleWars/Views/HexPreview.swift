import SwiftUI

/// A single hexagon rendered the same way the map draws its territories —
/// owner-colored fill, dark outline, terrain overlay, and the army/prod/fort
/// badge — for use inside modals. Mirrors the web app's shared `hexBadge` /
/// `hexTerrain` snippets (used by both the map SVG and the attack/quantity
/// modals) so a hex reads identically everywhere. Drawn in the web modal's
/// `200×180` viewBox space (center `(100,90)`, circumradius `62`, badge
/// scale `1.4`) and scaled to fit the view's frame.
struct HexPreview: View {
    let terrain: Terrain
    let owner: Player?
    let armies: Int
    let production: Bool
    let fortified: Bool
    var fillOverride: Color? = nil

    /// `#556` — the web app's fill for neutral/unowned hexes in modal previews.
    private static let neutralFill = Color(hex: 0x555566)

    var body: some View {
        Canvas { context, size in
            let s = min(size.width / 200, size.height / 180)
            let ox = (size.width - 200 * s) / 2
            let oy = (size.height - 180 * s) / 2
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }

            let cx: CGFloat = 100, cy: CGFloat = 90, hr: CGFloat = 62

            var hex = Path()
            for i in 0..<6 {
                let a = CGFloat.pi / 3 * CGFloat(i) - .pi / 2
                let pt = p(cx + hr * cos(a), cy + hr * sin(a))
                if i == 0 { hex.move(to: pt) } else { hex.addLine(to: pt) }
            }
            hex.closeSubpath()

            let fill = fillOverride ?? owner?.color ?? Self.neutralFill
            context.fill(hex, with: .color(fill))
            TerrainPatterns.draw(terrain: terrain, in: context, hexPath: hex, bounds: hex.boundingRect)
            context.stroke(hex, with: .color(MapColors.outline), lineWidth: 2 * s)

            // Badge, at the web modal's scale=1.4.
            let bs = 1.4 * s
            let center = p(cx, cy)
            if fortified {
                let r1 = 30 * bs, r2 = 34 * bs
                context.stroke(
                    Path(ellipseIn: CGRect(x: center.x - r1, y: center.y - r1, width: r1 * 2, height: r1 * 2)),
                    with: .color(MapColors.fortCyan.opacity(0.95)),
                    style: StrokeStyle(lineWidth: 3 * bs, dash: [6 * bs, 4 * bs])
                )
                context.stroke(
                    Path(ellipseIn: CGRect(x: center.x - r2, y: center.y - r2, width: r2 * 2, height: r2 * 2)),
                    with: .color(MapColors.fortCyan.opacity(0.55)),
                    lineWidth: 1.5 * bs
                )
            }

            let badgeR = 20 * bs
            let ring: Color = fortified ? MapColors.fortCyan : (production ? MapColors.cityGold : .white)
            let ringW: CGFloat = (fortified ? 3 : production ? 2.5 : 1.5) * bs
            let badgeRect = CGRect(x: center.x - badgeR, y: center.y - badgeR, width: badgeR * 2, height: badgeR * 2)
            context.fill(Path(ellipseIn: badgeRect), with: .color(.black.opacity(0.6)))
            context.stroke(Path(ellipseIn: badgeRect), with: .color(ring), lineWidth: ringW)
            context.draw(
                Text("\(armies)").font(.system(size: 20 * bs, weight: .bold, design: .monospaced)).foregroundStyle(.white),
                at: center
            )
            if production {
                context.draw(
                    Text("★").font(.system(size: 18 * bs)).foregroundStyle(MapColors.cityGold),
                    at: CGPoint(x: center.x + 20 * bs, y: center.y - 15 * bs)
                )
            }
        }
        .aspectRatio(200.0 / 180.0, contentMode: .fit)
    }
}

extension HexPreview {
    /// Build a preview straight from game state for a grid, with optional
    /// overrides for the shown army count and fill (used to preview the
    /// post-action result and to tint a soon-to-be-captured neutral hex).
    init(state: GameState, gridId: Int, armiesOverride: Int? = nil, fillOverride: Color? = nil) {
        let grid = state.map.grids[gridId]
        let st = state.states[gridId]
        self.init(
            terrain: grid.terrain,
            owner: st.owner,
            armies: armiesOverride ?? st.armies,
            production: grid.production,
            fortified: st.fortified == true,
            fillOverride: fillOverride
        )
    }
}
