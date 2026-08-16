import Foundation
import SwiftUI
import UIKit

@MainActor
final class ChatModel: ObservableObject {
    @Published var messages: [Message] = []
    @Published var tools: [ToolActivity] = []
    @Published var pendingPermission: PendingPermission?
    @Published var isRunning = false
    @Published var runStatus: String = "idle"
    @Published var title: String = "New chat"
    @Published var composerText: String = ""
    @Published var permissionMode: String = "default"
    @Published var pendingImages: [PendingImage] = []
    @Published var pendingMacFiles: [String] = []
    @Published var cwd: String?
    @Published var reconnecting = false
    @Published var toolCount = 0
    @Published var lastToolLabel: String?

    private let client: StudioClient
    let sessionId: String
    private var streamTask: Task<Void, Never>?
    private var streamingMessageId: String?
    private var textAccumulator = ""
    private var thoughtAccumulator = ""
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    init(client: StudioClient, sessionId: String) {
        self.client = client
        self.sessionId = sessionId
    }

    func load() async {
        do {
            let detail = try await client.session(sessionId)
            messages = detail.messages
            title = detail.title ?? "New chat"
            cwd = detail.cwd
            await reattachIfRunning()
        } catch {
            onError(error)
        }
    }

    /// If a turn is still in flight (app was backgrounded, or it was started
    /// from the Mac), pick the stream back up instead of showing a dead screen.
    func reattachIfRunning() async {
        guard let active = try? await client.activeRun(sessionId: sessionId),
            active.active, let runId = active.runId
        else { return }
        await attach(runId: runId, messageId: active.messageId)
    }

    /// Another client started this turn — join its stream.
    func attachToIncomingRun(runId: String, messageId: String?) async {
        guard runId != currentRunId else { return }
        if messages.isEmpty {
            if let detail = try? await client.session(sessionId) {
                messages = detail.messages
                title = detail.title ?? title
                cwd = detail.cwd ?? cwd
            }
        }
        await attach(runId: runId, messageId: messageId)
    }

    private func attach(runId: String, messageId: String?) async {
        streamingMessageId =
            messageId ?? messages.last(where: { $0.role == "assistant" })?.id
        textAccumulator = messages.first(where: { $0.id == streamingMessageId })?.text ?? ""
        thoughtAccumulator =
            messages.first(where: { $0.id == streamingMessageId })?.thoughts ?? ""
        isRunning = true
        runStatus = "running"
        reconnecting = false
        startStream(runId: runId)
    }

    var canSend: Bool {
        !isRunning
            && (!composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !pendingImages.isEmpty
                || !pendingMacFiles.isEmpty)
    }

