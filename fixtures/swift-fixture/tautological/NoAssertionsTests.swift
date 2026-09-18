// Cheap pass #5, which has no TypeScript twin above it: in Swift a test function that asserts nothing
// at all still passes, so "call the function and stop" is the cheapest pass of the lot.
// framework: swift-testing
import Testing
@testable import SwiftFixture

@Suite struct TakeWhileNoAssertionsTests {
    @Test func takesTheLeadingRun() {
        _ = Arrays.takeWhile([1, 2, 3, 4]) { value, _ in value < 3 }
    }
}
