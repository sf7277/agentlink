import { DomainError } from "../domain/errors.js";

export type Command =
  | { readonly kind: "help" }
  | { readonly kind: "projects" }
  | { readonly kind: "new"; readonly agent?: string; readonly project: string }
  | {
      readonly kind: "imports";
      readonly agent?: string;
      readonly project: string;
      readonly limit: number | "all";
    }
  | { readonly kind: "import_session"; readonly reference: string }
  | { readonly kind: "sessions" }
  | { readonly kind: "use"; readonly sessionId: string }
  | { readonly kind: "attach"; readonly sessionId: string }
  | { readonly kind: "resume"; readonly sessionId: string }
  | { readonly kind: "delete"; readonly sessionId: string }
  | { readonly kind: "delete_confirm"; readonly sessionId?: string }
  | { readonly kind: "status" }
  | { readonly kind: "recap" }
  | { readonly kind: "continue"; readonly text: string }
  | { readonly kind: "steer"; readonly text: string }
  | { readonly kind: "queue" }
  | { readonly kind: "queue_cancel"; readonly turnId?: string }
  | { readonly kind: "queue_resume" }
  | { readonly kind: "approvals" }
  | {
      readonly kind: "approval";
      readonly decision: "allow_once" | "deny" | "cancel";
      readonly leaseId?: string;
    }
  | { readonly kind: "stop" }
  | { readonly kind: "close" }
  | { readonly kind: "input"; readonly text: string };

function requireText(value: string | undefined, command: string): string {
  if (value === undefined || value.trim() === "") {
    throw new DomainError("command_argument_missing", `${command} requires an argument`);
  }
  return value.trim();
}

function requireSingleArgument(parts: readonly string[], command: string): string {
  if (parts.length !== 1) {
    throw new DomainError("command_argument_invalid", `${command} requires exactly one short ID`);
  }
  return requireText(parts[0], command);
}

function requireSequence(parts: readonly string[], command: string): string {
  const value = requireSingleArgument(parts, command);
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new DomainError(
      "command_argument_invalid",
      `${command} requires a list number`
    );
  }
  return value;
}

function parseImportList(parts: readonly string[]): Extract<Command, { kind: "imports" }> {
  if (parts.length < 1 || parts.length > 3 || parts[0] === undefined) {
    throw new DomainError(
      "command_argument_invalid",
      "/imports requires: project [number|all]"
    );
  }
  const explicitAgent =
    parts.length >= 2 && (parts[0] === "codex" || parts[0] === "grok" || parts[0] === "claude")
      ? parts[0]
      : undefined;
  const projectIndex = explicitAgent === undefined ? 0 : 1;
  const project = requireText(parts[projectIndex], "/imports");
  const requested = parts[projectIndex + 1] ?? "5";
  if (parts.length > projectIndex + 2) {
    throw new DomainError(
      "command_argument_invalid",
      "/imports requires: [agent] project [number|all]"
    );
  }
  if (requested === "all") {
    return {
      kind: "imports",
      ...(explicitAgent === undefined ? {} : { agent: explicitAgent }),
      project,
      limit: "all"
    };
  }
  if (!/^[1-9]\d*$/u.test(requested)) {
    throw new DomainError(
      "command_argument_invalid",
      "/imports count must be a positive number or all"
    );
  }
  return {
    kind: "imports",
    ...(explicitAgent === undefined ? {} : { agent: explicitAgent }),
    project,
    limit: Number.parseInt(requested, 10)
  };
}

export function parseCommand(text: string): Command {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "input", text: trimmed };
  const [head, ...parts] = trimmed.split(/\s+/u);
  const tail = parts.join(" ");
  switch (head) {
    case "/help":
      if (parts.length !== 0) {
        throw new DomainError("command_argument_invalid", "/help does not accept arguments");
      }
      return { kind: "help" };
    case "/projects": return { kind: "projects" };
    case "/new":
      if (parts.length === 1 && parts[0] !== undefined) {
        return { kind: "new", project: parts[0] };
      }
      if (parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined) {
        return { kind: "new", agent: parts[0], project: parts[1] };
      }
      throw new DomainError("command_argument_invalid", "/new requires: [agent] project");
    case "/imports":
      return parseImportList(parts);
    case "/import":
      return {
        kind: "import_session",
        reference: requireSequence(parts, "/import")
      };
    case "/sessions": return { kind: "sessions" };
    case "/use": return { kind: "use", sessionId: requireSingleArgument(parts, "/use") };
    case "/attach":
      return {
        kind: "attach",
        sessionId: requireSingleArgument(parts, "/attach")
      };
    case "/resume":
      return {
        kind: "resume",
        sessionId: requireSingleArgument(parts, "/resume")
      };
    case "/delete":
      if (parts[0] === "confirm" && parts.length === 1) {
        return { kind: "delete_confirm" };
      }
      if (parts[0] === "confirm" && parts.length === 2 && parts[1] !== undefined) {
        return { kind: "delete_confirm", sessionId: parts[1] };
      }
      if (parts[0] === "confirm") {
        throw new DomainError(
          "command_argument_invalid",
          "/delete confirm accepts at most one short ID"
        );
      }
      return { kind: "delete", sessionId: requireSingleArgument(parts, "/delete") };
    case "/status": return { kind: "status" };
    case "/recap": return { kind: "recap" };
    case "/continue": return { kind: "continue", text: requireText(tail, "/continue") };
    case "/steer": return { kind: "steer", text: requireText(tail, "/steer") };
    case "/queue":
      if (parts.length === 0) return { kind: "queue" };
      if (parts[0] === "resume" && parts.length === 1) return { kind: "queue_resume" };
      if (parts[0] === "cancel" && parts.length === 1) {
        return { kind: "queue_cancel" };
      }
      if (parts[0] === "cancel" && parts.length === 2 && parts[1] !== undefined) {
        return { kind: "queue_cancel", turnId: parts[1] };
      }
      throw new DomainError("command_argument_invalid", "Invalid /queue arguments");
    case "/approve":
      return {
        kind: "approval",
        decision: "allow_once",
        ...(parts.length === 0 ? {} : { leaseId: requireSingleArgument(parts, "/approve") })
      };
    case "/deny":
      return {
        kind: "approval",
        decision: "deny",
        ...(parts.length === 0 ? {} : { leaseId: requireSingleArgument(parts, "/deny") })
      };
    case "/cancel":
      return {
        kind: "approval",
        decision: "cancel",
        ...(parts.length === 0 ? {} : { leaseId: requireSingleArgument(parts, "/cancel") })
      };
    case "/approvals": return { kind: "approvals" };
    case "/stop": return { kind: "stop" };
    case "/close": return { kind: "close" };
    default: throw new DomainError("command_unknown", `Unknown command: ${head}`);
  }
}
