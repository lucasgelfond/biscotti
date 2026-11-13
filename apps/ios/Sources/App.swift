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
                if store.api == nil { SetupView(store: store) } else { TasksView(store: store) }
            }
            .onChange(of: phase) { if phase == .active { store.restart() } }
            .task { await Push.ask(store: store) }
        }
    }
}

/// Push notifications: the phone asks once, then gives the gate its token (push.ts sends the alerts).
enum Push {
    @MainActor static var store: Store?

    @MainActor static func ask(store: Store) async {
        Push.store = store
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
