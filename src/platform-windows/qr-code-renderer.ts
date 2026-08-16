import { writeFile } from "node:fs/promises";
import QRCode from "qrcode";

export async function renderWindowsQr(content: string, outputPath: string): Promise<void> {
  const svg = await new Promise<string>((resolve, reject) => {
    QRCode.toString(
      content,
      { type: "svg", errorCorrectionLevel: "M", margin: 2 },
      (error, output) => error === null ? resolve(output) : reject(error)
    );
  });
  await writeFile(outputPath, svg, { encoding: "utf8", mode: 0o600 });
}
