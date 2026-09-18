// shape: error_or_throw — the error type and the message, not just "it threw". framework: swift-testing
import Testing
@testable import SwiftFixture

@Suite struct PercentChangeErrorOrThrowTests {
    @Test func reportsARiseAsAPositiveFraction() throws {
        #expect(try Numbers.percentChange(from: 200, to: 250) == 0.25)
    }

    @Test func reportsAFallAsANegativeFraction() throws {
        #expect(try Numbers.percentChange(from: 200, to: 150) == -0.25)
    }

    @Test func throwsWhenTheBaseIsZero() {
        #expect(throws: RangeError("percent change from zero is undefined")) {
            try Numbers.percentChange(from: 0, to: 10)
        }
    }

    @Test func measuresAgainstTheMagnitudeOfANegativeBase() throws {
        #expect(try Numbers.percentChange(from: -200, to: -150) == 0.25)
    }
}
