import Foundation

enum StudioError: LocalizedError, Equatable {
    case notConfigured
    case unauthorized
    case forbidden(String)
    case http(Int, String)
    case badURL(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Not paired with a Mac yet."
        case .unauthorized:
            return "The Mac rejected this token. Re-pair from Heir Studio."
        case .forbidden(let m):
            return m
        case .http(let code, let m):
            return m.isEmpty ? "Server returned \(code)." : m
        case .badURL(let s):
            return "\"\(s)\" is not a valid server address."
        }
    }
}

/// Where the phone connects, and with what token.
struct ServerConfig: Codable, Equatable, Sendable {
    var baseURL: URL
    var token: String

    /// Accepts "100.101.102.103:3847" as well as a full URL.
    static func parse(urlString: String, token: String) throws -> ServerConfig {
        var s = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { throw StudioError.badURL(urlString) }
        if !s.contains("://") { s = "http://" + s }
        guard let url = URL(string: s), url.host != nil else {
            throw StudioError.badURL(urlString)
        }
        return ServerConfig(baseURL: url, token: token)
    }
}

/// REST + SSE against Heir Studio.
///
/// SSE deliberately uses `URLSession.bytes` rather than a browser-style
/// EventSource: EventSource cannot attach an Authorization header, and every
/// remote request here must carry the bearer token.
actor StudioClient {
    private var config: ServerConfig?
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.waitsForConnectivity = true
            config.timeoutIntervalForRequest = 60
            config.httpShouldSetCookies = true
            self.session = URLSession(configuration: config)
        }
    }

    func configure(_ config: ServerConfig?) {
        self.config = config
    }

    var isConfigured: Bool { config != nil }

    private func request(_ path: String, method: String = "GET", body: Encodable? = nil) throws
        -> URLRequest
    {
        guard let config else { throw StudioError.notConfigured }
        guard let url = URL(string: path, relativeTo: config.baseURL) else {
            throw StudioError.badURL(path)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = method == "GET" && (path.hasPrefix("/api/events") || path.contains("/stream"))
            ? 0
            : 30
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        return req
    }

    private func check(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard !(200..<300).contains(http.statusCode) else { return }
        let message = (try? JSONDecoder().decode(APIError.self, from: data))?.error ?? ""
        switch http.statusCode {
        case 401: throw StudioError.unauthorized
        case 403: throw StudioError.forbidden(message.isEmpty ? "Refused by the Mac." : message)
        default: throw StudioError.http(http.statusCode, message)
        }
    }

    private func send<T: Decodable>(_ req: URLRequest, as: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: req)
        try check(response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: Endpoints

    func health() async throws -> Health {
        try await send(request("/api/health"), as: Health.self)
    }

    /// Verify a candidate config without adopting it — used by the pairing screen.
    func probe(_ candidate: ServerConfig) async throws -> Health {
        let previous = config
        config = candidate
        defer { config = previous }
        return try await health()
    }

    func sessions() async throws -> SessionList {
        try await send(request("/api/sessions"), as: SessionList.self)
    }

    func session(_ id: String) async throws -> SessionDetail {
        try await send(request("/api/sessions/\(id)"), as: SessionDetail.self)
    }

    func project() async throws -> ProjectState {
        try await send(request("/api/project"), as: ProjectState.self)
    }

    static func queryURL(path: String, items: [URLQueryItem]) -> String {
        var components = URLComponents()
        components.path = path
        components.queryItems = items.isEmpty ? nil : items
        return components.string ?? path
    }

    func listDirectory(_ path: String, includeFiles: Bool = false) async throws -> DirectoryListing
    {
        var items = [URLQueryItem(name: "path", value: path)]
        if includeFiles {
            items.append(URLQueryItem(name: "files", value: "1"))
        }
        return try await send(
            request(Self.queryURL(path: "/api/fs", items: items)), as: DirectoryListing.self)
    }

    func readFile(at path: String) async throws -> FileContents {
        try await send(
            request(
                Self.queryURL(
                    path: "/api/file", items: [URLQueryItem(name: "path", value: path)])),
            as: FileContents.self)
    }

    func registerPushToken(_ token: String) async throws {
        struct Body: Encodable { let token: String }
        let (data, response) = try await session.data(
            for: request("/api/device/push", method: "POST", body: Body(token: token)))
        try check(response, data: data)
    }

    func unregisterPushToken(_ token: String) async throws {
        struct Body: Encodable { let token: String }
        let (data, response) = try await session.data(
            for: request("/api/device/push", method: "DELETE", body: Body(token: token)))
        try check(response, data: data)
    }

    func gitStatus(cwd: String) async throws -> GitStatus {
        try await send(
            request(
                Self.queryURL(
                    path: "/api/git/status", items: [URLQueryItem(name: "cwd", value: cwd)])),
            as: GitStatus.self)
    }

    func gitDiff(cwd: String, staged: Bool? = nil, path: String? = nil) async throws -> GitDiff {
        var items = [URLQueryItem(name: "cwd", value: cwd)]
        if let staged {
            items.append(URLQueryItem(name: "staged", value: staged ? "1" : "0"))
        }
        if let path {
            items.append(URLQueryItem(name: "path", value: path))
        }
        return try await send(
            request(Self.queryURL(path: "/api/git/diff", items: items)), as: GitDiff.self)
    }

    func gitCommit(cwd: String, message: String, paths: [String]? = nil) async throws
        -> GitActionResult
    {
        struct Body: Encodable {
            let cwd: String
            let message: String
            let paths: [String]?
        }
        return try await sendAllowingEmpty(
            request(
                "/api/git/commit", method: "POST",
                body: Body(cwd: cwd, message: message, paths: paths)),
            as: GitActionResult.self) ?? GitActionResult(ok: true)
    }

    func gitPush(cwd: String) async throws -> GitActionResult {
        struct Body: Encodable { let cwd: String }
        return try await sendAllowingEmpty(
            request("/api/git/push", method: "POST", body: Body(cwd: cwd)),
            as: GitActionResult.self) ?? GitActionResult(ok: true)
    }

    private func sendAllowingEmpty<T: Decodable>(_ req: URLRequest, as: T.Type) async throws -> T? {
        let (data, response) = try await session.data(for: req)
        try check(response, data: data)
        if data.isEmpty { return nil }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func createSession(cwd: String?) async throws -> SessionSummary {
        struct Body: Encodable { let cwd: String? }
        return try await send(
            request("/api/sessions", method: "POST", body: Body(cwd: cwd)),
            as: SessionSummary.self)
    }

    func deleteSession(_ id: String) async throws {
        let (data, response) = try await session.data(
            for: request("/api/sessions/\(id)", method: "DELETE"))
        try check(response, data: data)
    }

    struct SendOptions: Encodable {
        var text: String
        var permissionMode: String?
        var workflowId: String = "code-agent"
        var images: [String]?
        var files: [String]?
        var model: String?
        var reasoningEffort: String?
        var maxBudgetUsd: Double?
        var worktree: Bool?
        var background: Bool?
    }

    struct UploadedFile: Decodable, Sendable {
        let name: String
        let kind: String?
    }

    struct UploadResponse: Decodable, Sendable {
        let files: [UploadedFile]
    }

    func uploadJPEG(_ data: Data, filename: String) async throws -> String {
        guard let config else { throw StudioError.notConfigured }
        guard let url = URL(string: "/api/upload", relativeTo: config.baseURL) else {
            throw StudioError.badURL("/api/upload")
        }
        let boundary = "heir-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 120

        var body = Data()
        func append(_ s: String) { body.append(Data(s.utf8)) }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"files\"; filename=\"\(filename)\"\r\n")
        append("Content-Type: image/jpeg\r\n\r\n")
        body.append(data)
        append("\r\n--\(boundary)--\r\n")
        req.httpBody = body

        let (respData, response) = try await session.data(for: req)
        try check(response, data: respData)
        let parsed = try JSONDecoder().decode(UploadResponse.self, from: respData)
        guard let name = parsed.files.first?.name else {
            throw StudioError.http(500, "Upload returned no file.")
        }
        return name
    }

    func sendMessage(sessionId: String, options: SendOptions) async throws
        -> PostMessageResponse
    {
        try await send(
            request("/api/sessions/\(sessionId)/messages", method: "POST", body: options),
            as: PostMessageResponse.self)
    }

    func activeRun(sessionId: String) async throws -> ActiveRun {
        try await send(request("/api/sessions/\(sessionId)/active-run"), as: ActiveRun.self)
    }

    func cancel(runId: String) async throws {
        let (data, response) = try await session.data(
            for: request("/api/runs/\(runId)/cancel", method: "POST"))
        try check(response, data: data)
    }

    func respondPermission(runId: String, permissionId: String, allow: Bool, optionId: String?)
        async throws
    {
        struct Body: Encodable {
            let allow: Bool?
            let deny: Bool?
            let cancelled: Bool?
            let optionId: String?
        }
        let body = Body(
            allow: allow ? true : nil,
            deny: allow ? nil : true,
            cancelled: allow ? nil : true,
            optionId: optionId)
        let (data, response) = try await session.data(
            for: request(
                "/api/runs/\(runId)/permissions/\(permissionId)", method: "POST", body: body))
        try check(response, data: data)
    }

    /// Studio-wide session/run fan-out. Stays open until cancelled.
    func streamHub() throws -> AsyncThrowingStream<HubEvent, Error> {
        let req = try request("/api/events")
        return bytesStream(req) { data in
            try? JSONDecoder().decode(HubEvent.self, from: data)
        }
    }

    /// Live run events. The stream ends when the server closes it.
    func streamEvents(runId: String, after: Int = 0) throws -> AsyncThrowingStream<StreamEvent, Error> {
        let path = after > 0
            ? "/api/runs/\(runId)/stream?after=\(after)"
            : "/api/runs/\(runId)/stream"
        let req = try request(path)
        return bytesStream(req) { data in
            try? JSONDecoder().decode(StreamEvent.self, from: data)
        }
    }

    func compactSession(_ id: String, note: String?) async throws -> CompactResult {
        struct Body: Encodable { let note: String? }
        return try await send(
            request("/api/sessions/\(id)/compact", method: "POST", body: Body(note: note)),
            as: CompactResult.self)
    }

    func sessionContext(_ id: String) async throws -> ContextResponse {
        try await send(request("/api/sessions/\(id)/context"), as: ContextResponse.self)
    }

    func history(query: String, limit: Int = 40) async throws -> [HistoryHit] {
        let items = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        let list = try await send(
            request(Self.queryURL(path: "/api/history", items: items)),
            as: HistoryList.self)
        return list.hits
    }

    func listCheckpoints(sessionId: String) async throws -> [CheckpointSummary] {
        let list = try await send(
            request("/api/sessions/\(sessionId)/checkpoints"),
            as: CheckpointList.self)
        return list.checkpoints
    }

    func createCheckpoint(sessionId: String, label: String?) async throws -> CheckpointSummary {
        struct Body: Encodable { let label: String?; let reason: String }
        return try await send(
            request(
                "/api/sessions/\(sessionId)/checkpoints",
                method: "POST",
                body: Body(label: label, reason: "manual")),
            as: CheckpointSummary.self)
    }

    func restoreCheckpoint(sessionId: String, checkpointId: String) async throws -> SessionDetail {
        let result = try await send(
            request(
                "/api/sessions/\(sessionId)/checkpoints/\(checkpointId)/restore",
                method: "POST"),
            as: CheckpointRestore.self)
        if let session = result.session { return session }
        return try await session(sessionId)
    }

    private func bytesStream<T>(
        _ req: URLRequest, decode: @escaping @Sendable (Data) -> T?
    ) -> AsyncThrowingStream<T, Error> {
        let session = self.session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: req)
                    if let http = response as? HTTPURLResponse,
                        !(200..<300).contains(http.statusCode)
                    {
                        throw http.statusCode == 401
                            ? StudioError.unauthorized
                            : StudioError.http(http.statusCode, "")
                    }
                    for try await line in bytes.lines {
                        guard line.hasPrefix("data:") else { continue }
                        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        guard !payload.isEmpty, let data = payload.data(using: .utf8) else {
                            continue
                        }
                        if let event = decode(data) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// Type-erasing shim so `request(body:)` can take any Encodable.
private struct AnyEncodable: Encodable {
    private let encodeTo: (Encoder) throws -> Void
    init(_ wrapped: Encodable) { encodeTo = wrapped.encode(to:) }
    func encode(to encoder: Encoder) throws { try encodeTo(encoder) }
}
