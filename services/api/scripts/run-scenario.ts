import { post } from './client.js';

const result = await post('/api/demo/scenario');
console.log(JSON.stringify(result, null, 2));
