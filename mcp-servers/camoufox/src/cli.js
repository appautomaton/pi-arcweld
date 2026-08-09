import { isAbsolute } from "node:path";

export function parseCliArgs(args) {
  let executablePath;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--executable-path") {
      executablePath = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--executable-path=")) {
      executablePath = argument.slice("--executable-path=".length);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!executablePath) throw new Error("--executable-path requires an absolute browser path.");
  if (!isAbsolute(executablePath)) throw new Error("--executable-path must be absolute.");

  return { executablePath };
}
