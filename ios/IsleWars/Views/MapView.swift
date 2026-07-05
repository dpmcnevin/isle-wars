import SwiftUI

/// Milestone 3: full visual fidelity — terrain patterns, rivers, sea lanes,
/// army/fortification/production badges, island/city/water labels, plus a
/// drag-to-attack/move gesture with a color-coded arrow and
/// candidate/target hex highlighting. Ferry/invasion/artillery targeting
/// still goes through tap-to-select (`onTapHex` dispatches to `selectGrid`
/// for any non-placing phase) rather than a drag arrow — a deliberate scope
/// trim; those flows are card-triggered and rarer than attack/move.
struct MapView: View {
    let state: GameState
    let onTapHex: (Int) -> Void
    let onDragAttack: (Int, Int) -> Void
    let onDragMove: (Int, Int) -> Void
    /// Drag release during a Ferry card's `ferry_from` phase — mirrors the
    /// web's purple ferry drag arrow. Connectivity is validated by the engine
    /// on drop rather than pre-highlighted (no cheap Swift-side reachability).
    var onDragFerry: (Int, Int) -> Void = { _, _ in }
    /// Keeps the map geometry clear of the screen edges and the floating HUD
    /// bars; the water background still fills the whole view.
    var contentInsets: EdgeInsets = EdgeInsets()

    @State private var dragStart: CGPoint?
    @State private var isDragArmed = false
    @State private var dragFrom: Int?
    @State private var dragCurrentPoint: CGPoint?
    @State private var dragHoverTarget: Int?

    // Hex inspector (replicates the web hover tooltip). Driven by pointer/Pencil
    // hover via `onContinuousHover` and by a touch long-press "peek".
    @State private var infoGrid: Int?
    @State private var infoPoint: CGPoint = .zero
    @State private var suppressTapAfterInfo = false

    private var map: GameMap { state.map }
    private var states: [GridState] { state.states }

    private var riverPolylines: [[Point]] {
        RiverCache.shared.polylines(for: map)
    }

