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
/// before the user has opened a chat. Token upload waits until a pairing
/// exists; the token itself is never invented (simulator builds simply fail
/// `registerForRemoteNotifications` and stay silent).
@MainActor
final class PushService {
    static let shared = PushService()

    static let permissionCategory = PushRouting.permissionCategory
    static let runCategory = PushRouting.runCategory
    static let allowAction = PushRouting.allowAction
    static let denyAction = PushRouting.denyAction
    static let stopAction = PushRouting.stopAction
    static let openAction = PushRouting.openAction

    private static let tokenDefaultsKey = "heir.apns.token"

    private(set) var hexToken: String? {
        didSet { UserDefaults.standard.set(hexToken, forKey: Self.tokenDefaultsKey) }
    }

    weak var appModel: AppModel?

    private init() {
        hexToken = UserDefaults.standard.string(forKey: Self.tokenDefaultsKey)
    }

    func attach(_ model: AppModel) {
        appModel = model
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
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
            }
        } catch {
            // Pairing still works without push.
        }
        await uploadTokenIfPossible()
    }

    func didRegister(deviceToken: Data) async {
        hexToken = Self.hexToken(from: deviceToken)
        await uploadTokenIfPossible()
    }

    func didFailToRegister(_ error: Error) async {
        // Unsigned / simulator builds never receive a token. Do not stub one.
        _ = error
    }

    func unregister(using client: StudioClient) async {
        guard let token = hexToken else { return }
        try? await client.unregisterPushToken(token)
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
        Task { await appModel?.refreshSessions() }
    }

    private func uploadTokenIfPossible() async {
        guard let token = hexToken, await AppModel.sharedClient.isConfigured else { return }
        try? await AppModel.sharedClient.registerPushToken(token)
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
