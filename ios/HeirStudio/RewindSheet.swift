import SwiftUI

/// TUI `/rewind` — drop later turns. Files on disk stay as they are.
struct RewindSheet: View {
    @ObservedObject var model: ChatModel
    @Environment(\.dismiss) private var dismiss
    @State private var points: [RewindPoint] = []
    @State private var errorText: String?
    @State private var pending: RewindPoint?

    var body: some View {
        NavigationStack {
            List {
                if let errorText {
                    Text(errorText).foregroundStyle(.orange)
                }
                ForEach(points) { point in
                    Button {
                        pending = point
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(point.text?.isEmpty == false ? point.text! : "(empty prompt)")
                                .foregroundStyle(.primary)
                                .lineLimit(3)
                            if let at = point.createdAt {
                                Text(Date(timeIntervalSince1970: at / 1000), style: .relative)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Rewind")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task { await load() }
            .confirmationDialog(
                "Rewind to this turn? Later messages leave the chat. Files on disk are not reverted.",
                isPresented: Binding(
                    get: { pending != nil },
                    set: { if !$0 { pending = nil } }),
                titleVisibility: .visible
            ) {
                Button("Rewind", role: .destructive) {
                    guard let pending else { return }
                    Task {
                        await model.rewind(to: pending)
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) { pending = nil }
            }
        }
    }

    private func load() async {
        do {
            points = try await AppModel.sharedClient.rewindPoints(model.sessionId).points
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
