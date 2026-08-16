import Foundation

// MARK: - Server payloads

struct Health: Codable, Sendable {
    let ok: Bool
    let grokVersion: String?
    let activeRuns: Int?
    let maxConcurrentRuns: Int?
    let approvalConflict: ApprovalConflict?
    let settingsSummary: SettingsSummary?

    struct SettingsSummary: Codable, Sendable {
        let permissionMode: String?
        let model: String?
    }
}

/// Set when the Grok CLI's own config forces always-approve, which means a
/// permission prompt will never reach the phone no matter what mode is picked.
struct ApprovalConflict: Codable, Sendable {
    let conflict: Bool
    let message: String?
}

struct SessionSummary: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let title: String?
    let cwd: String?
    let messageCount: Int?
    let updatedAt: Double?
    let activeRunId: String?
    let lastPreview: String?
    let grokSessionId: String?
    let context: SessionContext?

    var displayTitle: String { (title?.isEmpty == false ? title! : nil) ?? "New chat" }
    var isLive: Bool { activeRunId != nil }
}

struct SessionContext: Codable, Sendable, Hashable {
    let used: Int?
    let total: Int?
    let percent: Int?
    let compactedAt: Double?
    let lastNote: String?
    let trigger: String?
    let tokensBefore: Int?
    let tokensAfter: Int?
}

struct RewindPoint: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let index: Int?
    let text: String?
    let createdAt: Double?
}

struct RewindList: Codable, Sendable {
    let points: [RewindPoint]
    let active: Bool?
}

struct RewindResult: Codable, Sendable {
    let ok: Bool?
    let grokRewound: Bool?
    let grokError: String?
    let filesReverted: Bool?
    let session: SessionDetail?
}

struct CompactResult: Codable, Sendable {
    let ok: Bool?
    let grokSessionId: String?
    let context: SessionContext?
    let summary: String?
}

struct ContextResponse: Codable, Sendable {
    let grokSessionId: String?
    let active: Bool?
    let context: SessionContext?
}

struct HistoryHit: Codable, Identifiable, Sendable, Hashable {
    let sessionId: String
    let sessionTitle: String?
    let messageId: String?
    let text: String
    let at: Double?
    let cwd: String?
    var id: String { "\(sessionId):\(messageId ?? text)" }
}

struct HistoryList: Codable, Sendable {
    let hits: [HistoryHit]
}

struct CheckpointSummary: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let label: String?
    let reason: String?
    let createdAt: Double?
}

struct CheckpointList: Codable, Sendable {
    let checkpoints: [CheckpointSummary]
}

struct CheckpointRestore: Codable, Sendable {
    let ok: Bool?
    let session: SessionDetail?
}

struct SessionList: Codable, Sendable {
    let activeId: String?
    let sessions: [SessionSummary]
}

struct Message: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let role: String
    var text: String?
    var thoughts: String?
    var status: String?
    var runId: String?
    var images: [String]?
    let at: Double?
}

struct SessionDetail: Codable, Sendable {
    let id: String
    let title: String?
    let cwd: String?
    var messages: [Message]
    var grokSessionId: String?
    var context: SessionContext?
    var lastPreview: String?
    var activeRunId: String?
}

struct RunMeta: Codable, Sendable {
    let id: String
    let status: String?
    let permissionMode: String?
    let transport: String?
    let model: String?
}

struct PostMessageResponse: Codable, Sendable {
    let session: SessionDetail
    let userMessage: Message
    let assistantMessage: Message
    let run: RunEnvelope
    let permissionDowngradedFrom: String?

    struct RunEnvelope: Codable, Sendable {
        let id: String
        let meta: RunMeta
    }
}

struct ActiveRun: Codable, Sendable {
    let active: Bool
    let runId: String?
    let messageId: String?
}

struct APIError: Codable, Sendable { let error: String? }

struct HubEvent: Decodable, Sendable {
    let type: String
    let event: String?
    let sessionId: String?
    let runId: String?
    let messageId: String?
    let status: String?
    let session: SessionSummary?
}

