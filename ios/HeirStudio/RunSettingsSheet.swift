import SwiftUI

struct RunSettingsSheet: View {
    @ObservedObject var model: ChatModel
    @Environment(\.dismiss) private var dismiss
    @State private var models: [ModelInfo] = []
    @State private var budget: BudgetStatus?
    @State private var worktrees: WorktreeList?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                if let errorText {
                    Section { Text(errorText).foregroundStyle(.orange).font(.footnote) }
                }
                Section("Model") {
                    Picker("Model", selection: $model.selectedModel) {
                        Text("Mac default").tag("")
                        ForEach(models) { item in
                            Text(item.displayName).tag(item.id)
                        }
                    }
                    Picker("Thinking", selection: $model.reasoningEffort) {
                        Text("High").tag("high")
                        Text("Medium").tag("medium")
                        Text("Low").tag("low")
                    }
                }
                Section("Budget") {
                    if let spent = budget?.spentUsd {
                        LabeledContent("Spent today", value: String(format: "$%.2f", spent))
                    }
                    if let remaining = budget?.remainingUsd {
                        LabeledContent("Remaining", value: String(format: "$%.2f", remaining))
                    }
                    TextField("Cap this run (USD)", text: $model.maxBudgetUsd)
                        .keyboardType(.decimalPad)
                }
                Section("Worktree") {
                    Toggle("Isolated git worktree", isOn: $model.useWorktree)
                    if worktrees?.git == false {
                        Text("This project is not a git repo — the Mac will reject a worktree run.")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle("This run")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            async let listed = AppModel.sharedClient.listModels()
            async let status = AppModel.sharedClient.budget(sessionId: model.sessionId)
            async let trees = AppModel.sharedClient.listWorktrees(cwd: model.cwd)
            models = try await listed
            budget = try await status
            worktrees = try await trees
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
    }
}
