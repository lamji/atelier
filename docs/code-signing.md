# Code-signing the Windows installer

Status: releases up to v1.0.2 were published unsigned. They are the reason
this page exists. `npm run release` no longer allows it: without a signing
credential the build does not start, and an installer Windows will not
vouch for is never tagged or published. This is what signing costs, what it
fixes, and how to turn it on.

## What being unsigned actually does

Windows shows **"Windows protected your PC — unknown publisher"** on first
run, and the user has to click *More info* → *Run anyway*. Every downloader
sees it, every time, until the file earns SmartScreen reputation. For a new
app distributed to people who did not build it themselves, that dialog is
the single largest thing standing between a download and a running app.

Publishing the SHA-256 (the release does, in the notes and in
`SHA256SUMS.txt`) proves the file was not tampered with **in transit**. It
does not remove the warning: SmartScreen asks who signed the code, not
whether the bytes match a hash the same page served.

## What removes it

An **Authenticode certificate** from a CA (DigiCert, Sectigo, SSL.com and
others). Two grades:

| | OV (standard) | EV |
|---|---|---|
| Cost | ~$200–400/year | ~$400–700/year |
| Delivery | file or hardware token | hardware token / cloud HSM (mandatory) |
| SmartScreen | warning until reputation builds | trusted immediately |
| Identity check | business verification | stricter business verification |

Since June 2023 the CA/Browser Forum requires private keys for OV
certificates to live on hardware too, so "download a .pfx and use it" is no
longer generally available from a public CA — expect a token, or a cloud
signing service (Azure Trusted Signing, DigiCert KeyLocker, SSL.com eSigner)
that signs over an API. Cloud signing is what fits an unattended
`npm run release`.

## Turning it on

The credential lives in the environment; nothing in `electron-builder.yml`
names a signer. `apps/desktop/scripts/signing.mjs` reads it and decides how
the build is invoked, in this order.

### Azure Trusted Signing (or another cloud/HSM signer)

What a certificate issued today can actually do, and what an unattended
`npm run release` can drive:

```powershell
$env:AZURE_SIGN_ENDPOINT  = "https://<region>.codesigning.azure.net"
$env:AZURE_SIGN_ACCOUNT   = "<trusted signing account>"
$env:AZURE_SIGN_PROFILE   = "<certificate profile>"
$env:AZURE_TENANT_ID      = "…"   # Entra ID service principal
$env:AZURE_CLIENT_ID      = "…"
$env:AZURE_CLIENT_SECRET  = "…"
npm run release
```

The release script turns the first three into
`-c.win.azureSignOptions.*` arguments for electron-builder; Azure's
`Invoke-TrustedSigning` reads the last three itself. Set the endpoint and
then leave one of the others out and the release stops in preflight naming
exactly which — a half-configured signer is a misconfiguration, not a
reason to fall back to unsigned.

### A certificate file

If you hold a .pfx (an older OV certificate, or one exported from a token
that allows it):

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"        # or the base64 of the file
$env:CSC_KEY_PASSWORD = "…"
npm run release
```

electron-builder picks these up on its own — nothing is passed to it.

### How it signs

`win.signtoolOptions` in `apps/desktop/electron-builder.yml` pins SHA-256
and an RFC 3161 timestamp server, so the signature keeps validating after
the certificate behind it expires.

## The gate

Signing fails quietly by design — electron-builder signs when a credential
is there and simply does not when it is not — so `scripts/release.mjs`
checks twice:

1. **Before the build.** No credential, no build. The twelve minutes are
   not spent producing something that has to be thrown away.
2. **After the build.** It asks Windows, not the environment:
   `Get-AuthenticodeSignature` on the installer must come back `Valid`.
   Anything else — not signed, expired, untrusted chain — stops the release
   before the commit, the tag and the upload. The certificate subject then
   goes into the release notes, so the notes describe a signature that was
   verified rather than one that was assumed.

The escape hatch is explicit and loud:

```sh
npm run release -- --allow-unsigned
```

It warns in the console, and the notes tell the downloader they will meet
SmartScreen and should check the SHA-256 first:

```powershell
Get-FileHash Atelier-Setup.exe -Algorithm SHA256
```

That is the honest position for a build nobody vouched for: verifiable, not
trusted.
