import UserNotifications
import XCTest

@testable import HeirStudio

final class PushTokenTests: XCTestCase {
    func testHexFromDeviceTokenIsLowercase() {
        let data = Data([0x0A, 0xFF, 0x00, 0x1B, 0xC3])
        XCTAssertEqual(PushService.hexToken(from: data), "0aff001bc3")
    }

    func testEmptyTokenIsEmptyString() {
        XCTAssertEqual(PushService.hexToken(from: Data()), "")
    }

    func testCategoryAndActionIdentifiers() {
        XCTAssertEqual(PushRouting.permissionCategory, "HEIR_PERMISSION")
        XCTAssertEqual(PushRouting.runCategory, "HEIR_RUN")
        XCTAssertEqual(PushRouting.allowAction, "ALLOW")
        XCTAssertEqual(PushRouting.denyAction, "DENY")
        XCTAssertEqual(PushRouting.stopAction, "STOP")
        XCTAssertEqual(PushRouting.openAction, "OPEN")
    }

    func testStatusTextBeforePrompt() {
        XCTAssertEqual(
            PushService.statusText(
                authorization: .notDetermined,
                hexToken: nil,
                registeredOnMac: false,
                lastError: nil),
            "Not asked yet")
    }

    func testStatusTextWhenDenied() {
        XCTAssertEqual(
            PushService.statusText(
                authorization: .denied,
                hexToken: nil,
                registeredOnMac: false,
                lastError: nil),
            "Off — enable in iPhone Settings")
    }

    func testStreamAfterQuery() {
        let path = StudioClient.queryURL(
            path: "/api/runs/abc/stream",
            items: [URLQueryItem(name: "after", value: "12")])
        XCTAssertTrue(path.contains("after=12"))
    }

    func testCompactResultDecodes() throws {
        let json = """
            {"ok":true,"grokSessionId":"g1",
             "context":{"used":12000,"total":80000,"percent":15,"trigger":"manual"}}
            """
        let result = try JSONDecoder().decode(CompactResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.ok, true)
        XCTAssertEqual(result.context?.percent, 15)
        XCTAssertEqual(result.context?.trigger, "manual")
    }

    func testStatusTextWhenAuthorizedButNotUploaded() {
        XCTAssertEqual(
            PushService.statusText(
                authorization: .authorized,
                hexToken: "ab".repeatToken(),
                registeredOnMac: false,
                lastError: nil),
            "On this phone — Mac not registered yet")
        XCTAssertEqual(
            PushService.statusText(
                authorization: .authorized,
                hexToken: "ab".repeatToken(),
                registeredOnMac: true,
                lastError: nil),
            "On")
    }
}

private extension String {
    func repeatToken() -> String { String(repeating: self, count: 32) }
}

final class PushPayloadTests: XCTestCase {
    func testReadsDocumentedUserInfoKeys() {
        let info: [AnyHashable: Any] = [
            "sessionId": "s1",
            "runId": "r1",
            "permissionId": "p1",
            "optionAllow": "allow-once",
            "optionDeny": "reject-once",
        ]
        let payload = PushService.payload(from: info)
        XCTAssertEqual(payload.sessionId, "s1")
        XCTAssertEqual(payload.runId, "r1")
        XCTAssertEqual(payload.permissionId, "p1")
        XCTAssertEqual(payload.optionAllow, "allow-once")
        XCTAssertEqual(payload.optionDeny, "reject-once")
    }

    func testTrimsEmptyStringsAndAcceptsNumbers() {
        let info: [AnyHashable: Any] = [
            "sessionId": "  ",
            "runId": NSNumber(value: 44),
            "permissionId": "",
        ]
        let payload = PushService.payload(from: info)
        XCTAssertNil(payload.sessionId)
        XCTAssertEqual(payload.runId, "44")
        XCTAssertNil(payload.permissionId)
        XCTAssertNil(payload.optionAllow)
    }
}

final class FsQueryTests: XCTestCase {
    func testFilesFlagIsOmittedByDefault() {
        let url = StudioClient.queryURL(
            path: "/api/fs", items: [URLQueryItem(name: "path", value: "/tmp")])
        XCTAssertTrue(url.hasPrefix("/api/fs?"))
        XCTAssertFalse(url.contains("files="))
        XCTAssertTrue(url.contains("path="))
    }

