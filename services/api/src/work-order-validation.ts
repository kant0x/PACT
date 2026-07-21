import { inferTaskCategory, normalizeWorkOrderSpec, WORK_ORDER_TEMPLATE_IDS, type WorkOrderSpec } from '@pact/shared';
import { ApiProblem } from './errors.js';

const categories = new Set<WorkOrderSpec['category']>(['CREATIVE', 'SECURITY', 'RESEARCH', 'ENGINEERING']);

/** Upgrade an older three-field task into a useful, reviewable work envelope. */
export function defaultWorkOrderForTask(input: { title?: string; description?: string; successCriteria?: string }): Partial<WorkOrderSpec> {
  const criteria = typeof input.successCriteria === 'string' ? input.successCriteria.trim() : '';
  const reviewableCriteria = criteria.length >= 8 ? criteria : 'The requested result is present and ready for review.';
  return {
    category: inferTaskCategory(input) ?? undefined,
    inputRequirements: input.description,
    deliverableFormat: criteria.length >= 20 ? criteria : undefined,
    acceptanceChecklist: [
      reviewableCriteria,
      'The returned artifact can be checked from the supplied inputs and evidence.',
    ],
  };
}

/** Validate and normalize the creator's signed execution envelope. */
export function validateWorkOrderSpec(input: unknown): WorkOrderSpec {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new ApiProblem(400, 'INVALID_WORK_ORDER', 'workOrder must be an object');
  }
  const value = normalizeWorkOrderSpec(input as Partial<WorkOrderSpec> | null | undefined);
  if (!categories.has(value.category)) throw new ApiProblem(400, 'INVALID_WORK_CATEGORY', 'workOrder.category is not supported');
  if (value.templateId && !WORK_ORDER_TEMPLATE_IDS.includes(value.templateId)) throw new ApiProblem(400, 'INVALID_WORK_TEMPLATE', 'workOrder.templateId is not supported');
  if (value.inputRequirements.length < 20 || value.inputRequirements.length > 20_000) {
    throw new ApiProblem(400, 'INVALID_WORK_INPUTS', 'workOrder.inputRequirements must contain 20..20000 characters');
  }
  if (value.deliverableFormat.length < 20 || value.deliverableFormat.length > 20_000) {
    throw new ApiProblem(400, 'INVALID_WORK_OUTPUT', 'workOrder.deliverableFormat must contain 20..20000 characters');
  }
  if (value.acceptanceChecklist.length < 2 || value.acceptanceChecklist.length > 16) {
    throw new ApiProblem(400, 'INVALID_ACCEPTANCE_CHECKLIST', 'workOrder.acceptanceChecklist must contain 2..16 checks');
  }
  if (value.acceptanceChecklist.some((item) => item.length < 8 || item.length > 1_000)) {
    throw new ApiProblem(400, 'INVALID_ACCEPTANCE_CHECK', 'Each acceptance check must contain 8..1000 characters');
  }
  if (value.requiredCapabilities.length > 16 || value.requiredCapabilities.some((item) => item.length < 2 || item.length > 120)) {
    throw new ApiProblem(400, 'INVALID_REQUIRED_CAPABILITIES', 'Required capabilities must contain 2..120 characters each');
  }
  if (value.sourceUrl && (!/^https?:\/\//i.test(value.sourceUrl) || value.sourceUrl.length > 2_048)) {
    throw new ApiProblem(400, 'INVALID_SOURCE_URL', 'workOrder.sourceUrl must be an http(s) URL under 2048 characters');
  }
  return value;
}
