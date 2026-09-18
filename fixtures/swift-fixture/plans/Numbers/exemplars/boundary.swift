// shape: boundary — the value either side of each limit, and a range with no width. framework: xctest
import XCTest
@testable import SwiftFixture

final class ClampBoundaryXCTests: XCTestCase {
    func testLeavesAValueSittingExactlyOnTheMinimum() throws {
        XCTAssertEqual(try Numbers.clamp(0, lower: 0, upper: 10), 0)
    }

    func testLeavesAValueSittingExactlyOnTheMaximum() throws {
        XCTAssertEqual(try Numbers.clamp(10, lower: 0, upper: 10), 10)
    }

    func testReturnsTheOnlyValueASinglePointRangeAllows() throws {
        XCTAssertEqual(try Numbers.clamp(7, lower: 7, upper: 7), 7)
    }

    func testClampsTheValueOneStepOutsideEachLimit() throws {
        XCTAssertEqual(try Numbers.clamp(-1, lower: 0, upper: 10), 0)
        XCTAssertEqual(try Numbers.clamp(11, lower: 0, upper: 10), 10)
    }
}
