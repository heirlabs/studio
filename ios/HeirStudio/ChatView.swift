import PhotosUI
import SwiftUI
import UIKit

struct ChatView: View {
    let sessionId: String
    let initialTitle: String

    @EnvironmentObject private var appModel: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model: ChatModel
    @FocusState private var composerFocused: Bool
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var showMacPicker = false
    @State private var showGit = false
    @State private var showCheckpoints = false
    @State private var showRunSettings = false

    init(sessionId: String, initialTitle: String) {
        self.sessionId = sessionId
        self.initialTitle = initialTitle
        // The client actor is shared; ChatModel owns only this session's state.
        _model = StateObject(wrappedValue: ChatModel(client: AppModel.sharedClient, sessionId: sessionId))
    }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            Divider()
            composer
        }
        .navigationTitle(model.title.isEmpty ? initialTitle : model.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Compact context") {
                        Task { await model.compact() }
                    }
                    .disabled(model.isRunning || model.compacting)
                    Button("Checkpoints") { showCheckpoints = true }
                    Button("Model, budget, worktree") { showRunSettings = true }
                    if let percent = model.context?.percent {
                        Text("Context \(percent)%")
                    }
                } label: {
                    Image(systemName: "rectangle.compress.vertical")
                }
                .accessibilityLabel("Context")
            }
            ToolbarItem(placement: .topBarTrailing) {
                if let cwd = model.cwd, !cwd.isEmpty {
                    Button { showGit = true } label: {
                        Image(systemName: "arrow.triangle.branch")
                    }
                    .accessibilityLabel("Git")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if model.isRunning {
                    Button(role: .destructive) {
                        Task { await model.cancel() }
                    } label: {
                        Label("Stop", systemImage: "stop.circle")
                    }
                } else {
                    Menu {
                        Picker("Permission mode", selection: $model.permissionMode) {
                            Text("Ask every time").tag("default")
                            Text("Accept edits").tag("acceptEdits")
                            Text("Plan only").tag("plan")
                        }
                    } label: {
                        Image(systemName: "lock.shield")
                    }
                }
            }
        }
        .task { await model.load() }
        .onChange(of: appModel.inboundRun) { _, incoming in
            guard let incoming, incoming.sessionId == sessionId else { return }
            Task { await model.attachToIncomingRun(runId: incoming.runId, messageId: incoming.messageId) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await model.handleBecameActive() }
            } else {
                model.beginBackgroundGrace()
            }
        }
        .onDisappear {
            // Locking the phone also hits onDisappear. Only tear down when the
            // user actually pops this chat while the app is in the foreground.
            if scenePhase == .active {
                model.stopStreaming()
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in model.addImage(image) }
                .ignoresSafeArea()
        }
        .onChange(of: photoItems) { _, items in
            Task { await ingest(items) }
        }
        .sheet(item: $model.pendingPermission) { permission in
            PermissionSheet(permission: permission) { allow in
                Task { await model.respond(to: permission, allow: allow) }
            }
            .presentationDetents([.medium])
        }
        .sheet(isPresented: $showMacPicker) {
            MacFilePicker(client: appModel.client, startPath: model.cwd) { path in
                model.attachMacFile(path)
            }
        }
        .sheet(isPresented: $showGit) {
            GitSheet(client: appModel.client, cwd: model.cwd ?? "")
        }
        .sheet(isPresented: $showCheckpoints) {
            CheckpointSheet(client: appModel.client, sessionId: sessionId) { detail in
                model.applyRestored(detail)
            }
        }
        .sheet(isPresented: $showRunSettings) {
            RunSettingsSheet(model: model)
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(model.messages) { message in
                        MessageRow(
                            message: message,
                            thinkingExpanded: model.isRunning && message.id == model.messages.last?.id)
                            .id(message.id)
                    }
                    if model.isRunning || !model.tools.isEmpty {
                        ActivityStrip(
                            reconnecting: model.reconnecting,
                            isRunning: model.isRunning,
                            toolCount: model.toolCount,
                            lastTool: model.lastToolLabel,
                            tools: model.tools
                        )
                        .id("tools")
                    }
                }
                .padding(16)
            }
            .overlay(alignment: .bottom) {
                if !model.followTail, model.isRunning {
                    Button("Jump to latest") {
                        model.followTail = true
                        scrollToEnd(proxy)
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.bottom, 8)
                }
            }
            .simultaneousGesture(
                DragGesture(minimumDistance: 8).onChanged { value in
                    if value.translation.height > 12 { model.followTail = false }
                })
            .onChange(of: model.messages.count) { _, _ in scrollToEnd(proxy) }
            .onChange(of: model.toolCount) { _, _ in scrollToEnd(proxy) }
            .onChange(of: model.messages.last?.thoughts) { _, _ in scrollToEnd(proxy) }
        }
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        guard model.followTail else { return }
        withAnimation(.easeOut(duration: 0.2)) {
            if !model.tools.isEmpty {
                proxy.scrollTo("tools", anchor: .bottom)
            } else if let last = model.messages.last {
                proxy.scrollTo(last.id, anchor: .bottom)
            }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.pendingMacFiles.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.pendingMacFiles, id: \.self) { path in
                            HStack(spacing: 6) {
                                Image(systemName: "doc")
                                Text(URL(fileURLWithPath: path).lastPathComponent)
                                    .font(.caption)
                                    .lineLimit(1)
                                Button {
                                    model.removeMacFile(path)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.7))
                                }
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(.quaternary.opacity(0.4), in: .capsule)
                        }
                    }
                }
            }
            if !model.pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.pendingImages) { image in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: image.preview)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 64, height: 64)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                Button {
                                    model.removeImage(image.id)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.7))
                                }
                                .offset(x: 4, y: -4)
                            }
                        }
                    }
                }
            }
            if let queued = model.queuedText {
                HStack {
                    Text("Next: \(queued)")
                        .font(.caption)
                        .lineLimit(1)
                    Spacer()
                    Button("Clear") { model.queuedText = nil }
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
            }
            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(selection: $photoItems, maxSelectionCount: 6, matching: .images) {
                    Image(systemName: "photo")
                        .font(.system(size: 20))
                }
                .disabled(model.isRunning)

                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button { showCamera = true } label: {
                        Image(systemName: "camera")
                            .font(.system(size: 20))
                    }
                    .disabled(model.isRunning)
                }

                Button { showMacPicker = true } label: {
                    Image(systemName: "paperclip")
                        .font(.system(size: 20))
                }
                .disabled(model.isRunning)
                .accessibilityLabel("Attach Mac file")

                TextField("Describe the coding task…", text: $model.composerText, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .padding(10)
                    .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 18))
                    .focused($composerFocused)

                Button {
                    composerFocused = false
                    Task { await model.send() }
                } label: {
                    Image(systemName: model.isRunning ? "hourglass" : "arrow.up.circle.fill")
                        .font(.system(size: 30))
                }
                .disabled(!model.canSend)
            }
        }
        .padding(12)
    }

    private func ingest(_ items: [PhotosPickerItem]) async {
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self),
                let image = UIImage(data: data)
            {
                model.addImage(image)
            }
        }
        photoItems = []
    }
}

