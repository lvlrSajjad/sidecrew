// The Swift Testing half. Phase 3 fills it; this only proves the target compiles and runs.
import Testing
@testable import SwiftFixture

@Test func fixtureIsStillAShell() {
    #expect(SwiftFixture.phase == 3)
}