struct ProjectState: Codable, Sendable {
    let current: String?
    let recent: [String]
}

struct DirectoryListing: Codable, Sendable {
    let path: String
    let parent: String?
    let home: String?
    let entries: [DirEntry]
}

struct DirEntry: Codable, Sendable, Identifiable {
    let name: String
    let path: String
    let type: String
    let size: Int64?
    var id: String { path }

    var isDirectory: Bool { type == "dir" || type == "directory" }
}

struct FileContents: Codable, Sendable {
    let path: String
    let text: String?

    var contents: String { text ?? "" }
}

struct GitStatus: Codable, Sendable {
    var cwd: String?
    var branch: String?
    var upstream: String?
    var ahead: Int?
    var behind: Int?
    var clean: Bool?
    var files: [GitFile]

    var isClean: Bool {
        if let clean { return clean }
        return files.isEmpty
    }

    private enum CodingKeys: String, CodingKey {
        case cwd, branch, upstream, ahead, behind, clean, files
        case current, head, entries, changes, dirty
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd)
        branch =
            try c.decodeIfPresent(String.self, forKey: .branch)
            ?? c.decodeIfPresent(String.self, forKey: .current)
            ?? c.decodeIfPresent(String.self, forKey: .head)
        upstream = try c.decodeIfPresent(String.self, forKey: .upstream)
        ahead = try c.decodeIfPresent(Int.self, forKey: .ahead)
        behind = try c.decodeIfPresent(Int.self, forKey: .behind)
        if let clean = try c.decodeIfPresent(Bool.self, forKey: .clean) {
            self.clean = clean
        } else if let dirty = try c.decodeIfPresent(Bool.self, forKey: .dirty) {
            self.clean = !dirty
        } else {
            self.clean = nil
        }
        files =
            try c.decodeIfPresent([GitFile].self, forKey: .files)
            ?? c.decodeIfPresent([GitFile].self, forKey: .entries)
            ?? c.decodeIfPresent([GitFile].self, forKey: .changes)
            ?? []
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(cwd, forKey: .cwd)
        try c.encodeIfPresent(branch, forKey: .branch)
        try c.encodeIfPresent(upstream, forKey: .upstream)
        try c.encodeIfPresent(ahead, forKey: .ahead)
        try c.encodeIfPresent(behind, forKey: .behind)
        try c.encodeIfPresent(clean, forKey: .clean)
        try c.encode(files, forKey: .files)
    }
}

struct GitFile: Codable, Identifiable, Sendable, Hashable {
    var path: String
    var status: String?
    var staged: Bool?
    var index: String?
    var worktree: String?

    var id: String { path }

    var displayStatus: String {
        if let status, !status.trimmingCharacters(in: .whitespaces).isEmpty {
            return status
        }
        let xy = "\(index ?? "")\(worktree ?? "")"
            .trimmingCharacters(in: .whitespaces)
        return xy.isEmpty ? "?" : xy
    }

    private enum CodingKeys: String, CodingKey {
        case path, name, status, staged, index, worktree, xy
    }

    init(
        path: String, status: String? = nil, staged: Bool? = nil, index: String? = nil,
        worktree: String? = nil
    ) {
        self.path = path
        self.status = status
        self.staged = staged
        self.index = index
        self.worktree = worktree
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path =
            try c.decodeIfPresent(String.self, forKey: .path)
            ?? c.decodeIfPresent(String.self, forKey: .name)
            ?? ""
        status =
            try c.decodeIfPresent(String.self, forKey: .status)
            ?? c.decodeIfPresent(String.self, forKey: .xy)
        staged = try c.decodeIfPresent(Bool.self, forKey: .staged)
        index = try c.decodeIfPresent(String.self, forKey: .index)
        worktree = try c.decodeIfPresent(String.self, forKey: .worktree)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(path, forKey: .path)
        try c.encodeIfPresent(status, forKey: .status)
        try c.encodeIfPresent(staged, forKey: .staged)
        try c.encodeIfPresent(index, forKey: .index)
        try c.encodeIfPresent(worktree, forKey: .worktree)
    }
}

