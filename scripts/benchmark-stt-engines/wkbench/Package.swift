// swift-tools-version: 5.10
// WhisperKit latency benchmark; usage in docs/plans/WHISPERKIT_COMPARISON.md.
import PackageDescription

let package = Package(
    name: "wkbench",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Revision benchmarked on 2026-09-24.
        .package(url: "https://github.com/argmaxinc/argmax-oss-swift.git",
                 revision: "3111602262888bf68717029b2d3c9d486b02e160"),
    ],
    targets: [
        .executableTarget(
            name: "wkbench",
            dependencies: [.product(name: "WhisperKit", package: "argmax-oss-swift")]
        ),
    ]
)
