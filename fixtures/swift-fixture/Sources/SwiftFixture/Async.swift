import Foundation

/// Every task failed. Carries them all, like the TypeScript fixture's `AggregateError`.
public struct AllTasksFailed: Error, CustomStringConvertible {
    public let errors: [Error]
    public var description: String { "all \(errors.count) tasks failed" }
}

/// The asynchronous corner of the fixture. Deterministic: no timers, no clock, no I/O.
public enum Async {
    /// `fn` applied to each item strictly in order, awaiting each before starting the next.
    public static func mapSeries<T, R>(_ items: [T], _ fn: (T, Int) async throws -> R) async rethrows -> [R] {
        var out: [R] = []
        var i = 0
        while i < items.count {
            out.append(try await fn(items[i], i))
            i += 1
        }
        return out
    }

    /// The result of the first task that resolves, trying them in order. Throws `AllTasksFailed`
    /// carrying every failure when no task resolves — including when there are no tasks.
    public static func firstSuccessful<T>(_ tasks: [() async throws -> T]) async throws -> T {
        var errors: [Error] = []
        var i = 0
        while i < tasks.count {
            do {
                return try await tasks[i]()
            } catch {
                errors.append(error)
            }
            i += 1
        }
        throw AllTasksFailed(errors: errors)
    }
}
