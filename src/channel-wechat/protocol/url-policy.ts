const TRUSTED_ILINK_HOSTS = new Set(["ilinkai.weixin.qq.com"]);

export function assertTrustedIlinkBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    !TRUSTED_ILINK_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("iLink base URL is not an approved HTTPS origin");
  }
  url.hash = "";
  url.search = "";
  return url.href;
}
