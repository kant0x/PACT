import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "src");
const artifactDir = path.join(root, "artifacts");

const sources = Object.fromEntries(
  fs.readdirSync(sourceDir)
    .filter((file) => file.endsWith(".sol"))
    .map((file) => [file, { content: fs.readFileSync(path.join(sourceDir, file), "utf8") }]),
);

const input = {
  language: "Solidity",
  sources,
  settings: {
    // Arc is EVM-compatible, while the local Ganache runner does not yet
    // implement every opcode emitted for newer hard forks by recent solc.
    evmVersion: "shanghai",
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = output.errors ?? [];
for (const diagnostic of errors) {
  const stream = diagnostic.severity === "error" ? process.stderr : process.stdout;
  stream.write(`${diagnostic.formattedMessage}\n`);
}

if (errors.some(({ severity }) => severity === "error")) {
  process.exitCode = 1;
} else {
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.mkdirSync(artifactDir, { recursive: true });

  for (const [sourceName, contracts] of Object.entries(output.contracts)) {
    for (const [contractName, contract] of Object.entries(contracts)) {
      const artifact = {
        contractName,
        sourceName,
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
      };
      fs.writeFileSync(
        path.join(artifactDir, `${contractName}.json`),
        `${JSON.stringify(artifact, null, 2)}\n`,
      );
    }
  }

  process.stdout.write(`Compiled ${Object.keys(sources).length} Solidity sources.\n`);
}
