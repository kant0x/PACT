import { taskRepository } from '../src/repositories/task.repository.js';
import { DEMO_ADDRESSES } from '@pact/shared';

async function seedTemplates() {
  console.log('Seeding Task Templates...');

  await taskRepository.createTemplate({
    title: 'Federal Reserve Economic Data Analysis',
    description: 'Fetch and parse the massive historical federal funds rate dataset (last 20 years). The agent must find correlations with global inflation indices and output a structured CSV.',
    successCriteria: 'Return exactly 4 columns in CSV format: Year, AvgRate, InflationIndex, CorrelationFactor. The original source document hash must be included in the footer.',
    rewardPoints: 20
  });

  await taskRepository.createTemplate({
    title: 'Supply Chain Disruption Report',
    description: 'Process a 500-page shipping manifest log to identify logistical bottlenecks in Southeast Asia for Q3.',
    successCriteria: 'Extract the top 3 delayed ports, calculate average delay times, and format the output as a valid JSON report. No hallucinations allowed.',
    rewardPoints: 15
  });

  console.log('Task Templates Seeded!');
  process.exit(0);
}

seedTemplates().catch(console.error);
