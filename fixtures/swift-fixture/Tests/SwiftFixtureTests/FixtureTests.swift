// The package's own Swift Testing suite. Same rules as the XCTest one next door.
import Testing
@testable import SwiftFixture

@Test func commonPrefixStopsAtTheFirstDifference() {
    #expect(Strings.commonPrefix("sidecrew", "sidecar") == "sidec")
}

@Test func canTransitionRejectsAnEventTheStateDoesNotAccept() {
    #expect(Machine.canTransition(.draft, .place))
    #expect(!Machine.canTransition(.shipped, .cancel))
}

@Test func rotateWrapsNegativeOffsetsToTheRight() {
    #expect(Arrays.rotate([1, 2, 3, 4], by: -1) == [4, 1, 2, 3])
}
