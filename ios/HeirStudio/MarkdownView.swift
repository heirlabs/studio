import SwiftUI

// MARK: - AST

enum MarkdownInline: Equatable, Sendable {
    case text(String)
    case bold([MarkdownInline])
    case italic([MarkdownInline])
    case code(String)
    case link(text: String, url: URL)
}

enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, inlines: [MarkdownInline])
    case paragraph(inlines: [MarkdownInline])
    case unorderedList(items: [[MarkdownInline]])
    case orderedList(start: Int, items: [[MarkdownInline]])
    case code(language: String, code: String)
    case diff(UnifiedDiff)
}

// MARK: - Parser

enum MarkdownParser: Sendable {
    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
            .map(String.init)

        var blocks: [MarkdownBlock] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                i += 1
                continue
            }

            if let language = fenceLanguage(line) {
                i += 1
                var body: [String] = []
                while i < lines.count {
                    if isFenceLine(lines[i]) {
                        i += 1
                        break
                    }
                    body.append(lines[i])
                    i += 1
                }
                if body.last?.isEmpty == true { body.removeLast() }
                let code = body.joined(separator: "\n")
                blocks.append(codeBlock(language: language, code: code))
                continue
            }

            if let (level, rest) = heading(line) {
                blocks.append(.heading(level: level, inlines: parseInlines(rest)))
                i += 1
                continue
            }

            if isUnorderedItem(line) {
                var items: [[MarkdownInline]] = []
                while i < lines.count, isUnorderedItem(lines[i]) {
                    var item = parseInlines(String(lines[i].dropFirst(2)))
                    i += 1
                    consumeContinuations(lines: lines, index: &i, into: &item)
                    items.append(item)
                }
                blocks.append(.unorderedList(items: items))
                continue
            }

            if let first = orderedItem(line) {
                var items: [[MarkdownInline]] = []
                let start = first.number
                while i < lines.count, let item = orderedItem(lines[i]) {
                    var inlines = parseInlines(item.text)
                    i += 1
                    consumeContinuations(lines: lines, index: &i, into: &inlines)
                    items.append(inlines)
                }
                blocks.append(.orderedList(start: start, items: items))
                continue
            }

            if isDiffPreamble(line), looksLikeDiff(from: i, in: lines) {
                var body: [String] = []
                while i < lines.count {
                    let candidate = lines[i]
                    if !body.isEmpty && isMarkdownInterrupt(candidate) { break }
                    if !body.isEmpty && candidate.trimmingCharacters(in: .whitespaces).isEmpty {
                        let next = nextNonempty(after: i, in: lines)
                        if let next, !isDiffContinuation(next) { break }
                    }
                    body.append(candidate)
                    i += 1
                }
                let parsed = UnifiedDiffParser.parse(body.joined(separator: "\n"))
                if parsed.files.isEmpty {
                    blocks.append(.paragraph(inlines: parseInlines(body.joined(separator: "\n"))))
                } else {
                    blocks.append(.diff(parsed))
                }
                continue
            }

            var paragraphLines = [line]
            i += 1
            while i < lines.count {
                let next = lines[i]
                if next.trimmingCharacters(in: .whitespaces).isEmpty { break }
                if isBlockStart(next, remaining: lines.suffix(from: i + 1)) { break }
                paragraphLines.append(next)
                i += 1
            }
            blocks.append(.paragraph(inlines: parseInlines(paragraphLines.joined(separator: "\n"))))
        }
        return blocks
    }

    static func parseInlines(_ source: String) -> [MarkdownInline] {
        var result: [MarkdownInline] = []
        var i = source.startIndex
        var textStart = i

        func flush(upTo end: String.Index) {
            if textStart < end {
                result.append(.text(String(source[textStart..<end])))
            }
        }

        while i < source.endIndex {
            if source[i] == "\\" {
                let next = source.index(after: i)
                if next < source.endIndex {
                    flush(upTo: i)
                    result.append(.text(String(source[next])))
                    i = source.index(after: next)
                    textStart = i
                    continue
                }
            }

            if source[i] == "`" {
                let content = source.index(after: i)
                if content < source.endIndex,
                    let close = find(source, token: "`", from: content),
                    close >= content
                {
                    flush(upTo: i)
                    result.append(.code(String(source[content..<close])))
                    i = source.index(after: close)
                    textStart = i
                    continue
                }
            }

            if source[i] == "[", let link = parseLink(source, from: i) {
                flush(upTo: i)
                result.append(.link(text: link.text, url: link.url))
                i = link.end
                textStart = i
                continue
            }

            if source[i...].hasPrefix("**") {
                let content = source.index(i, offsetBy: 2)
                if content < source.endIndex,
                    let close = find(source, token: "**", from: content),
                    close > content
                {
                    flush(upTo: i)
                    result.append(.bold(parseInlines(String(source[content..<close]))))
                    i = source.index(close, offsetBy: 2)
                    textStart = i
                    continue
                }
            }

            if source[i...].hasPrefix("__") {
                let prevOK = i == source.startIndex || !isWordChar(source[source.index(before: i)])
                let content = source.index(i, offsetBy: 2)
                if prevOK, content < source.endIndex,
                    let close = find(source, token: "__", from: content),
                    close > content
                {
                    flush(upTo: i)
                    result.append(.bold(parseInlines(String(source[content..<close]))))
                    i = source.index(close, offsetBy: 2)
                    textStart = i
                    continue
                }
            }

            if source[i] == "*" {
                let content = source.index(after: i)
                if content < source.endIndex,
                    !source[content].isWhitespace,
                    let close = findEmphasisClose(source, mark: "*", from: content)
                {
                    flush(upTo: i)
                    result.append(.italic(parseInlines(String(source[content..<close]))))
                    i = source.index(after: close)
                    textStart = i
                    continue
                }
            }

            if source[i] == "_" {
                let prevOK = i == source.startIndex || !isWordChar(source[source.index(before: i)])
                let content = source.index(after: i)
                if prevOK, content < source.endIndex,
                    !source[content].isWhitespace,
                    let close = findEmphasisClose(source, mark: "_", from: content)
                {
                    let after = source.index(after: close)
                    if after == source.endIndex || !isWordChar(source[after]) {
                        flush(upTo: i)
                        result.append(.italic(parseInlines(String(source[content..<close]))))
                        i = after
                        textStart = i
                        continue
                    }
                }
            }

            i = source.index(after: i)
        }
        flush(upTo: source.endIndex)
        return result
    }

    // MARK: Block helpers

    private static func codeBlock(language: String, code: String) -> MarkdownBlock {
        let parsed = UnifiedDiffParser.parse(code)
        if isDiffLanguage(language) || UnifiedDiffParser.looksLikeUnifiedDiff(code), !parsed.files.isEmpty {
            return .diff(parsed)
        }
        return .code(language: language, code: code)
    }

    static func isDiffLanguage(_ language: String) -> Bool {
        language == "diff" || language == "udiff" || language == "patch"
    }

    private static func fenceLanguage(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("```") else { return nil }
        return String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func isFenceLine(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix("```")
    }

    private static func heading(_ line: String) -> (Int, String)? {
        if line.hasPrefix("### ") {
            return (3, line.dropFirst(4).trimmingCharacters(in: .whitespaces))
        }
        if line.hasPrefix("## ") {
            return (2, line.dropFirst(3).trimmingCharacters(in: .whitespaces))
        }
        if line.hasPrefix("# ") {
            return (1, line.dropFirst(2).trimmingCharacters(in: .whitespaces))
        }
        return nil
    }

    private static func isUnorderedItem(_ line: String) -> Bool {
        line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ")
    }

    private static func orderedItem(_ line: String) -> (number: Int, text: String)? {
        guard let dot = line.firstIndex(of: ".") else { return nil }
        let numberPart = line[..<dot]
        guard let number = Int(numberPart), number >= 0 else { return nil }
        let afterDot = line.index(after: dot)
        guard afterDot < line.endIndex, line[afterDot] == " " else { return nil }
        let textStart = line.index(after: afterDot)
        return (number, String(line[textStart...]))
    }

    private static func isDiffPreamble(_ line: String) -> Bool {
        line.hasPrefix("diff --git ") || line.hasPrefix("--- ")
    }

    private static func looksLikeDiff(from start: Int, in lines: [String]) -> Bool {
        var hasNew = false
        var hasHunk = false
        let limit = min(lines.count, start + 60)
        var i = start
        while i < limit {
            let line = lines[i]
            if i > start && isFenceLine(line) { break }
            if i > start && heading(line) != nil { break }
            if line.hasPrefix("+++ ") { hasNew = true }
            if line.hasPrefix("@@") { hasHunk = true }
            if hasNew && hasHunk { return true }
            i += 1
        }
        return false
    }

    private static func isDiffContinuation(_ line: String) -> Bool {
        if line.hasPrefix("diff --git ") { return true }
        if line.hasPrefix("index ") { return true }
        if line.hasPrefix("new file ") || line.hasPrefix("deleted file ") { return true }
        if line.hasPrefix("old mode ") || line.hasPrefix("new mode ") { return true }
        if line.hasPrefix("similarity ") || line.hasPrefix("dissimilarity ") { return true }
        if line.hasPrefix("rename ") || line.hasPrefix("copy ") { return true }
        if line.hasPrefix("--- ") || line.hasPrefix("+++ ") { return true }
        if line.hasPrefix("@@") { return true }
        if line.hasPrefix("+") || line.hasPrefix("-") || line.hasPrefix(" ") || line.hasPrefix("\\") {
            return true
        }
        if line.hasPrefix("Binary files ") { return true }
        return false
    }

    private static func isMarkdownInterrupt(_ line: String) -> Bool {
        isFenceLine(line) || heading(line) != nil
    }

    private static func isBlockStart(_ line: String, remaining: ArraySlice<String> = []) -> Bool {
        if fenceLanguage(line) != nil { return true }
        if heading(line) != nil { return true }
        if isUnorderedItem(line) || orderedItem(line) != nil { return true }
        if isDiffPreamble(line) {
            var window = [line]
            window.append(contentsOf: remaining)
            if looksLikeDiff(from: 0, in: window) { return true }
        }
        return false
    }

    private static func nextNonempty(after index: Int, in lines: [String]) -> String? {
        var i = index + 1
        while i < lines.count {
            if !lines[i].trimmingCharacters(in: .whitespaces).isEmpty { return lines[i] }
            i += 1
        }
        return nil
    }

    private static func consumeContinuations(
        lines: [String],
        index: inout Int,
        into item: inout [MarkdownInline]
    ) {
        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { return }
            if isBlockStart(line, remaining: lines.suffix(from: index + 1)) { return }
            guard line.hasPrefix("  ") || line.hasPrefix("\t") else { return }
            let extra = parseInlines(line.trimmingCharacters(in: .whitespaces))
            if !extra.isEmpty {
                if !item.isEmpty { item.append(.text(" ")) }
                item.append(contentsOf: extra)
            }
            index += 1
        }
    }

    // MARK: Inline helpers

    private static func find(_ source: String, token: String, from: String.Index) -> String.Index? {
        var j = from
        while j < source.endIndex {
            if source[j] == "\\" {
                j = source.index(after: j)
                if j < source.endIndex { j = source.index(after: j) }
                continue
            }
            if source[j...].hasPrefix(token) { return j }
            j = source.index(after: j)
        }
        return nil
    }

    private static func findEmphasisClose(_ source: String, mark: Character, from: String.Index)
        -> String.Index?
    {
        var j = from
        while j < source.endIndex {
            if source[j] == "\\" {
                j = source.index(after: j)
                if j < source.endIndex { j = source.index(after: j) }
                continue
            }
            if source[j] == mark {
                let prev = source[source.index(before: j)]
                if !prev.isWhitespace { return j }
            }
            j = source.index(after: j)
        }
        return nil
    }

    private static func parseLink(_ source: String, from: String.Index) -> (
        text: String, url: URL, end: String.Index
    )? {
        guard source[from] == "[" else { return nil }
        var i = source.index(after: from)
        var label = ""
        while i < source.endIndex, source[i] != "]" {
            if source[i] == "\n" { return nil }
            label.append(source[i])
            i = source.index(after: i)
        }
        guard i < source.endIndex else { return nil }
        i = source.index(after: i)
        guard i < source.endIndex, source[i] == "(" else { return nil }
        i = source.index(after: i)
        var raw = ""
        while i < source.endIndex, source[i] != ")" {
            if source[i] == "\n" { return nil }
            raw.append(source[i])
            i = source.index(after: i)
        }
        guard i < source.endIndex else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard let url = makeURL(trimmed) else { return nil }
        return (label, url, source.index(after: i))
    }

    private static func makeURL(_ raw: String) -> URL? {
        if let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https" || scheme == "mailto"
        {
            return url
        }
        if raw.hasPrefix("www."), let url = URL(string: "https://\(raw)") {
            return url
        }
        return nil
    }

    private static func isWordChar(_ character: Character) -> Bool {
        character.isLetter || character.isNumber
    }
}

