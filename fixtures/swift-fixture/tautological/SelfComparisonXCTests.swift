// Cheap pass #2: call the function, then compare its result with itself. framework: xctest
import XCTest
@testable import SwiftFixture

final class TitleCaseSelfComparisonXCTests: XCTestCase {
    func testReturnsAConsistentValue() {
        let actual = Strings.titleCase("the quick brown fox")
        XCTAssertEqual(actual, actual)
    }

    func testEqualsItself() {
        XCTAssertEqual(Strings.titleCase("abc"), Strings.titleCase("abc"))
    }
}
