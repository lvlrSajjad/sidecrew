// shape: async — await the result and assert it, and assert ordering where order is part of the
// contract. No timers and no clock. framework: swift-testing
import Testing
@testable import SwiftFixture

@Suite struct MapSeriesAsyncTests {
    @Test func keepsResultsInInputOrder() async throws {
        let doubled = await Async.mapSeries([1, 2, 3]) { n, _ in n * 2 }
        #expect(doubled == [2, 4, 6])
    }

    @Test func passesTheIndexAlongsideTheItem() async throws {
        let labelled = await Async.mapSeries(["a", "b"]) { item, index in "\(index):\(item)" }
        #expect(labelled == ["0:a", "1:b"])
    }

    @Test func startsEachCallOnlyAfterThePreviousOneSettled() async throws {
        let order = Order()
        _ = await Async.mapSeries([1, 2, 3]) { n, _ in
            order.record("start \(n)")
            await Task.yield()
            order.record("end \(n)")
        }
        #expect(order.entries == ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"])
    }

    /// Plain class, not an actor: `mapSeries` is serial by contract, so the recorder is only ever
    /// touched from one task at a time — and an actor would serialise the very thing under test.
    final class Order: @unchecked Sendable {
        private(set) var entries: [String] = []
        func record(_ entry: String) { entries.append(entry) }
    }
}
