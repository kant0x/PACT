import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("PACTGiwaRegistryModule", (module) => {
  const deployer = module.getAccount(0);
  const registry = module.contract("PACTGiwaRegistry", [deployer]);

  module.call(registry, "setIssuer", [deployer, true]);

  return { registry };
});
