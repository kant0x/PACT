import type { HardhatUserConfig } from "hardhat/config";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import "dotenv/config";

const privateKey = process.env.GIWA_DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatVerify],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    giwaSepolia: {
      type: "http",
      chainType: "op",
      url: process.env.GIWA_SEPOLIA_RPC_URL ?? "https://sepolia-rpc.giwa.io",
      accounts: privateKey ? [privateKey] : [],
    },
  },
  chainDescriptors: {
    91342: {
      name: "GIWA Sepolia",
      blockExplorers: {
        blockscout: {
          name: "GIWA Sepolia Explorer",
          url: "https://sepolia-explorer.giwa.io",
          apiUrl: "https://sepolia-explorer.giwa.io/api",
        },
      },
    },
  },
};

export default config;
