import type { CredentialStore } from "../core/contracts/ports.js";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths,
  type MacosApplicationPaths
} from "../platform-macos/application-paths.js";
import { KeychainCredentialStore } from "../platform-macos/keychain-credential-store.js";
import { AtomicConfigStore as MacosAtomicConfigStore } from "../platform-macos/atomic-config-store.js";
import {
  ensureWindowsApplicationPaths,
  windowsApplicationPaths,
  type WindowsApplicationPaths
} from "../platform-windows/application-paths.js";
import { WindowsCredentialStore } from "../platform-windows/credential-store.js";
import { WindowsAtomicConfigStore } from "../platform-windows/atomic-config-store.js";
import type { ApplicationPaths } from "./application-paths.js";
import type { ConfigDocumentStore } from "../platform-macos/atomic-config-store.js";

export type SupportedApplicationPaths = MacosApplicationPaths | WindowsApplicationPaths;

export function applicationPaths(): SupportedApplicationPaths {
  if (process.platform === "darwin") return macosApplicationPaths();
  if (process.platform === "win32") return windowsApplicationPaths();
  throw new Error(`AgentLink supports macOS and Windows only; found ${process.platform}`);
}

export async function ensureApplicationPaths(paths: SupportedApplicationPaths): Promise<void> {
  if (process.platform === "darwin") {
    await ensureMacosApplicationPaths(paths as MacosApplicationPaths);
    return;
  }
  if (process.platform === "win32") {
    await ensureWindowsApplicationPaths(paths as WindowsApplicationPaths);
    return;
  }
  throw new Error(`AgentLink supports macOS and Windows only; found ${process.platform}`);
}

export function credentialStore(): CredentialStore {
  if (process.platform === "darwin") return new KeychainCredentialStore();
  if (process.platform === "win32") return new WindowsCredentialStore();
  throw new Error(`AgentLink supports macOS and Windows only; found ${process.platform}`);
}

export function configDocumentStore(path: string): ConfigDocumentStore {
  if (process.platform === "win32") return new WindowsAtomicConfigStore(path);
  if (process.platform === "darwin") {
    return new MacosAtomicConfigStore(path);
  }
  throw new Error(`AgentLink supports macOS and Windows only; found ${process.platform}`);
}

export async function cleanupPendingCredentialReferences(): Promise<void> {
  if (process.platform === "darwin") {
    await new KeychainCredentialStore().cleanupPendingReferences();
  }
}

export function isWindowsPaths(paths: ApplicationPaths): paths is WindowsApplicationPaths {
  return process.platform === "win32" && paths.socket.startsWith("\\\\.\\pipe\\");
}
