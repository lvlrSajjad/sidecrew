// shape: happy_path — one or two representative inputs, assert the exact return value. framework: xctest
import XCTest
@testable import SwiftFixture

final class SlugifyHappyPathXCTests: XCTestCase {
    func testLowercasesAndJoinsWordsWithDashes() {
        XCTAssertEqual(Strings.slugify("Hello World"), "hello-world")
    }

    func testStripsAccentsAndCollapsesPunctuation() {
        XCTAssertEqual(Strings.slugify("Crème brûlée — no. 2!"), "creme-brulee-no-2")
    }

    func testLeavesNoLeadingOrTrailingDash() {
        XCTAssertEqual(Strings.slugify("  --Sidecrew--  "), "sidecrew")
    }
}
