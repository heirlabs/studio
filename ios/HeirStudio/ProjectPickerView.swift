import SwiftUI

/// Pick a folder that already exists on the paired Mac. The phone cannot
/// browse its own Files app for this — the agent runs on the Mac.
struct ProjectPickerView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var onPick: (String) async -> Void

    @State private var listing: DirectoryListing?
    @State private var recents: [String] = []
    @State private var current: String?
    @State private var typed = ""
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List {
                if let errorText {
                    Section {
                        Label(errorText, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                            .font(.footnote)
                    }
                }

                if !recents.isEmpty {
                    Section("Recent on this Mac") {
                        ForEach(recents, id: \.self) { path in
                            Button {
                                Task { await pick(path) }
                            } label: {
                                Label(shortPath(path), systemImage: "clock")
                                    .foregroundStyle(.primary)
                            }
                        }
                    }
                }

                Section("Browse this Mac") {
                    TextField("Path on the Mac", text: $typed)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                        .onSubmit { Task { await load(typed) } }

                    if let listing {
                        if let parent = listing.parent {
                            Button {
                                Task { await load(parent) }
                            } label: {
                                Label("..", systemImage: "arrow.up.left")
                            }
                        }
                        ForEach(listing.entries) { entry in
                            Button {
                                Task { await load(entry.path) }
                            } label: {
                                Label(entry.name, systemImage: "folder")
                                    .foregroundStyle(.primary)
                            }
                        }
                        if listing.entries.isEmpty {
                            Text("No subfolders")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Project folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use folder") {
                        Task { await pick(typed) }
                    }
                    .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty || loading)
                }
            }
            .overlay {
                if loading { ProgressView() }
            }
            .task { await bootstrap() }
        }
    }

    private func bootstrap() async {
        loading = true
        defer { loading = false }
        do {
            let project = try await model.client.project()
            recents = project.recent
            current = project.current
            await load(project.current ?? "~")
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            await load("~")
        }
    }

    private func load(_ path: String) async {
        loading = true
        defer { loading = false }
        do {
            let listing = try await model.client.listDirectory(path)
            self.listing = listing
            typed = listing.path
            errorText = nil
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func pick(_ path: String) async {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        loading = true
        defer { loading = false }
        await onPick(trimmed)
        dismiss()
    }
}
