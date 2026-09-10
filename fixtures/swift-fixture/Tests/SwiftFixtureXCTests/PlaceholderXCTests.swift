// The XCTest half. Phase 3 fills it; this only proves the target compiles and runs.
import XCTest
@testable import SwiftFixture

final class PlaceholderXCTests: XCTestCase {
    func testFixtureIsStillAShell() {
        XCTAssertEqual(SwiftFixture.phase, 3)
    }
}
