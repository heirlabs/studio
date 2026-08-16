import SwiftUI

/// Status / commit / push for the session's Mac cwd.
struct GitSheet: View {
    let client: StudioClient
    let cwd: String

    @Environment(\.dismiss) private var dismiss

    @State private var status: GitStatus?
    @State private var selected: Set<String> = []
    @State private var message = ""
    @State private var loading = true
    @State private var working = false
    @State private var errorText: String?
    @State private var note: String?
    @State private var presentedDiff: PresentedDiff?

    var body: some View {
        NavigationStack {
            Form {
                if let errorText {
                    Section {
                        Label(errorText, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                            .font(.footnote)
                    }
                }
                if let note {
                    Section {
                        Label(note, systemImage: "checkmark.circle")
                            .foregroundStyle(.green)
                            .font(.footnote)
                    }
                }

                Section("Repository") {
                    LabeledContent("Folder", value: shortPath(cwd))
                    LabeledContent("Branch", value: status?.branch ?? "—")
                    if let upstream = status?.upstream, !upstream.isEmpty {
                        LabeledContent("Upstream", value: upstream)
                    }
                    if let ahead = status?.ahead, let behind = status?.behind,
                        ahead > 0 || behind > 0
                    {
                        LabeledContent("Sync", value: syncLabel(ahead: ahead, behind: behind))
                    }
                    LabeledContent("State", value: stateLabel)
                }

                Section {
                    if let status, status.files.isEmpty {
                        Text(status.isClean ? "Working tree clean." : "No file list from the Mac.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(status?.files ?? []) { file in
                        fileRow(file)
                    }
                } header: {
                    Text("Changes")
                } footer: {
                    if !(status?.files.isEmpty ?? true) {
                        Text("Selected files are sent with Commit. Leave none selected to let the Mac decide.")
                    }
                }

                Section("Commit") {
                    TextField("Commit message", text: $message, axis: .vertical)
                        .lineLimit(2...6)
                    Button {
                        Task { await commit() }
                    } label: {
                        HStack {
                            if working { ProgressView().padding(.trailing, 4) }
                            Text(commitLabel)
                        }
                    }
                    .disabled(
                        working || loading
                            || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                Section {
                    Button {
                        Task { await push() }
                    } label: {
                        HStack {
                            if working { ProgressView().padding(.trailing, 4) }
                            Text("Push")
                        }
                    }
                    .disabled(working || loading)
                } footer: {
                    Text("Pushes the current branch of this project on your Mac.")
                }
            }
            .navigationTitle("Git")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await reload() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(loading || working)
                    .accessibilityLabel("Refresh")
                }
            }
            .overlay {
                if loading { ProgressView() }
            }
            .task { await reload() }
            .refreshable { await reload() }
            .sheet(item: $presentedDiff) { diff in
                GitDiffSheet(title: diff.title, text: diff.text)
            }
        }
    }

    private var stateLabel: String {
        if let status {
            return status.isClean ? "Clean" : "\(status.files.count) changed"
        }
        return "—"
    }

    private var commitLabel: String {
        if selected.isEmpty { return "Commit" }
        return "Commit \(selected.count) file\(selected.count == 1 ? "" : "s")"
    }

    private func fileRow(_ file: GitFile) -> some View {
        let on = selected.contains(file.path)
        return HStack(alignment: .center, spacing: 10) {
            Button {
                toggle(file.path)
            } label: {
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(on ? Color.accentColor : .secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(on ? "Deselect \(file.path)" : "Select \(file.path)")

            VStack(alignment: .leading, spacing: 2) {
                Text(file.path)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(file.displayStatus)
                        .font(.caption2.monospaced())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(statusColor(file.displayStatus).opacity(0.22), in: .capsule)
                    if file.staged == true {
                        Text("staged")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
            Button {
                Task { await showDiff(file, staged: nil) }
            } label: {
                Image(systemName: "doc.text.magnifyingglass")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("View diff")
        }
        .contextMenu {
            Button("Diff") { Task { await showDiff(file, staged: nil) } }
            Button("Staged diff") { Task { await showDiff(file, staged: true) } }
            Button("Unstaged diff") { Task { await showDiff(file, staged: false) } }
            Button(on ? "Deselect" : "Select") { toggle(file.path) }
        }
    }

    private func toggle(_ path: String) {
        if selected.contains(path) {
            selected.remove(path)
        } else {
            selected.insert(path)
        }
    }

    private func reload() async {
        guard !cwd.trimmingCharacters(in: .whitespaces).isEmpty else {
            errorText = "This chat has no project folder."
            loading = false
            return
        }
        loading = true
        defer { loading = false }
        do {
            let next = try await client.gitStatus(cwd: cwd)
            status = next
            let paths = Set(next.files.map(\.path))
            if selected.isEmpty {
                selected = paths
            } else {
                selected = selected.intersection(paths)
            }
            errorText = nil
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func commit() async {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        working = true
        defer { working = false }
        do {
            let paths = selected.isEmpty ? nil : Array(selected).sorted()
            let result = try await client.gitCommit(cwd: cwd, message: text, paths: paths)
            if let err = result.error, result.ok == false {
                errorText = err
                return
            }
            note = result.hash.map { "Committed \($0)" }
                ?? result.output
                ?? result.message
                ?? "Committed."
            message = ""
            errorText = nil
            await reload()
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func push() async {
        working = true
        defer { working = false }
        do {
            let result = try await client.gitPush(cwd: cwd)
            if let err = result.error, result.ok == false {
                errorText = err
                return
            }
            note = result.output ?? result.message ?? "Pushed."
            errorText = nil
            await reload()
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func showDiff(_ file: GitFile, staged: Bool?) async {
        do {
            let diff = try await client.gitDiff(cwd: cwd, staged: staged, path: file.path)
            let label = [file.path, staged == true ? "(staged)" : nil]
                .compactMap { $0 }.joined(separator: " ")
            presentedDiff = PresentedDiff(title: label, text: diff.content)
            errorText = nil
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func syncLabel(ahead: Int, behind: Int) -> String {
        var parts: [String] = []
        if ahead > 0 { parts.append("+\(ahead)") }
        if behind > 0 { parts.append("-\(behind)") }
        return parts.isEmpty ? "In sync" : parts.joined(separator: " · ")
    }

    private func statusColor(_ status: String) -> Color {
        let s = status.uppercased()
        if s.contains("D") || s.contains("DELETE") { return .red }
        if s.contains("?") || s.contains("UNTRACK") || s.contains("A") || s.contains("ADD") {
            return .green
        }
        if s.contains("R") || s.contains("RENAME") { return .purple }
        return .orange
    }

    private struct PresentedDiff: Identifiable {
        let id = UUID()
        let title: String
        let text: String
    }
}

private struct GitDiffSheet: View {
    let title: String
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(text.isEmpty ? "No diff." : text)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .background(Color.black)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
