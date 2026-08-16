import XCTest

@testable import HeirStudio

final class MarkdownParserTests: XCTestCase {
    func testBold() {
        let blocks = MarkdownParser.parse("hello **world**")
        XCTAssertEqual(blocks.count, 1)
        guard case .paragraph(let inlines) = blocks[0] else {
            return XCTFail("expected paragraph, got \(blocks)")
        }
        XCTAssertEqual(
            inlines,
            [
                .text("hello "),
                .bold([.text("world")]),
            ])
    }

    func testHeading() {
        let blocks = MarkdownParser.parse("## Hello")
        XCTAssertEqual(blocks.count, 1)
        guard case .heading(let level, let inlines) = blocks[0] else {
            return XCTFail("expected heading, got \(blocks)")
        }
        XCTAssertEqual(level, 2)
        XCTAssertEqual(inlines, [.text("Hello")])
    }

    func testList() {
        let blocks = MarkdownParser.parse("- alpha\n- beta")
        XCTAssertEqual(blocks.count, 1)
        guard case .unorderedList(let items) = blocks[0] else {
            return XCTFail("expected unordered list, got \(blocks)")
        }
        XCTAssertEqual(items, [[.text("alpha")], [.text("beta")]])
    }

    func testFencedSwift() {
        let source = """
            ```swift
            print(1)
            ```
            """
        let blocks = MarkdownParser.parse(source)
        XCTAssertEqual(blocks.count, 1)
        guard case .code(let language, let code) = blocks[0] else {
            return XCTFail("expected fenced swift code, got \(blocks)")
        }
        XCTAssertEqual(language, "swift")
        XCTAssertEqual(code, "print(1)")
    }

    func testUnifiedDiffDetectionFencedDiffLanguage() {
        let source = """
            ```diff
            --- a/Foo.swift
            +++ b/Foo.swift
            @@ -1,1 +1,1 @@
            -let a = 1
            +let a = 2
            ```
            """
        let blocks = MarkdownParser.parse(source)
        XCTAssertEqual(blocks.count, 1)
        guard case .diff(let diff) = blocks[0] else {
            return XCTFail("expected fenced diff block, got \(blocks)")
        }
        XCTAssertEqual(diff.files.count, 1)
        XCTAssertEqual(diff.files[0].displayPath, "Foo.swift")
        XCTAssertEqual(diff.files[0].hunks.count, 1)
        XCTAssertEqual(diff.files[0].hunks[0].lines.map(\.kind), [.remove, .add])
    }

    func testUnifiedDiffDetectionWithoutLanguageTag() {
        let source = """
            ```
            --- a/x.swift
            +++ b/x.swift
            @@ -1,1 +1,1 @@
            -old
            +new
            ```
            """
        let blocks = MarkdownParser.parse(source)
        XCTAssertEqual(blocks.count, 1)
        guard case .diff(let diff) = blocks[0] else {
            return XCTFail("expected implicit unified-diff fence, got \(blocks)")
        }
        XCTAssertEqual(diff.files.first?.displayPath, "x.swift")
    }

    func testLooksLikeUnifiedDiff() {
        XCTAssertTrue(
            UnifiedDiffParser.looksLikeUnifiedDiff(
                """
                --- a/f
                +++ b/f
                @@ -1 +1 @@
                -a
                +b
                """))
        XCTAssertTrue(MarkdownParser.isDiffLanguage("diff"))
        XCTAssertTrue(MarkdownParser.isDiffLanguage("udiff"))
        XCTAssertFalse(UnifiedDiffParser.looksLikeUnifiedDiff("let x = 1\nprint(x)"))
    }

    func testItalicInlineCodeAndLink() {
        let blocks = MarkdownParser.parse("see *docs* at [site](https://example.com) and `x`")
        guard case .paragraph(let inlines) = blocks.first else {
            return XCTFail("expected paragraph")
        }
        XCTAssertEqual(inlines.count, 6)
        guard case .italic(let inner) = inlines[1] else { return XCTFail("expected italic") }
        XCTAssertEqual(inner, [.text("docs")])
        guard case .link(let label, let url) = inlines[3] else { return XCTFail("expected link") }
        XCTAssertEqual(label, "site")
        XCTAssertEqual(url.absoluteString, "https://example.com")
        guard case .code(let code) = inlines[5] else { return XCTFail("expected inline code") }
        XCTAssertEqual(code, "x")
    }

    func testOrderedListAndMultipleHunks() {
        let list = MarkdownParser.parse("1. one\n2. two")
        guard case .orderedList(let start, let items) = list.first else {
            return XCTFail("expected ordered list")
        }
        XCTAssertEqual(start, 1)
        XCTAssertEqual(items.count, 2)

        let source = """
            ```udiff
            --- a/A.swift
            +++ b/A.swift
            @@ -1 +1 @@
            -a
            +b
            --- a/B.swift
            +++ b/B.swift
            @@ -3 +3 @@
            -c
            +d
            ```
            """
        let blocks = MarkdownParser.parse(source)
        guard case .diff(let diff) = blocks.first else {
            return XCTFail("expected multi-file diff")
        }
        XCTAssertEqual(diff.files.map(\.displayPath), ["A.swift", "B.swift"])
        XCTAssertEqual(diff.files.flatMap(\.hunks).count, 2)
    }

    func testUnfencedUnifiedDiff() {
        let source = """
            Patch below:
            --- a/n.swift
            +++ b/n.swift
            @@ -1 +1 @@
            -old
            +new
            """
        let blocks = MarkdownParser.parse(source)
        XCTAssertEqual(blocks.count, 2)
        guard case .paragraph = blocks[0] else { return XCTFail("expected lead-in paragraph") }
        guard case .diff(let diff) = blocks[1] else {
            return XCTFail("expected unfenced unified diff, got \(blocks)")
        }
        XCTAssertEqual(diff.files.first?.displayPath, "n.swift")
    }
}
