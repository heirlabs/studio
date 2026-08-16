import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var config: ServerConfig?
    @Published private(set) var health: Health?
    @Published var sessions: [SessionSummary] = []
    @Published var banner: Banner?
    /// Credentials handed in by a `heirstudio://pair` link. Pre-filled only —
    /// a link can arrive from anywhere, so connecting stays an explicit tap.
    @Published var suggestedPairing: (url: String, token: String)?
    /// Last run started on this Mac from any client. ChatView attaches if it matches.
    @Published var inboundRun: InboundRun?
    /// Session the user should be looking at (push / hub). Session list navigates here.
    @Published var openedSession: SessionSummary?

    struct InboundRun: Equatable {
        let sessionId: String
        let runId: String
        let messageId: String?
    }

    private var hubTask: Task<Void, Never>?

    /// Parse `heirstudio://pair?url=…&token=…`.
    func acceptPairingLink(_ url: URL) {
        guard url.scheme == "heirstudio",
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let items = components.queryItems,
            let server = items.first(where: { $0.name == "url" })?.value,
            let token = items.first(where: { $0.name == "token" })?.value
        else { return }
        suggestedPairing = (server, token)
    }

    /// Shared with ChatView, which NavigationStack constructs without access to
    /// the environment — one client, one configuration.
    let client = AppModel.sharedClient

    struct Banner: Identifiable, Equatable {
        enum Level: Equatable { case info, warning, error }
        let id = UUID()
        let level: Level
        let text: String
    }

    var isPaired: Bool { config != nil }

    init() {
        PushService.shared.attach(self)
    }

    /// Restore a previous pairing on launch.
    func restore() async {
        guard let stored = Keychain.load() else { return }
        config = stored
        await client.configure(stored)
        // Upload any token we already have before the health/session fetches.
        await PushService.shared.requestAuthorizationAndRegister()
        await refreshHealth()
        await refreshSessions()
        startHub()
    }

    func pair(with candidate: ServerConfig) async throws {
        // Prove the Mac answers before persisting anything.
        let probed = try await client.probe(candidate)
        try Keychain.save(candidate)
        config = candidate
        health = probed
        await client.configure(candidate)
        await refreshSessions()
        surfaceApprovalConflict(probed)
        startHub()
        await PushService.shared.requestAuthorizationAndRegister()
    }

    /// Adopt credentials that arrived by link while already paired.
    func pairWithSuggestion() async {
        guard let suggestion = suggestedPairing else { return }
        suggestedPairing = nil
        do {
            try await pair(with: ServerConfig.parse(
                urlString: suggestion.url, token: suggestion.token))
            banner = Banner(level: .info, text: "Connected to \(suggestion.url)")
        } catch {
            report(error)
        }
    }

    func unpair() async {
        await PushService.shared.unregister(using: client)
        Keychain.clear()
        config = nil
        health = nil
        sessions = []
        inboundRun = nil
        hubTask?.cancel()
        hubTask = nil
        await client.configure(nil)
    }

    func handleBecameActive() async {
        await PushService.shared.requestAuthorizationAndRegister()
        guard isPaired else { return }
        startHub()
        await refreshHealth()
        await refreshSessions()
    }

    func refreshHealth() async {
        guard isPaired else { return }
        do {
            let h = try await client.health()
            health = h
            surfaceApprovalConflict(h)
        } catch {
            report(error)
        }
    }

    func refreshSessions() async {
        guard isPaired else { return }
        do {
            sessions = try await client.sessions().sessions
        } catch {
            report(error)
        }
    }

    func createSession(cwd: String) async -> SessionSummary? {
        do {
            let created = try await client.createSession(cwd: cwd)
            await refreshSessions()
            return created
        } catch {
            report(error)
            return nil
        }
    }

    func deleteSession(_ id: String) async {
        do {
            try await client.deleteSession(id)
            await refreshSessions()
        } catch {
            report(error)
        }
    }

    private func startHub() {
        hubTask?.cancel()
        hubTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let stream = try await self.client.streamHub()
                    for try await event in stream {
                        if Task.isCancelled { return }
                        await self.handleHub(event)
                    }
                } catch is CancellationError {
                    return
                } catch {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
        }
    }

    private func handleHub(_ event: HubEvent) async {
        switch (event.type, event.event) {
        case ("session", _):
            await refreshSessions()
        case ("run", "started"):
            await refreshSessions()
            if let sid = event.sessionId, let rid = event.runId {
                inboundRun = InboundRun(sessionId: sid, runId: rid, messageId: event.messageId)
                openSession(id: sid)
            }
        case ("run", "finished"):
            await refreshSessions()
        case ("session", "compacted"):
            await refreshSessions()
        default:
            break
        }
    }

    func openSession(id: String) {
        if let match = sessions.first(where: { $0.id == id }) {
            openedSession = match
            return
        }
        openedSession = SessionSummary(
            id: id,
            title: nil,
            cwd: nil,
            messageCount: nil,
            updatedAt: nil,
            activeRunId: inboundRun?.runId,
            lastPreview: nil,
            grokSessionId: nil,
            context: nil)
    }

    func report(_ error: Error) {
        let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        banner = Banner(level: .error, text: text)
    }

    /// The Mac's own grok config can force always-approve, in which case tapping
    /// Approve on the phone will never happen — say so instead of pretending.
    private func surfaceApprovalConflict(_ health: Health) {
        guard health.approvalConflict?.conflict == true,
            let message = health.approvalConflict?.message
        else { return }
        banner = Banner(level: .warning, text: message)
    }
}
