// swift-tools-version: 6.0
import PackageDescription

// Two test targets on purpose. Muter invokes the package's own test command, so the verifier has to
// cope with whichever framework a target uses — and Phase 3 has to prove it copes with both.
let package = Package(
    name: "SwiftFixture",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "SwiftFixture"),
        .testTarget(name: "SwiftFixtureXCTests", dependencies: ["SwiftFixture"]),
        .testTarget(name: "SwiftFixtureTests", dependencies: ["SwiftFixture"]),
    ]
)
