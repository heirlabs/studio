import SwiftUI

// MARK: - Model

struct UnifiedDiff: Equatable, Sendable {
    var files: [DiffFile]
}

struct DiffFile: Equatable, Sendable {
    var oldPath: String?
    var newPath: String?
    var hunks: [DiffHunk]

    /// Prefer the new path, then the old path, stripping `a/` / `b/` and `/dev/null`.
    var displayPath: String {
        let cleanedNew = Self.displayable(newPath)
        let cleanedOld = Self.displayable(oldPath)
        if let cleanedNew, let cleanedOld, cleanedNew != cleanedOld {
            return "\(cleanedOld) → \(cleanedNew)"
        }
        return cleanedNew ?? cleanedOld ?? "diff"
    }

    private static func displayable(_ path: String?) -> String? {
        guard var path, !path.isEmpty, path != "/dev/null" else { return nil }
        if path.hasPrefix("a/") || path.hasPrefix("b/") {
            path = String(path.dropFirst(2))
        }
        return path
    }
}

struct DiffHunk: Equatable, Sendable {
    var header: String
    var lines: [DiffLine]
}

struct DiffLine: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case add
        case remove
        case context
        case meta
    }

    var kind: Kind
    var text: String
}

// MARK: - Parser

enum UnifiedDiffParser: Sendable {
    static func parse(_ source: String) -> UnifiedDiff {
        let lines = Self.lines(from: source)
        var files: [DiffFile] = []
        var current = DiffFile(oldPath: nil, newPath: nil, hunks: [])
        var currentHunk: DiffHunk?

        func flushHunk() {
            if let hunk = currentHunk {
                current.hunks.append(hunk)
                currentHunk = nil
            }
        }

        func flushFile() {
            flushHunk()
            if current.oldPath != nil || current.newPath != nil || !current.hunks.isEmpty {
                files.append(current)
            }
            current = DiffFile(oldPath: nil, newPath: nil, hunks: [])
        }

        for line in lines {
            if line.hasPrefix("diff --git ") {
                flushFile()
                continue
            }
            if line.hasPrefix("--- ") {
                if current.oldPath != nil && (!current.hunks.isEmpty || current.newPath != nil) {
                    flushFile()
                }
                current.oldPath = cleanPath(line)
                continue
            }
            if line.hasPrefix("+++ ") {
                current.newPath = cleanPath(line)
                continue
            }
            if line.hasPrefix("@@") {
                flushHunk()
                currentHunk = DiffHunk(header: line, lines: [])
                continue
            }
            guard currentHunk != nil else { continue }
            if line.hasPrefix("+") {
                currentHunk?.lines.append(DiffLine(kind: .add, text: line))
            } else if line.hasPrefix("-") {
                currentHunk?.lines.append(DiffLine(kind: .remove, text: line))
            } else if line.hasPrefix("\\") {
                currentHunk?.lines.append(DiffLine(kind: .meta, text: line))
            } else {
                currentHunk?.lines.append(DiffLine(kind: .context, text: line))
            }
        }
        flushFile()
        return UnifiedDiff(files: files)
    }

    /// True when the block is a unified diff: `---` / `+++` plus a hunk, or a git header.
    static func looksLikeUnifiedDiff(_ text: String) -> Bool {
        var hasOld = false
        var hasNew = false
        var hasHunk = false
        var hasGit = false
        for line in lines(from: text) {
            if line.hasPrefix("diff --git ") { hasGit = true }
            else if line.hasPrefix("--- ") { hasOld = true }
            else if line.hasPrefix("+++ ") { hasNew = true }
            else if line.hasPrefix("@@") { hasHunk = true }
        }
        if hasHunk && (hasOld || hasNew || hasGit) { return true }
        return hasOld && hasNew
    }

    static func cleanPath(_ headerLine: String) -> String {
        var value = headerLine
        if value.hasPrefix("--- ") || value.hasPrefix("+++ ") {
            value = String(value.dropFirst(4))
        }
        if let tab = value.firstIndex(of: "\t") {
            value = String(value[..<tab])
        }
        return value.trimmingCharacters(in: .whitespaces)
    }

    private static func lines(from source: String) -> [String] {
        source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
            .map(String.init)
    }
}

// MARK: - View

struct DiffView: View {
    let diff: UnifiedDiff

    init(diff: UnifiedDiff) {
        self.diff = diff
    }

    init(text: String) {
        self.diff = UnifiedDiffParser.parse(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(diff.files.enumerated()), id: \.offset) { _, file in
                fileCard(file)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func fileCard(_ file: DiffFile) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            fileHeader(file)
            ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                hunkBody(hunk)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(.quaternary, lineWidth: 1)
        )
    }

    private func fileHeader(_ file: DiffFile) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: "plus.forwardslash.minus")
                    .font(.caption2)
                Text(file.displayPath)
                    .font(.system(.caption, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
            }
            if let oldPath = file.oldPath {
                Text("--- \(oldPath)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if let newPath = file.newPath {
                Text("+++ \(newPath)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4))
    }

    private func hunkBody(_ hunk: DiffHunk) -> some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                Text(hunk.header)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Color.blue.opacity(0.16))
                    .lineLimit(1)

                ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                    Text(line.text.isEmpty ? " " : line.text)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(foreground(for: line.kind))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 1)
                        .background(background(for: line.kind))
                        .lineLimit(1)
                }
            }
            .textSelection(.enabled)
        }
    }

    private func foreground(for kind: DiffLine.Kind) -> Color {
        switch kind {
        case .add: Color.green
        case .remove: Color.red
        case .context, .meta: Color.secondary
        }
    }

    private func background(for kind: DiffLine.Kind) -> Color {
        switch kind {
        case .add: Color.green.opacity(0.18)
        case .remove: Color.red.opacity(0.18)
        case .context, .meta: Color.clear
        }
    }
}
