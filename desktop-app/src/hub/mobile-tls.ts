import { X509Certificate, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { childEnv, Vault } from "./security";

export async function mobileTls(dir: string, name: string) {
  const vault = new Vault(dir, "mobile-tls.dpapi");
  if (!(await vault.configured(name))) {
    const passphrase = randomBytes(24).toString("hex");
    const script = `
      $ErrorActionPreference='Stop'
      $rsa=[System.Security.Cryptography.RSA]::Create(2048)
      $request=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=Alcor Mobile',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-15),[DateTimeOffset]::UtcNow.AddYears(5))
      [Console]::WriteLine([Convert]::ToBase64String($cert.RawData))
      [Console]::Write([Convert]::ToBase64String($cert.Export('Pfx',$env:ALCOR_CERT_PASSPHRASE)))
    `;
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)(
        join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { windowsHide: true, timeout: 15000, env: { ...childEnv(), ALCOR_CERT_PASSPHRASE: passphrase } },
      ));
    } catch {
      throw new Error("无法创建桌面配对证书");
    }
    const [cert, pfx] = stdout.trim().split(/\s+/);
    // Save the PFX alone plus its password; the public fingerprint is not a credential.
    const pin = new X509Certificate(Buffer.from(cert, "base64")).fingerprint256.replaceAll(":", "");
    await vault.save(name, [passphrase, pin, pfx].join("."));
  }
  const [passphrase, fingerprint, encoded] = (await vault.get(name)).split(".");
  return { pfx: Buffer.from(encoded, "base64"), passphrase, pin: Buffer.from(fingerprint, "hex").toString("base64url") };
}