struct GitDiff: Codable, Sendable {
    var path: String?
    var staged: Bool?
    var diff: String?
    var text: String?
    var patch: String?

    var content: String { diff ?? patch ?? text ?? "" }
}

struct GitActionResult: Codable, Sendable {
    var ok: Bool? = nil
    var hash: String? = nil
    var output: String? = nil
    var error: String? = nil
    var message: String? = nil
    var remote: String? = nil
    var branch: String? = nil
}

// MARK: - Stream events

/// One `data:` frame from /api/runs/:id/stream. The server normalizes both the
/// headless and ACP transports onto this shape, so the client needs one decoder.
struct StreamEvent: Decodable, Sendable {
    let type: String
    let event: String?
    let data: String?
    let name: String?
    let message: String?
    let status: String?
    let id: StringOrInt?
    let reason: String?
    let decision: String?
    let seq: Int?
    let tokensBefore: Int?
    let tokensAfter: Int?
    let trigger: String?
    let toolCall: ToolCall?
    let options: [PermissionOption]?
    let input: AnyCodable?
    let result: AnyCodable?

    struct ToolCall: Decodable, Sendable {
        let title: String?
        let kind: String?
        let rawInput: AnyCodable?
    }

    var permissionID: String? { id?.stringValue }
}

struct PermissionOption: Decodable, Sendable, Identifiable, Hashable {
    let optionId: String
    let name: String?
    let kind: String?
    var id: String { optionId }

    var isAllow: Bool { kind == "allow_once" || kind == "allow_always" }
}

/// JSON-RPC ids arrive as either a number or a string.
enum StringOrInt: Decodable, Sendable {
    case string(String), int(Int)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let i = try? c.decode(Int.self) { self = .int(i); return }
        self = .string(try c.decode(String.self))
    }

    var stringValue: String {
        switch self {
        case .string(let s): return s
        case .int(let i): return String(i)
        }
    }
}

/// Minimal any-JSON holder so tool payloads can be shown without a schema.
struct AnyCodable: Decodable, Sendable {
    let preview: String

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { preview = s }
        else if let b = try? c.decode(Bool.self) { preview = String(b) }
        else if let d = try? c.decode(Double.self) {
            preview = d == d.rounded() ? String(Int(d)) : String(d)
        } else if let dict = try? c.decode([String: AnyCodable].self) {
            preview = "{" + dict.map { "\($0.key): \($0.value.preview)" }
                .sorted().joined(separator: ", ") + "}"
        } else if let arr = try? c.decode([AnyCodable].self) {
            preview = "[" + arr.map(\.preview).joined(separator: ", ") + "]"
        } else {
            preview = ""
        }
    }
}

// MARK: - UI view models

struct ToolActivity: Identifiable, Sendable, Hashable {
    enum Kind: Sendable { case call, result, error, note }
    let id = UUID()
    let name: String
    let kind: Kind
    let detail: String
}

struct ModelInfo: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let name: String?
    let description: String?
    let contextWindow: Int?
    var displayName: String { name?.isEmpty == false ? name! : id }
}

struct ModelList: Codable, Sendable {
    let models: [ModelInfo]
}

struct BudgetStatus: Codable, Sendable {
    let spentUsd: Double?
    let maxBudgetUsd: Double?
    let remainingUsd: Double?
    let turns: Int?
}

struct WorktreeInfo: Codable, Identifiable, Sendable, Hashable {
    let name: String
    let path: String?
    let branch: String?
    var id: String { name }
}

struct WorktreeList: Codable, Sendable {
    let git: Bool?
    let worktrees: [WorktreeInfo]
    let cwd: String?
}

struct PendingPermission: Identifiable, Sendable, Equatable {
    let id: String
    let runId: String
    let title: String
    let detail: String
    let allowOptionId: String?
    let denyOptionId: String?
}
