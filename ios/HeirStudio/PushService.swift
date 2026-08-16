import Combine
import Foundation
import UIKit
import UserNotifications

enum PushRouting: Sendable {
    static let permissionCategory = "HEIR_PERMISSION"
    static let runCategory = "HEIR_RUN"
    static let allowAction = "ALLOW"
    static let denyAction = "DENY"
    static let stopAction = "STOP"
    static let openAction = "OPEN"
}

/// APNs registration and lock-screen Allow / Deny / Stop routing.
///
/// Categories are installed at launch so a notification can carry actions
/// before the user has opened a chat. The system prompt is requested as soon
/// as the first view appears — waiting until after a pairing / health check
/// is why 1.0.4 never asked. Token upload still waits until a pairing exists;
/// the token itself is never invented (simulator builds fail
/// `registerForRemoteNotifications` and stay silent).
@MainActor
final class PushService: ObservableObject {
    static let shared = PushService()

    static let permissionCategory = PushRouting.permissionCategory
    static let runCategory = PushRouting.runCategory
    static let allowAction = PushRouting.allowAction
    static let denyAction = PushRouting.denyAction
    static let stopAction = PushRouting.stopAction
    static let openAction = PushRouting.openAction

    private static let tokenDefaultsKey = "heir.apns.token"

    @Published private(set) var hexToken: String? {
        didSet { UserDefaults.standard.set(hexToken, forKey: Self.tokenDefaultsKey) }
    }

    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined
    @Published private(set) var lastError: String?
    @Published private(set) var registeredOnMac = false

    weak var appModel: AppModel?

    var statusText: String {
        Self.statusText(
            authorization: authorization,
            hexToken: hexToken,
            registeredOnMac: registeredOnMac,
            lastError: lastError)
    }

    private init() {
        hexToken = UserDefaults.standard.string(forKey: Self.tokenDefaultsKey)
    }

    func attach(_ model: AppModel) {
        appModel = model
    }

    nonisolated static func statusText(
        authorization: UNAuthorizationStatus,
        hexToken: String?,
        registeredOnMac: Bool,
        lastError: String?
    ) -> String {
        switch authorization {
        case .notDetermined:
            return "Not asked yet"
        case .denied:
            return "Off — enable in iPhone Settings"
        case .authorized, .provisional, .ephemeral:
            if let lastError, !lastError.isEmpty { return lastError }
            if hexToken == nil { return "Waiting for Apple…" }
            if registeredOnMac { return "On" }
            return "On this phone — Mac not registered yet"
        @unknown default:
            return "Unknown"
        }
    }

    nonisolated static func installCategories() {
        let allow = UNNotificationAction(
            identifier: PushRouting.allowAction,
            title: "Allow",
            options: [.authenticationRequired])
        let deny = UNNotificationAction(
            identifier: PushRouting.denyAction,
            title: "Deny",
            options: [.destructive, .authenticationRequired])
        let permission = UNNotificationCategory(
            identifier: PushRouting.permissionCategory,
            actions: [allow, deny],
            intentIdentifiers: [],
            options: [])

        let stop = UNNotificationAction(
            identifier: PushRouting.stopAction,
            title: "Stop",
            options: [.destructive, .authenticationRequired])
        let open = UNNotificationAction(
            identifier: PushRouting.openAction,
            title: "Open",
            options: [.foreground])
        let run = UNNotificationCategory(
            identifier: PushRouting.runCategory,
            actions: [stop, open],
            intentIdentifiers: [],
            options: [])

        UNUserNotificationCenter.current().setNotificationCategories([permission, run])
    }

    func requestAuthorizationAndRegister() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        authorization = settings.authorizationStatus

        var granted = Self.isGranted(settings.authorizationStatus)
        if settings.authorizationStatus == .notDetermined {
            do {
                granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            } catch {
                lastError = error.localizedDescription
                appModel?.banner = AppModel.Banner(
                    level: .warning,
                    text: "Could not ask for notifications: \(error.localizedDescription)")
                granted = false
            }
            let after = await center.notificationSettings()
            authorization = after.authorizationStatus
            granted = Self.isGranted(after.authorizationStatus) || granted
        }

        if granted {
            lastError = nil
            UIApplication.shared.registerForRemoteNotifications()
        } else if authorization == .denied {
            lastError = "Notifications are off. Enable them in Settings → Heir Studio."
            appModel?.banner = AppModel.Banner(level: .warning, text: lastError!)
        }
        await uploadTokenIfPossible()
    }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    func didRegister(deviceToken: Data) async {
        hexToken = Self.hexToken(from: deviceToken)
        lastError = nil
        await uploadTokenIfPossible()
    }

    func didFailToRegister(_ error: Error) async {
        lastError = error.localizedDescription
        appModel?.banner = AppModel.Banner(
            level: .warning,
            text: "Push registration failed: \(error.localizedDescription)")
    }

    private static func isGranted(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional || status == .ephemeral
    }

    func unregister(using client: StudioClient) async {
        guard let token = hexToken else { return }
        try? await client.unregisterPushToken(token)
        registeredOnMac = false
    }

    func handle(action: String, payload: Payload) async {
        switch action {
        case PushRouting.allowAction:
            guard let runId = payload.runId, let permissionId = payload.permissionId else { return }
            try? await AppModel.sharedClient.respondPermission(
                runId: runId,
                permissionId: permissionId,
                allow: true,
                optionId: payload.optionAllow)
        case PushRouting.denyAction:
            guard let runId = payload.runId, let permissionId = payload.permissionId else { return }
            try? await AppModel.sharedClient.respondPermission(
                runId: runId,
                permissionId: permissionId,
                allow: false,
                optionId: payload.optionDeny)
        case PushRouting.stopAction:
            guard let runId = payload.runId else { return }
            try? await AppModel.sharedClient.cancel(runId: runId)
        case PushRouting.openAction, UNNotificationDefaultActionIdentifier:
            applyOpen(payload)
        default:
            break
        }
    }

    private func applyOpen(_ payload: Payload) {
        guard let sessionId = payload.sessionId else { return }
        if let runId = payload.runId {
            appModel?.inboundRun = AppModel.InboundRun(
                sessionId: sessionId, runId: runId, messageId: nil)
        }
        appModel?.openSession(id: sessionId)
        Task { await appModel?.refreshSessions() }
    }

    private func uploadTokenIfPossible() async {
        guard let token = hexToken else { return }
        guard await AppModel.sharedClient.isConfigured else { return }
        do {
            try await AppModel.sharedClient.registerPushToken(token)
            registeredOnMac = true
            lastError = nil
        } catch {
            registeredOnMac = false
            lastError = error.localizedDescription
            appModel?.banner = AppModel.Banner(
                level: .warning,
                text: "Could not register this iPhone for alerts: \(error.localizedDescription)")
        }
    }

    nonisolated static func hexToken(from data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    struct Payload: Equatable, Sendable {
        var sessionId: String?
        var runId: String?
        var permissionId: String?
        var optionAllow: String?
        var optionDeny: String?
    }

    nonisolated static func payload(from userInfo: [AnyHashable: Any]) -> Payload {
        func string(_ key: String) -> String? {
            if let s = userInfo[key] as? String {
                let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
            if let n = userInfo[key] as? NSNumber {
                return n.stringValue
            }
            return nil
        }
        return Payload(
            sessionId: string("sessionId"),
            runId: string("runId"),
            permissionId: string("permissionId"),
            optionAllow: string("optionAllow"),
            optionDeny: string("optionDeny"))
    }
}
