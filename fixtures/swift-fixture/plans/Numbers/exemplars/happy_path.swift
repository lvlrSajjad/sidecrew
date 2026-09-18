// shape: happy_path — one or two representative inputs, assert the exact return value. framework: xctest
import XCTest
@testable import SwiftFixture

final class ClampHappyPathXCTests: XCTestCase {
    func testReturnsAValueThatIsAlreadyInsideTheRange() throws {
        XCTAssertEqual(try Numbers.clamp(5, lower: 0, upper: 10), 5)
    }

    func testPullsAValueBelowTheRangeUpToTheMinimum() throws {
        XCTAssertEqual(try Numbers.clamp(-3, lower: 0, upper: 10), 0)
    }

    func testPullsAValueAboveTheRangeDownToTheMaximum() throws {
        XCTAssertEqual(try Numbers.clamp(42, lower: 0, upper: 10), 10)
    }
}
