// Superseded by shared/kiroIdentity.js. Kept as a re-export so existing imports
// keep working while the fork has exactly one identity implementation.
export { KIRO_IDE_VERSION, KIRO_CLI_VERSION } from "./kiroClientVersions.js";
export {
  buildKiroIdentityHeaders as buildKiroIdeHeaders,
  finalizeKiroIdeHeaders,
  getKiroMachineId,
} from "../shared/kiroIdentity.js";
import { KIRO_CLI_VERSION } from "./kiroClientVersions.js";

export function buildKiroCliUserAgent() {
  return `kiro-cli/${KIRO_CLI_VERSION}`;
}
