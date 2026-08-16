import SwiftUI

/// Browse files on the paired Mac and attach a path as chat context.
/// The bytes never leave the Mac — the agent already has the filesystem.
struct MacFilePicker: View {
    let client: StudioClient
    var startPath: String?
    var onAttach: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var listing: DirectoryListing?
    @State private var typed = ""
    @State private var filter = ""
    @State private var loading = true
    @State private var errorText: String?
    @State private var pendingFile: DirEntry?
    @State private var previewText: String?
    @State private var loadingPreview = false

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

                Section {
                    TextField("Path on the Mac", text: $typed)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                        .onSubmit { Task { await load(typed) } }
                    TextField("Filter by name", text: $filter)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section(listing.map { shortPath($0.path) } ?? "Browse this Mac") {
                    if let parent = listing?.parent {
                        Button {
                            Task { await load(parent) }
                        } label: {
                            Label("..", systemImage: "arrow.up.left")
                        }
                    }
                    ForEach(visibleEntries) { entry in
                        Button {
                            Task { await handle(entry) }
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: icon(for: entry))
                                    .foregroundStyle(entry.isDirectory ? .primary : .secondary)
                                    .frame(width: 22)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.name)
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    if !entry.isDirectory, let size = entry.size {
                                        Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer(minLength: 0)
                                if entry.isDirectory {
                                    Image(systemName: "chevron.right")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                    if let listing, listing.entries.isEmpty {
                        Text("Empty folder")
                            .foregroundStyle(.secondary)
                    } else if listing != nil, visibleEntries.isEmpty {
                        Text("No matches")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Attach from Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .overlay {
                if loading { ProgressView() }
            }
            .task { await bootstrap() }
            .sheet(item: $pendingFile, onDismiss: {
                previewText = nil
            }) { file in
                attachConfirmation(file)
            }
        }
    }

    private var visibleEntries: [DirEntry] {
        let entries = listing?.entries ?? []
        let q = filter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let filtered =
            q.isEmpty ? entries : entries.filter { $0.name.lowercased().contains(q) }
        return filtered.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory && !b.isDirectory }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    @ViewBuilder
    private func attachConfirmation(_ file: DirEntry) -> some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                Label(file.name, systemImage: "doc")
                    .font(.headline)
                Text(file.path)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                if let size = file.size {
                    Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if loadingPreview {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if let previewText, !previewText.isEmpty {
                    ScrollView {
                        Text(previewText)
                            .font(.system(.caption2, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 240)
                    .padding(10)
                    .background(.quaternary.opacity(0.3), in: .rect(cornerRadius: 10))
                }

                Spacer()

                Text("The file stays on your Mac. The agent will read it from this path.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    onAttach(file.path)
                    pendingFile = nil
                    dismiss()
                } label: {
                    Text("Attach").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(20)
            .navigationTitle("Attach file")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { pendingFile = nil }
                }
            }
            .task { await loadPreview(file.path) }
        }
        .presentationDetents([.medium, .large])
    }

    private func icon(for entry: DirEntry) -> String {
        if entry.isDirectory { return "folder" }
        let ext = URL(fileURLWithPath: entry.name).pathExtension.lowercased()
        switch ext {
        case "swift", "js", "ts", "tsx", "py", "go", "rs", "rb", "java", "kt":
            return "chevron.left.forwardslash.chevron.right"
        case "md", "txt", "json", "yml", "yaml", "toml", "xml":
            return "doc.text"
        case "png", "jpg", "jpeg", "gif", "webp", "heic":
            return "photo"
        default:
            return "doc"
        }
    }

    private func bootstrap() async {
        loading = true
        defer { loading = false }
        if let startPath, !startPath.trimmingCharacters(in: .whitespaces).isEmpty {
            await load(startPath)
            return
        }
        if let project = try? await client.project(), let current = project.current {
            await load(current)
        } else {
            await load("~")
        }
    }

    private func load(_ path: String) async {
        loading = true
        defer { loading = false }
        do {
            let listing = try await client.listDirectory(path, includeFiles: true)
            self.listing = listing
            typed = listing.path
            errorText = nil
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func handle(_ entry: DirEntry) async {
        if entry.isDirectory {
            await load(entry.path)
        } else {
            pendingFile = entry
        }
    }

    private func loadPreview(_ path: String) async {
        loadingPreview = true
        defer { loadingPreview = false }
        guard let file = try? await client.readFile(at: path) else {
            previewText = nil
            return
        }
        let text = file.contents
        if text.isEmpty {
            previewText = nil
        } else if text.count > 2_000 {
            previewText = String(text.prefix(2_000)) + "\n…"
        } else {
            previewText = text
        }
    }
}
