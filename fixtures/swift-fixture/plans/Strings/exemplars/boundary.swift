// shape: boundary — empty input, one character, nothing usable. One test per boundary. framework: xctest
import XCTest
@testable import SwiftFixture

final class SlugifyBoundaryXCTests: XCTestCase {
    func testReturnsAnEmptyStringForAnEmptyString() {
        XCTAssertEqual(Strings.slugify(""), "")
    }

    func testKeepsASingleUsableCharacter() {
        XCTAssertEqual(Strings.slugify("A"), "a")
    }

    func testReturnsAnEmptyStringWhenNothingSurvivesTheFilter() {
        XCTAssertEqual(Strings.slugify("!!!"), "")
    }

    func testCollapsesARunOfSeparatorsToOneDash() {
        XCTAssertEqual(Strings.slugify("a   b"), "a-b")
    }
}
