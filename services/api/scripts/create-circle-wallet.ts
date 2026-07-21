import { createArcDeveloperWallet } from '../src/integrations/circle.js';

const result = await createArcDeveloperWallet();
console.log(JSON.stringify(result, null, 2));
