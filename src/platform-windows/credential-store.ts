import type { CredentialStore } from "../core/contracts/ports.js";

interface CredentialEntry {
  setPassword(password: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
}

interface KeyringModule {
  Entry: new (service: string, username: string) => CredentialEntry;
}

const SERVICE = "AgentLink";

export class WindowsCredentialStore implements CredentialStore {
  public async put(reference: string, secret: string): Promise<void> {
    const entry = await this.entry(reference);
    if (secret.length === 0) throw new Error("Credential secret must not be empty");
    entry.setPassword(secret);
  }

  public async get(reference: string): Promise<string | undefined> {
    const entry = await this.entry(reference);
    return entry.getPassword() ?? undefined;
  }

  public async delete(reference: string): Promise<void> {
    const entry = await this.entry(reference);
    entry.deletePassword();
  }

  private async entry(reference: string): Promise<CredentialEntry> {
    validateReference(reference);
    if (process.platform !== "win32") {
      throw new Error("Windows Credential Manager is only available on Windows");
    }
    let module: KeyringModule;
    try {
      module = await import("@napi-rs/keyring") as unknown as KeyringModule;
    } catch (error) {
      throw new Error(
        "Windows Credential Manager binding is unavailable; reinstall AgentLink with optional dependencies",
        { cause: error }
      );
    }
    return new module.Entry(SERVICE, reference);
  }
}

function validateReference(reference: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(reference)) {
    throw new Error("Credential reference contains unsupported characters");
  }
}
