// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "BiscottiInstaller",
    platforms: [.macOS(.v14)],
    targets: [.executableTarget(name: "BiscottiInstaller", swiftSettings: [.swiftLanguageMode(.v5)])]
)
