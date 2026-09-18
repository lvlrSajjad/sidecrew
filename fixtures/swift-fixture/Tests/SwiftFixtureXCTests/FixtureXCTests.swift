// The package's own XCTest suite. Green, small, and deliberately silent about `truncate`'s boundary —
// the planted off-by-one is documented in README.md, not caught here (see the TypeScript fixture's
// README for why). The verifier removes every file in Tests/ before it runs a candidate, so nothing
// here can hand a candidate a kill it did not earn.
import XCTest
@testable import SwiftFixture

final class FixtureXCTests: XCTestCase {
    func testSlugifyLowercasesAndJoins() {
        XCTAssertEqual(Strings.slugify("Hello World"), "hello-world")
    }

    func testGcdOfTwoMagnitudes() {
        XCTAssertEqual(Numbers.gcd(-12, 18), 6)
    }

    func testUniqueKeepsFirstOccurrence() {
        XCTAssertEqual(Arrays.unique([3, 1, 3, 2, 1]), [3, 1, 2])
    }
}