    var body: some View {
        GeometryReader { geo in
            let transform = MapTransform(viewBox: map.viewBox, containerSize: geo.size, insets: contentInsets)

            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    drawWater(context: context, size: geo.size, transform: transform)
                    drawSeaLanes(context: context, transform: transform)
                    drawTerritories(context: context, transform: transform)
                    drawRivers(context: context, transform: transform)
                    drawBadgesAndLabels(context: context, transform: transform)
                    drawDragArrowIfNeeded(context: context, transform: transform)
                }
                .contentShape(Rectangle())
                .gesture(dragGesture(transform: transform))
                .simultaneousGesture(infoPressGesture(transform: transform))
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let location):
                        infoGrid = hexAt(location, transform: transform)
                        infoPoint = location
                    case .ended:
                        infoGrid = nil
                    }
                }

                if let id = infoGrid, let info = HexInfo.make(gridId: id, map: map, states: states) {
                    HexInfoCard(info: info)
                        .position(infoCardPosition(for: infoPoint, in: geo.size))
                        .allowsHitTesting(false)
                }
            }
        }
    }

    /// The hex whose polygon contains a view-space point, if any.
    private func hexAt(_ viewPoint: CGPoint, transform: MapTransform) -> Int? {
        let mapPoint = transform.reverse(viewPoint)
        return map.grids.first { pointInPolygon(mapPoint, polygon: $0.cell) }?.id
    }

    /// Places the info card near the pointer/finger, clamped to stay on-screen.
    private func infoCardPosition(for point: CGPoint, in size: CGSize) -> CGPoint {
        let cardW: CGFloat = 240, cardH: CGFloat = 190
        let x = min(max(point.x + cardW / 2 + 18, cardW / 2 + 8), size.width - cardW / 2 - 8)
        let y = min(max(point.y, cardH / 2 + 8), size.height - cardH / 2 - 8)
        return CGPoint(x: x, y: y)
    }

    /// Touch "peek": hold on a hex to show its info card, dismissed on release.
    /// Runs simultaneously with the pan/attack drag — a stationary hold shows
    /// info (and suppresses the release tap) while movement instead arms the
    /// attack/move drag, so the two don't fight.
    private func infoPressGesture(transform: MapTransform) -> some Gesture {
        LongPressGesture(minimumDuration: 0.3)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .onChanged { value in
                if case .second(true, let drag?) = value {
                    infoGrid = hexAt(drag.location, transform: transform)
                    infoPoint = drag.location
                    suppressTapAfterInfo = true
                }
            }
            .onEnded { _ in
                infoGrid = nil
            }
    }

    // MARK: - Drawing passes

    private func drawWater(context: GraphicsContext, size: CGSize, transform: MapTransform) {
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(red: 0.09, green: 0.22, blue: 0.35)))
        for hex in map.waterHexes {
            context.stroke(transform.polygonPath(hex), with: .color(.white.opacity(0.05)), lineWidth: 1)
        }
    }

    private func drawSeaLanes(context: GraphicsContext, transform: MapTransform) {
        for lane in map.seaLanes where lane.count == 2 {
            let path = seaLanePath(a: lane[0], b: lane[1], map: map, transform: transform)
            context.stroke(
                path,
                with: .color(Color(red: 0.63, green: 0.85, blue: 1.0).opacity(0.85)),
                style: StrokeStyle(lineWidth: 2.5, dash: [6, 4])
            )
        }
    }

    private func drawTerritories(context: GraphicsContext, transform: MapTransform) {
        let attackCandidates = attackCandidateSet
        let moveCandidates = moveCandidateSet

        for grid in map.grids {
            let path = transform.polygonPath(grid.cell)
            let owner = states.indices.contains(grid.id) ? states[grid.id].owner : nil
            let fillColor = owner?.color ?? Color(white: 0.55)
            context.fill(path, with: .color(fillColor))

            TerrainPatterns.draw(terrain: grid.terrain, in: context, hexPath: path, bounds: path.boundingRect)

            let style = strokeStyle(
                for: grid.id,
                attackCandidates: attackCandidates,
                moveCandidates: moveCandidates
            )
            if let glow = style.glow {
                // Mirrors the web app's `drop-shadow` on highlighted hexes so
                // selectable/selected/drag-target outlines read as glowing.
                context.drawLayer { layer in
                    layer.addFilter(.shadow(color: glow, radius: style.glowRadius))
                    layer.stroke(path, with: .color(style.color), lineWidth: style.width)
                }
            }
            context.stroke(path, with: .color(style.color), lineWidth: style.width)
        }
    }

    private struct HexStroke {
        var color: Color
        var width: CGFloat
        var glow: Color?
        var glowRadius: CGFloat = 6
    }

    private func strokeStyle(for gridId: Int, attackCandidates: Set<Int>, moveCandidates: Set<Int>) -> HexStroke {
        if gridId == dragFrom {
            return HexStroke(color: .white, width: 4, glow: .white, glowRadius: 8)
        }
        if let hover = dragHoverTarget, hover == gridId {
            if attackCandidates.contains(gridId) { return HexStroke(color: MapColors.attack, width: 5, glow: MapColors.attack, glowRadius: 12) }
            if moveCandidates.contains(gridId) { return HexStroke(color: MapColors.move, width: 5, glow: MapColors.move, glowRadius: 12) }
        }
        if attackCandidates.contains(gridId) { return HexStroke(color: MapColors.attack, width: 3, glow: MapColors.attack.opacity(0.7), glowRadius: 6) }
        if moveCandidates.contains(gridId) { return HexStroke(color: MapColors.move, width: 3, glow: MapColors.move.opacity(0.7), glowRadius: 6) }
        if gridId == state.selectedFrom { return HexStroke(color: MapColors.selectedFrom, width: 4, glow: .white, glowRadius: 8) }
        if gridId == state.selectedTo { return HexStroke(color: MapColors.selectedTo, width: 4, glow: MapColors.selectedTo, glowRadius: 8) }
        if isSelectable(gridId) {
            // The player's own actionable territories, highlighted the way the
            // web app's `.territory.selectable` white stroke + glow does.
            return HexStroke(color: .white, width: 3, glow: .white.opacity(0.65), glowRadius: 4)
        }
        return HexStroke(color: MapColors.outline, width: 2, glow: nil)
    }

    /// Which hexes the current human player can currently act on, matching the
    /// web app's `isSelectable`. Drives the white "selectable" glow. The rarer
    /// connect-based card `*_to` phases (ferry/invasion/artillery) fall through
    /// to no highlight rather than reimplementing their reachability helpers.
    private func isSelectable(_ id: Int) -> Bool {
        guard state.current == .human,
              states.indices.contains(id), map.grids.indices.contains(id) else { return false }
        let st = states[id]
        let owner = st.owner
        let armies = st.armies
        let from = state.selectedFrom
        let grid = map.grids[id]
        func adjToFrom() -> Bool {
            guard let from, map.adj.indices.contains(from) else { return false }
            return map.adj[from].contains(id)
        }
        switch state.phase {
        case .placing:
            return owner == .human
        case .attackSelectFrom, .moveSelectFrom, .airFrom, .invasionFrom:
            return owner == .human && armies >= 2
        case .attackSelectTo:
            return from != nil && adjToFrom() && owner != .human
        case .moveSelectTo:
            return from != nil && adjToFrom() && owner == .human
        case .airTo:
            return owner == .human && id != from
        case .bombSelect, .sabotageSelect:
            return owner != nil && owner != .human
        case .reinforceSelect, .fortifySelect, .rampartSelect, .ferryFrom:
            return owner == .human
        case .ferryTo:
            return from != nil && owner == .human && id != from
        case .artilleryFrom:
            return owner == .human && armies >= 2 && grid.production
        case .deforestSelect:
            return grid.terrain == .forest
        case .oasisSelect:
            return grid.terrain == .desert && owner == state.current
        case .stormFrom:
            return map.seaLanes.contains { $0.contains(id) }
        case .stormTo:
            guard let from else { return false }
            return map.seaLanes.contains { $0.count == 2 && (($0[0] == from && $0[1] == id) || ($0[0] == id && $0[1] == from)) }
        default:
            return false
        }
    }

    private func drawRivers(context: GraphicsContext, transform: MapTransform) {
        guard !riverPolylines.isEmpty else { return }
        let layers: [(Color, CGFloat)] = [
            (Color(red: 0.04, green: 0.18, blue: 0.36), 14),
            (Color(red: 0.24, green: 0.63, blue: 0.88), 9),
            (Color(red: 0.88, green: 0.95, blue: 1.0), 3)
        ]
        // Soft glow pass (approximates the SVG feGaussianBlur+feMerge behind
        // the sharp lines) then a crisp pass on top.
        context.drawLayer { layer in
            layer.addFilter(.blur(radius: 2.5))
            for pts in riverPolylines {
                let path = transform.polylinePath(pts)
                for (color, width) in layers {
                    layer.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
                }
            }
        }
        for pts in riverPolylines {
            let path = transform.polylinePath(pts)
            for (color, width) in layers {
                context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
            }
        }
    }

    private func drawBadgesAndLabels(context: GraphicsContext, transform: MapTransform) {
        for grid in map.grids {
            guard states.indices.contains(grid.id) else { continue }
            let st = states[grid.id]
            let center = transform.point(grid.cellCenter)
            // Badge/font constants below (20, 30, 34, 14pt, etc.) are already
            // in "map-space units" matching the web app's scale=1 convention
            // (hex circumradius is 70 map units there too) — transform.scale
            // is exactly the map-to-view-pixel factor, so no extra divisor
            // belongs here. (A stray "/ 3.0" here previously shrank every
            // badge/label 3x, which is why army-count numbers were reading
            // as invisible dots.)
            let scale: CGFloat = transform.scale

            if st.fortified == true {
                let fortR1 = 34 * scale, fortR2 = 38 * scale
                context.stroke(
                    Path(ellipseIn: CGRect(x: center.x - fortR1, y: center.y - fortR1, width: fortR1 * 2, height: fortR1 * 2)),
                    with: .color(MapColors.fortCyan.opacity(0.95)),
                    style: StrokeStyle(lineWidth: 3 * scale, dash: [6 * scale, 4 * scale])
                )
                context.stroke(
                    Path(ellipseIn: CGRect(x: center.x - fortR2, y: center.y - fortR2, width: fortR2 * 2, height: fortR2 * 2)),
                    with: .color(MapColors.fortCyan.opacity(0.55)),
                    lineWidth: 1.5 * scale
                )
            }

            if st.rampart == true {
                let rampR = (st.fortified == true ? 42 : 34) * scale
                context.stroke(
                    Path(ellipseIn: CGRect(x: center.x - rampR, y: center.y - rampR, width: rampR * 2, height: rampR * 2)),
                    with: .color(AppTheme.successBorder.opacity(0.85)),
                    lineWidth: 2 * scale
                )
            }

            let badgeR = 26 * scale
            let ringColor: Color = st.fortified == true ? MapColors.fortCyan : (grid.production ? MapColors.cityGold : .white)
            let ringWidth: CGFloat = (st.fortified == true ? 3 : grid.production ? 2.5 : 1.5) * scale
            context.fill(
                Path(ellipseIn: CGRect(x: center.x - badgeR, y: center.y - badgeR, width: badgeR * 2, height: badgeR * 2)),
                with: .color(.black.opacity(0.6))
            )
            context.stroke(
                Path(ellipseIn: CGRect(x: center.x - badgeR, y: center.y - badgeR, width: badgeR * 2, height: badgeR * 2)),
                with: .color(ringColor),
                lineWidth: ringWidth
            )
            context.draw(
                Text("\(st.armies)").font(.system(size: 19 * scale, weight: .bold, design: .monospaced)).foregroundStyle(.white),
                at: center
            )

            if st.fortified == true {
                context.draw(Text("🛡").font(.system(size: 13 * scale)), at: CGPoint(x: center.x - 24 * scale, y: center.y - 16 * scale))
            }
            if st.rampart == true {
                context.draw(Text("🧱").font(.system(size: 12 * scale)), at: CGPoint(x: center.x - 24 * scale, y: center.y + 18 * scale))
            }
            if grid.production {
                context.draw(Text("★").font(.system(size: 14 * scale)).foregroundStyle(MapColors.cityGold), at: CGPoint(x: center.x + 26 * scale, y: center.y - 17 * scale))
            }
            if let cityName = grid.cityName {
                drawOutlinedLabel(
                    cityName, in: context,
                    at: CGPoint(x: center.x, y: center.y + 38 * scale),
                    font: .system(size: 11 * max(scale, 0.6), weight: .bold).italic(),
                    fillColor: MapColors.cityGold
                )
            }
        }

        for island in map.islands {
            let labelPos = transform.point(island.labelPos)
            drawOutlinedLabel(
                island.name.uppercased(), in: context,
                at: CGPoint(x: labelPos.x, y: labelPos.y - 2),
                font: .system(size: 16, weight: .bold).italic(),
                fillColor: MapColors.islandLabel
            )
            drawOutlinedLabel(
                "+\(island.value)", in: context,
                at: CGPoint(x: labelPos.x, y: labelPos.y + 17),
                font: .system(size: 12, weight: .bold),
                fillColor: MapColors.cityGold
            )
        }

        for feature in map.waterFeatures {
            let center = transform.point(feature.center)
            drawOutlinedLabel(
                feature.name, in: context,
                at: CGPoint(x: center.x, y: center.y + 4),
                font: .system(size: 13).italic(),
                fillColor: MapColors.waterLabel,
                outlineRadius: 1.0
            )
        }
    }

    private func drawDragArrowIfNeeded(context: GraphicsContext, transform: MapTransform) {
        guard let from = dragFrom, let currentPoint = dragCurrentPoint,
              map.grids.indices.contains(from) else { return }
        let sourceCenter = transform.point(map.grids[from].cellCenter)
        let kind = dragActionKind(from: from, hover: dragHoverTarget)
        drawDragArrow(in: context, from: sourceCenter, to: currentPoint, color: kind.color, solid: kind != .invalid)
    }

    // MARK: - Drag gesture

    private var attackCandidateSet: Set<Int> {
        guard let from = dragFrom, map.adj.indices.contains(from) else { return [] }
        return Set(map.adj[from].filter { states.indices.contains($0) && states[$0].owner != state.current })
    }

    private var moveCandidateSet: Set<Int> {
        guard let from = dragFrom, map.adj.indices.contains(from) else { return [] }
        return Set(map.adj[from].filter { $0 != from && states.indices.contains($0) && states[$0].owner == state.current })
    }

    private func dragActionKind(from: Int, hover: Int?) -> DragActionKind {
        // Ferry crosses open water (non-adjacent), so it doesn't go through the
        // adjacency check — any of the player's other territories is a candidate
        // drop; the engine rejects unreachable ones on release.
        if state.phase == .ferryFrom {
            guard let hover, hover != from, states.indices.contains(hover),
                  states[hover].owner == state.current else { return .invalid }
            return .ferry
        }
        guard let hover, hover != from, map.adj.indices.contains(from), map.adj[from].contains(hover) else { return .invalid }
        guard states.indices.contains(hover) else { return .invalid }
        if states[hover].owner == state.current { return .move }
        return .attack
    }

    /// Whether a drag can start from this hex given the current phase — the
    /// `action` phase (attack/move) or a Ferry card's `ferry_from` phase.
    private func canDragFrom(_ gridId: Int) -> Bool {
        guard states.indices.contains(gridId), states[gridId].owner == state.current else { return false }
        return state.phase == .action || state.phase == .ferryFrom
    }

    private func dragGesture(transform: MapTransform) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if dragStart == nil { dragStart = value.startLocation }
                let dist = hypot(value.location.x - value.startLocation.x, value.location.y - value.startLocation.y)
                if !isDragArmed && dist > 10 {
                    isDragArmed = true
                    let startMapPoint = transform.reverse(value.startLocation)
                    if let grid = map.grids.first(where: { pointInPolygon(startMapPoint, polygon: $0.cell) }),
                       canDragFrom(grid.id) {
                        dragFrom = grid.id
                    }
                }
                if isDragArmed, dragFrom != nil {
                    dragCurrentPoint = value.location
                    let mapPoint = transform.reverse(value.location)
                    dragHoverTarget = map.grids.first(where: { pointInPolygon(mapPoint, polygon: $0.cell) })?.id
                }
            }
            .onEnded { value in
                let wasArmed = isDragArmed
                let from = dragFrom
                let to = dragHoverTarget
                let peeked = suppressTapAfterInfo
                dragStart = nil
                isDragArmed = false
                dragFrom = nil
                dragCurrentPoint = nil
                dragHoverTarget = nil
                suppressTapAfterInfo = false

                guard wasArmed, let from else {
                    // A long-press "peek" happened on this touch — consume it
                    // rather than treating the lift as a tap (select/place).
                    if peeked { return }
                    let mapPoint = transform.reverse(value.location)
                    if let grid = map.grids.first(where: { pointInPolygon(mapPoint, polygon: $0.cell) }) {
                        onTapHex(grid.id)
                    }
                    return
                }
                // Ferry: any of the player's other hexes is a candidate drop;
                // the engine validates reachability.
                if state.phase == .ferryFrom {
                    guard let to, to != from, states.indices.contains(to),
                          states[to].owner == state.current else { return }
                    onDragFerry(from, to)
                    return
                }
                guard let to, to != from, map.adj.indices.contains(from), map.adj[from].contains(to),
                      states.indices.contains(to) else { return }
                if states[to].owner == state.current {
                    onDragMove(from, to)
                } else {
                    onDragAttack(from, to)
                }
            }
    }
}

