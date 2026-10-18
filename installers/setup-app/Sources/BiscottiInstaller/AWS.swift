import CryptoKit
import Foundation

/// Just enough of the EC2 Query API, signed with SigV4, to launch biscotti's machine. Untested against real AWS.
struct AWS {
    let accessKey: String
    let secretKey: String
    var sessionToken: String?
    let region: String

    static let regions = ["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-central-1", "ap-northeast-1", "ap-southeast-2"]

    /// The default profile from ~/.aws/credentials, if there is one.
    static func savedCredentials(region: String) -> AWS? {
        let file = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".aws/credentials")
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        var values: [String: String] = [:]
        var inDefault = false
        for line in text.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            if line.hasPrefix("[") { inDefault = line == "[default]"; continue }
            let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if inDefault, parts.count == 2 { values[parts[0]] = parts[1] }
        }
        guard let key = values["aws_access_key_id"], let secret = values["aws_secret_access_key"] else { return nil }
        return AWS(accessKey: key, secretKey: secret, sessionToken: values["aws_session_token"], region: region)
    }

    /// One EC2 action; returns the response XML. `log` gets the action's name, never its parameters.
    func call(_ action: String, _ params: [String: String] = [:], log: (String) -> Void) async throws -> String {
        log(action)
        let host = "ec2.\(region).amazonaws.com"
        let body = (params.merging(["Action": action, "Version": "2016-11-15"]) { a, _ in a })
            .sorted { $0.key < $1.key }.map { "\(encode($0.key))=\(encode($0.value))" }.joined(separator: "&")
        let stamp = Self.stamp.string(from: Date())
        let date = String(stamp.prefix(8))
        var headers = ["content-type": "application/x-www-form-urlencoded; charset=utf-8", "host": host, "x-amz-date": stamp]
        if let sessionToken { headers["x-amz-security-token"] = sessionToken }
        let names = headers.keys.sorted()
        let canonical = ["POST", "/", "", names.map { "\($0):\(headers[$0]!)\n" }.joined(), names.joined(separator: ";"), hex(SHA256.hash(data: Data(body.utf8)))]
            .joined(separator: "\n")
        let scope = "\(date)/\(region)/ec2/aws4_request"
        let toSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(SHA256.hash(data: Data(canonical.utf8)))].joined(separator: "\n")
        let signingKey = [date, region, "ec2", "aws4_request"].reduce(SymmetricKey(data: Data("AWS4\(secretKey)".utf8))) {
            SymmetricKey(data: Data(HMAC<SHA256>.authenticationCode(for: Data($1.utf8), using: $0)))
        }
        let signature = hex(HMAC<SHA256>.authenticationCode(for: Data(toSign.utf8), using: signingKey))

        var request = URLRequest(url: URL(string: "https://\(host)/")!)
        request.httpMethod = "POST"
        request.httpBody = Data(body.utf8)
        for (name, value) in headers where name != "host" { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue("AWS4-HMAC-SHA256 Credential=\(accessKey)/\(scope), SignedHeaders=\(names.joined(separator: ";")), Signature=\(signature)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let xml = String(decoding: data, as: UTF8.self)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw AWSError(code: values("Code", in: xml).first ?? "Error", message: values("Message", in: xml).first ?? xml)
        }
        return xml
    }

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private func encode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")) ?? s
    }

    private func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}

struct AWSError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { "AWS: \(code): \(message)" }
}

/// Every <tag>value</tag> in an EC2 response, in order.
func values(_ tag: String, in xml: String) -> [String] {
    xml.components(separatedBy: "<\(tag)>").dropFirst().compactMap { $0.components(separatedBy: "</\(tag)>").first }
}

extension AWS {
    /// Launches biscotti's instance and returns its public IP once SSH answers. `key` is the SSH private key file.
    func launch(userData: String, key: URL, log: @escaping (String) -> Void) async throws -> String {
        // The key pair: this Mac's key, named by its fingerprint so a re-run reuses it.
        let publicKey = try String(contentsOf: key.appendingPathExtension("pub"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let keyName = "biscotti-" + SHA256.hash(data: Data(publicKey.utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
        do {
            _ = try await call("ImportKeyPair", ["KeyName": keyName, "PublicKeyMaterial": Data(publicKey.utf8).base64EncodedString()], log: log)
        } catch let error as AWSError where error.code == "InvalidKeyPair.Duplicate" {}

        // A security group that lets in SSH only; biscotti itself is reached over Tailscale.
        let group: String
        do {
            let xml = try await call("CreateSecurityGroup", ["GroupName": "biscotti-ssh", "GroupDescription": "biscotti: SSH only"], log: log)
            group = values("groupId", in: xml).first ?? ""
        } catch let error as AWSError where error.code == "InvalidGroup.Duplicate" {
            group = values("groupId", in: try await call("DescribeSecurityGroups", ["GroupName.1": "biscotti-ssh"], log: log)).first ?? ""
        }
        do {
            _ = try await call("AuthorizeSecurityGroupIngress", [
                "GroupId": group, "IpPermissions.1.IpProtocol": "tcp", "IpPermissions.1.FromPort": "22",
                "IpPermissions.1.ToPort": "22", "IpPermissions.1.IpRanges.1.CidrIp": "0.0.0.0/0",
            ], log: log)
        } catch let error as AWSError where error.code == "InvalidPermission.Duplicate" {}

        // The newest official NixOS 26.05 x86_64 image.
        let images = try await call("DescribeImages", [
            "Owner.1": "427812963091", "Filter.1.Name": "name", "Filter.1.Value.1": "nixos/26.05*",
            "Filter.2.Name": "architecture", "Filter.2.Value.1": "x86_64",
        ], log: log)
        let found = images.components(separatedBy: "<imageId>").dropFirst().map { item in
            (id: item.components(separatedBy: "</imageId>")[0], created: values("creationDate", in: item).first ?? "", root: values("rootDeviceName", in: item).first ?? "/dev/xvda")
        }
        guard let image = found.max(by: { $0.created < $1.created }) else { throw InstallerError("No NixOS image found in \(region)") }

        let launched = try await call("RunInstances", [
            "ImageId": image.id, "InstanceType": "m8i.large", "MinCount": "1", "MaxCount": "1", "KeyName": keyName,
            "SecurityGroupId.1": group, "UserData": Data(userData.utf8).base64EncodedString(),
            "CpuOptions.NestedVirtualization": "enabled",
            "BlockDeviceMapping.1.DeviceName": image.root, "BlockDeviceMapping.1.Ebs.VolumeSize": "40",
            "BlockDeviceMapping.1.Ebs.VolumeType": "gp3",
            "TagSpecification.1.ResourceType": "instance", "TagSpecification.1.Tag.1.Key": "Name", "TagSpecification.1.Tag.1.Value": "biscotti",
        ], log: log)
        guard let instance = values("instanceId", in: launched).first else { throw InstallerError("RunInstances returned no instance") }

        log("Waiting for the instance to start…")
        var ip = ""
        while ip.isEmpty {
            try await Task.sleep(for: .seconds(5))
            let xml = try await call("DescribeInstances", ["InstanceId.1": instance], log: { _ in })
            if values("name", in: xml).contains("running") { ip = values("ipAddress", in: xml).first ?? "" }
        }
        log("Waiting for SSH on \(ip)…")
        for _ in 0..<60 {
            if (try? run("/usr/bin/ssh", ["-i", key.path, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "root@\(ip)", "true"])) != nil { return ip }
            try await Task.sleep(for: .seconds(5))
        }
        throw InstallerError("The instance never answered on SSH")
    }
}
