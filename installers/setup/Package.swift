// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "BiscottiInstaller",
    platforms: [.macOS(.v14)],
    dependencies: [.package(url: "https://github.com/facebook/zstd", exact: "1.5.7")],
    targets: [
        .executableTarget(
            name: "BiscottiInstaller",
            dependencies: [.product(name: "libzstd", package: "zstd")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
