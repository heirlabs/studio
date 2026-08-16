import AVFoundation
import SwiftUI

/// First-run pairing. The Mac shows a QR code (Heir Studio → Connect a device);
/// scanning it avoids typing a 43-character token on a phone keyboard.
struct PairingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var urlText = ""
    @State private var token = ""
    @State private var accessClientId = ""
    @State private var accessClientSecret = ""
    @State private var isScanning = false
    @State private var isConnecting = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        isScanning = true
                    } label: {
                        Label("Scan pairing QR code", systemImage: "qrcode.viewfinder")
                    }
                } footer: {
                    Text(
                        "On your Mac, open Heir Studio and choose Connect a device. "
                            + "Both devices must be signed in to the same Tailscale network.")
                }

                Section("Or enter manually") {
                    TextField("100.101.102.103:3847", text: $urlText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Pairing token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Access client id (optional)", text: $accessClientId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Access client secret (optional)", text: $accessClientSecret)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                if let errorText {
                    Section {
                        Label(errorText, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                            .font(.footnote)
                    }
                }

                Section {
                    Button {
                        Task { await connect() }
                    } label: {
                        HStack {
                            if isConnecting { ProgressView().padding(.trailing, 4) }
                            Text(isConnecting ? "Connecting…" : "Connect")
                        }
                    }
                    .disabled(urlText.isEmpty || token.isEmpty || isConnecting)
                }
            }
            .navigationTitle("Heir Studio")
            .onChange(of: model.suggestedPairing?.token) { _, _ in
                guard let suggestion = model.suggestedPairing else { return }
                urlText = suggestion.url
                token = suggestion.token
                accessClientId = suggestion.accessClientId ?? ""
                accessClientSecret = suggestion.accessClientSecret ?? ""
            }
            .sheet(isPresented: $isScanning) {
                QRScannerView { scanned in
                    isScanning = false
                    apply(scanned)
                }
            }
        }
    }

    /// Pairing payload is `heirstudio://pair?url=…&token=…`, or bare JSON.
    private func apply(_ raw: String) {
        if let components = URLComponents(string: raw),
            components.scheme == "heirstudio",
            let items = components.queryItems
        {
            urlText = items.first(where: { $0.name == "url" })?.value ?? urlText
            token = items.first(where: { $0.name == "token" })?.value ?? token
            accessClientId =
                items.first(where: { $0.name == "access_client_id" })?.value
                ?? items.first(where: { $0.name == "accessClientId" })?.value
                ?? accessClientId
            accessClientSecret =
                items.first(where: { $0.name == "access_client_secret" })?.value
                ?? items.first(where: { $0.name == "accessClientSecret" })?.value
                ?? accessClientSecret
        } else if let data = raw.data(using: .utf8),
            let decoded = try? JSONDecoder().decode(PairPayload.self, from: data)
        {
            urlText = decoded.url
            token = decoded.token
            accessClientId = decoded.accessClientId ?? accessClientId
            accessClientSecret = decoded.accessClientSecret ?? accessClientSecret
        } else {
            errorText = "That QR code is not a Heir Studio pairing code."
            return
        }
        Task { await connect() }
    }

    private struct PairPayload: Decodable {
        let url: String
        let token: String
        let accessClientId: String?
        let accessClientSecret: String?
    }

    private func connect() async {
        errorText = nil
        isConnecting = true
        defer { isConnecting = false }
        do {
            let config = try ServerConfig.parse(
                urlString: urlText,
                token: token,
                accessClientId: accessClientId.isEmpty ? nil : accessClientId,
                accessClientSecret: accessClientSecret.isEmpty ? nil : accessClientSecret)
            try await model.pair(with: config)
        } catch {
            errorText =
                (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// Thin AVFoundation QR reader.
struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onScan = onScan
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onScan: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var hasScanned = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video),
                let input = try? AVCaptureDeviceInput(device: device),
                session.canAddInput(input)
            else { return }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            guard !session.isRunning else { return }
            // startRunning blocks; keep it off the main thread.
            let capture = session
            DispatchQueue.global(qos: .userInitiated).async { capture.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            if session.isRunning { session.stopRunning() }
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput objects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !hasScanned,
                let object = objects.first as? AVMetadataMachineReadableCodeObject,
                let value = object.stringValue
            else { return }
            hasScanned = true
            session.stopRunning()
            onScan?(value)
        }
    }
}