/// Caches the (fairly expensive-to-compute-once) river polyline geometry
/// per map so we don't redo the perimeter walk every redraw.
final class RiverCache: @unchecked Sendable {
    static let shared = RiverCache()
    private var cache: [Int: [[Point]]] = [:]
    private let lock = NSLock()

    func polylines(for map: GameMap) -> [[Point]] {
        let key = map.seed_
        lock.lock()
        defer { lock.unlock() }
        if let cached = cache[key] { return cached }
        let computed = RiverGeometry.polylines(for: map)
        cache[key] = computed
        return computed
    }
}

private extension GameMap {
    /// Cheap cache key: rivers/grids never change shape after generation,
    /// so hashing the river-pair list + grid count is a stable-enough
    /// fingerprint for this map instance.
    var seed_: Int {
        var hasher = Hasher()
        hasher.combine(grids.count)
        for r in rivers { hasher.combine(r) }
        return hasher.finalize()
    }
}

/// Maps between the game's fixed map coordinate space (`GameMap.viewBox`)
/// and the SwiftUI view's coordinate space, preserving aspect ratio
/// (letterboxed, like the web SVG's `viewBox` behavior).
struct MapTransform {
    let viewBox: ViewBox
    let containerSize: CGSize
    let scale: CGFloat
    let offset: CGPoint

