// Cheap pass #3: the Swift Testing spelling of the same nothing. framework: swift-testing
import Testing
@testable import SwiftFixture

@Suite struct ChunkConstantExpectTests {
    @Test func doesSomething() throws {
        _ = try Arrays.chunk([1, 2, 3, 4, 5], size: 2)
        #expect(true)
    }

    @Test func arithmeticStillHolds() {
        #expect(2 + 2 == 4)
    }
}
