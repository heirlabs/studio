import SwiftUI
import UIKit
import UserNotifications

@main
struct HeirStudioApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .onOpenURL { model.acceptPairingLink($0) }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        PushService.installCategories()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            await PushService.shared.didRegister(deviceToken: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in
            await PushService.shared.didFailToRegister(error)
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge, .list]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let action = response.actionIdentifier
        let payload = PushService.payload(from: response.notification.request.content.userInfo)
        await PushService.shared.handle(action: action, payload: payload)
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if model.isPaired {
                SessionListView()
            } else {
                PairingView()
            }
        }
        .task {
            // Ask while the first screen is visible. 1.0.4 waited until
            // after a pairing/health round-trip, so the system sheet never
            // appeared and the Mac never received a device token.
            await PushService.shared.requestAuthorizationAndRegister()
            await model.restore()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await model.handleBecameActive() }
            }
        }
        .overlay(alignment: .top) { bannerView }
        .animation(.default, value: model.isPaired)
        // A quick-tunnel URL changes on every restart, so re-pairing is the
        // normal case, not an edge case. Confirm because a link can come from
        // anywhere — but keep it to one tap.
        .alert(
            "Connect to this Mac?",
            isPresented: .constant(model.isPaired && model.suggestedPairing != nil)
        ) {
            Button("Cancel", role: .cancel) { model.suggestedPairing = nil }
            Button("Connect") { Task { await model.pairWithSuggestion() } }
        } message: {
            Text(model.suggestedPairing?.url ?? "")
        }
    }

    @ViewBuilder
    private var bannerView: some View {
        if let banner = model.banner {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: icon(for: banner.level))
                Text(banner.text)
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button {
                    model.banner = nil
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.plain)
            }
            .padding(12)
            .background(color(for: banner.level).opacity(0.22), in: .rect(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(color(for: banner.level).opacity(0.5)))
            .padding(.horizontal, 12)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private func icon(for level: AppModel.Banner.Level) -> String {
        switch level {
        case .info: "info.circle"
        case .warning: "exclamationmark.triangle"
        case .error: "xmark.octagon"
        }
    }

    private func color(for level: AppModel.Banner.Level) -> Color {
        switch level {
        case .info: .blue
        case .warning: .orange
        case .error: .red
        }
    }
}
