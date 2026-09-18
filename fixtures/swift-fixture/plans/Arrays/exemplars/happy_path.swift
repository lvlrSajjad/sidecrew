// shape: happy_path — one or two representative inputs, assert the exact return value. framework: xctest
import XCTest
@testable import SwiftFixture

final class ChunkHappyPathXCTests: XCTestCase {
    func testSplitsIntoRunsOfTheRequestedSize() throws {
        XCTAssertEqual(try Arrays.chunk([1, 2, 3, 4], size: 2), [[1, 2], [3, 4]])
    }

    func testLeavesTheLastRunShortWhenTheSizeDoesNotDivideEvenly() throws {
        XCTAssertEqual(try Arrays.chunk([1, 2, 3, 4, 5], size: 2), [[1, 2], [3, 4], [5]])
    }
}
