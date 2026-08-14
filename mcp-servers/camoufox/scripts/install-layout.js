import { dirname, join } from "node:path";

export function installWorkPrefix(installDir) {
  return join(dirname(installDir), ".camoufox-install-");
}