extension AppModel {
    /// One client for the process; ChatView is constructed by NavigationStack
    /// and cannot receive it through the environment at init time.
    static let sharedClient = StudioClient()
}

struct MessageRow: View {
    let message: Message
    var thinkingExpanded: Bool = false
    @State private var thinkingOpen = false

    var body: some View {
        switch message.role {
        case "user":
            HStack {
                Spacer(minLength: 40)
                VStack(alignment: .trailing, spacing: 6) {
                    if let images = message.images, !images.isEmpty {
                        Text("\(images.count) image\(images.count == 1 ? "" : "s") attached")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let text = message.text, !text.isEmpty, text != "(see attached image)" {
                        Text(text)
                    }
                }
                .padding(10)
                .background(.tint.opacity(0.25), in: .rect(cornerRadius: 14))
                .textSelection(.enabled)
            }
        case "system":
            Text(message.text ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        default:
            VStack(alignment: .leading, spacing: 8) {
                if let thoughts = message.thoughts, !thoughts.isEmpty {
                    DisclosureGroup(isExpanded: $thinkingOpen) {
                        Text(thoughts)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    } label: {
                        Label("Thinking", systemImage: "brain")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if let text = message.text, !text.isEmpty {
                    MarkdownView(text: text)
                } else if message.status == "running" {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Working…").foregroundStyle(.secondary)
                    }
                }
                if message.status == "failed" || message.status == "error" {
                    Label("Run \(message.status ?? "")", systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .onAppear {
                thinkingOpen = thinkingExpanded || message.status == "running"
            }
            .onChange(of: thinkingExpanded) { _, open in
                if open { thinkingOpen = true }
            }
        }
    }
}

struct ActivityStrip: View {
    let reconnecting: Bool
    let isRunning: Bool
    let toolCount: Int
    let lastTool: String?
    let tools: [ToolActivity]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if reconnecting {
                Label("Catching up with the Mac…", systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else if isRunning {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(statusLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            } else if toolCount > 0 {
                Text(statusLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(tools.suffix(12)) { tool in
                Label(tool.detail.isEmpty ? tool.name : tool.detail, systemImage: icon(for: tool.kind))
                    .font(.caption)
                    .foregroundStyle(tool.kind == .error ? Color.red : Color.secondary)
                    .lineLimit(2)
            }
            if tools.count > 12 {
                Text("\(tools.count - 12) earlier tools")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: .rect(cornerRadius: 10))
    }

    private func icon(for kind: ToolActivity.Kind) -> String {
        switch kind {
        case .call: "wrench"
        case .result: "checkmark"
        case .error: "exclamationmark.triangle"
        case .note: "info.circle"
        }
    }

    private var statusLine: String {
        if let lastTool, toolCount > 1 {
            return "\(toolCount) tools · \(lastTool)"
        }
        if let lastTool { return lastTool }
        if toolCount > 0 { return "\(toolCount) tools" }
        return "Working…"
    }
}

struct PermissionSheet: View {
    let permission: PendingPermission
    let respond: (Bool) -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Label(permission.title, systemImage: "lock.shield")
                    .font(.headline)

                if !permission.detail.isEmpty {
                    ScrollView {
                        Text(permission.detail)
                            .font(.system(.caption, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(10)
                    .background(.quaternary.opacity(0.3), in: .rect(cornerRadius: 10))
                }

                Text("The agent is waiting on your Mac until you answer.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                HStack(spacing: 12) {
                    Button(role: .destructive) { respond(false) } label: {
                        Text("Deny").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)

                    Button { respond(true) } label: {
                        Text("Allow").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding(20)
            .navigationTitle("Permission required")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled()
        }
    }
}
