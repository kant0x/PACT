import { post } from './client.js';

const result = await post('/api/demo/seed', { successes: 8 });
console.log(JSON.stringify(result, null, 2));
