import SwiftUI

struct CheckpointSheet: View {
    let client: StudioClient
    let sessionId: String
    var onRestored: (SessionDetail) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var items: [CheckpointSummary] = []
    @State private var errorText: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                if let errorText {
                    Text(errorText).foregroundStyle(.orange).font(.footnote)
                }
                ForEach(items) { item in
                    Button {
                        Task { await restore(item) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.label ?? "Checkpoint")
                            if let reason = item.reason {
                                Text(reason).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .disabled(busy)
                }
            }
            .navigationTitle("Checkpoints")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Save") { Task { await create() } }
                        .disabled(busy)
                }
            }
            .task { await reload() }
        }
    }

    private func reload() async {
        do { items = try await client.listCheckpoints(sessionId: sessionId) }
        catch { errorText = error.localizedDescription }
    }

    private func create() async {
        busy = true
        defer { busy = false }
        do {
            _ = try await client.createCheckpoint(sessionId: sessionId, label: "Manual")
            await reload()
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func restore(_ item: CheckpointSummary) async {
        busy = true
        defer { busy = false }
        do {
            let session = try await client.restoreCheckpoint(
                sessionId: sessionId, checkpointId: item.id)
            onRestored(session)
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}
