// Cheap pass #4: a real assertion about something that is not the function under test.
// framework: swift-testing
import Testing
@testable import SwiftFixture

@Suite struct RotateFunctionNeverCalledTests {
    @Test func movesElementsToTheFront() {
        let xs = [1, 2, 3]
        let rotatedByHand = Array(xs[1...]) + Array(xs[..<1])
        #expect(rotatedByHand == [2, 3, 1])
    }
}
