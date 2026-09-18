// shape: boundary — empty input, one element, and a size larger than the input. framework: xctest
import XCTest
@testable import SwiftFixture

final class ChunkBoundaryXCTests: XCTestCase {
    func testReturnsNoRunsForAnEmptyArray() throws {
        XCTAssertEqual(try Arrays.chunk([Int](), size: 3), [])
    }

    func testReturnsOneRunOfOneForASingleElement() throws {
        XCTAssertEqual(try Arrays.chunk([1], size: 1), [[1]])
    }

    func testReturnsTheWholeArrayAsOneRunWhenTheSizeExceedsIt() throws {
        XCTAssertEqual(try Arrays.chunk([1, 2], size: 5), [[1, 2]])
    }

    func testReturnsOneRunPerElementWhenTheSizeIsOne() throws {
        XCTAssertEqual(try Arrays.chunk([1, 2, 3], size: 1), [[1], [2], [3]])
    }
}
