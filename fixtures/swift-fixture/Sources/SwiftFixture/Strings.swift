import Foundation

/// String utilities. Pure, total unless the doc comment says otherwise.
/// Written with explicit loops rather than `replacingOccurrences(of:with:)` chains on purpose: Muter's
/// four operators only see relational operators, logical connectors, ternaries and discarded side
/// effects, so a one-line Foundation chain produces no mutants at all and `killed ≥ 1` becomes
/// unreachable for reasons that have nothing to do with the test. See ADR-0005.
public enum Strings {
    /// A URL-safe slug: lowercase, accents stripped, runs of non-alphanumerics collapsed to one dash,
    /// no leading or trailing dash.
    public static func slugify(_ input: String) -> String {
        let folded = input.folding(options: .diacriticInsensitive, locale: .init(identifier: "en_US_POSIX")).lowercased()
        var out = ""
        var pendingDash = false
        for character in folded {
            if character.isLetter || character.isNumber {
                if pendingDash && !out.isEmpty { out.append("-") }
                out.append(character)
                pendingDash = false
            } else {
                pendingDash = true
            }
        }
        return out
    }

    /// Shortens `text` to at most `maxLength` characters, ending with a one-character ellipsis when
    /// anything was cut. Text that already fits is returned unchanged. `maxLength <= 0` gives "".
    public static func truncate(_ text: String, maxLength: Int) -> String {
        if maxLength <= 0 { return "" }
        if text.count < maxLength { return text }
        return String(text.prefix(maxLength - 1)) + "…"
    }

    /// Upper-cases the first letter of every whitespace-separated word and lower-cases the rest.
    public static func titleCase(_ input: String) -> String {
        var out: [String] = []
        for word in input.split(separator: " ", omittingEmptySubsequences: false) {
            if word.isEmpty {
                out.append("")
            } else {
                out.append(word.prefix(1).uppercased() + word.dropFirst().lowercased())
            }
        }
        return out.joined(separator: " ")
    }

    /// Non-overlapping occurrences of `needle` in `haystack`. An empty needle counts as none.
    public static func countOccurrences(_ haystack: String, _ needle: String) -> Int {
        if needle.isEmpty { return 0 }
        var count = 0
        var from = haystack.startIndex
        while from < haystack.endIndex,
              let found = haystack.range(of: needle, range: from ..< haystack.endIndex) {
            count += 1
            from = found.upperBound
        }
        return count
    }

    /// The longest string that starts both `a` and `b`.
    public static func commonPrefix(_ a: String, _ b: String) -> String {
        let left = Array(a)
        let right = Array(b)
        let limit = min(left.count, right.count)
        var i = 0
        while i < limit && left[i] == right[i] { i += 1 }
        return String(left.prefix(i))
    }
}
