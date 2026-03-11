$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$certPath = Join-Path $scriptDir 'cert.pem'
$keyPath = Join-Path $scriptDir 'key.pem'

if (Test-Path $certPath -PathType Container) {
    throw "Expected file path at '$certPath' but found a directory. Remove it and rerun the script."
}

if (Test-Path $keyPath -PathType Container) {
    throw "Expected file path at '$keyPath' but found a directory. Remove it and rerun the script."
}

$dnsName = 'localhost'
$ipAddress = [System.Net.IPAddress]::Parse('127.0.0.1')

$rsa = [System.Security.Cryptography.RSA]::Create(4096)
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=localhost, O=COE491, L=Dubai, S=Dubai, C=AE',
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

$sanBuilder = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$sanBuilder.AddDnsName($dnsName)
$sanBuilder.AddIpAddress($ipAddress)
$request.CertificateExtensions.Add($sanBuilder.Build())
$request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $false)
)
$request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment,
        $false
    )
)
$request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($request.PublicKey, $false)
)

$notBefore = [System.DateTimeOffset]::UtcNow.AddMinutes(-5)
$notAfter = $notBefore.AddDays(365)
$certificate = $request.CreateSelfSigned($notBefore, $notAfter)

$certPem = $certificate.ExportCertificatePem()
$keyPem = $rsa.ExportPkcs8PrivateKeyPem()

[System.IO.File]::WriteAllText($certPath, $certPem, [System.Text.Encoding]::ASCII)
[System.IO.File]::WriteAllText($keyPath, $keyPem, [System.Text.Encoding]::ASCII)

Write-Output "[tls] Generated self-signed certificate:"
Write-Output "      $certPath"
Write-Output "      $keyPath"
