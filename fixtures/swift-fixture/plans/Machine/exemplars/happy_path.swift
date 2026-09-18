// shape: happy_path — one or two representative inputs, assert the exact return value.
// framework: swift-testing
import Testing
@testable import SwiftFixture

@Suite struct CanTransitionHappyPathTests {
    @Test func acceptsAnEventTheStateAllows() {
        #expect(Machine.canTransition(.draft, .place) == true)
    }

    @Test func refusesAnEventTheStateDoesNotAllow() {
        #expect(Machine.canTransition(.draft, .ship) == false)
    }
}
