import Foundation

/// Ports the web app's `riverPolylines` derived value (+page.svelte) into
/// Swift: walks hex perimeters between river-edge faces to build continuous
/// polylines from the raw `map.rivers: [gridIdA, gridIdB]` pairs. Computed
/// once per map and cached by the caller — not cheap enough to redo per
/// frame, but trivial for a map this size (rivers are short, a handful of
/// hexes each).
enum RiverGeometry {
    static func polylines(for map: GameMap) -> [[Point]] {
        let grids = map.grids
        guard grids.indices.count == grids.count else { return [] }

        func vkey(_ p: Point) -> String {
            "\(Int((p.x * 10).rounded())),\(Int((p.y * 10).rounded()))"
        }

        var vertLandCount: [String: Int] = [:]
        for g in grids {
            for v in g.cell {
                vertLandCount[vkey(v), default: 0] += 1
            }
        }
        func isInland(_ p: Point) -> Bool {
            (vertLandCount[vkey(p)] ?? 0) >= 3
        }

        func sharedFace(_ a: Int, _ b: Int) -> [Point] {
            guard grids.indices.contains(a), grids.indices.contains(b) else { return [] }
            let bKeys = Set(grids[b].cell.map(vkey))
            return grids[a].cell.filter { bKeys.contains(vkey($0)) }
        }

        func arcThrough(_ h: Int, _ entry: Point, _ exit: Point) -> [Point] {
            guard grids.indices.contains(h) else { return [entry, exit] }
            let cell = grids[h].cell
            let n = cell.count
            guard n > 0,
                  let ei = cell.firstIndex(where: { vkey($0) == vkey(entry) }),
                  let xi = cell.firstIndex(where: { vkey($0) == vkey(exit) }) else {
                return [entry, exit]
            }
            func walk(_ dir: Int) -> [Int] {
                var seq = [ei]
                var c = ei
                var guardCount = 0
                while c != xi && guardCount < n + 1 {
                    c = ((c + dir) % n + n) % n
                    seq.append(c)
                    guardCount += 1
                }
                return seq
            }
            let seqPlus = walk(1)
            let seqMinus = walk(-1)
            func cost(_ seq: [Int]) -> Int {
                guard seq.count > 2 else { return seq.count }
                var coastal = 0
                for idx in seq[1..<(seq.count - 1)] where !isInland(cell[idx]) {
                    coastal += 1
                }
                return coastal * 1000 + seq.count
            }
            let chosen = cost(seqPlus) <= cost(seqMinus) ? seqPlus : seqMinus
            return chosen.map { cell[$0] }
        }

        var nbr: [Int: [Int]] = [:]
        for pair in map.rivers where pair.count == 2 {
            let a = pair[0], b = pair[1]
            nbr[a, default: []].append(b)
            nbr[b, default: []].append(a)
        }
        func ek(_ a: Int, _ b: Int) -> String { a < b ? "\(a)-\(b)" : "\(b)-\(a)" }

        var usedEdges = Set<String>()
        var chains: [[Int]] = []
        let nodesSorted = nbr.keys.sorted { (nbr[$0]?.count ?? 0) < (nbr[$1]?.count ?? 0) }
        for start in nodesSorted {
            guard let neighbors = nbr[start] else { continue }
            for firstNext in neighbors {
                let e0 = ek(start, firstNext)
                if usedEdges.contains(e0) { continue }
                usedEdges.insert(e0)
                var chain = [start, firstNext]
                var prev = start
                var cur = firstNext
                while true {
                    guard let curNeighbors = nbr[cur],
                          let next = curNeighbors.first(where: { $0 != prev && !usedEdges.contains(ek(cur, $0)) })
                    else { break }
                    usedEdges.insert(ek(cur, next))
                    chain.append(next)
                    prev = cur
                    cur = next
                }
                chains.append(chain)
            }
        }

        var polylines: [[Point]] = []
        for chain in chains {
            guard chain.count >= 2 else { continue }
            var faces: [[Point]] = []
            var validChain = true
            for i in 0..<(chain.count - 1) {
                let face = sharedFace(chain[i], chain[i + 1])
                guard face.count == 2 else { validChain = false; break }
                faces.append(face)
            }
            guard validChain, !faces.isEmpty else { continue }

            let numFaces = faces.count
            let numInterior = max(chain.count - 2, 0)

            func totalArcLength(mask: Int) -> Int {
                guard numInterior > 0 else { return 0 }
                var sum = 0
                for j in 1...(chain.count - 2) {
                    let inIdx = j - 1, outIdx = j
                    let entryBit = (mask >> inIdx) & 1
                    let exitBit = (mask >> outIdx) & 1
                    let entryPt = faces[inIdx][entryBit]
                    let exitPt = faces[outIdx][exitBit]
                    sum += arcThrough(chain[j], entryPt, exitPt).count
                }
                return sum
            }

            var bestMask = 0
            var bestCost = Int.max
            let combos = 1 << numFaces
            // Rivers are short (a handful of faces); brute force is fine.
            for mask in 0..<combos {
                let cost = totalArcLength(mask: mask)
                if cost < bestCost {
                    bestCost = cost
                    bestMask = mask
                }
            }

            var points: [Point] = []
            let firstBit = bestMask & 1
            points.append(faces[0][1 - firstBit])
            points.append(faces[0][firstBit])

            if numInterior > 0 {
                for j in 1...(chain.count - 2) {
                    let inIdx = j - 1, outIdx = j
                    let entryBit = (bestMask >> inIdx) & 1
                    let exitBit = (bestMask >> outIdx) & 1
                    let entryPt = faces[inIdx][entryBit]
                    let exitPt = faces[outIdx][exitBit]
                    let arc = arcThrough(chain[j], entryPt, exitPt)
                    points.append(contentsOf: arc.dropFirst())
                }
            }

            let lastIdx = faces.count - 1
            let lastBit = (bestMask >> lastIdx) & 1
            points.append(faces[lastIdx][1 - lastBit])

            polylines.append(points)
        }
        return polylines
    }
}
