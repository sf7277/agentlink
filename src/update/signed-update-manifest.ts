import { createHash, verify as verifySignature, type KeyLike } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";

const semverSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const compatibilityEntrySchema = z.object({
  adapterVersion: semverSchema,
  protocolRevision: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  status: z.enum(["verified", "incompatible"]),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u)).max(64),
  verifiedAt: z.iso.datetime()
}).strict();

export const updateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal("agentlink"),
  releaseVersion: semverSchema,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  target: z.object({
    os: z.enum(["darwin"]),
    arch: z.enum(["arm64", "x64"])
  }).strict(),
  artifact: z.object({
    url: z.string().url(),
    sha256: sha256Schema,
    size: z.number().int().positive().max(1024 * 1024 * 1024)
  }).strict(),
  compatibilityMatrix: z.array(compatibilityEntrySchema).min(1).max(100),
  requiresLocalConfirmation: z.literal(true)
}).strict();

export const signedUpdateEnvelopeSchema = z.object({
  keyId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  manifest: updateManifestSchema,
  signature: z.string().min(1).max(512)
}).strict();

export type UpdateManifest = z.infer<typeof updateManifestSchema>;
export type SignedUpdateEnvelope = z.infer<typeof signedUpdateEnvelopeSchema>;

export interface VerifiedUpdate {
  readonly manifest: UpdateManifest;
  readonly currentAdapterStatus: "verified" | "incompatible";
}

export class UpdateVerificationError extends Error {
  public constructor(
    public readonly code:
      | "invalid_envelope"
      | "unknown_signing_key"
      | "invalid_signature"
      | "manifest_time_invalid"
      | "target_mismatch"
      | "untrusted_download_source"
      | "matrix_missing"
      | "artifact_invalid",
    message: string
  ) {
    super(message);
    this.name = "UpdateVerificationError";
  }
}

export class SignedUpdateManifestVerifier {
  readonly #trustedBase: URL;

  public constructor(private readonly options: {
    readonly trustedKeys: ReadonlyMap<string, KeyLike>;
    readonly trustedReleaseBaseUrl: string;
    readonly currentAdapterVersion: string;
    readonly target: { readonly os: "darwin"; readonly arch: "arm64" | "x64" };
    readonly now?: () => Date;
  }) {
    this.#trustedBase = normalizedTrustedBase(options.trustedReleaseBaseUrl);
  }

  public verifyEnvelope(value: unknown): VerifiedUpdate {
    const result = signedUpdateEnvelopeSchema.safeParse(value);
    if (!result.success) {
      throw new UpdateVerificationError("invalid_envelope", "Update envelope is invalid");
    }
    const envelope = result.data;
    const key = this.options.trustedKeys.get(envelope.keyId);
    if (key === undefined) {
      throw new UpdateVerificationError("unknown_signing_key", "Update signing key is not trusted");
    }
    const signature = decodeCanonicalBase64(envelope.signature);
    if (
      signature === undefined ||
      !verifySignature(
        null,
        Buffer.from(canonicalJson(envelope.manifest), "utf8"),
        key,
        signature
      )
    ) {
      throw new UpdateVerificationError("invalid_signature", "Update signature is invalid");
    }

    const now = (this.options.now ?? (() => new Date()))().getTime();
    const issuedAt = Date.parse(envelope.manifest.issuedAt);
    const expiresAt = Date.parse(envelope.manifest.expiresAt);
    if (issuedAt > now || expiresAt <= now || expiresAt <= issuedAt) {
      throw new UpdateVerificationError("manifest_time_invalid", "Update manifest is not currently valid");
    }
    if (
      envelope.manifest.target.os !== this.options.target.os ||
      envelope.manifest.target.arch !== this.options.target.arch
    ) {
      throw new UpdateVerificationError("target_mismatch", "Update target does not match this host");
    }
    assertTrustedArtifactUrl(this.#trustedBase, envelope.manifest.artifact.url);
    const entry = envelope.manifest.compatibilityMatrix.find(
      (candidate) => candidate.adapterVersion === this.options.currentAdapterVersion
    );
    if (entry === undefined) {
      throw new UpdateVerificationError(
        "matrix_missing",
        "Signed compatibility matrix does not cover the current Adapter"
      );
    }
    return {
      manifest: envelope.manifest,
      currentAdapterStatus: entry.status
    };
  }

  public async verifyArtifact(path: string, update: VerifiedUpdate): Promise<void> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw new UpdateVerificationError("artifact_invalid", "Update artifact cannot be opened safely");
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== update.manifest.artifact.size) {
        throw new UpdateVerificationError("artifact_invalid", "Update artifact size does not match manifest");
      }
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < stat.size) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        hash.update(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (position !== stat.size || hash.digest("hex") !== update.manifest.artifact.sha256) {
        throw new UpdateVerificationError("artifact_invalid", "Update artifact hash does not match manifest");
      }
    } finally {
      await handle.close();
    }
  }
}

export function canonicalUpdateManifest(manifest: UpdateManifest): string {
  return canonicalJson(manifest);
}

function normalizedTrustedBase(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Trusted release base must be a credential-free HTTPS URL");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function assertTrustedArtifactUrl(base: URL, value: string): void {
  const artifact = new URL(value);
  if (
    artifact.protocol !== "https:" ||
    artifact.origin !== base.origin ||
    artifact.username !== "" ||
    artifact.password !== "" ||
    artifact.search !== "" ||
    artifact.hash !== "" ||
    !artifact.pathname.startsWith(base.pathname) ||
    /%(?:2e|2f|5c)/iu.test(artifact.pathname)
  ) {
    throw new UpdateVerificationError(
      "untrusted_download_source",
      "Update artifact is outside the trusted release source"
    );
  }
}

function decodeCanonicalBase64(value: string): Buffer | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error("Update manifest contains a non-JSON value");
}
