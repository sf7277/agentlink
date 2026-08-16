declare module "qrcode" {
  interface QrOptions {
    readonly type: "svg";
    readonly errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    readonly margin?: number;
  }

  interface QrCode {
    toString(
      text: string,
      options: QrOptions,
      callback: (error: Error | null, output: string) => void
    ): void;
  }

  const qrcode: QrCode;
  export default qrcode;
}
