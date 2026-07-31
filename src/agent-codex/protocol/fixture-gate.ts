import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const manifestSchema = z.object({
  codexVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  experimentalIncluded: z.literal(false),
  requiredMethods: z.array(z.string().min(1)),
  requiredServerRequests: z.array(z.string().min(1))
}).passthrough();

export async function verifyProtocolFixture(directory: string): Promise<{
  readonly codexVersion: string;
  readonly methods: readonly string[];
}> {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as unknown
  );
  const clientRequest = await readFile(join(directory, "generated/ts/ClientRequest.ts"), "utf8");
  const serverRequest = await readFile(join(directory, "generated/ts/ServerRequest.ts"), "utf8");
  for (const method of manifest.requiredMethods) {
    if (!clientRequest.includes(`"method": "${method}"`)) {
      throw new Error(`Codex fixture is missing required method: ${method}`);
    }
  }
  for (const method of manifest.requiredServerRequests) {
    if (!serverRequest.includes(`"method": "${method}"`)) {
      throw new Error(`Codex fixture is missing required server request: ${method}`);
    }
  }
  return { codexVersion: manifest.codexVersion, methods: manifest.requiredMethods };
}
