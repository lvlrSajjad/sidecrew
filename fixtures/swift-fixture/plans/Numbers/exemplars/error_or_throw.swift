// shape: error_or_throw — the inputs the contract rejects. Assert the error type, and that the message
// names the offending value. framework: xctest
import XCTest
@testable import SwiftFixture

final class ClampErrorOrThrowXCTests: XCTestCase {
    func testThrowsWhenTheBoundsAreInverted() {
        XCTAssertThrowsError(try Numbers.clamp(5, lower: 10, upper: 0)) { error in
            XCTAssertTrue(error is RangeError)
        }
    }

    func testNamesTheEmptyRangeItWasGiven() {
        XCTAssertThrowsError(try Numbers.clamp(5, lower: 10, upper: 0)) { error in
            XCTAssertEqual((error as? RangeError)?.message, "empty range: [10.0, 0.0]")
        }
    }

    func testDoesNotThrowWhenTheBoundsMerelyTouch() throws {
        XCTAssertEqual(try Numbers.clamp(5, lower: 3, upper: 3), 3)
    }
}
