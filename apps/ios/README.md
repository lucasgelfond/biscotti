# The biscotti app

Your tasks from your biscotti, on iPhone, iPad and Mac: what's working, kept and done, each task's steps as they
happen, its report and screenshot, its live desktop. Start tasks, tell or follow up on them, stop them, and move a local
one to the cloud (long-press, or right-click on a Mac). Push notifications when a task reports or fails.

It talks to the gate's task API (`core/src/api.ts`) over Tailscale, so the device must be on your tailnet (the
Tailscale app, connected). There's no sign-in: Tailscale says who's asking, and the gate lets only `API_OWNER` in.

## Build

```sh
brew install xcodegen
cd apps/ios
TEAM_ID=ABCDE12345 BUNDLE_PREFIX=com.yourname xcodegen
open biscotti.xcodeproj
```

Pick your iPhone (or My Mac) and run. `TEAM_ID` is your Apple developer team (developer.apple.com → Membership).

## Push notifications

1. developer.apple.com → Certificates, IDs & Profiles → Keys → **+**, check **Apple Push Notifications service
   (APNs)**, download the `.p8` (once only) and note its Key ID.
2. Copy it to the biscotti host: `scp AuthKey_XXXX.p8 root@biscotti:/var/lib/biscotti/data/apns.p8`.
3. In `/var/lib/biscotti/.env`: `APNS_KEY_FILE=/data/apns.p8`, `APNS_KEY_ID=` the Key ID, `APNS_TEAM_ID=` your team,
   `APNS_TOPIC=` the app's bundle ID (`BUNDLE_PREFIX.biscotti`). Restart biscotti.
4. Open the app and allow notifications. Builds from Xcode use Apple's sandbox servers, TestFlight and App Store builds
   the production ones; the app tells the gate which.

The Mac build has no push notifications (the entitlement is the iPhone's). If Xcode refuses to sign the Mac build over
`aps-environment`, build for iPhone/iPad only or remove macOS from `supportedDestinations`.
