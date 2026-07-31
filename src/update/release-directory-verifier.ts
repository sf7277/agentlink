import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

export const releaseMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal("agentlink"),
  version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
  target: z.object({
    os: z.literal("darwin"),
    arch: z.enum(["arm64", "x64"])
  }).strict(),
  entrypoint: z.literal("dist/src/main.js"),
  nodeMajor: z.literal(22),
  runtime: z.object({
    path: z.literal("runtime/bin/node"),
    version: z.string().regex(/^22\.\d+\.\d+$/u)
  }).strict()
}).strict();

const releaseFileSchema = z.object({
  path: z.string().min(1).max(1024),
  size: z.number().int().nonnegative().max(1024 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

const releaseFilesSchema = z.object({
  schemaVersion: z.literal(1),
  algorithm: z.literal("sha256"),
  files: z.array(releaseFileSchema).min(1).max(20_000)
}).strict();

export type ReleaseMetadata = z.infer<typeof releaseMetadataSchema>;

export async function verifyReleaseDirectory(root: string): Promise<{
  readonly canonicalRoot: string;
  readonly metadata: ReleaseMetadata;
  readonly fileCount: number;
}> {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Release root must be a real directory");
  }
  const canonicalRoot = await realpath(root);
  const manifestBytes = await readFile(join(canonicalRoot, "release-files.json"));
  if (manifestBytes.length > 4 * 1024 * 1024) {
    throw new Error("Release file manifest exceeds size limit");
  }
  const manifest = releaseFilesSchema.parse(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  const expected = new Map<string, z.infer<typeof releaseFileSchema>>();
  for (const file of manifest.files) {
    assertSafeRelativePath(file.path);
    if (file.path === "release-files.json" || expected.has(file.path)) {
      throw new Error("Release file manifest contains a duplicate or self entry");
    }
    expected.set(file.path, file);
  }

  const seen = new Set<string>();
  const pending = [canonicalRoot];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const relativePath = relative(canonicalRoot, path).split("\\").join("/");
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`Release contains symlink: ${relativePath}`);
      if ((metadata.mode & 0o077) !== 0) {
        throw new Error(`Release entry is accessible by group or others: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!metadata.isFile()) throw new Error(`Release contains unsupported entry: ${relativePath}`);
      if (relativePath === "release-files.json") continue;
      const declared = expected.get(relativePath);
      if (declared === undefined) throw new Error(`Release contains unlisted file: ${relativePath}`);
      totalBytes += metadata.size;
      if (totalBytes > 1024 * 1024 * 1024) throw new Error("Release exceeds size limit");
      if (metadata.size !== declared.size || await sha256(path, metadata.size) !== declared.sha256) {
        throw new Error(`Release file verification failed: ${relativePath}`);
      }
      seen.add(relativePath);
    }
  }
  if (seen.size !== expected.size) {
    const missing = [...expected.keys()].find((path) => !seen.has(path));
    throw new Error(`Release file is missing: ${missing ?? "unknown"}`);
  }
  const metadata = releaseMetadataSchema.parse(
    JSON.parse(await readFile(join(canonicalRoot, "release.json"), "utf8")) as unknown
  );
  const runtimeDeclaration = expected.get(metadata.runtime.path);
  if (runtimeDeclaration === undefined) {
    throw new Error("Release runtime is missing from the file manifest");
  }
  const runtimePath = join(canonicalRoot, metadata.runtime.path);
  const runtimeMetadata = await lstat(runtimePath);
  if (!runtimeMetadata.isFile() || (runtimeMetadata.mode & 0o111) === 0) {
    throw new Error("Release runtime must be an executable regular file");
  }
  await assertMachOArchitecture(runtimePath, metadata.target.arch);
  return { canonicalRoot, metadata, fileCount: seen.size };
}

function assertSafeRelativePath(path: string): void {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    resolve("/", path) === "/"
  ) {
    throw new Error("Release file manifest contains an unsafe path");
  }
}

async function sha256(path: string, size: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position !== size) throw new Error("Release file changed during verification");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function assertMachOArchitecture(path: string, arch: "arm64" | "x64"): Promise<void> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.readUInt32LE(0) !== 0xfeedfacf) {
      throw new Error("Release runtime is not a supported 64-bit Mach-O executable");
    }
    const expectedCpuType = arch === "arm64" ? 0x0100000c : 0x01000007;
    if (header.readUInt32LE(4) !== expectedCpuType) {
      throw new Error(`Release runtime architecture does not match ${arch}`);
    }
  } finally {
    await handle.close();
  }
}
