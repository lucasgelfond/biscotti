// The biscotti app, for iPhone, iPad and Mac: your tasks from your biscotti (working, kept, done), each task's steps
// as they happen, its report, screenshot and live desktop. Start, tell, follow up on, stop, and move tasks to the cloud
// (long-press, or right-click on a Mac). Push notifications when a task reports or fails.
//
// It talks to the gate's task API (core/src/api.ts) over Tailscale, so the device has to be on the tailnet. There's
// no sign-in: Tailscale says who's asking, and the gate lets only API_OWNER in.
//
// Build: TEAM_ID is your Apple developer team (developer.apple.com → Membership), BUNDLE_PREFIX your reverse domain.
//   brew install xcodegen
//   cd apps/ios && TEAM_ID=V9NJV7HGHW BUNDLE_PREFIX=com.lucasgelfond xcodegen && open biscotti.xcodeproj
// then pick your iPhone (or My Mac) and run. Or from the shell:
//   xcodebuild -project biscotti.xcodeproj -scheme biscotti -destination generic/platform=iOS -allowProvisioningUpdates
//   xcrun devicectl device install app --device <UDID> <DerivedData>/Build/Products/Debug-iphoneos/biscotti.app
// The Mac build has no push notifications (the entitlement is the iPhone's); if Xcode won't sign it over
// aps-environment, build for iPhone/iPad only or drop macOS from supportedDestinations in project.yml.

import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#endif

@main
struct BiscottiApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor private var delegate: PushDelegate
    #endif
    @State private var store = Store()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Group {
                // Tailscale first: the board only once the gate answers.
                if store.api == nil || store.editingHost { SetupView(store: store) }
                else if store.offTailnet { TailscaleView(store: store) }
                else { TasksView(store: store) }
            }
            // Back from the Tailscale app (or from sleep): try again now.
            .onChange(of: phase) { if phase == .active { store.restart() } }
            // Asked once the gate answers, so the Tailscale prompt comes before the notifications one.
            .task(id: store.connected) { if store.connected { await Push.ask(store: store) } }
        }
    }
}

/// Push notifications: the phone asks once, then gives the gate its token (push.ts sends the alerts).
///
/// Setting up the gate's side, once:
/// 1. developer.apple.com → Certificates, IDs & Profiles → Keys → +, check Apple Push Notifications service (APNs),
///    download the .p8 (it can be downloaded only once) and note its Key ID.
/// 2. Copy it to the biscotti host: `scp AuthKey_XXXX.p8 root@biscotti:/var/lib/biscotti/data/apns.p8`.
/// 3. In /var/lib/biscotti/.env: APNS_KEY_FILE=/data/apns.p8, APNS_KEY_ID= the Key ID, APNS_TEAM_ID= your team,
///    APNS_TOPIC= the app's bundle ID (BUNDLE_PREFIX.biscotti). Restart biscotti.
/// 4. Open the app and allow notifications. Xcode builds use Apple's sandbox servers, TestFlight and App Store builds
///    the production ones; the app tells the gate which.
enum Push {
    @MainActor static var store: Store?
    @MainActor private static var asked = false

    @MainActor static func ask(store: Store) async {
        Push.store = store
        guard !asked else { return }
        asked = true
        #if os(iOS)
        guard (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) == true else { return }
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }

    static func registered(_ token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        let sandbox = true
        #else
        let sandbox = false
        #endif
        Task { @MainActor in try? await store?.api?.register(device: hex, sandbox: sandbox) }
    }
}

#if os(iOS)
final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Push.registered(deviceToken)
    }
    // Shown even with the app open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
#endif