    func attachMacFile(_ path: String) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if !pendingMacFiles.contains(trimmed) {
            pendingMacFiles.append(trimmed)
        }
    }

    func removeMacFile(_ path: String) {
        pendingMacFiles.removeAll { $0 == path }
    }

    func addImage(_ image: UIImage) {
        guard let data = ImagePrep.jpeg(from: image) else { return }
        let preview = UIImage(data: data) ?? image
        pendingImages.append(
            PendingImage(data: data, filename: "photo-\(Int(Date().timeIntervalSince1970)).jpg", preview: preview))
    }

    func removeImage(_ id: UUID) {
        pendingImages.removeAll { $0.id == id }
    }

    func send() async {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        let toUpload = pendingImages
        let macFiles = pendingMacFiles
        composerText = ""
        pendingImages = []
        pendingMacFiles = []
        isRunning = true
        runStatus = "running"
        reconnecting = false
        tools.removeAll()
        toolCount = 0
        lastToolLabel = nil
        textAccumulator = ""
        thoughtAccumulator = ""

        do {
            var names: [String] = []
            for image in toUpload {
                names.append(try await client.uploadJPEG(image.data, filename: image.filename))
            }
            var prompt = text
            if prompt.isEmpty && !names.isEmpty && macFiles.isEmpty {
                prompt = "(see attached image)"
            }
            if !macFiles.isEmpty {
                let attached = macFiles.map { "Attached Mac file: \($0)" }.joined(separator: "\n")
                prompt = prompt.isEmpty ? attached : prompt + "\n\n" + attached
            }
            let response = try await client.sendMessage(
                sessionId: sessionId,
                options: .init(
                    text: prompt,
                    permissionMode: permissionMode,
                    images: names.isEmpty ? nil : names,
                    files: macFiles.isEmpty ? nil : macFiles))
            messages = response.session.messages
            title = response.session.title ?? title
            cwd = response.session.cwd ?? cwd
            streamingMessageId = response.assistantMessage.id

            if let downgraded = response.permissionDowngradedFrom {
                note(
                    "Permission mode downgraded from \(downgraded) to "
                        + "\(response.run.meta.permissionMode ?? "default") for this remote run.")
            }
            startStream(runId: response.run.id)
        } catch {
            isRunning = false
            runStatus = "error"
            onError(error)
        }
    }

    func cancel() async {
        guard let runId = currentRunId else { return }
        do { try await client.cancel(runId: runId) } catch { onError(error) }
    }

    private var currentRunId: String?

    private func startStream(runId: String) {
        streamTask?.cancel()
        currentRunId = runId
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let stream = try await self.client.streamEvents(runId: runId)
                for try await event in stream {
                    if Task.isCancelled { return }
                    await self.handle(event, runId: runId)
                }
                // Stream ended without a finished event — the phone likely
                // slept. The agent is still on the Mac; catch up.
                if !Task.isCancelled, self.isRunning {
                    await self.recoverAfterDrop()
                }
            } catch is CancellationError {
                return
            } catch {
                if !Task.isCancelled {
                    await self.recoverAfterDrop(error: error)
                }
            }
        }
    }

    /// Leaving the app or locking the phone kills the HTTP stream. That is not
    /// a failed run — work continues on the Mac. Reattach, or load the result.
    func recoverAfterDrop(error: Error? = nil) async {
        guard isRunning || currentRunId != nil else { return }
        reconnecting = true
        for attempt in 0..<8 {
            try? await Task.sleep(nanoseconds: UInt64(500_000_000 * (attempt + 1)))
            if Task.isCancelled { return }
            if let active = try? await client.activeRun(sessionId: sessionId),
                active.active, let runId = active.runId
            {
                reconnecting = false
                await attach(runId: runId, messageId: active.messageId)
                return
            }
            if let detail = try? await client.session(sessionId) {
                let stillRunning = detail.messages.contains {
                    $0.role == "assistant" && $0.status == "running"
                }
                if !stillRunning {
                    reconnecting = false
                    messages = detail.messages
                    title = detail.title ?? title
                    isRunning = false
                    if runStatus == "running" { runStatus = "completed" }
                    currentRunId = nil
                    return
                }
            }
        }
        reconnecting = false
        if let error, isRunning {
            note("Paused — the agent is still on your Mac. Come back to this chat to catch up.")
            _ = error
        }
    }

    func handleBecameActive() async {
        endBackgroundGrace()
        reconnecting = false
        await reattachIfRunning()
        if !isRunning, currentRunId == nil {
            if let detail = try? await client.session(sessionId) {
                messages = mergePreservingStream(detail.messages)
                title = detail.title ?? title
                cwd = detail.cwd ?? cwd
            }
        }
    }

    func beginBackgroundGrace() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "heir-stream") {
            [weak self] in
            self?.endBackgroundGrace()
        }
    }

    func endBackgroundGrace() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    private func handle(_ event: StreamEvent, runId: String) {
        switch (event.type, event.event) {
        case ("text", _):
            textAccumulator += event.data ?? ""
            paint(status: "running")

        case ("thought", _):
            thoughtAccumulator += event.data ?? ""
            paint(status: "running")

        case ("tool_call", _):
            recordTool(name: event.name ?? "tool", detail: event.input?.preview ?? "")

        case ("tool_result", _):
            lastToolLabel = summarizeTool(event.name ?? "tool", event.result?.preview ?? "")

        case ("error", _):
            append(
                ToolActivity(
                    name: "error", kind: .error, detail: event.message ?? "run error"))
            runStatus = "failed"

        case ("studio", "permission_request"):
            presentPermission(event, runId: runId)

        case ("studio", "permission_auto"):
            append(
                ToolActivity(
                    name: "permission \(event.decision ?? "")",
                    kind: event.decision == "deny" ? .error : .note,
                    detail: event.reason ?? ""))

        case ("studio", "budget_exceeded"):
            append(
                ToolActivity(
                    name: "budget", kind: .error, detail: event.message ?? "budget exceeded"))

        case ("studio", "stderr"):
            let line = (event.data ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !line.isEmpty {
                append(ToolActivity(name: "stderr", kind: .note, detail: line))
            }

        case ("studio", "finished"):
            finish(status: event.status ?? "completed")

        default:
            break
        }
    }

    private func presentPermission(_ event: StreamEvent, runId: String) {
        guard let id = event.permissionID else { return }
        let options = event.options ?? []
        pendingPermission = PendingPermission(
            id: id,
            runId: runId,
            title: event.toolCall?.title ?? event.toolCall?.kind ?? "Tool permission",
            detail: event.toolCall?.rawInput?.preview ?? "",
            allowOptionId: options.first(where: \.isAllow)?.optionId,
            denyOptionId: options.first(where: { !$0.isAllow })?.optionId)
    }

    func respond(to permission: PendingPermission, allow: Bool) async {
        pendingPermission = nil
        do {
            try await client.respondPermission(
                runId: permission.runId,
                permissionId: permission.id,
                allow: allow,
                optionId: allow ? permission.allowOptionId : permission.denyOptionId)
            append(
                ToolActivity(
                    name: allow ? "approved" : "denied", kind: allow ? .note : .error,
                    detail: permission.title))
        } catch {
            onError(error)
        }
    }

    private func finish(status: String) {
        isRunning = false
        runStatus = status
        currentRunId = nil
        // A dismissed prompt for a finished run would answer nothing.
        pendingPermission = nil
        streamTask?.cancel()
        streamTask = nil
        Task { await reloadAfterFinish(status: status) }
    }

    private func reloadAfterFinish(status: String) async {
        guard let detail = try? await client.session(sessionId) else {
            paint(status: status)
            return
        }
        var loaded = detail.messages
        // The server may still show the last turn as running for a moment.
        if let idx = loaded.lastIndex(where: { $0.role == "assistant" }),
            loaded[idx].status == "running"
        {
            loaded[idx].status = status
        }
        // Never let a reload blank out text we already streamed.
        if let idx = loaded.lastIndex(where: { $0.role == "assistant" }),
            (loaded[idx].text ?? "").isEmpty, !textAccumulator.isEmpty
        {
            loaded[idx].text = textAccumulator
        }
        messages = mergePreservingStream(loaded)
        title = detail.title ?? title
        cwd = detail.cwd ?? cwd
    }

    private func mergePreservingStream(_ loaded: [Message]) -> [Message] {
        var loaded = loaded
        if let idx = loaded.lastIndex(where: { $0.role == "assistant" }),
            (loaded[idx].text ?? "").isEmpty, !textAccumulator.isEmpty
        {
            loaded[idx].text = textAccumulator
        }
        if let idx = loaded.lastIndex(where: { $0.role == "assistant" }),
            (loaded[idx].thoughts ?? "").isEmpty, !thoughtAccumulator.isEmpty
        {
            loaded[idx].thoughts = thoughtAccumulator
        }
        return loaded
    }

    /// Mirror streamed deltas into the placeholder assistant message.
    private func paint(status: String) {
        guard let id = streamingMessageId,
            let idx = messages.firstIndex(where: { $0.id == id })
        else { return }
        messages[idx].text = textAccumulator
        messages[idx].thoughts = thoughtAccumulator
        messages[idx].status = status
    }

    private func recordTool(name: String, detail: String) {
        toolCount += 1
        lastToolLabel = summarizeTool(name, detail)
        // Keep errors only in the strip — raw shell dumps bury the thinking.
        if name == "error" {
            append(ToolActivity(name: name, kind: .error, detail: summarizeTool(name, detail)))
        }
    }

    private func summarizeTool(_ name: String, _ detail: String) -> String {
        let compact = detail
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if name.contains("terminal") || name.contains("shell") || name == "run_terminal_command" {
            if let cmd = compact.split(separator: "command:").dropFirst().first {
                let body = cmd.trimmingCharacters(in: CharacterSet(charactersIn: " {}"))
                let short = body.count > 72 ? String(body.prefix(72)) + "…" : body
                return "Shell · \(short)"
            }
            return "Shell"
        }
        if compact.isEmpty { return name }
        return compact.count > 80 ? "\(name) · \(compact.prefix(80))…" : "\(name) · \(compact)"
    }

    private func append(_ activity: ToolActivity) {
        tools.append(activity)
        if tools.count > 8 {
            tools.removeFirst(tools.count - 8)
        }
    }

    private func note(_ text: String) {
        append(ToolActivity(name: "note", kind: .note, detail: text))
    }

    private func onError(_ error: Error) {
        let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        append(ToolActivity(name: "error", kind: .error, detail: text))
    }

    func stopStreaming() {
        streamTask?.cancel()
        streamTask = nil
        endBackgroundGrace()
    }
}
