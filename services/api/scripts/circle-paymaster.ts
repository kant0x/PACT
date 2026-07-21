import { createArcSponsoredWallet } from '../src/integrations/circle.js';
import {
  createCirclePaymasterFromEnv,
  type SponsoredOperation
} from '../src/integrations/paymaster.js';

const args = process.argv.slice(2);
const command = args[0];

const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || !args[index + 1]) throw new Error(`--${name} is required`);
  return args[index + 1];
};

if (command === 'create-wallet') {
  const result = await createArcSponsoredWallet();
  console.log(JSON.stringify(result, null, 2));
} else if (command === 'create-task' || command === 'post-collateral') {
  const walletId = option('wallet-id');
  let operation: SponsoredOperation;

  if (command === 'create-task') {
    operation = {
      kind: 'createTask',
      agentAddress: option('agent'),
      totalAmountUsdc: option('amount-usdc'),
      requiredCollateralPct: Number(option('collateral-pct'))
    };
  } else {
    operation = {
      kind: 'postCollateral',
      taskId: option('task-id'),
      collateralAmountUsdc: option('amount-usdc')
    };
  }

  const { adapter, ledger } = createCirclePaymasterFromEnv();
  try {
    const result = await adapter.sponsorFirstOperation(walletId, operation);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    ledger.close();
  }
} else {
  throw new Error(
    'Use create-wallet, create-task --wallet-id ... --agent ... --amount-usdc ... --collateral-pct ..., '
    + 'or post-collateral --wallet-id ... --task-id ... --amount-usdc ...'
  );
}