// MARK: - View

struct MarkdownView: View {
    let text: String

    var body: some View {
        let blocks = MarkdownParser.parse(text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let inlines):
            Text(Self.attributed(inlines, font: headingFont(level)))
                .frame(maxWidth: .infinity, alignment: .leading)
        case .paragraph(let inlines):
            Text(Self.attributed(inlines, font: .body))
                .frame(maxWidth: .infinity, alignment: .leading)
        case .unorderedList(let items):
            listView(ordered: false, start: 1, items: items)
        case .orderedList(let start, let items):
            listView(ordered: true, start: start, items: items)
        case .code(let language, let code):
            codeBlock(language: language, code: code)
        case .diff(let diff):
            DiffView(diff: diff)
        }
    }

    private func listView(ordered: Bool, start: Int, items: [[MarkdownInline]]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(ordered ? "\(start + index)." : "•")
                        .foregroundStyle(.secondary)
                        .frame(minWidth: ordered ? 22 : 12, alignment: .trailing)
                    Text(Self.attributed(item, font: .body))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func codeBlock(language: String, code: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !language.isEmpty {
                Text(language)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.top, 8)
            }
            ScrollView(.horizontal, showsIndicators: true) {
                Text(code)
                    .font(.system(.caption, design: .monospaced))
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(.quaternary.opacity(0.3), in: .rect(cornerRadius: 10))
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2.bold()
        case 2: .title3.bold()
        default: .headline
        }
    }

    static func attributed(_ inlines: [MarkdownInline], font: Font) -> AttributedString {
        var result = AttributedString()
        for inline in inlines {
            switch inline {
            case .text(let string):
                var part = AttributedString(string)
                part.font = font
                result += part
            case .bold(let inner):
                result += attributed(inner, font: font.bold())
            case .italic(let inner):
                result += attributed(inner, font: font.italic())
            case .code(let string):
                var part = AttributedString(string)
                part.font = .system(.body, design: .monospaced)
                part.backgroundColor = Color.secondary.opacity(0.16)
                result += part
            case .link(let label, let url):
                var part = AttributedString(label)
                part.font = font
                part.link = url
                part.underlineStyle = .single
                part.foregroundColor = Color.accentColor
                result += part
            }
        }
        return result
    }
}