    func testFilesFlagIsOneWhenRequested() {
        let url = StudioClient.queryURL(
            path: "/api/fs",
            items: [
                URLQueryItem(name: "path", value: "/Users/futjr/woc"),
                URLQueryItem(name: "files", value: "1"),
            ])
        XCTAssertTrue(url.contains("files=1"))
    }

    func testGitStatusAndDiffQueries() {
        let status = StudioClient.queryURL(
            path: "/api/git/status", items: [URLQueryItem(name: "cwd", value: "/repo")])
        XCTAssertTrue(status.hasPrefix("/api/git/status?"))
        XCTAssertTrue(status.contains("cwd="))

        let diff = StudioClient.queryURL(
            path: "/api/git/diff",
            items: [
                URLQueryItem(name: "cwd", value: "/repo"),
                URLQueryItem(name: "staged", value: "1"),
                URLQueryItem(name: "path", value: "a.swift"),
            ])
        XCTAssertTrue(diff.contains("staged=1"))
        XCTAssertTrue(diff.contains("path=a.swift"))
    }

    func testDecodesListingWithFilesAndSize() throws {
        let json = """
            {"path":"/Users/futjr/woc","parent":"/Users/futjr","home":"/Users/futjr",
             "entries":[
               {"name":"src","path":"/Users/futjr/woc/src","type":"dir"},
               {"name":"README.md","path":"/Users/futjr/woc/README.md","type":"file","size":120}
             ]}
            """
        let listing = try JSONDecoder().decode(DirectoryListing.self, from: Data(json.utf8))
        XCTAssertEqual(listing.entries.count, 2)
        XCTAssertTrue(listing.entries[0].isDirectory)
        XCTAssertFalse(listing.entries[1].isDirectory)
        XCTAssertEqual(listing.entries[1].size, 120)
    }

    func testDecodesFileContents() throws {
        let json = #"{"path":"/tmp/a.txt","text":"hello"}"#
        let file = try JSONDecoder().decode(FileContents.self, from: Data(json.utf8))
        XCTAssertEqual(file.path, "/tmp/a.txt")
        XCTAssertEqual(file.contents, "hello")
    }
}

final class SendOptionsFilesTests: XCTestCase {
    func testEncodesFilesArray() throws {
        let opts = StudioClient.SendOptions(
            text: "look at this", permissionMode: "default", files: ["/Users/x/a.swift"])
        let data = try JSONEncoder().encode(opts)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["text"] as? String, "look at this")
        XCTAssertEqual(json["files"] as? [String], ["/Users/x/a.swift"])
    }
}

final class GitPayloadTests: XCTestCase {
    func testDecodesStatusWithFilesKey() throws {
        let json = """
            {"cwd":"/repo","branch":"main","ahead":1,"behind":0,"clean":false,
             "files":[{"path":"a.swift","status":"M","staged":true}]}
            """
        let status = try JSONDecoder().decode(GitStatus.self, from: Data(json.utf8))
        XCTAssertEqual(status.branch, "main")
        XCTAssertEqual(status.ahead, 1)
        XCTAssertEqual(status.files.count, 1)
        XCTAssertEqual(status.files[0].path, "a.swift")
        XCTAssertEqual(status.files[0].displayStatus, "M")
        XCTAssertEqual(status.files[0].staged, true)
        XCTAssertFalse(status.isClean)
    }

    func testDecodesStatusAliases() throws {
        let json = """
            {"current":"feat","dirty":true,
             "entries":[{"name":"b.ts","xy":"??","index":"?","worktree":"?"}]}
            """
        let status = try JSONDecoder().decode(GitStatus.self, from: Data(json.utf8))
        XCTAssertEqual(status.branch, "feat")
        XCTAssertEqual(status.clean, false)
        XCTAssertEqual(status.files.first?.path, "b.ts")
        XCTAssertEqual(status.files.first?.displayStatus, "??")
    }

    func testDecodesDiffAndActionResult() throws {
        let diff = try JSONDecoder().decode(
            GitDiff.self, from: Data(#"{"path":"a.swift","diff":"+hi"}"#.utf8))
        XCTAssertEqual(diff.content, "+hi")

        let patch = try JSONDecoder().decode(
            GitDiff.self, from: Data(#"{"patch":"@@ -1 +1 @@"}"#.utf8))
        XCTAssertEqual(patch.content, "@@ -1 +1 @@")

        let result = try JSONDecoder().decode(
            GitActionResult.self, from: Data(#"{"ok":true,"hash":"abc123"}"#.utf8))
        XCTAssertEqual(result.ok, true)
        XCTAssertEqual(result.hash, "abc123")
    }
}
