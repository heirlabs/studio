import XCTest

@testable import HeirStudio

final class ServerConfigTests: XCTestCase {
    func testAddsSchemeWhenOmitted() throws {
        let config = try ServerConfig.parse(urlString: "100.101.102.103:3847", token: "t")
        XCTAssertEqual(config.baseURL.absoluteString, "http://100.101.102.103:3847")
        XCTAssertEqual(config.baseURL.host, "100.101.102.103")
    }

    func testKeepsExplicitScheme() throws {
        let config = try ServerConfig.parse(urlString: "https://mac.tailnet.ts.net", token: "t")
        XCTAssertEqual(config.baseURL.scheme, "https")
    }

    func testTrimsWhitespace() throws {
        let config = try ServerConfig.parse(urlString: "  10.0.0.2:3847\n", token: "t")
        XCTAssertEqual(config.baseURL.host, "10.0.0.2")
    }

    func testRejectsEmptyAndHostless() {
        XCTAssertThrowsError(try ServerConfig.parse(urlString: "", token: "t"))
        XCTAssertThrowsError(try ServerConfig.parse(urlString: "   ", token: "t"))
        XCTAssertThrowsError(try ServerConfig.parse(urlString: "http://", token: "t"))
    }
}

final class StreamEventDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> StreamEvent {
        try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
    }

    func testDecodesTextDelta() throws {
        let event = try decode(#"{"type":"text","data":"PONG"}"#)
        XCTAssertEqual(event.type, "text")
        XCTAssertEqual(event.data, "PONG")
    }

    /// The server normalizes both transports to {name, input}; this is the
    /// shape the UI actually renders.
    func testDecodesNormalizedToolCall() throws {
        let event = try decode(
            #"{"type":"tool_call","name":"list_dir","input":{"target_directory":"."},"toolCallId":"c1"}"#
        )
        XCTAssertEqual(event.name, "list_dir")
        XCTAssertEqual(event.input?.preview, "{target_directory: .}")
    }

    func testDecodesToolResult() throws {
        let event = try decode(
            #"{"type":"tool_result","name":"read_file","result":"contents","status":"completed"}"#)
        XCTAssertEqual(event.result?.preview, "contents")
        XCTAssertEqual(event.status, "completed")
    }

    func testDecodesPermissionRequestWithNumericId() throws {
        let event = try decode(
            """
            {"type":"studio","event":"permission_request","id":9001,
             "toolCall":{"title":"run_terminal_command","kind":"execute",
                         "rawInput":{"command":"echo hi"}},
             "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
                        {"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}
            """)
        XCTAssertEqual(event.permissionID, "9001")
        XCTAssertEqual(event.toolCall?.title, "run_terminal_command")
        XCTAssertEqual(event.toolCall?.rawInput?.preview, "{command: echo hi}")
        XCTAssertEqual(event.options?.count, 2)
        XCTAssertEqual(event.options?.first(where: { $0.isAllow })?.optionId, "allow-once")
    }

    func testDecodesPermissionRequestWithStringId() throws {
        let event = try decode(#"{"type":"studio","event":"permission_request","id":"abc"}"#)
        XCTAssertEqual(event.permissionID, "abc")
    }

    func testDecodesAutoDecision() throws {
        let event = try decode(
            #"{"type":"studio","event":"permission_auto","decision":"deny","reason":"blocked in read-only sandbox"}"#
        )
        XCTAssertEqual(event.decision, "deny")
        XCTAssertEqual(event.reason, "blocked in read-only sandbox")
    }

    func testDecodesFinished() throws {
        let event = try decode(#"{"type":"studio","event":"finished","status":"completed"}"#)
        XCTAssertEqual(event.event, "finished")
        XCTAssertEqual(event.status, "completed")
    }

    func testUnknownFieldsDoNotBreakDecoding() throws {
        let event = try decode(#"{"type":"usage","usage":{"input_tokens":5},"future":true}"#)
        XCTAssertEqual(event.type, "usage")
    }

    func testAnyCodableRendersNestedShapes() throws {
        let event = try decode(#"{"type":"tool_call","input":{"a":[1,2],"b":"x"}}"#)
        // keys are sorted so the preview is stable
        XCTAssertEqual(event.input?.preview, "{a: [1, 2], b: x}")
    }
}

final class PermissionOptionTests: XCTestCase {
    func testAllowDetection() {
        XCTAssertTrue(
            PermissionOption(optionId: "a", name: "Allow once", kind: "allow_once").isAllow)
        XCTAssertTrue(
            PermissionOption(optionId: "b", name: "Always", kind: "allow_always").isAllow)
        XCTAssertFalse(
            PermissionOption(optionId: "c", name: "Reject", kind: "reject_once").isAllow)
    }
}

final class PathFormattingTests: XCTestCase {
    func testShortensHomePaths() {
        XCTAssertEqual(shortPath("/Users/futjr/code/app"), "~/code/app")
        XCTAssertEqual(shortPath("/opt/src"), "/opt/src")
        XCTAssertEqual(shortPath(""), "")
    }
}

final class HubEventTests: XCTestCase {
    func testDecodesRunStarted() throws {
        let json = """
            {"type":"run","event":"started","sessionId":"s1","runId":"r1","messageId":"m1"}
            """
        let event = try JSONDecoder().decode(HubEvent.self, from: Data(json.utf8))
        XCTAssertEqual(event.type, "run")
        XCTAssertEqual(event.event, "started")
        XCTAssertEqual(event.sessionId, "s1")
        XCTAssertEqual(event.runId, "r1")
    }
}

final class DirectoryListingTests: XCTestCase {
    func testDecodesListing() throws {
        let json = """
            {"path":"/Users/futjr/woc","parent":"/Users/futjr","home":"/Users/futjr",
             "entries":[{"name":"woc","path":"/Users/futjr/woc/woc","type":"dir"}]}
            """
        let listing = try JSONDecoder().decode(DirectoryListing.self, from: Data(json.utf8))
        XCTAssertEqual(listing.path, "/Users/futjr/woc")
        XCTAssertEqual(listing.entries.first?.name, "woc")
        XCTAssertEqual(listing.entries.first?.id, "/Users/futjr/woc/woc")
    }
}
