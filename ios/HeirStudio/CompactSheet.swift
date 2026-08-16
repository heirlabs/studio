import SwiftUI

/// TUI `/compact [keep]` — optional note about what Grok should preserve.
struct CompactSheet: View {
    @ObservedObject var model: ChatModel
    @Environment(\.dismiss) private var dismiss
    @State private var keep = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What should Grok keep? (optional)", text: $keep, axis: .vertical)
                        .lineLimit(3...8)
                } footer: {
                    Text(
                        "Same as /compact in the terminal. Leave empty to let Grok decide. "
                            + "Cannot run while a turn is live.")
                }
                if let percent = model.context?.percent {
                    Section("Current window") {
                        LabeledContent("Used", value: "\(percent)%")
                        if let before = model.context?.tokensBefore,
                            let after = model.context?.tokensAfter
                        {
                            LabeledContent("Last compact", value: "\(before) → \(after)")
                        }
                    }
                }
            }
            .navigationTitle("Compact context")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.compacting ? "Working…" : "Compact") {
                        Task {
                            await model.compact(keep: keep.isEmpty ? nil : keep)
                            dismiss()
                        }
                    }
                    .disabled(model.isRunning || model.compacting)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
