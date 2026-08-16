import SwiftUI

struct HistorySearchView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var hits: [HistoryHit] = []
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List {
                if let errorText {
                    Text(errorText).font(.footnote).foregroundStyle(.orange)
                }
                ForEach(hits) { hit in
                    Button {
                        model.openSession(id: hit.sessionId)
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(hit.sessionTitle?.isEmpty == false ? hit.sessionTitle! : "Chat")
                                .font(.headline)
                            Text(hit.text)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
            }
            .navigationTitle("Search chats")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Prompts on this Mac")
            .onChange(of: query) { _, _ in
                Task { await search() }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task { await search() }
        }
    }

    private func search() async {
        do {
            hits = try await AppModel.sharedClient.history(query: query, limit: 40)
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
    }
}
