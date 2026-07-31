import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalUpdateManifest,
  SignedUpdateManifestVerifier,
  type UpdateManifest,
  UpdateVerificationError
} from "../../src/update/signed-update-manifest.js";

function fixtureManifest(bytes: Buffer): UpdateManifest {
  return {
    schemaVersion: 1,
    product: "agentlink",
    releaseVersion: "0.2.0",
    issuedAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-20T00:00:00.000Z",
    target: { os: "darwin", arch: "arm64" },
    artifact: {
      url: "https://releases.agentlink.invalid/stable/agentlink-0.2.0.bin",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length
    },
    compatibilityMatrix: [{
      adapterVersion: "0.1.0",
      protocolRevision: "ilink-backend-v1",
      status: "incompatible",
      capabilities: ["text", "cursor", "stable-client-id"],
      verifiedAt: "2026-07-19T00:00:00.000Z"
    }],
    requiresLocalConfirmation: true
  };
}

test("signed update manifest pins key, compatibility matrix, target and artifact", async () => {
  const artifact = Buffer.from("verified update artifact", "utf8");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifest = fixtureManifest(artifact);
  const envelope = {
    keyId: "release-2026",
    manifest,
    signature: sign(null, Buffer.from(canonicalUpdateManifest(manifest)), privateKey).toString("base64")
  };
  const verifier = new SignedUpdateManifestVerifier({
    trustedKeys: new Map([["release-2026", publicKey]]),
    trustedReleaseBaseUrl: "https://releases.agentlink.invalid/stable/",
    currentAdapterVersion: "0.1.0",
    target: { os: "darwin", arch: "arm64" },
    now: () => new Date("2026-07-19T12:00:00.000Z")
  });
  const verified = verifier.verifyEnvelope(envelope);
  assert.equal(verified.currentAdapterStatus, "incompatible");

  const root = await mkdtemp(join(tmpdir(), "agentlink-update-manifest-"));
  const path = join(root, "artifact.bin");
  await writeFile(path, artifact);
  await verifier.verifyArtifact(path, verified);
  await writeFile(path, Buffer.from("tampered", "utf8"));
  await assert.rejects(
    verifier.verifyArtifact(path, verified),
    (error) => error instanceof UpdateVerificationError && error.code === "artifact_invalid"
  );
});

test("manifest tampering and channel-controlled download sources fail closed", () => {
  const artifact = Buffer.from("artifact", "utf8");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifest = fixtureManifest(artifact);
  const signature = sign(
    null,
    Buffer.from(canonicalUpdateManifest(manifest)),
    privateKey
  ).toString("base64");
  const verifier = new SignedUpdateManifestVerifier({
    trustedKeys: new Map([["release-2026", publicKey]]),
    trustedReleaseBaseUrl: "https://releases.agentlink.invalid/stable/",
    currentAdapterVersion: "0.1.0",
    target: { os: "darwin", arch: "arm64" },
    now: () => new Date("2026-07-19T12:00:00.000Z")
  });

  assert.throws(
    () => verifier.verifyEnvelope({
      keyId: "release-2026",
      manifest: { ...manifest, releaseVersion: "0.2.1" },
      signature
    }),
    (error) => error instanceof UpdateVerificationError && error.code === "invalid_signature"
  );

  const injected = {
    ...manifest,
    artifact: { ...manifest.artifact, url: "https://message.invalid/agentlink.bin" }
  };
  assert.throws(
    () => verifier.verifyEnvelope({
      keyId: "release-2026",
      manifest: injected,
      signature: sign(
        null,
        Buffer.from(canonicalUpdateManifest(injected)),
        privateKey
      ).toString("base64")
    }),
    (error) =>
      error instanceof UpdateVerificationError && error.code === "untrusted_download_source"
  );
});

test("expired, wrong-target and matrix-missing manifests are rejected after signature verification", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const base = fixtureManifest(Buffer.from("artifact", "utf8"));
  const verifier = new SignedUpdateManifestVerifier({
    trustedKeys: new Map([["release-2026", publicKey]]),
    trustedReleaseBaseUrl: "https://releases.agentlink.invalid/stable/",
    currentAdapterVersion: "0.1.0",
    target: { os: "darwin", arch: "arm64" },
    now: () => new Date("2026-07-21T00:00:00.000Z")
  });
  const envelope = (manifest: UpdateManifest) => ({
    keyId: "release-2026",
    manifest,
    signature: sign(
      null,
      Buffer.from(canonicalUpdateManifest(manifest)),
      privateKey
    ).toString("base64")
  });
  assert.throws(
    () => verifier.verifyEnvelope(envelope(base)),
    (error) => error instanceof UpdateVerificationError && error.code === "manifest_time_invalid"
  );

  const activeVerifier = new SignedUpdateManifestVerifier({
    trustedKeys: new Map([["release-2026", publicKey]]),
    trustedReleaseBaseUrl: "https://releases.agentlink.invalid/stable/",
    currentAdapterVersion: "9.9.9",
    target: { os: "darwin", arch: "arm64" },
    now: () => new Date("2026-07-19T12:00:00.000Z")
  });
  assert.throws(
    () => activeVerifier.verifyEnvelope(envelope(base)),
    (error) => error instanceof UpdateVerificationError && error.code === "matrix_missing"
  );
  assert.throws(
    () => activeVerifier.verifyEnvelope(envelope({
      ...base,
      target: { os: "darwin", arch: "x64" },
      compatibilityMatrix: [{
        ...base.compatibilityMatrix[0]!,
        adapterVersion: "9.9.9"
      }]
    })),
    (error) => error instanceof UpdateVerificationError && error.code === "target_mismatch"
  );
});
