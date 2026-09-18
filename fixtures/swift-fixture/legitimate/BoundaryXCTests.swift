// shape: boundary — empty input, single element, exact multiple. One test per boundary. framework: xctest
import XCTest
@testable import SwiftFixture

final class ChunkBoundaryXCTests: XCTestCase {
    func testReturnsNothingForAnEmptyArray() throws {
        XCTAssertEqual(try Arrays.chunk([Int](), size: 3), [])
    }

    func testReturnsOneShortRunWhenSmallerThanTheSize() throws {
        XCTAssertEqual(try Arrays.chunk([1], size: 3), [[1]])
    }

    func testSplitsEvenlyWhenTheSizeDividesTheLength() throws {
        XCTAssertEqual(try Arrays.chunk([1, 2, 3, 4], size: 2), [[1, 2], [3, 4]])
    }

    func testLeavesTheRemainderInAShortFinalRun() throws {
        XCTAssertEqual(try Arrays.chunk([1, 2, 3, 4, 5], size: 2), [[1, 2], [3, 4], [5]])
    }

    func testRejectsASizeBelowOne() {
        XCTAssertThrowsError(try Arrays.chunk([1, 2], size: 0)) { error in
            XCTAssertEqual(error as? RangeError, RangeError("chunk size must be at least 1, got 0"))
        }
    }
}