    init(viewBox: ViewBox, containerSize: CGSize, insets: EdgeInsets = EdgeInsets()) {
        self.viewBox = viewBox
        self.containerSize = containerSize
        // Fit the map into the inset region (so hexes stay clear of the screen
        // edges and floating HUD) while the water still fills the full canvas.
        let availWidth = max(1, containerSize.width - insets.leading - insets.trailing)
        let availHeight = max(1, containerSize.height - insets.top - insets.bottom)
        let scale = min(availWidth / viewBox.w, availHeight / viewBox.h)
        self.scale = scale
        let renderedWidth = viewBox.w * scale
        let renderedHeight = viewBox.h * scale
        self.offset = CGPoint(
            x: insets.leading + (availWidth - renderedWidth) / 2,
            y: insets.top + (availHeight - renderedHeight) / 2
        )
    }

    func point(_ p: Point) -> CGPoint {
        CGPoint(
            x: (p.x - viewBox.x) * scale + offset.x,
            y: (p.y - viewBox.y) * scale + offset.y
        )
    }

    func reverse(_ viewPoint: CGPoint) -> Point {
        Point(
            x: (viewPoint.x - offset.x) / scale + viewBox.x,
            y: (viewPoint.y - offset.y) / scale + viewBox.y
        )
    }

    func polygonPath(_ points: [Point]) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: point(first))
        for p in points.dropFirst() {
            path.addLine(to: point(p))
        }
        path.closeSubpath()
        return path
    }

    func polylinePath(_ points: [Point]) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: point(first))
        for p in points.dropFirst() {
            path.addLine(to: point(p))
        }
        return path
    }
}

func pointInPolygon(_ point: Point, polygon: [Point]) -> Bool {
    var inside = false
    var j = polygon.count - 1
    for i in 0..<polygon.count {
        let pi = polygon[i]
        let pj = polygon[j]
        if (pi.y > point.y) != (pj.y > point.y),
           point.x < (pj.x - pi.x) * (point.y - pi.y) / (pj.y - pi.y) + pi.x {
            inside.toggle()
        }
        j = i
    }
    return inside
}

extension Grid {
    /// Centroid of the hex's 6 vertices, used for badge placement.
    var cellCenter: Point {
        let n = Double(cell.count)
        let sum = cell.reduce(Point(x: 0, y: 0)) { Point(x: $0.x + $1.x, y: $0.y + $1.y) }
        return Point(x: sum.x / n, y: sum.y / n)
    }
}
