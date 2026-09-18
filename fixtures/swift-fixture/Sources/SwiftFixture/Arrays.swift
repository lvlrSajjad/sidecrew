import Foundation

/// Array utilities. Every function returns a new array and never mutates its input.
public enum Arrays {
    /// `xs` split into runs of `size`; the last run is short when it does not divide evenly.
    public static func chunk<T>(_ xs: [T], size: Int) throws -> [[T]] {
        if size < 1 { throw RangeError("chunk size must be at least 1, got \(size)") }
        var out: [[T]] = []
        var i = 0
        while i < xs.count {
            out.append(Array(xs[i ..< min(i + size, xs.count)]))
            i += size
        }
        return out
    }

    /// `xs` with later duplicates dropped, first occurrence wins.
    public static func unique<T: Hashable>(_ xs: [T]) -> [T] {
        var seen: Set<T> = []
        var out: [T] = []
        for x in xs where !seen.contains(x) {
            seen.insert(x)
            out.append(x)
        }
        return out
    }

    /// Pairs up to the length of the shorter input.
    public static func zipShortest<A, B>(_ as_: [A], _ bs: [B]) -> [(A, B)] {
        var out: [(A, B)] = []
        var i = 0
        let limit = min(as_.count, bs.count)
        while i < limit {
            out.append((as_[i], bs[i]))
            i += 1
        }
        return out
    }

    /// `xs` rotated left by `by` positions; negative rotates right. An empty array is returned as-is.
    public static func rotate<T>(_ xs: [T], by: Int) -> [T] {
        if xs.isEmpty { return [] }
        var offset = by % xs.count
        if offset < 0 { offset += xs.count }
        return Array(xs[offset...]) + Array(xs[..<offset])
    }

    /// The longest leading run of `xs` for which `predicate` holds.
    public static func takeWhile<T>(_ xs: [T], _ predicate: (T, Int) -> Bool) -> [T] {
        var out: [T] = []
        var i = 0
        while i < xs.count {
            if !predicate(xs[i], i) { break }
            out.append(xs[i])
            i += 1
        }
        return out
    }
}
