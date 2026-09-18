import Foundation

/// Raised by the two functions here that refuse their input, and by `Arrays.chunk`. The TypeScript
/// fixture throws `RangeError`; Swift has no such thing, so the shape is one case with a message.
public struct RangeError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// Numeric utilities. `clamp` and `percentChange` are the two that throw.
public enum Numbers {
    /// `value` pulled into `[lower, upper]`. Throws when the bounds are inverted.
    public static func clamp(_ value: Double, lower: Double, upper: Double) throws -> Double {
        if lower > upper { throw RangeError("empty range: [\(lower), \(upper)]") }
        if value < lower { return lower }
        if value > upper { return upper }
        return value
    }

    /// `value` rounded to `decimals` places, half away from zero. Negative `decimals` rounds to tens,
    /// hundreds, and so on.
    public static func roundTo(_ value: Double, decimals: Int) -> Double {
        let factor = pow(10.0, Double(decimals))
        let scaled = value * factor
        let rounded = scaled < 0 ? -(-scaled).rounded() : scaled.rounded()
        return rounded / factor
    }

    /// Change from `from` to `to` as a fraction of `from`. Throws when `from` is 0.
    public static func percentChange(from: Double, to: Double) throws -> Double {
        if from == 0 { throw RangeError("percent change from zero is undefined") }
        return (to - from) / abs(from)
    }

    /// Greatest common divisor of the magnitudes of `a` and `b`. `gcd(0, 0)` is 0.
    public static func gcd(_ a: Int, _ b: Int) -> Int {
        var x = abs(a)
        var y = abs(b)
        while y != 0 {
            let next = x % y
            x = y
            y = next
        }
        return x
    }

    /// Arithmetic mean. An empty list has a mean of 0.
    public static func mean(_ values: [Double]) -> Double {
        if values.count == 0 { return 0 }
        var total = 0.0
        for value in values { total += value }
        return total / Double(values.count)
    }

    /// Median of a copy of `values`; the mean of the middle two when the count is even. Empty gives 0.
    public static func median(_ values: [Double]) -> Double {
        if values.count == 0 { return 0 }
        let sorted = values.sorted()
        let mid = sorted.count / 2
        return sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    }
}
