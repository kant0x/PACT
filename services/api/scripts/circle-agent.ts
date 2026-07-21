import { spawn } from 'node:child_process';
import { buildSpendingPolicyArgs } from '../src/integrations/circle.js';

const command = process.argv[2] ?? 'status';
let args: string[];

if (command === 'status') {
  args = ['wallet', 'status', '--type', 'agent'];
} else if (command === 'create-testnet') {
  args = ['wallet', 'create', '--type', 'agent', '--testnet'];
} else if (command === 'list-arc') {
  args = ['wallet', 'list', '--chain', 'ARC-TESTNET', '--type', 'agent', '--output', 'json'];
} else if (command === 'policy') {
  args = buildSpendingPolicyArgs({
    address: process.env.CIRCLE_AGENT_WALLET_ADDRESS ?? '',
    chain: process.env.CIRCLE_POLICY_CHAIN ?? 'BASE',
    perTransaction: Number(process.env.CIRCLE_POLICY_PER_TX ?? 25),
    daily: Number(process.env.CIRCLE_POLICY_DAILY ?? 100),
    weekly: Number(process.env.CIRCLE_POLICY_WEEKLY ?? 500),
    monthly: Number(process.env.CIRCLE_POLICY_MONTHLY ?? 1500)
  });
} else {
  throw new Error('Use status, create-testnet, list-arc, or policy');
}

const executable = process.platform === 'win32' ? 'circle.cmd' : 'circle';
const child = spawn(executable, args, { stdio: 'inherit', shell: false });
child.once('error', (error) => {
  console.error('Circle CLI is unavailable. Install it with: npm install -g @circle-fin/cli');
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
