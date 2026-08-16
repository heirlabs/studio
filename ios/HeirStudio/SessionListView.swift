import SwiftUI

struct SessionListView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showSettings = false
    @State private var showProjectPicker = false
    @State private var newSession: SessionSummary?

    var body: some View {
        NavigationStack {
            List {
                if model.sessions.isEmpty {
                    ContentUnavailableView(
                        "No chats yet",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Start one to prompt the agent on your Mac."))
                }
                ForEach(model.sessions) { session in
                    NavigationLink(value: session) {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(session.displayTitle)
                                    .lineLimit(1)
                                if session.activeRunId != nil {
                                    Image(systemName: "circle.fill")
                                        .font(.system(size: 7))
                                        .foregroundStyle(.green)
                                }
                            }
                            if let cwd = session.cwd {
                                Text(shortPath(cwd))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                            }
                        }
                    }
                }
                .onDelete { indexSet in
                    let ids = indexSet.map { model.sessions[$0].id }
                    Task { for id in ids { await model.deleteSession(id) } }
                }
            }
            .navigationTitle("Chats")
            .navigationDestination(for: SessionSummary.self) { session in
                ChatView(sessionId: session.id, initialTitle: session.displayTitle)
            }
            .navigationDestination(item: $newSession) { session in
                ChatView(sessionId: session.id, initialTitle: session.displayTitle)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showProjectPicker = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                }
            }
            .refreshable {
                await model.refreshSessions()
                await model.refreshHealth()
            }
            .sheet(isPresented: $showSettings) { ConnectionSettingsView() }
            .sheet(isPresented: $showProjectPicker) {
                ProjectPickerView { cwd in
                    newSession = await model.createSession(cwd: cwd)
                }
            }
            .task {
                await model.refreshHealth()
                await model.refreshSessions()
            }
        }
    }
}

struct ConnectionSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Mac") {
                    LabeledContent("Address", value: model.config?.baseURL.absoluteString ?? "—")
                    LabeledContent("Grok", value: model.health?.grokVersion ?? "—")
                    LabeledContent(
                        "Active runs",
                        value: model.health.map {
                            "\($0.activeRuns ?? 0)/\($0.maxConcurrentRuns ?? 0)"
                        } ?? "—")
                    LabeledContent(
                        "Mode", value: model.health?.settingsSummary?.permissionMode ?? "—")
                }

                if model.health?.approvalConflict?.conflict == true,
                    let message = model.health?.approvalConflict?.message
                {
                    Section("Approvals will not prompt") {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }

                Section {
                    Button("Unpair this phone", role: .destructive) {
                        Task {
                            await model.unpair()
                            dismiss()
                        }
                    }
                } footer: {
                    Text("Removes the stored token from this device's Keychain.")
                }
            }
            .navigationTitle("Connection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await model.refreshHealth() }
        }
    }
}

func shortPath(_ path: String) -> String {
    guard let range = path.range(of: "/Users/") else { return path }
    let rest = path[range.upperBound...]
    guard let slash = rest.firstIndex(of: "/") else { return path }
    return "~" + rest[slash...]
}
