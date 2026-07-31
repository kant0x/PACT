import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

if (fs.existsSync(envPath)) {
  throw new Error(`Refusing to overwrite existing ${envPath}`);
}

const privateKey = `0x${randomBytes(32).toString("hex")}`;
const account = privateKeyToAccount(privateKey);
const contents = [
  "# GIWA Sepolia deployment wallet. Never commit or share this file.",
  "GIWA_SEPOLIA_RPC_URL=https://sepolia-rpc.giwa.io",
  `GIWA_DEPLOYER_PRIVATE_KEY=${privateKey}`,
  "",
].join("\n");

fs.writeFileSync(envPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
process.stdout.write(`${account.address}\n`);
