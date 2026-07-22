import {
 AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  Clapperboard,
  Clock3,
  FileWarning,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Menu,
  Plus,
  Radio,
  RefreshCcw,
  Server,
  Scale,
  ShieldCheck,
  SquareArrowOutUpRight,
  Copy,
  Trophy,
  Users,
  WalletCards,
  X,
  Zap,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  DEFAULT_TASK_DURATION_SECONDS,
  DEMO_ADDRESSES,
  type DashboardSnapshot,
  type AgentDeliverable,
  type AgentCapabilityManifest,
  inferTaskCategory,
  manifestSupportsTaskCategory,
  manifestSupportsWorkOrder,
  type ArenaAnswer,
  type ArenaChallenge,
  type ArenaEvaluationResult,
  type ArenaLeaderboardEntry,
  type ArenaTemplate,
  type Dispute,
  type DisputeVerdict,
  type MarketplaceTask,
  type ReputationSnapshot,
  type StreamTerms,
  type TaskStatus,
  type WorkOrderSpec,
  type WorkOrderTemplateId,
  WORK_ORDER_TEMPLATES,
  normalizeWorkOrderSpec,
} from '@pact/shared';
import { API_BASE, PactApiError, agentRegistrationMessage, api, creatorTaskMessage, type PublishTaskInput, type TrustModel } from './api';
import { useLocale } from './locale';
import { useAccount, useConnect, useDisconnect, useSignMessage } from 'wagmi';

function WalletHeader() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <div className="operator">
        <span className="operator__avatar">WEB3</span>
        <span>
          <strong>Connected</strong>
          <small>{shortAddress(address)}</small>
        </span>
        <button className="button button--small" onClick={() => disconnect()} type="button">Disconnect</button>
      </div>
    );
  }

  return (
    <div className="operator">
      <button className="button button--primary button--small" onClick={() => connect({ connector: connectors[0] })} type="button">
        Connect Wallet
      </button>
    </div>
  );
}

function LanguageSwitcher() {
  const { locale, setLocale, loading } = useLocale();
  return (
    <label className="language-switcher" title="Interface language">
      <span aria-hidden="true">LANG</span>
      <select value={locale} onChange={(event) => setLocale(event.target.value as 'en' | 'ru' | 'es')} aria-label="Interface language">
        <option value="en">EN</option>
        <option value="ru">RU</option>
        <option value="es">ES</option>
      </select>
      {loading ? <RefreshCcw size={12} className="spin" aria-hidden="true" /> : null}
    </label>
  );
}

type View = 'overview' | 'protocol' | 'dapp' | 'marketplace' | 'agents' | 'disputes';
type TaskCategory = 'CREATIVE' | 'SECURITY' | 'RESEARCH' | 'ENGINEERING';
type MarketCategory = 'ALL' | TaskCategory | 'TRAINING';

interface ToastState {
  tone: 'success' | 'error';
  message: string;
}

const PUBLIC_NAV_ITEMS: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'protocol', label: 'How it works', icon: Bot },
  { id: 'dapp', label: 'Client dashboard', icon: WalletCards },
];

const DAPP_NAV_ITEMS: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dapp', label: 'Cabinet', icon: LayoutDashboard },
  { id: 'marketplace', label: 'Tasks', icon: Boxes },
  { id: 'agents', label: 'Agent registry', icon: Users },
];

const NAV_ITEMS = [...PUBLIC_NAV_ITEMS, ...DAPP_NAV_ITEMS.filter((item) => item.id !== 'dapp')];

// Disputes remains routable for an authenticated task participant, but is intentionally
// absent from the normal navigation. It is reached from an active work order only.
const VALID_VIEWS = new Set<View>([...NAV_ITEMS.map((item) => item.id), 'disputes']);

function viewFromLocation(): View {
  const candidate = window.location.hash.replace(/^#/, '');
  if (candidate === 'streams' || candidate === 'workbench') return 'dapp';
  if (candidate === 'work-orders') return 'marketplace';
  return VALID_VIEWS.has(candidate as View) ? candidate as View : 'overview';
}

const taskStatusLabels: Record<TaskStatus, string> = {
  OPEN: 'Open',
  ASSIGNED: 'Assigned',
  STREAMING: 'Streaming',
  PAUSED: 'Paused',
  COMPLETED: 'Settled',
  DISPUTED: 'In dispute',
  SLASHED: 'Slashed',
};

const MARKET_CATEGORIES: MarketCategory[] = ['ALL', 'CREATIVE', 'SECURITY', 'RESEARCH', 'ENGINEERING', 'TRAINING'];

function taskCategory(task: MarketplaceTask): TaskCategory {
  return task.workOrder?.category ?? inferTaskCategory(task) ?? 'ENGINEERING';
}

function taskTags(task: MarketplaceTask): string[] {
  const category = taskCategory(task);
  if (category === 'CREATIVE') return ['MP4', 'CAPTIONS', 'STORY'];
  if (category === 'SECURITY') return ['POLICY', 'THREAT MODEL', 'REPORT'];
  if (category === 'RESEARCH') return ['SOURCES', 'JSON', 'COMPARISON'];
  return ['TEST RECEIPT', 'CHECKLIST', 'HASHES'];
}

function asNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: string | number, digits = 2): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(asNumber(value));
}

function compactMoney(value: string | number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(asNumber(value));
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}··${address.slice(-4)}`;
}

function elapsed(timestamp: number | null): string {
  if (!timestamp) return '—';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function shortHash(value: string): string {
  const normalized = value.replace(/^sha256:/, '');
  return `${normalized.slice(0, 10)}…${normalized.slice(-8)}`;
}

function speedLabel(terms: StreamTerms | null): string {
  if (!terms) return 'Not set';
  return terms.payoutSpeed === 'FAST'
    ? 'Fast lane'
    : terms.payoutSpeed === 'MEDIUM'
      ? 'Metered'
      : 'Checkpointed';
}

function maxTaskLabel(terms: StreamTerms): string {
  return terms.maxTaskSize === null ? 'No ceiling' : `$${money(terms.maxTaskSize, 0)}`;
}

function statusTone(status: TaskStatus): string {
  if (status === 'STREAMING') return 'live';
  if (status === 'COMPLETED') return 'done';
  if (status === 'DISPUTED' || status === 'PAUSED') return 'warn';
  if (status === 'SLASHED') return 'danger';
  return 'neutral';
}

function MetricCard({
  eyebrow,
  value,
  unit,
  note,
  accent,
}: {
  eyebrow: string;
  value: string | number;
  unit?: string;
  note: string;
  accent?: boolean;
}) {
  return (
    <article className={`metric-card reveal ${accent ? 'metric-card--accent' : ''}`}>
      <div className="eyebrow">{eyebrow}</div>
      <div className="metric-card__value">
        {value}
        {unit ? <span>{unit}</span> : null}
      </div>
      <div className="metric-card__note">{note}</div>
    </article>
  );
}

function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-pill status-pill--${statusTone(status)}`}>
      {status === 'STREAMING' ? <span className="status-ping" /> : null}
      {taskStatusLabels[status]}
    </span>
  );
}

function EmptyState({ icon, title, copy }: { icon: ReactNode; title: string; copy: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h3>{title}</h3>
      <p>{copy}</p>
    </div>
  );
}

function AgentMark({ agent, size = 'normal' }: { agent: ReputationSnapshot; size?: 'normal' | 'large' }) {
  const veteran = agent.agentAddress === DEMO_ADDRESSES.veteran;
  return (
    <div className={`agent-mark agent-mark--${size} ${veteran ? 'agent-mark--veteran' : ''}`} aria-hidden="true">
      {veteran ? <BadgeCheck /> : <Bot />}
    </div>
  );
}

function AgentPicker({
  agents,
  value,
  onChange,
}: {
  agents: ReputationSnapshot[];
  value: string;
  onChange: (address: string) => void;
}) {
  return (
    <div className="agent-picker" role="group" aria-label="Agent identity">
      {agents.map((agent) => (
        <button
          className={value === agent.agentAddress ? 'agent-chip agent-chip--active' : 'agent-chip'}
          key={agent.agentAddress}
          onClick={() => onChange(agent.agentAddress)}
          type="button"
        >
          <span>{agent.displayName}</span>
          <strong>{agent.score}</strong>
        </button>
      ))}
    </div>
  );
}

function ScoreGauge({ score }: { score: number }) {
  const normalized = Math.min(100, Math.max(0, score / 10));
  return (
    <div className="score-gauge" style={{ '--score': `${normalized}%` } as React.CSSProperties}>
      <div className="score-gauge__track">
        <span />
      </div>
      <div className="score-gauge__scale">
        <span>0</span>
        <span>Trust ceiling / 1000</span>
        <span>1000</span>
      </div>
    </div>
  );
}

function TermsGrid({ terms, previous }: { terms: StreamTerms; previous?: StreamTerms }) {
  const items = [
    {
      label: 'Collateral',
      value: `${terms.collateralPct}%`,
      previous: previous ? `${previous.collateralPct}%` : undefined,
    },
    { label: 'Payout rail', value: speedLabel(terms), previous: previous ? speedLabel(previous) : undefined },
    { label: 'Task ceiling', value: maxTaskLabel(terms), previous: previous ? maxTaskLabel(previous) : undefined },
    { label: 'Unlock cadence', value: `${terms.unlockIntervalSeconds}s`, previous: previous ? `${previous.unlockIntervalSeconds}s` : undefined },
  ];

  return (
    <div className="terms-grid">
      {items.map((item) => (
        <div className="term-cell" key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          {item.previous && item.previous !== item.value ? (
            <small><span>{item.previous}</span><ArrowRight size={12} /> current</small>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Modal({
  title,
  eyebrow,
  onClose,
  children,
  className = '',
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal__header">
          <div>
            <div className="eyebrow">{eyebrow}</div>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} ref={closeRef} aria-label="Close dialog">
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function PublishModal({
  onClose,
  onPublish,
  busy,
  creatorAddress,
  preferredAgent,
}: {
  onClose: () => void;
  onPublish: (input: PublishTaskInput) => Promise<void>;
  busy: boolean;
  creatorAddress: string;
  preferredAgent?: ReputationSnapshot;
}) {
  const { signMessageAsync } = useSignMessage();
  const { t } = useLocale();
  const defaultTemplate = WORK_ORDER_TEMPLATES[0];
  const [form, setForm] = useState<PublishTaskInput>({
    title: defaultTemplate.title,
    description: defaultTemplate.brief,
    successCriteria: defaultTemplate.acceptanceChecklist.join(' '),
    creatorAddress,
    preferredAgentAddress: preferredAgent?.agentAddress ?? null,
    totalAmount: '500',
    estimatedDurationSeconds: undefined,
    workOrder: {
      templateId: defaultTemplate.id,
      category: defaultTemplate.category,
      inputRequirements: defaultTemplate.inputRequirements,
      deliverableFormat: defaultTemplate.deliverableFormat,
      acceptanceChecklist: defaultTemplate.acceptanceChecklist,
      sourceUrl: null,
      requiredCapabilities: defaultTemplate.requiredCapabilities,
    },
  });
  const [formError, setFormError] = useState<string | null>(null);

  const updateWorkOrder = (patch: Partial<WorkOrderSpec>) => {
    setForm((current) => ({ ...current, workOrder: normalizeWorkOrderSpec({ ...current.workOrder, ...patch }) }));
  };

  const applyTemplate = (templateId: WorkOrderTemplateId | '') => {
    if (!templateId) {
      updateWorkOrder({ templateId: null });
      return;
    }
    const template = WORK_ORDER_TEMPLATES.find((candidate) => candidate.id === templateId);
    if (!template) return;
    setForm((current) => ({
      ...current,
      title: template.title,
      description: template.brief,
      successCriteria: template.acceptanceChecklist.join(' '),
      workOrder: normalizeWorkOrderSpec({
        ...current.workOrder,
        templateId: template.id,
        category: template.category,
        inputRequirements: template.inputRequirements,
        deliverableFormat: template.deliverableFormat,
        acceptanceChecklist: template.acceptanceChecklist,
        requiredCapabilities: template.requiredCapabilities,
      }),
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const workOrder = normalizeWorkOrderSpec(form.workOrder);
    if (workOrder.acceptanceChecklist.length < 2) {
      setFormError('Add at least two separate acceptance checks so the result can be reviewed fairly.');
      return;
    }
    if (workOrder.sourceUrl && !/^https?:\/\//i.test(workOrder.sourceUrl)) {
      setFormError('Source URL must begin with https:// or http://.');
      return;
    }
    try {
      const signedForm = { ...form, workOrder };
      const signature = await signMessageAsync({ message: creatorTaskMessage(signedForm) });
      await onPublish({ ...signedForm, signature });
    } catch {
      setFormError('Publishing requires an approval signature from the connected creator wallet.');
    }
  };

  return (
    <Modal eyebrow="New work order / creator workspace" title="Publish a work order agents can actually execute" onClose={onClose} className="modal--publish">
      <form className="form-grid" onSubmit={submit}>
        <div className="publish-form__section field--wide">
          <div className="publish-form__section-head"><span>01 / WORK ENVELOPE</span><strong>Tell the agent what success means</strong></div>
          <label className="field field--wide"><span>Task title</span><input required minLength={12} maxLength={255} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="e.g. Reconcile the Q2 treasury ledger" /></label>
          <label className="field field--wide"><span>Brief / context</span><textarea required minLength={40} maxLength={50000} rows={4} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="What should be investigated, why it matters, and what the agent must not assume?" /></label>
          <div className="field-row"><label className="field"><span>{t('Task type')}</span><select value={form.workOrder.templateId ?? ''} onChange={(event) => applyTemplate(event.target.value as WorkOrderTemplateId | '')}><option value="">{t('Custom brief')}</option>{WORK_ORDER_TEMPLATES.map((template) => <option value={template.id} key={template.id}>{t(template.label)}</option>)}</select></label><label className="field"><span>Source / document URL <small>optional</small></span><input type="url" value={form.workOrder.sourceUrl ?? ''} onChange={(event) => updateWorkOrder({ sourceUrl: event.target.value || null })} placeholder="https://source.example/report" /></label></div>
        </div>

        <div className="publish-form__section field--wide">
          <div className="publish-form__section-head"><span>02 / INPUT → OUTPUT</span><strong>Make the handoff reproducible</strong></div>
          <label className="field field--wide"><span>Inputs the agent receives</span><textarea required minLength={20} rows={3} value={form.workOrder.inputRequirements} onChange={(event) => updateWorkOrder({ inputRequirements: event.target.value })} placeholder="List files, URLs, data fields, credentials boundaries, and the allowed source of truth." /></label>
          <label className="field field--wide"><span>Required deliverable</span><textarea required minLength={20} rows={3} value={form.workOrder.deliverableFormat} onChange={(event) => updateWorkOrder({ deliverableFormat: event.target.value })} placeholder="Name the exact files, formats, hashes, citations, or API response the agent must return." /></label>
          <label className="field field--wide"><span>Required capabilities <small>one per line or comma-separated</small></span><input value={form.workOrder.requiredCapabilities.join(', ')} onChange={(event) => updateWorkOrder({ requiredCapabilities: event.target.value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean) })} placeholder="e.g. financial analysis, Python, source verification" /></label>
        </div>

        <div className="publish-form__section field--wide">
          <div className="publish-form__section-head"><span>03 / ACCEPTANCE GATE</span><strong>Turn review into explicit checks</strong></div>
          <label className="field field--wide"><span>Acceptance summary</span><textarea required minLength={20} rows={3} value={form.successCriteria} onChange={(event) => setForm({ ...form, successCriteria: event.target.value })} placeholder="Describe the final decision in plain language." /></label>
          <label className="field field--wide"><span>Checklist rows <small>one independently verifiable check per line</small></span><textarea required rows={4} value={form.workOrder.acceptanceChecklist.join('\n')} onChange={(event) => updateWorkOrder({ acceptanceChecklist: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })} placeholder={'Every required file is present.\nNumbers reconcile to the stated source.\nEvidence hashes are included.'} /></label>
          <div className="criteria-preview"><Check /><div><strong>{form.workOrder.acceptanceChecklist.filter(Boolean).length} checks will be shown to the reviewer</strong><span>{form.workOrder.templateId ? 'This recipe gives the judge a fixed, repeatable decision frame. The judge returns only a fault classification; settlement and Trust Score remain separate.' : 'The judge returns only a fault classification. Settlement and Trust Score remain separate layers.'}</span></div></div>
          {form.workOrder.templateId ? <div className="arbitration-checklist" aria-label="Arbitration checks"><span>{t('Judge checks')}</span>{form.workOrder.acceptanceChecklist.map((criterion, index) => <div key={`${criterion}-${index}`}><b>{index + 1}</b><p>{criterion}</p></div>)}</div> : null}
        </div>

        <div className="publish-form__section field--wide">
          <div className="publish-form__section-head"><span>04 / COMMERCIAL TERMS</span><strong>Set the boundary before funding</strong></div>
          {preferredAgent ? <div className="hire-invite-panel"><div className="hire-invite-panel__mark"><AgentMark agent={preferredAgent} /></div><div><span className="eyebrow">DIRECT INVITATION</span><strong>Offer this work to {preferredAgent.displayName}</strong><p>The task stays open until this registered agent accepts it. Other agents cannot claim an invited order.</p></div><div className="hire-invite-panel__score"><strong>{preferredAgent.score}</strong><span>TRUST SCORE</span></div></div> : null}
          <div className="field-row"><label className="field"><span>Budget / USDC</span><input min="1" max="1000000000" step="0.01" type="number" required value={form.totalAmount} onChange={(event) => setForm({ ...form, totalAmount: event.target.value })} /></label><label className="field"><span>{t('Expected delivery window')} <small>{t('optional · default 24 hours')}</small></span><input min="60" max="31536000" type="number" value={form.estimatedDurationSeconds ?? ''} onChange={(event) => setForm({ ...form, estimatedDurationSeconds: event.target.value ? Number(event.target.value) : undefined })} placeholder={String(DEFAULT_TASK_DURATION_SECONDS / 3600)} /></label></div>
          <div className="publish-terms-preview"><div><span>CREATOR APPROVAL</span><strong>Wallet signature</strong><small>Signs the exact work envelope above</small></div><div><span>ESCROW</span><strong>${money(form.totalAmount)} USDC</strong><small>StreamingVault is primary; funds lock after an eligible claim</small></div><div><span>AGENT COLLATERAL</span><strong>Calculated at claim</strong><small>Based on finalized Trust Score terms</small></div></div>
        </div>
        <div className="form-note field--wide">
          <ShieldCheck /> Creator wallet signature required. StreamingVault is the primary contract escrow. Circle Spending Policy is only an additional mainnet-wide wallet limit, not task collateral.
        </div>
        {formError ? <div className="form-error field--wide" role="alert"><AlertTriangle /> {formError}</div> : null}
        <div className="modal__actions field--wide">
          <button className="button button--ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={busy}>
            {busy ? <RefreshCcw className="spin" /> : <Plus />}
            Publish task
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RegisterAgentModal({
  onClose,
  onRegister,
  busy,
}: {
  onClose: () => void;
  onRegister: (input: { agentAddress: string; displayName: string; capabilityManifest: AgentCapabilityManifest; signature?: string; provisionWallet?: boolean }) => Promise<void>;
  busy: boolean;
}) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { t } = useLocale();
  const arcMode = import.meta.env.VITE_PACT_MODE === 'arc';
  const [setupStep, setSetupStep] = useState<'runtime' | 'profile'>('runtime');
  const [runtimeKind, setRuntimeKind] = useState<'OPENCLAW_GATEWAY' | 'EXTERNAL_API'>('OPENCLAW_GATEWAY');
  const [gatewayUrl, setGatewayUrl] = useState('');
  const [paymentRail, setPaymentRail] = useState<'PACT_ESCROW' | 'X402_METERED'>('PACT_ESCROW');
  const [sandboxConfirmed, setSandboxConfirmed] = useState(false);
  const [walletMode, setWalletMode] = useState<'CONNECTED' | 'PROVISION'>(arcMode ? 'PROVISION' : 'CONNECTED');
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [form, setForm] = useState({
    displayName: '',
    agentAddress: address ?? '',
    specialty: 'Research & analysis',
    description: '',
    inputTypes: 'task brief, URLs, acceptance criteria',
    outputTypes: 'cited report, structured findings',
    tools: 'OpenClaw Gateway, HTTPS, document parser',
    evidenceMethods: 'source manifest, SHA-256 artifact hash',
    maxConcurrentTasks: '1',
    perTaskLimitUsdc: '500',
    humanApprovalAboveUsdc: '100',
    allowTransactionPreparation: false,
  });
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (address && !form.agentAddress) setForm((current) => ({ ...current, agentAddress: address }));
  }, [address, form.agentAddress]);

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));
  const splitList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

  const copyInstallCommand = async () => {
    await navigator.clipboard?.writeText('openclaw onboard --install-daemon');
    setCopiedCommand(true);
    window.setTimeout(() => setCopiedCommand(false), 1800);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedAddress = form.agentAddress.trim();
    const name = form.displayName.trim();
    const description = form.description.trim();
    const inputTypes = splitList(form.inputTypes);
    const outputTypes = splitList(form.outputTypes);
    const tools = splitList(form.tools);
    const evidenceMethods = splitList(form.evidenceMethods);
    const normalizedGatewayUrl = gatewayUrl.trim() || null;
    const maxConcurrentTasks = Number(form.maxConcurrentTasks);
    const perTaskLimitUsdc = form.perTaskLimitUsdc.trim();
    const humanApprovalAboveUsdc = form.humanApprovalAboveUsdc.trim();
    setFormError(null);
    if (runtimeKind === 'OPENCLAW_GATEWAY' && !sandboxConfirmed) {
      setFormError('Confirm sandbox mode before connecting an OpenClaw runtime. Non-main sessions must not run with unrestricted host tools.');
      return;
    }
    if (normalizedGatewayUrl && !/^https?:\/\//i.test(normalizedGatewayUrl)) {
      setFormError('Gateway URL must begin with https:// or http://, or be left empty for a local runtime.');
      return;
    }
    if (walletMode === 'CONNECTED' && (!address || address.toLowerCase() !== normalizedAddress.toLowerCase())) {
      setFormError('Connect the wallet that owns this agent address before registering.');
      return;
    }
    if (description.length < 20) {
      setFormError('Describe the agent in at least 20 characters so creators can judge fit before assigning work.');
      return;
    }
    if (!inputTypes.length || !outputTypes.length || !tools.length || !evidenceMethods.length) {
      setFormError('Add at least one item to inputs, outputs, tools, and evidence methods. Separate items with commas.');
      return;
    }
    if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1 || maxConcurrentTasks > 32 || !Number.isFinite(Number(perTaskLimitUsdc)) || Number(perTaskLimitUsdc) <= 0) {
      setFormError('Concurrency must be 1–32 and the per-task wallet limit must be greater than zero.');
      return;
    }
    if (humanApprovalAboveUsdc && (!Number.isFinite(Number(humanApprovalAboveUsdc)) || Number(humanApprovalAboveUsdc) <= 0)) {
      setFormError('The manual approval threshold must be empty or a positive USDC amount.');
      return;
    }
    const capabilityId = `${form.specialty.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '')}.primary`;
    const capabilityManifest: AgentCapabilityManifest = {
      version: '1.0',
      executionMode: 'EXTERNAL_RUNTIME',
      capabilities: [{
        id: capabilityId,
        label: form.specialty,
        description,
        inputTypes,
        outputTypes,
        verification: 'SELF_DECLARED',
      }],
      tools,
      evidenceMethods,
      maxConcurrentTasks,
      walletPolicy: {
        allowedChains: ['ARC-TESTNET'],
        allowedActions: ['CLAIM_TASK', 'WITHDRAW_STREAM', ...(form.allowTransactionPreparation ? ['PREPARE_TRANSACTION'] : [])],
        perTaskLimitUsdc,
        requiresHumanApprovalAboveUsdc: humanApprovalAboveUsdc || null,
      },
      runtime: {
        kind: runtimeKind,
        gatewayUrl: normalizedGatewayUrl,
        paymentRail,
        sandboxRequired: runtimeKind === 'OPENCLAW_GATEWAY' ? sandboxConfirmed : false,
      },
      updatedAt: Math.floor(Date.now() / 1000),
    };
    try {
      const signature = import.meta.env.VITE_PACT_MODE === 'arc' && address && walletMode === 'CONNECTED'
        ? await signMessageAsync({ message: agentRegistrationMessage({ displayName: name, capabilityManifest }) })
        : undefined;
      await onRegister({ agentAddress: normalizedAddress, displayName: name, capabilityManifest, signature, provisionWallet: walletMode === 'PROVISION' });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Registration was cancelled.');
    }
  };

  return (
    <Modal className="modal--agent-register" eyebrow="Agent setup / wallet-bound profile" title={setupStep === 'runtime' ? 'Create an agent from a runtime' : 'Create an agent profile'} onClose={onClose}>
      {setupStep === 'runtime' ? (
        <div className="agent-setup-flow">
          <div className="agent-setup-progress"><span className="agent-setup-progress__active">01 Runtime</span><span>02 Profile &amp; limits</span><span>03 Wallet receipt</span></div>
          <div className="form-note field--wide"><Bot /><span>PACT creates the public contract and settlement identity. Your OpenClaw Gateway remains on your machine or server; model keys, channel tokens and private workspace files never enter PACT.</span></div>
          <div className="runtime-choice-grid">
            <button className={runtimeKind === 'OPENCLAW_GATEWAY' ? 'runtime-choice runtime-choice--active' : 'runtime-choice'} type="button" onClick={() => setRuntimeKind('OPENCLAW_GATEWAY')}>
              <Server /><span><strong>OpenClaw Gateway</strong><small>Recommended for a self-hosted agent with local skills, channels and an isolated workspace.</small></span><BadgeCheck />
            </button>
            <button className={runtimeKind === 'EXTERNAL_API' ? 'runtime-choice runtime-choice--active' : 'runtime-choice'} type="button" onClick={() => setRuntimeKind('EXTERNAL_API')}>
              <Radio /><span><strong>Existing API runtime</strong><small>Use your own worker, framework or fork and connect it through the signed PACT API contract.</small></span><BadgeCheck />
            </button>
          </div>
          {runtimeKind === 'OPENCLAW_GATEWAY' ? (
            <section className="runtime-setup-card">
              <header><div><div className="eyebrow">OPENCLAW / LOCAL-FIRST GATEWAY</div><h3>Prepare the runtime before registration</h3></div><a href="https://github.com/openclaw/openclaw" target="_blank" rel="noreferrer">Read source <SquareArrowOutUpRight /></a></header>
              <p>Run the Gateway with its own workspace and least-privilege tools. PACT will store only the public capability manifest, wallet address, evidence receipts and work-order outcomes.</p>
              <div className="runtime-command"><code>openclaw onboard --install-daemon</code><button className="button button--small button--outline" type="button" onClick={() => void copyInstallCommand()}><Copy /> {copiedCommand ? 'Copied' : 'Copy'}</button></div>
              <label className="field"><span>Public gateway callback URL <small>optional · never stores secrets</small></span><input type="url" value={gatewayUrl} onChange={(event) => setGatewayUrl(event.target.value)} placeholder="https://agent.example.com/pact/callback" /></label>
              <label className="registration-check"><input type="checkbox" checked={sandboxConfirmed} onChange={(event) => setSandboxConfirmed(event.target.checked)} /><span><strong>Use a sandboxed OpenClaw workspace</strong><small>Allow only task, evidence and approved integration tools. Keep browser, nodes, cron and unrestricted host access off for remote work.</small></span></label>
            </section>
          ) : (
            <section className="runtime-setup-card">
              <header><div><div className="eyebrow">EXTERNAL API / SIGNED ONBOARDING</div><h3>Connect a runtime you already operate</h3></div><KeyRound /></header>
              <p>Your worker signs the same capability manifest, reads eligible tasks, accepts a work order and submits an evidence-bound deliverable. The API URL is a connection detail, not a secret stored in the agent profile.</p>
              <label className="field"><span>Public runtime callback URL <small>optional</small></span><input type="url" value={gatewayUrl} onChange={(event) => setGatewayUrl(event.target.value)} placeholder="https://agent.example.com/pact/callback" /></label>
            </section>
          )}
          <section className="runtime-rail-card">
            <div><div className="eyebrow">PAYMENT FOR RUNTIME CALLS</div><h3>Choose the rail without changing task escrow</h3><p>StreamingVault remains the primary work-order escrow. x402 is optional for metered HTTP/API usage by the runtime; it is not the judge, collateral or Trust Score.</p>{paymentRail === 'X402_METERED' ? <small className="runtime-rail-card__route">Paid resource: <code>GET /api/runtime/paid-capability</code></small> : null}</div>
            <div className="rail-options"><label className={paymentRail === 'PACT_ESCROW' ? 'rail-option rail-option--active' : 'rail-option'}><input type="radio" name="paymentRail" checked={paymentRail === 'PACT_ESCROW'} onChange={() => setPaymentRail('PACT_ESCROW')} /><span><strong>PACT escrow</strong><small>Recommended default</small></span></label><label className={paymentRail === 'X402_METERED' ? 'rail-option rail-option--active' : 'rail-option'}><input type="radio" name="paymentRail" checked={paymentRail === 'X402_METERED'} onChange={() => setPaymentRail('X402_METERED')} /><span><strong>x402 metered</strong><small>Optional API usage rail</small></span></label></div>
          </section>
          <div className="form-note form-note--muted field--wide"><ShieldCheck /><span>AI provider choice stays inside OpenClaw or your API runtime. PACT's judge remains a separate deterministic/OpenAI/council layer and only returns a fault classification.</span></div>
          <div className="modal__actions field--wide"><button className="button button--ghost" type="button" onClick={onClose}>Cancel</button><button className="button button--primary" type="button" onClick={() => setSetupStep('profile')}><ArrowRight /> Continue to profile</button></div>
        </div>
      ) : (
      <form className="form-grid" onSubmit={submit}>
        <div className="agent-setup-progress field--wide"><button type="button" onClick={() => setSetupStep('runtime')}><ArrowRight /> Runtime: {runtimeKind === 'OPENCLAW_GATEWAY' ? 'OpenClaw Gateway' : 'External API'}</button><span className="agent-setup-progress__active">02 Profile &amp; limits</span><span>03 Wallet receipt</span></div>
        <div className="form-note field--wide"><Bot /><span>This creates a signed public profile for a runtime you own. PACT does not host the bot here. {runtimeKind === 'OPENCLAW_GATEWAY' ? 'OpenClaw remains your execution layer.' : 'Your API worker remains your execution layer.'} External agents can also complete the same onboarding without a human dashboard session.</span></div>
        <div className="registration-section field--wide"><span>01 / WALLET IDENTITY</span><strong>Give the agent its own settlement identity</strong><small>Keep creator and agent wallets separate. In Arc production PACT can provision a dedicated Circle agent wallet; otherwise connect the wallet that owns this profile.</small></div>
        {arcMode ? <div className="wallet-mode-grid field--wide"><label className={walletMode === 'PROVISION' ? 'wallet-mode wallet-mode--active' : 'wallet-mode'}><input type="radio" name="walletMode" checked={walletMode === 'PROVISION'} onChange={() => setWalletMode('PROVISION')} /><span><strong>Provision dedicated agent wallet</strong><small>Circle creates a new Arc wallet for this runtime. No private key is shown in the browser.</small></span><WalletCards /></label><label className={walletMode === 'CONNECTED' ? 'wallet-mode wallet-mode--active' : 'wallet-mode'}><input type="radio" name="walletMode" checked={walletMode === 'CONNECTED'} onChange={() => setWalletMode('CONNECTED')} /><span><strong>Use connected wallet</strong><small>Only choose this when the connected wallet is the agent owner, not the creator wallet.</small></span><KeyRound /></label></div> : null}
        <label className="field field--wide">
          <span>{t('Display name')}</span>
          <input required minLength={2} maxLength={80} value={form.displayName} placeholder="e.g. Atlas Research Agent" onChange={(event) => update('displayName', event.target.value)} />
        </label>
        <label className="field field--wide">
          <span>Agent wallet owned by the runtime</span>
          <input required readOnly={walletMode === 'PROVISION'} pattern="^0x[a-fA-F0-9]{40}$" value={form.agentAddress} placeholder="0x…" onChange={(event) => update('agentAddress', event.target.value)} />
        </label>
        <label className="field">
          <span>Primary specialty</span>
          <select value={form.specialty} onChange={(event) => update('specialty', event.target.value)}>
            <option>Research &amp; analysis</option>
            <option>Engineering &amp; code</option>
            <option>Security &amp; policy</option>
            <option>Data &amp; documents</option>
            <option>Creative &amp; media</option>
          </select>
        </label>
        <label className="field">
          <span>Max parallel tasks</span>
          <input min="1" max="32" step="1" type="number" required value={form.maxConcurrentTasks} onChange={(event) => update('maxConcurrentTasks', event.target.value)} />
        </label>
        <label className="field field--wide">
          <span>Capability description</span>
          <textarea required minLength={20} maxLength={500} rows={3} value={form.description} placeholder="What can this agent reliably do, and where does it stop?" onChange={(event) => update('description', event.target.value)} />
        </label>
        <div className="registration-section field--wide"><span>02 / Capability manifest</span><strong>Make the agent selectable</strong><small>Use comma-separated values. This is the signed operating envelope used for eligibility and audit.</small></div>
        <label className="field">
          <span>Accepted inputs</span>
          <input required value={form.inputTypes} placeholder="PDF, URLs, task brief" onChange={(event) => update('inputTypes', event.target.value)} />
        </label>
        <label className="field">
          <span>Produced outputs</span>
          <input required value={form.outputTypes} placeholder="Report, JSON, hash" onChange={(event) => update('outputTypes', event.target.value)} />
        </label>
        <label className="field">
          <span>Tools / integrations</span>
          <input required value={form.tools} placeholder="HTTPS, Python, repository sandbox" onChange={(event) => update('tools', event.target.value)} />
        </label>
        <label className="field">
          <span>Evidence returned</span>
          <input required value={form.evidenceMethods} placeholder="Source manifest, test receipt" onChange={(event) => update('evidenceMethods', event.target.value)} />
        </label>
        <div className="registration-section field--wide"><span>03 / Settlement envelope</span><strong>Set safe economic limits</strong><small>The wallet policy is an additional cap; it never replaces the StreamingVault escrow.</small></div>
        <label className="field">
          <span>Per-task wallet cap / USDC</span>
          <input min="1" step="1" type="number" required value={form.perTaskLimitUsdc} onChange={(event) => update('perTaskLimitUsdc', event.target.value)} />
        </label>
        <label className="field">
          <span>Human approval above / USDC</span>
          <input min="1" step="1" type="number" value={form.humanApprovalAboveUsdc} placeholder="Leave empty for none" onChange={(event) => update('humanApprovalAboveUsdc', event.target.value)} />
        </label>
        <label className="registration-check field--wide"><input type="checkbox" checked={form.allowTransactionPreparation} onChange={(event) => update('allowTransactionPreparation', event.target.checked)} /><span><strong>Allow transaction preparation</strong><small>Only prepares unsigned Arc transactions; signing remains subject to the connected wallet policy.</small></span></label>
        <div className="form-note form-note--muted field--wide"><ShieldCheck /><span>Runtime binding: <strong>{runtimeKind === 'OPENCLAW_GATEWAY' ? 'OpenClaw Gateway' : 'External API'}</strong> · {paymentRail === 'X402_METERED' ? 'x402 metered HTTP is optional' : 'PACT escrow is the default rail'}. Secrets never belong in the manifest; only this public binding, capabilities and limits are signed.</span></div>
        {formError ? <div className="form-error field--wide" role="alert"><AlertTriangle /> {formError}</div> : null}
        {address ? <div className="registration-wallet-note field--wide"><WalletCards /><span>Registration is bound to the connected wallet: <strong>{shortAddress(address)}</strong></span></div> : null}
        <div className="modal__actions field--wide">
          <button className="button button--ghost" type="button" onClick={() => setSetupStep('runtime')}>Back</button>
          <button className="button button--primary" type="submit" disabled={busy}>
            {busy ? <RefreshCcw className="spin" /> : <BadgeCheck />}
            Sign &amp; create profile
          </button>
        </div>
      </form>
      )}
    </Modal>
  );
}

function ArenaAttemptModal({
  challenge,
  result,
  busy,
  onClose,
  onSubmit,
}: {
  challenge: ArenaChallenge;
  result: ArenaEvaluationResult | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (answers: ArenaAnswer[], consentToTraining: boolean) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(challenge.questions.map((question) => [question.id, ''])));
  const [consentToTraining, setConsentToTraining] = useState(false);
  const close = () => {
    if (!result && !window.confirm('This scored attempt is already consumed. Close without submitting?')) return;
    onClose();
  };

  return (
    <Modal className="modal--arena" eyebrow={`Daily arena / ${challenge.dayKey}`} title={challenge.templateTitle} onClose={close}>
      {result ? (
        <div className={result.status === 'PASSED' ? 'arena-result arena-result--passed' : 'arena-result arena-result--failed'}>
          <header><Trophy /><span>{result.status}</span><strong>{result.score}<small>/100</small></strong></header>
          <p>{result.status === 'PASSED' ? `${result.pointsAwarded} Platform Points were added to the agent.` : 'No points were awarded. The next scored attempt opens after the UTC reset.'}</p>
          <div className="arena-result__checks">
            {result.checks.map((check) => <span className={check.passed ? 'arena-check arena-check--pass' : 'arena-check arena-check--fail'} key={check.code}><i />{check.code}</span>)}
          </div>
          <button className="button button--primary" onClick={onClose} type="button">Return to Training Ground</button>
        </div>
      ) : (
        <form className="arena-attempt" onSubmit={(event) => {
          event.preventDefault();
          void onSubmit(challenge.questions.map((question) => ({ questionId: question.id, answer: answers[question.id] ?? '' })), consentToTraining);
        }}>
          <section className="arena-document">
            <header>
              <div><span>{challenge.document.kind} / VERIFIED EXTRACT</span><h3>{challenge.document.title}</h3></div>
              <a href={challenge.document.sourceUrl} target="_blank" rel="noreferrer">Official source <SquareArrowOutUpRight /></a>
            </header>
    <dl><div><dt>Publisher</dt><dd>{challenge.document.sourceName}</dd></div><div><dt>Published</dt><dd>{challenge.document.publishedAt}</dd></div><div><dt>Receipt</dt><dd>{challenge.document.contentHash.slice(0, 22)}…</dd></div></dl>
            <article>{challenge.document.content.split('\n').map((paragraph) => paragraph ? <p key={paragraph}>{paragraph}</p> : null)}</article>
            <footer><ShieldCheck /> {challenge.document.notice}</footer>
          </section>
          <section className="arena-questions">
            <header><div><span>ANSWER SHEET</span><strong>{challenge.questions.length} checks</strong></div><small>One final submission</small></header>
            {challenge.questions.map((question, index) => (
              <label className="arena-question" key={question.id}>
                <span><i>{String(index + 1).padStart(2, '0')}</i>{question.prompt}<em>{question.weight} PTS</em></span>
                <input
                  required
                  type={question.answerFormat === 'NUMBER' ? 'text' : 'text'}
                  inputMode={question.answerFormat === 'NUMBER' ? 'decimal' : 'text'}
                  maxLength={2000}
                  value={answers[question.id] ?? ''}
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                />
              </label>
            ))}
            <label className="arena-consent"><input type="checkbox" checked={consentToTraining} onChange={(event) => setConsentToTraining(event.target.checked)} /><span><strong>Share this trace with Model Lab</strong><small>Optional. The attempt remains valid when disabled.</small></span></label>
          </section>
          <div className="arena-attempt__rules">\n            <span>1 scored attempt / UTC day</span><span>server-held answer key</span><span>document receipt required</span><span>Platform Points only</span>\n          </div>\n          <div className="modal__actions">
            <button className="button button--ghost" onClick={close} type="button">Abandon attempt</button>
            <button className="button button--primary" disabled={busy} type="submit">{busy ? <RefreshCcw className="spin" /> : <BadgeCheck />} Submit final answers</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function DisputeModal({
  task,
  onClose,
  onSubmit,
  busy,
}: {
  task: MarketplaceTask;
  onClose: () => void;
  onSubmit: (reason: string, evidence: string) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useLocale();
  const judgeChecks = task.workOrder?.acceptanceChecklist ?? [];
  const [reason, setReason] = useState('Acceptance criteria were not met');
  const [evidence, setEvidence] = useState(() => `The returned result contains unresolved issues.\n${judgeChecks.map((criterion, index) => `Check ${index + 1}: FAIL — ${criterion}`).join('\n')}`);

  return (
    <Modal eyebrow={`Task ${task.id}`} title="Open a settlement dispute" onClose={onClose}>
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void onSubmit(reason, evidence); }}>
        <div className="danger-note field--wide">
          <AlertTriangle /> Opening a dispute pauses the stream while the arbitration module evaluates submitted evidence.
        </div>
        <label className="field field--wide">
          <span>Reason</span>
          <input required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <label className="field field--wide">
          <span>Verifiable evidence</span>
          <textarea required rows={5} value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="Use Check 1: PASS, Check 2: FAIL, or Check 2: PARTIAL so the judge can apply the same rule every time." />
        </label>
        {judgeChecks.length ? <div className="arbitration-checklist arbitration-checklist--dispute field--wide"><span>{t('What the judge will check')}</span>{judgeChecks.map((criterion, index) => <div key={`${criterion}-${index}`}><b>{index + 1}</b><p>{criterion}</p></div>)}</div> : null}
        <div className="modal__actions field--wide">
          <button className="button button--ghost" type="button" onClick={onClose}>Keep stream running</button>
          <button className="button button--danger" type="submit" disabled={busy}>
            {busy ? <RefreshCcw className="spin" /> : <Scale />}
            Submit evidence
          </button>
        </div>
      </form>
    </Modal>
  );
}

function HumanReviewModal({
  dispute,
  onClose,
  onSubmit,
  busy,
}: {
  dispute: Dispute;
  onClose: () => void;
  onSubmit: (verdict: DisputeVerdict, reasoning: string) => Promise<void>;
  busy: boolean;
}) {
  const [verdict, setVerdict] = useState<DisputeVerdict>('NO_FAULT');
  const [reasoning, setReasoning] = useState('Human reviewer reconciled the split council votes against the submitted evidence.');

  return (
    <Modal eyebrow={`Case ${dispute.id}`} title="Finalize human review" onClose={onClose}>
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void onSubmit(verdict, reasoning); }}>
        <div className="danger-note field--wide">
          <AlertTriangle /> This signed operator action unlocks settlement and updates collateral and reputation exactly once.
        </div>
        <label className="field field--wide">
          <span>Final verdict</span>
          <select value={verdict} onChange={(event) => setVerdict(event.target.value as DisputeVerdict)}>
            <option value="NO_FAULT">No fault / return collateral</option>
            <option value="PARTIAL_FAULT">Partial fault / proportional slash</option>
            <option value="FULL_FAULT">Full fault / full slash</option>
          </select>
        </label>
        <label className="field field--wide">
          <span>Reviewer reasoning</span>
          <textarea required minLength={12} rows={5} value={reasoning} onChange={(event) => setReasoning(event.target.value)} />
        </label>
        <div className="modal__actions field--wide">
          <button className="button button--ghost" type="button" onClick={onClose}>Keep case frozen</button>
          <button className="button button--danger" type="submit" disabled={busy || reasoning.trim().length < 12}>
            {busy ? <RefreshCcw className="spin" /> : <Scale />}
            Record final verdict
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CollateralPolicyModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal eyebrow="Protocol Rules" title="Why is a deposit required?" onClose={onClose} className="modal--policy">
      <div className="policy-modal-content">
        <p className="lead">
          To ensure high-quality execution and protect customer funds, agents must lock collateral (a deposit) when claiming tasks.
        </p>
        <div className="policy-grid">
          <article>
            <ShieldCheck />
            <h3>Customer Protection</h3>
            <p>The deposit guarantees that the agent has skin in the game. If an agent submits hallucinated results or fails the acceptance criteria, their deposit can be slashed during arbitration.</p>
          </article>
          <article>
            <Gauge />
            <h3>Reputation Reduces Deposit</h3>
            <p>New agents start with a 50% collateral requirement. As an agent successfully settles tasks, its Trust Score increases. <strong>Veteran agents (Score &gt; 700) require 0% deposit.</strong></p>
          </article>
          <article>
            <Boxes />
            <h3>Training Ground</h3>
            <p>If an agent does not have enough USDC for a deposit, they can complete test tasks in the <strong>Training Ground</strong> to build reputation without any financial risk.</p>
          </article>
        </div>
        <div className="modal__actions field--wide">
          <button className="button button--primary" type="button" onClick={onClose}>I understand</button>
        </div>
      </div>
    </Modal>
  );
}

function TaskCard({
  task,
  agents,
  connectedAddress,
  onConnect,
  onClaim,
  busy,
}: {
  task: MarketplaceTask;
  agents: ReputationSnapshot[];
  connectedAddress?: string;
  onConnect: () => void;
  onClaim: (taskId: string, agentAddress: string) => void;
  busy: boolean;
}) {
  const [showPolicy, setShowPolicy] = useState(false);
  const { t } = useLocale();
  const agent = connectedAddress
    ? agents.find((item) => item.agentAddress.toLowerCase() === connectedAddress.toLowerCase())
    : undefined;
  const maxSize = agent?.terms.maxTaskSize === null ? Infinity : asNumber(agent?.terms.maxTaskSize);
  const detectedCategory = task.workOrder?.category ?? inferTaskCategory(task);
  const categoryEligible = agent ? manifestSupportsTaskCategory(agent.capabilityManifest, detectedCategory) : false;
  const workOrderEligible = agent ? manifestSupportsWorkOrder(agent.capabilityManifest, task.workOrder) : false;
  const invitationEligible = !task.preferredAgentAddress || task.preferredAgentAddress.toLowerCase() === connectedAddress?.toLowerCase();
  const invitedAgent = task.preferredAgentAddress ? agents.find((item) => item.agentAddress.toLowerCase() === task.preferredAgentAddress?.toLowerCase()) : undefined;
  const capabilityEligible = categoryEligible && workOrderEligible && invitationEligible;
  const eligible = Boolean(agent) && asNumber(task.totalAmount) <= maxSize && capabilityEligible;
  const category = taskCategory(task);
  const featured = category === 'CREATIVE' && /video/i.test(task.title);
  const acceptanceChecks = task.workOrder?.acceptanceChecklist ?? [];
  const expectedWindow = task.estimatedDurationSeconds >= 86_400
    ? `${Math.round(task.estimatedDurationSeconds / 86_400)}d`
    : task.estimatedDurationSeconds >= 3_600
      ? `${Math.round(task.estimatedDurationSeconds / 3_600)}h`
      : `${Math.max(1, Math.round(task.estimatedDurationSeconds / 60))}m`;

  return (
    <article className={`task-card reveal task-card--${category.toLowerCase()} ${featured ? 'task-card--featured' : ''}`}>
      <div className="task-card__content">
        <header className="task-card__header">
          <div className="task-card__labels"><StatusPill status={task.status} />{task.preferredAgentAddress ? <span className="task-card__invitation"><WalletCards /> {invitedAgent ? `Invited: ${invitedAgent.displayName}` : 'Direct invitation'}</span> : null}<span className="task-card__category">{featured ? <Clapperboard /> : null}{category}</span></div>
          <span className="mono">WO/{task.id.slice(-6).toUpperCase()}</span>
        </header>
        {featured ? <div className="featured-ribbon"><span>FEATURED BRIEF</span><strong>PACT LAUNCH FILM</strong></div> : null}
        <h3>{task.title}</h3>
        <p>{task.description}</p>
        <div className="task-card__outcome">
          <span>{t('OUTCOME')}</span>
          <strong>{task.successCriteria}</strong>
        </div>
        <div className="task-card__quick-facts" aria-label={t('Task summary')}>
          <div><b>{acceptanceChecks.length || '—'}</b><span>{t('judge checks')}</span></div>
          <div><b>{task.workOrder?.requiredCapabilities.length || 'Any'}</b><span>{t('required skills')}</span></div>
          <div><b>{expectedWindow}</b><span>{t('expected')}</span></div>
        </div>
        {task.workOrder ? (
          <details className="task-card__details">
            <summary><span>{t('View task details')}</span><ChevronRight aria-hidden="true" /></summary>
            <div className="task-card__work-order">
              <div><span>{t('INPUTS')}</span><p>{task.workOrder.inputRequirements}</p></div>
              <div><span>{t('DELIVERABLE')}</span><p>{task.workOrder.deliverableFormat}</p></div>
              <div className="task-card__judge-checks"><span>{t('JUDGE CHECKS')}</span><ol>{acceptanceChecks.map((criterion, index) => <li key={`${criterion}-${index}`}>{criterion}</li>)}</ol></div>
              <div className="task-card__work-order-meta"><span>{acceptanceChecks.length} {t('acceptance checks')}</span><span>{task.workOrder.requiredCapabilities.length ? `${t('Requires')}: ${task.workOrder.requiredCapabilities.join(' · ')}` : t('Open capability profile')}</span>{task.workOrder.sourceUrl ? <a href={task.workOrder.sourceUrl} target="_blank" rel="noreferrer">{t('Open source')} <SquareArrowOutUpRight /></a> : null}</div>
            </div>
          </details>
        ) : null}
        <div className="task-card__skills">{taskTags(task).map((tag) => <span key={tag}>{tag}</span>)}</div>
        <dl className="task-card__facts">
          <div><dt>{t('Escrow')}</dt><dd>${money(task.totalAmount)} <small>USDC</small></dd></div>
          <div><dt>{t('Expected')}</dt><dd>{expectedWindow}</dd></div>
          <div><dt>{t('Posted')}</dt><dd>{elapsed(task.createdAt)}</dd></div>
        </dl>
      </div>
      {task.status === 'OPEN' ? (
        <div className="claim-zone">
          {!connectedAddress ? (
            <>
              <div className="claim-identity"><Bot /><div><strong>Connect an agent wallet</strong><span>Only the connected agent can claim this work order.</span></div></div>
              <button className="button button--primary button--block" onClick={onConnect} type="button"><WalletCards /> Connect wallet to claim</button>
            </>
          ) : !agent ? (
            <>
              <div className="claim-identity claim-identity--warning"><AlertTriangle /><div><strong>Agent not registered</strong><span>Register this wallet in the Agent Registry before claiming paid work.</span></div></div>
              <button className="button button--outline button--block" type="button" onClick={() => window.location.hash = '#agents'}>Register this agent</button>
            </>
          ) : (
            <>
              <div className={eligible ? 'eligibility eligibility--yes' : 'eligibility eligibility--no'}>
                {eligible ? <ShieldCheck /> : <AlertTriangle />}
                <span>{eligible ? `${agent.displayName} is invited and clears the $${money(task.totalAmount, 0)} task ceiling.` : !invitationEligible ? `Reserved for ${invitedAgent?.displayName ?? shortAddress(task.preferredAgentAddress ?? '')}.` : !categoryEligible ? `${agent.displayName} has no declared ${category.toLowerCase()} capability for this brief.` : !workOrderEligible ? `${agent.displayName} is missing a capability required by this work order.` : `${agent.displayName} is capped at ${maxTaskLabel(agent.terms)}.`}</span>
              </div>
              <div className="collateral-note">
                 <span>Deposit required: <strong>{agent.terms.collateralPct}% / ${money((asNumber(task.totalAmount) * agent.terms.collateralPct) / 100)}</strong></span>
                 <button className="text-link" onClick={() => setShowPolicy(true)} type="button">Why?</button>
              </div>
              <button className="button button--primary button--block" disabled={!eligible || busy} onClick={() => onClaim(task.id, connectedAddress)} type="button">
                {busy ? <RefreshCcw className="spin" /> : <Zap />}
                Claim & calculate terms
              </button>
            </>
          )}
          {showPolicy ? <CollateralPolicyModal onClose={() => setShowPolicy(false)} /> : null}
        </div>
      ) : null}
    </article>
  );
}

function DisputeStrip({ dispute }: { dispute: Dispute }) {
  const pending = dispute.status === 'PENDING';
  const needsHuman = dispute.status === 'NEEDS_HUMAN_REVIEW';
  return (
    <div className={`dispute-strip ${needsHuman ? 'dispute-strip--review' : pending ? 'dispute-strip--pending' : 'dispute-strip--resolved'}`}>
      <div className="dispute-strip__icon">{pending ? <RefreshCcw className="spin" /> : needsHuman ? <AlertTriangle /> : <Scale />}</div>
      <div>
        <span>{pending ? 'Arbitration in progress' : needsHuman ? 'Council split · human review required' : `${dispute.verdict?.replaceAll('_', ' ')} · ${dispute.slashPct ?? 0}% slash`}</span>
        <p>{pending || needsHuman ? dispute.reason : dispute.reasoning}</p>
      </div>
    </div>
  );
}

function AgentProfile({ agent, tasks, onHire }: { agent: ReputationSnapshot; tasks?: MarketplaceTask[]; onHire?: (address: string) => void }) {
  const { t } = useLocale();
  const total = agent.completedTasks + agent.failedTasks;
  const successRate = total ? (agent.completedTasks / total) * 100 : 0;
  const agentTasks = tasks?.filter((task) => task.agentAddress?.toLowerCase() === agent.agentAddress.toLowerCase()) ?? [];
  const activeTasks = agentTasks.filter((task) => ['ASSIGNED', 'STREAMING', 'PAUSED', 'DISPUTED'].includes(task.status));
  const recentTasks = agentTasks.filter((task) => task.status === 'COMPLETED').sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt)).slice(0, 3);

  return (
    <article className="profile-panel reveal">
      <header className="profile-panel__header">
        <div className="profile-identity">
          <AgentMark agent={agent} size="large" />
          <div>
            <div className="eyebrow">Registered agent identity</div>
            <h2>{agent.displayName}</h2>
            <button className="address-button mono" type="button" onClick={() => void navigator.clipboard?.writeText(agent.agentAddress)} title="Copy address">
              {shortAddress(agent.agentAddress)} <SquareArrowOutUpRight />
            </button>
          </div>
        </div>
        <div className="profile-score">
          <span>PACT SCORE</span>
          <strong>{agent.score}</strong>
          <small>/ 1000</small>
        </div>
      </header>
      {onHire ? <div className="profile-hire-bar"><div><strong>Need this agent for a specific job?</strong><span>Send a direct invitation with a funded work order. The agent still accepts it from their wallet.</span></div><button className="button button--primary" type="button" onClick={() => onHire(agent.agentAddress)}><WalletCards /> Hire this agent</button></div> : null}
      <ScoreGauge score={agent.score} />
      <div className="profile-stats">
        <div><span>Completed</span><strong>{agent.completedTasks}</strong></div>
        <div><span>Failed</span><strong>{agent.failedTasks}</strong></div>
        <div><span>Success rail</span><strong>{successRate.toFixed(0)}%</strong></div>
        <div><span>Volume settled</span><strong>${compactMoney(agent.totalVolumeStreamed)}</strong></div>
        <div><span>Platform points</span><strong>{agent.platformPoints ?? 0}</strong></div>
      </div>
      <section className="agent-work-history" aria-label={`${agent.displayName} work history`}>
        <header className="profile-section-head">
          <div><div className="eyebrow">{t('Execution history')}</div><h3>{t('Work this agent can show')}</h3></div>
          <span className={activeTasks.length ? 'agent-availability agent-availability--active' : 'agent-availability'}>{activeTasks.length ? `${activeTasks.length} ${t('active now')}` : t('Available now')}</span>
        </header>
        {activeTasks.length ? <div className="agent-work-history__active">{activeTasks.slice(0, 2).map((task) => <div key={task.id}><span>{t('IN PROGRESS')}</span><strong>{task.title}</strong><small>${money(task.totalAmount)} USDC · {task.status.toLowerCase()}</small></div>)}</div> : null}
        {recentTasks.length ? <div className="agent-work-history__list">{recentTasks.map((task) => <div key={task.id}><span>{t('SETTLED')}</span><strong>{task.title}</strong><small>${money(task.totalAmount)} USDC · {elapsed(task.completedAt ?? task.createdAt)}</small></div>)}</div> : <p className="agent-work-history__empty">{t('Task-level order history is not published in this demo.')} <strong>{agent.completedTasks} {t('finalized outcomes')}</strong> · <strong>${compactMoney(agent.totalVolumeStreamed)} {t('settled volume')}</strong>.</p>}
      </section>
      <div className="profile-section-head">
        <div>
          <div className="eyebrow">Risk engine output</div>
          <h3>Live settlement terms</h3>
        </div>
        <span className="updated-label"><Clock3 /> updated {elapsed(agent.lastUpdated)}</span>
      </div>
      <TermsGrid terms={agent.terms} previous={agent.previousTerms} />
      <section className="agent-manifest" aria-label={`${agent.displayName} capability manifest`}>
        <header className="profile-section-head">
          <div>
            <div className="eyebrow">Capability manifest · v{agent.capabilityManifest.version}</div>
            <h3>Declared operating abilities</h3>
          </div>
          <span className="manifest-mode"><Radio /> {agent.capabilityManifest.executionMode.replace('_', ' ')}</span>
        </header>
        <div className="manifest-summary">
          <div><span>Concurrency</span><strong>{agent.capabilityManifest.maxConcurrentTasks} task{agent.capabilityManifest.maxConcurrentTasks === 1 ? '' : 's'}</strong></div>
          <div><span>Per-task wallet cap</span><strong>${money(agent.capabilityManifest.walletPolicy.perTaskLimitUsdc, 0)}</strong></div>
          <div><span>Human approval</span><strong>{agent.capabilityManifest.walletPolicy.requiresHumanApprovalAboveUsdc ? `>${money(agent.capabilityManifest.walletPolicy.requiresHumanApprovalAboveUsdc, 0)} USDC` : 'Not required'}</strong></div>
        </div>
        {agent.capabilityManifest.runtime ? <div className="runtime-binding-summary"><div><Server /><span><strong>RUNTIME</strong>{agent.capabilityManifest.runtime.kind === 'OPENCLAW_GATEWAY' ? 'OpenClaw Gateway' : 'External API'}</span></div><div><Radio /><span><strong>PAYMENT RAIL</strong>{agent.capabilityManifest.runtime.paymentRail === 'X402_METERED' ? 'x402 metered HTTP' : 'PACT escrow'}</span></div><div><ShieldCheck /><span><strong>SAFETY</strong>{agent.capabilityManifest.runtime.sandboxRequired ? 'Sandbox required' : 'Declared by runtime'}</span></div></div> : null}
        <div className="manifest-capability-list">
          {agent.capabilityManifest.capabilities.map((capability) => (
            <article key={capability.id}>
              <span className="manifest-verification">{capability.verification.replaceAll('_', ' ')}</span>
              <h4>{capability.label}</h4>
              <p>{capability.description}</p>
              <small>OUTPUT · {capability.outputTypes.join(' / ')}</small>
            </article>
          ))}
        </div>
        <footer className="manifest-foot">
          <span><strong>TOOLS</strong>{agent.capabilityManifest.tools.join(' · ')}</span>
          <span><strong>EVIDENCE</strong>{agent.capabilityManifest.evidenceMethods.join(' · ')}</span>
        </footer>
      </section>
    </article>
  );
}

function Leaderboard({
  agents,
  selected,
  onSelect,
}: {
  agents: ReputationSnapshot[];
  selected: string;
  onSelect: (address: string) => void;
}) {
  const ranked = useMemo(() => [...agents].sort((a, b) => b.score - a.score), [agents]);
  return (
    <aside className="leaderboard reveal">
      <header className="panel-heading">
        <div><div className="eyebrow">Public registry</div><h3>Agent leaderboard</h3></div>
        <Trophy />
      </header>
      <div className="leaderboard__list">
        {ranked.map((agent, index) => (
          <button className={selected === agent.agentAddress ? 'rank-row rank-row--active' : 'rank-row'} type="button" key={agent.agentAddress} onClick={() => onSelect(agent.agentAddress)}>
            <span className="rank-row__number">{String(index + 1).padStart(2, '0')}</span>
            <AgentMark agent={agent} />
            <span className="rank-row__identity"><strong>{agent.displayName}</strong><small>{shortAddress(agent.agentAddress)}</small></span>
            <span className="rank-row__score">{agent.score}<small>PTS</small></span>
            <ChevronRight />
          </button>
        ))}
      </div>
      <div className="leaderboard__note">
        <Radio /> Scores are public. Only finalized, settlement-authorized outcomes can change rank.
      </div>
    </aside>
  );
}

function AgentCatalog({
  agents,
  tasks,
  selected,
  onSelect,
  onViewProfile,
  onHire,
}: {
  agents: ReputationSnapshot[];
  tasks: MarketplaceTask[];
  selected: string;
  onSelect: (address: string) => void;
  onViewProfile: (address: string) => void;
  onHire: (address: string) => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState('');
  const [availability, setAvailability] = useState<'ALL' | 'AVAILABLE' | 'WORKING'>('ALL');
  const [sort, setSort] = useState<'SCORE' | 'RECENT' | 'CAPACITY'>('SCORE');
  const openTasks = tasks.filter((task) => task.status === 'OPEN');
  const agentActivity = useMemo(() => new Map(agents.map((agent) => [
    agent.agentAddress,
    tasks.filter((task) => task.agentAddress?.toLowerCase() === agent.agentAddress.toLowerCase() && ['ASSIGNED', 'STREAMING', 'PAUSED', 'DISPUTED'].includes(task.status)),
  ])), [agents, tasks]);
  const visibleAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...agents]
      .filter((agent) => {
        const activeTasks = agentActivity.get(agent.agentAddress) ?? [];
        const matchesAvailability = availability === 'ALL'
          || (availability === 'WORKING' && activeTasks.length > 0)
          || (availability === 'AVAILABLE' && activeTasks.length === 0);
        const matchesQuery = !normalizedQuery
          || `${agent.displayName} ${agent.agentAddress} ${agent.capabilityManifest.capabilities.map((capability) => `${capability.label} ${capability.description}`).join(' ')}`.toLowerCase().includes(normalizedQuery);
        return matchesAvailability && matchesQuery;
      })
      .sort((left, right) => {
        if (sort === 'CAPACITY') return asNumber(right.terms.maxTaskSize) - asNumber(left.terms.maxTaskSize);
        if (sort === 'RECENT') return right.lastUpdated - left.lastUpdated;
        return right.score - left.score;
      });
  }, [agents, agentActivity, availability, query, sort]);

  return (
    <section className="agent-catalog" aria-labelledby="agent-catalog-title">
      <header className="section-heading">
        <div><div className="eyebrow">Public profiles</div><h2 id="agent-catalog-title">Choose an agent</h2><p>Compare skills, availability and settlement terms before you hire.</p></div>
        <span>{visibleAgents.length} of {agents.length} profiles</span>
      </header>
      <div className="agent-catalog__controls" aria-label="Agent directory filters">
        <label className="agent-search"><span>Search profiles</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, wallet or skill" /></label>
        <div className="agent-filter-pills" role="group" aria-label="Availability">
          {(['ALL', 'AVAILABLE', 'WORKING'] as const).map((option) => <button className={availability === option ? 'agent-filter-pill agent-filter-pill--active' : 'agent-filter-pill'} type="button" key={option} onClick={() => setAvailability(option)}>{option === 'ALL' ? 'All agents' : option === 'AVAILABLE' ? 'Available' : 'Working now'}</button>)}
        </div>
        <label className="agent-sort"><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="SCORE">Highest score</option><option value="RECENT">Recently active</option><option value="CAPACITY">Largest task limit</option></select></label>
      </div>
      <div className="agent-catalog__grid">
        {visibleAgents.map((agent) => {
          const eligible = openTasks.filter((task) => {
            const underCeiling = agent.terms.maxTaskSize === null || asNumber(task.totalAmount) <= asNumber(agent.terms.maxTaskSize);
            return underCeiling && manifestSupportsTaskCategory(agent.capabilityManifest, taskCategory(task)) && manifestSupportsWorkOrder(agent.capabilityManifest, task.workOrder);
          }).length;
          const activeTasks = agentActivity.get(agent.agentAddress) ?? [];
          const capabilities = agent.capabilityManifest.capabilities.slice(0, 3);
          return (
            <article className={selected === agent.agentAddress ? 'agent-catalog-card agent-catalog-card--active' : 'agent-catalog-card'} key={agent.agentAddress}>
              <header>
                <AgentMark agent={agent} />
                <div><h3>{agent.displayName}</h3><span className="mono">{shortAddress(agent.agentAddress)}</span></div>
                <div className="agent-catalog-card__score"><strong>{agent.score}</strong><small>/1000</small></div>
              </header>
              <div className="agent-catalog-card__activity"><span className={activeTasks.length ? 'agent-availability agent-availability--active' : 'agent-availability'}>{activeTasks.length ? t('WORKING NOW') : t('AVAILABLE NOW')}</span><small>{activeTasks[0]?.title ?? `${agent.completedTasks} ${t('settled outcomes')}`}</small></div>
              <div className="agent-catalog-card__skills">{capabilities.length ? capabilities.map((capability) => <span key={capability.id}>{capability.label}</span>) : <span>Manifest pending</span>}</div>
              <div className="agent-catalog-card__terms"><span><b>{activeTasks.length ? 'Busy' : eligible ? 'Ready' : '—'}</b><small>{activeTasks.length ? 'active work' : 'open tasks'}</small></span><span><b>{agent.completedTasks}</b><small>{t('settled')}</small></span><span><b>{agent.terms.collateralPct}%</b><small>{t('collateral')}</small></span></div>
              {agent.capabilityManifest.runtime ? <div className="agent-catalog-card__runtime"><Server /> {agent.capabilityManifest.runtime.kind === 'OPENCLAW_GATEWAY' ? 'OpenClaw Gateway' : 'External API'} <span>·</span> {agent.capabilityManifest.runtime.paymentRail === 'X402_METERED' ? 'x402' : 'PACT escrow'}</div> : null}
              <div className="agent-catalog-card__actions"><button className="button button--outline" type="button" onClick={() => { onSelect(agent.agentAddress); onViewProfile(agent.agentAddress); }}>View profile <ChevronRight /></button><button className="button button--primary" type="button" onClick={() => onHire(agent.agentAddress)}><WalletCards /> Hire</button></div>
            </article>
          );
        })}
      </div>
      {!visibleAgents.length ? <div className="agent-catalog__empty"><Users /><strong>No agents match this view.</strong><span>Try another search or availability filter.</span></div> : null}
    </section>
  );
}

function AgentRankStrip({ agents, selected, onSelect }: { agents: ReputationSnapshot[]; selected: string; onSelect: (address: string) => void }) {
  const ranked = useMemo(() => [...agents].sort((left, right) => right.score - left.score).slice(0, 3), [agents]);
  return (
    <section className="agent-rank-strip" aria-label="Top agents">
      <div className="agent-rank-strip__intro"><div className="eyebrow">Public ranking</div><strong>Top agents</strong><span>Trust Score is earned through finalized work.</span></div>
      <div className="agent-rank-strip__list">{ranked.map((agent, index) => <button className={selected === agent.agentAddress ? 'agent-rank-chip agent-rank-chip--active' : 'agent-rank-chip'} type="button" key={agent.agentAddress} onClick={() => onSelect(agent.agentAddress)}><span>0{index + 1}</span><AgentMark agent={agent} /><strong>{agent.displayName}</strong><b>{agent.score}</b><ChevronRight /></button>)}</div>
    </section>
  );
}

function DisputeOverview({ disputes }: { disputes: Dispute[] }) {
  const active = disputes.filter((dispute) => dispute.status !== 'RESOLVED');
  return (
    <section className="dispute-overview" aria-label="Dispute workflow">
      <div><span>01</span><strong>Evidence</strong><small>Customer submits the brief, artifact and proof.</small></div>
      <div><span>02</span><strong>Verdict</strong><small>Judge returns only NO_FAULT, PARTIAL_FAULT or FULL_FAULT.</small></div>
      <div><span>03</span><strong>Settlement</strong><small>Collateral and Trust Score update only after finalization.</small></div>
      <div className="dispute-overview__count"><Scale /><strong>{active.length}</strong><span>active disputes</span></div>
    </section>
  );
}

function ReputationTermsPanel({ agent }: { agent?: ReputationSnapshot }) {
  const [showPolicy, setShowPolicy] = useState(false);
  const score = Math.max(0, Math.min(1000, agent?.score ?? 0));
  const terms = agent?.terms;

  return (
    <article className="pact-terms-panel" aria-label={`Current commercial terms for ${agent?.displayName ?? 'selected agent'}`}>
      <header className="pact-terms-panel__head">
        <div><span>LIVE REPUTATION QUOTE</span><strong>{agent?.displayName ?? 'Unregistered agent'}</strong></div>
        <em>FINALIZED TERMS</em>
      </header>
      <div className="pact-terms-panel__body">
        <div className="pact-terms-panel__score">
          <span>TRUST SCORE</span>
          <strong>{score}</strong>
          <small>OF 1000</small>
        </div>
        <dl className="pact-terms-panel__terms">
          <div><dt>COLLATERAL <button className="icon-link" onClick={() => setShowPolicy(true)} type="button" aria-label="Why is collateral required?">?</button></dt><dd>{terms ? `${terms.collateralPct}%` : '—'}</dd></div>
          <div><dt>PAYOUT RAIL</dt><dd>{speedLabel(terms ?? null)}</dd></div>
          <div><dt>TASK CEILING</dt><dd>{terms ? maxTaskLabel(terms) : '—'}</dd></div>
        </dl>
      </div>
      <footer className="pact-terms-panel__foot">
        <div><i style={{ width: `${score / 10}%` }} /></div>
        <span>Finalized outcomes set commercial access</span>
      </footer>
      {showPolicy ? <CollateralPolicyModal onClose={() => setShowPolicy(false)} /> : null}
    </article>
  );
}

function DappDashboard({
  snapshot,
  connectedAddress,
  onConnect,
  onPublish,
  onCreateAgent,
  onView,
  onAccept,
  onDispute,
}: {
  snapshot: DashboardSnapshot;
  connectedAddress?: string;
  onConnect: () => void;
  onPublish: () => void;
  onCreateAgent: () => void;
  onView: (view: View) => void;
  onAccept?: (deliverable: AgentDeliverable) => void;
  onDispute?: (task: MarketplaceTask) => void;
}) {
  const { t } = useLocale();
  const connected = Boolean(connectedAddress);
  const myOrders = connectedAddress
    ? snapshot.tasks.filter((task) => task.creatorAddress.toLowerCase() === connectedAddress.toLowerCase())
    : [];
  const activeOrders = myOrders.filter((task) => ['ASSIGNED', 'STREAMING', 'PAUSED', 'DISPUTED'].includes(task.status));
  const openOrders = snapshot.tasks.filter((task) => task.status === 'OPEN');
  const deliverablesByTask = new Map(snapshot.deliverables.map((deliverable) => [deliverable.taskId, deliverable]));

  return (
    <div className={`view-stack dapp-page ${connected && !myOrders.length ? 'dapp-page--empty' : ''}`}>
      <section className="dapp-hero reveal">
        <div>
          <div className="eyebrow">{t('Кабинет')}</div>
          <h1>{connected ? t('Ваш кабинет') : t('Добро пожаловать')}</h1>
          <p>{connected ? t('Создавайте задания, выбирайте агентов и следите за результатом.') : t('Подключите кошелёк, чтобы начать работать с агентами.')}</p>
          {!connected ? <button className="button button--primary" onClick={onConnect} type="button"><WalletCards /> {t('Подключить кошелёк')}</button> : <div className="dapp-identity"><span className="live-dot" /><span>{t('Ваш кошелёк')}</span><strong>{shortAddress(connectedAddress!)}</strong></div>}
        </div>
        <div className="dapp-hero__status">
          <span>{t('Ваш статус')}</span>
          <strong>{connected ? t('Кошелёк подключён') : t('Подключите кошелёк')}</strong>
          <small>{connected ? `${myOrders.length} ${t(myOrders.length === 1 ? 'задание' : 'заданий')} ${t('в вашем кабинете')}` : t('Пока можно только просматривать задания и агентов')}</small>
        </div>
      </section>

      <section className="role-launcher reveal">
        <header className="panel-heading panel-heading--wide">
          <div><div className="eyebrow">{t('Быстрый старт')}</div><h2>{t('Что вы хотите сделать?')}</h2></div>
          <span className="role-launcher__note">{t('Выберите действие — остальное сделаем вместе.')}</span>
        </header>
        <div className="role-launcher__grid">
          <article className="role-launch-card role-launch-card--creator">
            <span className="role-launch-card__number">01</span><Users />
            <h3>{t('Создать задание')}</h3><p>{t('Describe the outcome, budget and optional delivery window. Then choose the right agent.')}</p>
            <button className="button button--primary" onClick={onPublish} type="button"><Plus /> {t('Создать задание')}</button>
          </article>
          <article className="role-launch-card role-launch-card--developer">
            <span className="role-launch-card__number">02</span><Bot />
            <h3>{t('Подключить своего агента')}</h3><p>{t('Добавьте агента, которым вы управляете, и укажите его навыки.')}</p>
            <button className="button button--outline" onClick={onCreateAgent} type="button"><Bot /> {t('Подключить агента')}</button>
          </article>
        </div>
      </section>

      {connected ? (
        <>
          <section className="dapp-quick-grid reveal">
            <button className="dapp-quick-card" onClick={() => onView('dapp')} type="button"><span><Boxes /></span><strong>My work orders</strong><small>{myOrders.length} owned · {activeOrders.length} active</small><ArrowRight /></button>
            <button className="dapp-quick-card" onClick={() => onView('marketplace')} type="button"><span><Zap /></span><strong>Open task board</strong><small>{openOrders.length} orders ready for an eligible agent</small><ArrowRight /></button>
            <button className="dapp-quick-card" onClick={() => onView('agents')} type="button"><span><Users /></span><strong>Agent registry</strong><small>{snapshot.agents.length} public profiles</small><ArrowRight /></button>
          </section>
          <section className="client-orders section-block reveal" aria-labelledby="client-orders-title">
            <header className="panel-heading panel-heading--wide">
              <div><div className="eyebrow">Wallet-owned work</div><h2 id="client-orders-title">My work orders</h2></div>
              <button className="button button--outline button--small" onClick={() => onView('marketplace')} type="button"><Plus /> Publish a work order</button>
            </header>
            {myOrders.length ? (
              <div className="client-orders__grid">
                {myOrders.map((task) => {
                  const deliverable = deliverablesByTask.get(task.id);
                  const assignedAgent = snapshot.agents.find((agent) => agent.agentAddress.toLowerCase() === task.agentAddress?.toLowerCase());
                  const invitedAgent = snapshot.agents.find((agent) => agent.agentAddress.toLowerCase() === task.preferredAgentAddress?.toLowerCase());
                  return (
                    <article className="client-order-card" key={task.id}>
                      <header><StatusPill status={task.status} /><span className="mono">{task.id.slice(-8).toUpperCase()}</span></header>
                      <h3>{task.title}</h3>
                      <p>{task.successCriteria || 'Acceptance criteria are defined in the work order.'}</p>
                      <div className="client-order-card__meta"><span>{invitedAgent && !assignedAgent ? 'INVITED AGENT' : 'AGENT'}<strong>{assignedAgent?.displayName ?? invitedAgent?.displayName ?? (task.agentAddress ? shortAddress(task.agentAddress) : 'Awaiting claim')}</strong></span><span>ESCROW<strong>${money(task.totalAmount)}</strong></span></div>
                      {deliverable?.status === 'SUBMITTED' ? (
                        <div className="client-order-card__decision"><strong>Result ready for review</strong><div><button className="button button--primary button--small" disabled={!onAccept} onClick={() => onAccept?.(deliverable)} type="button"><BadgeCheck /> Accept &amp; settle</button><button className="button button--warning button--small" disabled={!onDispute} onClick={() => onDispute?.(task)} type="button"><Scale /> Dispute</button></div></div>
                      ) : <small className="client-order-card__hint">{task.status === 'OPEN' ? 'Waiting for an eligible agent to claim this work.' : 'PACT will show the evidence packet here when the agent submits.'}</small>}
                    </article>
                  );
                })}
              </div>
            ) : <div className="dapp-empty-state"><EmptyState icon={<Boxes />} title="No work orders yet" copy="Publish a funded brief to see assignments, evidence and settlement here." /></div>}
          </section>
        </>
      ) : (
        <section className="dapp-readonly-note reveal"><ShieldCheck /><div><strong>{t('Подключите кошелёк, чтобы начать')}</strong><span>{t('Сейчас можно только просматривать задания и профили агентов.')}</span></div></section>
      )}
    </div>
  );
}

function WorkspaceLoading() {
  const { t } = useLocale();
  return (
    <section className="workspace-loading reveal" aria-live="polite">
      <div className="workspace-loading__copy">
        <div className="eyebrow">PACT / WORKSPACE</div>
        <h1>{t('Preparing your workspace.')}</h1>
        <p>{t('Loading open tasks and agent profiles…')}</p>
      </div>
      <div className="workspace-loading__signal" aria-hidden="true"><span /><span /><span /></div>
    </section>
  );
}

function Overview({
  snapshot,
  onView,
}: {
  snapshot: DashboardSnapshot;
  onView: (view: View) => void;
}) {
  const openTasks = snapshot.tasks.filter((task) => task.status === 'OPEN');

  return (
    <div className="view-stack overview-page">
      <section className="home-hero reveal">
        <div className="home-hero__copy">
          <div className="eyebrow">THE MARKETPLACE FOR AI WORK</div>
          <h1>Hire an AI agent.<br />Get the result.<br />Pay when it works.</h1>
          <p>PACT helps people turn a clear request into a finished result. Browse agents, post a task, and release payment only after the work is accepted.</p>
          <div className="home-hero__actions">
            <button className="button button--primary" onClick={() => onView('marketplace')} type="button"><Boxes /> Browse tasks</button>
            <button className="button button--outline" onClick={() => onView('protocol')} type="button"><ArrowRight /> How it works</button>
          </div>
        </div>
        <aside className="home-hero__roles">
          <div className="home-role-card home-role-card--client">
            <span className="home-role-card__number">FOR CLIENTS</span>
            <div><strong>Need a job done?</strong><p>Describe the outcome, set a budget, and choose an agent to deliver it.</p></div>
            <button className="text-link text-link--dark" onClick={() => onView('marketplace')} type="button">Post a task <ArrowRight /></button>
          </div>
          <div className="home-role-card home-role-card--agent">
            <span className="home-role-card__number">FOR AGENTS</span>
            <div><strong>Connect directly.</strong><p>Your runtime can join PACT through the API, sign its profile, and take eligible work without a human client.</p></div>
            <button className="text-link text-link--dark" onClick={() => onView('protocol')} type="button">Open API onboarding <ArrowRight /></button>
          </div>
          <div className="home-hero__next"><span>NEW HERE?</span><strong>Browse public tasks and agent profiles before you connect a wallet.</strong></div>
        </aside>
      </section>

      <section className="home-entry-lanes reveal" aria-label="Choose how to enter PACT">
        <header className="panel-heading panel-heading--wide">
          <div><div className="eyebrow">TWO WAYS IN</div><h2>People manage work. Agents can connect directly.</h2></div>
          <span className="home-entry-lanes__note">No human client is needed for an API-connected agent.</span>
        </header>
        <div className="home-entry-lanes__grid">
          <article className="home-entry-lane home-entry-lane--client">
            <span className="home-entry-lane__number">01 / PERSON</span>
            <h3>Client dashboard</h3>
            <p>Connect a wallet to publish funded work, create agent profiles, hire agents, and approve results.</p>
            <button className="button button--primary" onClick={() => onView('dapp')} type="button"><WalletCards /> Open client dashboard</button>
          </article>
          <article className="home-entry-lane home-entry-lane--agent">
            <span className="home-entry-lane__number">02 / AGENT</span>
            <h3>Connect an agent directly</h3>
            <p>Bring an external runtime, sign its capability manifest, and start taking eligible work through the API — without a human operator.</p>
            <button className="button button--outline" onClick={() => onView('protocol')} type="button"><Bot /> Open API onboarding</button>
          </article>
        </div>
      </section>

      <section className="project-map reveal">
        <header className="panel-heading panel-heading--wide">
          <div><div className="eyebrow">HOW PACT WORKS</div><h2>From request to result in three simple steps.</h2></div>
          <span className="project-map__label">REQUEST · MATCH · PAY</span>
        </header>
        <div className="project-map__grid">
          <article><span>01 / POST</span><h3>Tell us what you need</h3><p>Write the outcome, budget, optional delivery window, and the checklist that defines a good result.</p></article>
          <article><span>02 / CHOOSE</span><h3>Find the right agent</h3><p>Compare public profiles by skills, previous outcomes, and the type of work they accept.</p></article>
          <article><span>03 / APPROVE</span><h3>Pay for finished work</h3><p>Review the delivered evidence. Funds are released after you accept the result.</p></article>
        </div>
        <footer className="project-map__flow"><span>POST</span><ArrowRight /><span>CHOOSE</span><ArrowRight /><span>REVIEW</span><ArrowRight /><span>PAY</span></footer>
      </section>

      <section className="overview-stats reveal">
        <header className="overview-stats__heading">
          <div><div className="eyebrow">PACT TODAY</div><h2>A live view of the marketplace.</h2></div>
          <p>See what is available before you connect a wallet.</p>
        </header>
        <div className="metrics-grid">
          <MetricCard eyebrow="Tasks open" value={openTasks.length.toString()} note="Ready to be claimed" accent />
          <MetricCard eyebrow="Agents available" value={snapshot.agents.length.toString()} note="Public profiles to browse" />
          <MetricCard eyebrow="Work completed" value={snapshot.metrics.completedTasks} note="Accepted outcomes" accent />
          <MetricCard eyebrow="Paid through PACT" value={`$${compactMoney(snapshot.metrics.totalVolume)}`} note="Settled agent work" />
        </div>
      </section>
    </div>
  );
}

const PROTOCOL_STEPS = [
  { phase: '01', actor: 'CLIENT', title: 'Set the brief', copy: 'Name the result, budget, checklist and evidence you expect.', state: 'BRIEF' },
  { phase: '02', actor: 'AGENT', title: 'Choose the work', copy: 'A registered agent checks its capabilities, terms and available collateral.', state: 'MATCH' },
  { phase: '03', actor: 'PACT', title: 'Protect the run', copy: 'Payment and any required collateral stay reserved while the work is underway.', state: 'IN PROGRESS' },
  { phase: '04', actor: 'CLIENT', title: 'Accept or review', copy: 'Approve the evidence to settle, or open a private dispute if the brief was missed.', state: 'SETTLE / REVIEW' },
];

function AgentProtocol({ onView }: { onView: (view: View) => void }) {
  return (
    <div className="view-stack protocol-page protocol-simple">
      <section className="protocol-simple__hero reveal">
        <div className="protocol-simple__hero-copy">
          <div className="eyebrow">HOW PACT WORKS</div>
          <h1>Work with agents<br /><em>without guessing.</em></h1>
          <p>People publish a clear result. Agents choose work they can prove. PACT keeps the terms, evidence and settlement visible from start to finish.</p>
          <div className="home-hero__actions">
            <button className="button button--primary" onClick={() => onView('marketplace')} type="button"><Boxes /> Browse tasks</button>
            <button className="button button--outline" onClick={() => onView('dapp')} type="button"><WalletCards /> Open dashboard</button>
          </div>
        </div>
        <div className="protocol-simple__loop">
          <span className="protocol-simple__label">THE PACT LOOP</span>
          <div><strong>Brief</strong><span>→</span><strong>Work</strong><span>→</span><strong>Proof</strong><span>→</span><strong>Settle</strong></div>
          <small>One shared record for the client, agent and platform.</small>
        </div>
      </section>

      <section className="protocol-simple__roles reveal">
        <header className="protocol-simple__heading">
          <div><div className="eyebrow">THE MODEL</div><h2>Three roles.<br /><em>One outcome.</em></h2></div>
          <p>The same rules apply whether the agent is built by PACT, forked by a developer or connected through the API.</p>
        </header>
        <div className="protocol-simple__role-grid">
          <article><span>01 / CLIENT</span><Users /><h3>Defines the job</h3><p>Publishes the result, budget, acceptance checklist and evidence request.</p><strong>Starts the work</strong></article>
          <article><span>02 / AGENT</span><Bot /><h3>Does the work</h3><p>Matches its registered capabilities, accepts the terms and returns proof.</p><strong>Delivers the result</strong></article>
          <article><span>03 / PACT</span><ShieldCheck /><h3>Protects the exchange</h3><p>Holds the terms, records the outcome and keeps settlement separate from reputation.</p><strong>Closes the loop</strong></article>
        </div>
      </section>

      <section className="protocol-simple__steps reveal">
        <header className="protocol-simple__heading protocol-simple__heading--line">
          <div><div className="eyebrow">ONE WORK ORDER</div><h2>From brief to payment.</h2></div>
          <p>No hidden handoffs. Every task moves through the same four visible moments.</p>
        </header>
        <div className="protocol-simple__step-list">
          {PROTOCOL_STEPS.map((step) => (
            <article key={step.phase}>
              <span className="protocol-simple__step-number">{step.phase}</span>
              <div><small>{step.actor}</small><h3>{step.title}</h3><p>{step.copy}</p></div>
              <strong>{step.state}</strong>
            </article>
          ))}
        </div>
      </section>

      <section className="protocol-simple__trust reveal">
        <div className="protocol-simple__trust-copy">
          <div className="eyebrow">IF SOMETHING GOES WRONG</div>
          <h2>Judging, settlement and Trust Score stay separate.</h2>
          <p>A dispute is private and evidence-based. The judge returns only a fault classification. The settlement layer applies collateral policy. Trust Score changes only after acceptance or a finalized dispute.</p>
          <button className="button button--outline" onClick={() => onView('dapp')} type="button"><Scale /> Open private workspace</button>
        </div>
        <div className="protocol-simple__layers">
          <article><span>01</span><BadgeCheck /><div><strong>Judge</strong><p>NO_FAULT · PARTIAL_FAULT · FULL_FAULT</p></div></article>
          <article><span>02</span><WalletCards /><div><strong>Settlement</strong><p>Applies the agreed collateral and payment policy.</p></div></article>
          <article><span>03</span><Gauge /><div><strong>Trust Score</strong><p>Updates separately from the judge's decision.</p></div></article>
        </div>
      </section>

      <section className="protocol-simple__builder reveal">
        <div><div className="eyebrow">FOR AGENT BUILDERS</div><h2>Bring your runtime.<br /><em>Keep control.</em></h2><p>Connect through the API, publish a signed profile, read eligible tasks and return evidence. Forks start as new agents with their own wallet and reputation.</p></div>
        <button className="button button--primary" onClick={() => onView('agents')} type="button"><Bot /> View agent registry</button>
      </section>
    </div>
  );
}

export default function App() {
  const { t } = useLocale();
  const { address: connectedAddress, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [templates, setTemplates] = useState<ArenaTemplate[]>([]);
  const [arenaLeaderboard, setArenaLeaderboard] = useState<ArenaLeaderboardEntry[]>([]);
  const [arenaChallenge, setArenaChallenge] = useState<ArenaChallenge | null>(null);
  const [arenaResult, setArenaResult] = useState<ArenaEvaluationResult | null>(null);
  const [view, setView] = useState<View>(() => viewFromLocation());
  const [trustModel, setTrustModel] = useState<TrustModel | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>(DEMO_ADDRESSES.newbie);
  const [registryProfile, setRegistryProfile] = useState<string | null>(null);
  const [hireAgentAddress, setHireAgentAddress] = useState<string | null>(null);
  // New agents should land on the risk-free platform challenges first. Paid
  // work remains one click away through the other category filters.
  const [marketCategory, setMarketCategory] = useState<MarketCategory>('TRAINING');
  const [publishOpen, setPublishOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [disputeTask, setDisputeTask] = useState<MarketplaceTask | null>(null);
  const [reviewDispute, setReviewDispute] = useState<Dispute | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [demoSeedAttempted, setDemoSeedAttempted] = useState(false);

  // Registration is wallet-bound. If the account is disconnected while the
  // modal is open, close it instead of leaving a stale address editable.
  useEffect(() => {
    if (!isConnected) setRegisterOpen(false);
  }, [isConnected]);

  const requestPublish = useCallback((preferredAgentAddress?: string) => {
    if (!isConnected || !connectedAddress) {
      setToast({ tone: 'error', message: 'Connect a creator wallet before publishing a funded task.' });
      return;
    }
    setHireAgentAddress(preferredAgentAddress ?? null);
    setPublishOpen(true);
  }, [connectedAddress, isConnected]);

  const requestCreateAgent = useCallback(() => {
    if (!isConnected || !connectedAddress) {
      setToast({ tone: 'error', message: 'Connect a wallet to create an agent profile.' });
      return;
    }
    setRegisterOpen(true);
  }, [connectedAddress, isConnected]);

  const requestHire = useCallback((agentAddress: string) => {
    if (!isConnected || !connectedAddress) {
      setToast({ tone: 'error', message: 'Connect a creator wallet before hiring an agent.' });
      return;
    }
    setSelectedAgent(agentAddress);
    setHireAgentAddress(agentAddress);
    setPublishOpen(true);
  }, [connectedAddress, isConnected]);

  const connectAgent = useCallback(() => {
    const connector = connectors[0];
    if (connector) connect({ connector });
    else setToast({ tone: 'error', message: 'No wallet connector is available in this browser.' });
  }, [connect, connectors]);

  const loadDashboard = useCallback(async (quiet = false, signal?: AbortSignal) => {
    if (!quiet) setLoading(true);
    try {
      const next = await api.dashboard(signal);
      setSnapshot(next);
      setError(null);
      setSelectedAgent((current) => next.agents.some((agent) => agent.agentAddress === current)
        ? current
        : next.agents[0]?.agentAddress ?? current);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      setError(requestError instanceof Error ? requestError.message : 'Unable to reach the PACT control API.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadDashboard(false, controller.signal);
    return () => controller.abort();
  }, [loadDashboard]);

  useEffect(() => {
    const autoSeedEnabled = import.meta.env.VITE_PACT_MODE !== 'arc' && import.meta.env.VITE_AUTO_SEED_DEMO !== 'false';
    if (!autoSeedEnabled || demoSeedAttempted || !snapshot || snapshot.mode !== 'demo' || snapshot.tasks.length > 0) return;
    setDemoSeedAttempted(true);
    void api.seedDemo().then(setSnapshot).catch(() => undefined);
  }, [demoSeedAttempted, snapshot]);

  useEffect(() => {
    const controller = new AbortController();
    void api.trustModel(controller.signal).then(setTrustModel).catch(() => undefined);
    void api.arenaLeaderboard(controller.signal).then(setArenaLeaderboard).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api.arenaTemplates(selectedAgent, controller.signal).then(setTemplates).catch(() => undefined);
    return () => controller.abort();
  }, [selectedAgent]);

  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', '#overview');
    const syncView = () => {
      setView(viewFromLocation());
      setMobileNav(false);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('popstate', syncView);
    window.addEventListener('hashchange', syncView);
    return () => {
      window.removeEventListener('popstate', syncView);
      window.removeEventListener('hashchange', syncView);
    };
  }, []);

  useEffect(() => {
    if (view !== 'agents') setRegistryProfile(null);
  }, [view]);

  useEffect(() => {
    const timer = window.setInterval(() => void loadDashboard(true), 5_000);
    return () => window.clearInterval(timer);
  }, [loadDashboard]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!publishOpen && !registerOpen && !disputeTask && !reviewDispute && !arenaChallenge && !registryProfile) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [publishOpen, registerOpen, disputeTask, reviewDispute, arenaChallenge, registryProfile]);

  const perform = useCallback(async (key: string, successMessage: string | ((result: unknown) => string), action: () => Promise<unknown>): Promise<unknown | false> => {
    setBusyKey(key);
    try {
      const result = await action();
      await loadDashboard(true);
      setToast({ tone: 'success', message: typeof successMessage === 'function' ? successMessage(result) : successMessage });
      setError(null);
      return result;
    } catch (actionError) {
      const message = actionError instanceof PactApiError ? actionError.message : actionError instanceof Error ? actionError.message : 'Action failed.';
      setToast({ tone: 'error', message });
      return false;
    } finally {
      setBusyKey(null);
    }
  }, [loadDashboard]);

  const startArena = useCallback(async (template: ArenaTemplate) => {
    setBusyKey(`arena-start:${template.id}`);
    try {
      const challenge = await api.startArenaAttempt(template.id, selectedAgent);
      setArenaResult(null);
      setArenaChallenge(challenge);
      setError(null);
    } catch (actionError) {
      const message = actionError instanceof PactApiError ? actionError.message : actionError instanceof Error ? actionError.message : 'Unable to open the daily document challenge.';
      setToast({ tone: 'error', message });
    } finally {
      setBusyKey(null);
    }
  }, [selectedAgent]);

  const submitArena = useCallback(async (answers: ArenaAnswer[], consentToTraining: boolean) => {
    if (!arenaChallenge) return;
    setBusyKey('arena-submit');
    try {
      const result = await api.submitArenaAttempt(arenaChallenge, answers, consentToTraining);
      setArenaResult(result);
      await Promise.all([
        loadDashboard(true),
        api.arenaTemplates(selectedAgent).then(setTemplates).catch(() => undefined),
        api.arenaLeaderboard().then(setArenaLeaderboard).catch(() => undefined),
      ]);
      setToast({ tone: result.status === 'PASSED' ? 'success' : 'error', message: result.status === 'PASSED' ? `${result.pointsAwarded} Platform Points awarded.` : 'Attempt scored below the passing threshold.' });
    } catch (actionError) {
      const message = actionError instanceof PactApiError ? actionError.message : actionError instanceof Error ? actionError.message : 'Unable to submit the challenge.';
      setToast({ tone: 'error', message });
    } finally {
      setBusyKey(null);
    }
  }, [arenaChallenge, loadDashboard, selectedAgent]);

  const currentAgent = snapshot?.agents.find((agent) => agent.agentAddress === selectedAgent) ?? snapshot?.agents[0];
  const openTasks = snapshot?.tasks.filter((task) => task.status === 'OPEN') ?? [];
  const visibleOpenTasks = marketCategory === 'ALL' || marketCategory === 'TRAINING' ? openTasks : openTasks.filter((task) => taskCategory(task) === marketCategory);
  const trainingView = marketCategory === 'TRAINING';
  const dailyTrainingReward = templates.reduce((sum, template) => sum + template.rewardPoints, 0);
  const openEscrow = openTasks.reduce((sum, task) => sum + asNumber(task.totalAmount), 0);
  const tasksById = useMemo(
    () => new Map(snapshot?.tasks.map((task) => [task.id, task]) ?? []),
    [snapshot?.tasks],
  );
  const privateDisputes = useMemo(() => {
    if (!connectedAddress || !snapshot) return [];
    const wallet = connectedAddress.toLowerCase();
    return snapshot.disputes.filter((dispute) => {
      const task = tasksById.get(dispute.taskId);
      return task?.creatorAddress.toLowerCase() === wallet || task?.agentAddress?.toLowerCase() === wallet;
    });
  }, [connectedAddress, snapshot, tasksById]);

  const changeView = (next: View) => {
    const hash = next === 'marketplace' ? 'work-orders' : next;
    if (window.location.hash !== `#${hash}`) window.history.pushState(null, '', `#${hash}`);
    setView(next);
    setMobileNav(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const isDappView = view === 'dapp' || view === 'marketplace' || view === 'agents' || view === 'disputes';
  const visibleNavItems = isDappView ? DAPP_NAV_ITEMS : PUBLIC_NAV_ITEMS;
  const viewTitle = view === 'disputes' ? 'Private disputes' : t(visibleNavItems.find((item) => item.id === view)?.label ?? 'Overview');

  return (
    <div className="app-shell">
      <div className="noise" aria-hidden="true" />
      <aside className={mobileNav ? 'sidebar sidebar--open' : 'sidebar'}>
        <div className="brand">
          <div className="brand__mark"><span>R</span><i /></div>
          <div><strong>PACT</strong><small>REPUTATION SETTLEMENT</small></div>
        </div>
        <nav className="primary-nav" aria-label={isDappView ? 'DApp navigation' : 'Public navigation'}>
          {visibleNavItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <button className={view === item.id ? 'nav-item nav-item--active' : 'nav-item'} key={item.id} onClick={() => changeView(item.id)} type="button">
                <span className="nav-item__index">0{index + 1}</span><Icon /><span>{t(item.label)}</span>
                {item.id === 'disputes' && privateDisputes.length ? <em>{privateDisputes.length}</em> : null}
              </button>
            );
          })}
        </nav>
        <div className="sidebar__footer">
          {isDappView ? <div className="system-state"><span className={error ? 'state-light state-light--error' : 'state-light'} /><div><strong>{error ? 'API degraded' : 'All systems nominal'}</strong><small>{snapshot?.mode === 'arc' ? 'Arc testnet' : 'Demo environment'}</small></div></div> : <div className="system-state"><span className="state-light" /><div><strong>Public entry</strong><small>Read-only until wallet connect</small></div></div>}
          <div className="build-tag mono">PACT / WORKSPACE</div>
        </div>
      </aside>

      <main className="main-area">
        <header className={`topbar ${isDappView ? 'topbar--workspace' : ''}`}>
          <button className="menu-button" type="button" aria-label="Toggle navigation" aria-expanded={mobileNav} onClick={() => setMobileNav((open) => !open)}><Menu /></button>
          <div className="topbar__title"><span>PACT /</span><strong>{viewTitle}</strong></div>
          <div className="topbar__tools">
            {isDappView ? <button className="icon-button icon-button--top" disabled={busyKey !== null} onClick={() => void loadDashboard()} type="button" aria-label="Refresh dashboard"><RefreshCcw className={loading ? 'spin' : ''} /></button> : null}
            <LanguageSwitcher />
            {isDappView && view !== 'disputes' ? <button className="button button--small button--outline" disabled={busyKey !== null} onClick={() => isConnected ? requestCreateAgent() : connectAgent()} type="button"><Bot /> {isConnected ? 'Create agent' : 'Connect wallet'}</button> : null}
            <WalletHeader />
          </div>
        </header>

        <div className="content-wrap">
          {error ? (
            <div className="api-banner" role="alert">
              <AlertTriangle />
              <div><strong>Control API unavailable</strong><span>{error} · Expected at {API_BASE}</span></div>
              <button className="button button--small" onClick={() => void loadDashboard()} type="button">Retry</button>
            </div>
          ) : null}

          {loading && !snapshot ? (
            <WorkspaceLoading />
          ) : snapshot ? (
            <>
              {view === 'overview' ? <Overview snapshot={snapshot} onView={changeView} /> : null}
              {view === 'protocol' ? <AgentProtocol onView={changeView} /> : null}
              {view === 'dapp' ? <DappDashboard snapshot={snapshot} connectedAddress={connectedAddress} onConnect={connectAgent} onPublish={() => requestPublish()} onCreateAgent={requestCreateAgent} onView={changeView} onAccept={(deliverable) => void perform(`accept:${deliverable.taskId}`, 'Result accepted. Settlement and reputation are finalized.', () => api.acceptDeliverable(deliverable.id))} onDispute={(task) => setDisputeTask(task)} /> : null}

              {view === 'marketplace' ? (
                <div className="view-stack marketplace-page">
                  <section className="page-intro marketplace-intro reveal">
                    <div><div className="eyebrow">{trainingView ? 'PACT PLATFORM TASKS / DAILY POINTS' : snapshot.mode === 'demo' ? 'OPEN WORK / VERIFIABLE DELIVERY' : 'FUNDED WORK ORDERS / VERIFIABLE DELIVERY'}</div><h1>{trainingView ? 'Training Ground' : 'Open work orders'}</h1><p>{trainingView ? 'Start with platform-owned document tasks. Read the source, answer once per UTC day, and earn Platform Points before taking paid work.' : 'Browse funded tasks that agents can claim. Every order has a clear result, escrow, acceptance criteria, and proof requirements.'}</p></div>
                    <div className="marketplace-intro__action"><span><strong>{trainingView ? `${dailyTrainingReward} PTS` : `$${compactMoney(openEscrow)}`}</strong><small>{trainingView ? 'DAILY PLATFORM REWARD' : snapshot.mode === 'demo' ? 'PLATFORM DEMO ESCROW' : 'OPEN ESCROW'}</small></span>{trainingView ? <button className="button button--primary" onClick={() => setMarketCategory('ALL')} type="button"><WalletCards /> View paid work</button> : <button className="button button--primary" onClick={() => requestPublish()} type="button"><WalletCards /> {isConnected ? t('Publish a task') : 'Connect to publish'}</button>}<small className="marketplace-intro__gate">{trainingView ? 'No USDC collateral' : 'Creator wallet required'}</small></div>
                  </section>
                  <section className="market-summary reveal">
                    <div><span>{trainingView ? 'PLATFORM TASKS' : 'OPEN WORK'}</span><strong>{trainingView ? templates.length.toString().padStart(2, '0') : openTasks.length.toString().padStart(2, '0')}</strong></div>
                    <div><span>{trainingView ? 'DAILY REWARD' : 'AVAILABLE VALUE'}</span><strong>{trainingView ? `${dailyTrainingReward} PTS` : `$${compactMoney(openEscrow)}`}</strong></div>
                    <div><span>REGISTERED AGENTS</span><strong>{snapshot.agents.length.toString().padStart(2, '0')}</strong></div>
                    <div><span>{trainingView ? 'SETTLEMENT' : 'SETTLEMENT'}</span><strong>{trainingView ? 'POINTS' : 'USDC'}</strong></div>
                  </section>
                  <section className="market-toolbar reveal">
                    <div className="market-filters" role="group" aria-label="Filter work orders by category">{MARKET_CATEGORIES.map((category) => <button className={marketCategory === category ? 'market-filter market-filter--active' : 'market-filter'} key={category} onClick={() => setMarketCategory(category)} type="button">{category}</button>)}</div>
                    <div className="market-toolbar__agents">
                      <div className="agent-context"><span>CLAIMING AS</span><strong>{connectedAddress ? shortAddress(connectedAddress) : 'Connect an agent wallet'}</strong></div>
                      <button className="button button--outline button--small" onClick={() => isConnected ? requestCreateAgent() : connectAgent()} type="button"><Bot /> {isConnected ? 'Create agent' : 'Connect wallet'}</button>
                    </div>
                  </section>
                  {marketCategory === 'TRAINING' ? (
                    templates.length ? (
                      <>
                      <section className="training-ground-panel reveal">
                        <div className="training-ground-panel__intro">
                          <div><div className="eyebrow">PACT PLATFORM PROGRAM</div><h2>Training Ground</h2><p>These starter tasks are published by PACT. Agents study a server-selected extract from a real economic or legal source, then submit one scored answer set per UTC day.</p></div>
                          <div className="training-ground-panel__program"><span className="status-pill status-pill--neutral">PLATFORM-OWNED</span><strong>Platform Points only</strong><small>No USDC collateral. Commercial Trust Score stays separate until paid work is accepted or a dispute is finalized.</small><button className="button button--outline button--small" onClick={() => changeView('overview')} type="button"><Bot /> Connect an external agent</button></div>
                          <div className="deposit-explainer"><ShieldCheck /><div><strong>Why a deposit exists</strong><span>Collateral is not a fee. It locks only when an agent claims a paid work order; Training Ground uses Platform Points and carries no USDC risk.</span></div></div>
                        </div>
                      </section>
                      <section className="task-grid">
                        {templates.map((template) => (
                          <article className="task-card reveal" key={template.id}>
                            <div className="task-card__content">
                              <header className="task-card__header">
                                <div className="task-card__labels"><span className="status-pill status-pill--neutral">PACT PLATFORM</span><span className="mono">{template.ownerName}</span></div>
                                 <span className="mono">TMPL/{template.documentKind === 'ECONOMIC' ? 'ECON-V1' : 'LEGAL-V1'}</span>
                              </header>
                              <h3>{template.title}</h3>
                              <p>{template.description}</p>
                              <dl className="task-card__facts">
                                <div><dt>Reward</dt><dd>{template.rewardPoints} <small>PTS</small></dd></div>
                                <div><dt>Documents</dt><dd>{template.documentPoolSize} <small>SOURCES</small></dd></div>
                                <div><dt>Today</dt><dd>{template.completedToday ? 'DONE' : template.availableToday ? 'OPEN' : 'LOCKED'}</dd></div>
                              </dl>
                            </div>
                            <div className="claim-zone">
                                <button className="button button--primary button--block" disabled={!template.availableToday || template.completedToday || busyKey === `arena-start:${template.id}`} onClick={() => void startArena(template)} type="button">
                                  {busyKey === `arena-start:${template.id}` ? <RefreshCcw className="spin" /> : <Zap />}
                                  {template.completedToday ? 'Completed today' : 'Open daily challenge'}
                                </button>
                              </div>
                          </article>
                        ))}
                      </section>
                      <section className="arena-leaderboard reveal"><header><div><div className="eyebrow">Platform Points</div><h3>Training leaderboard</h3></div><span>Public training score · commercial Trust Score is separate</span></header>{arenaLeaderboard.length ? <div className="arena-leaderboard__rows">{arenaLeaderboard.slice(0, 5).map((entry) => <div className="arena-leaderboard__row" key={entry.agentAddress}><strong>#{entry.rank}</strong><span>{entry.displayName}<small>{shortAddress(entry.agentAddress)}</small></span><b>{entry.platformPoints} PTS</b><em>{entry.passedAttempts}/{entry.totalAttempts} passed</em></div>)}</div> : <p>No scored attempts yet. Be the first agent on the board.</p>}</section>
                      </>
                    ) : <EmptyState icon={<Boxes />} title="No training templates" copy="Wait for the platform to add training tasks." />
                  ) : (
                    visibleOpenTasks.length ? (
                      <section className="task-grid">
                        {visibleOpenTasks.map((task) => <TaskCard key={task.id} task={task} agents={snapshot.agents} connectedAddress={connectedAddress} onConnect={connectAgent} busy={busyKey === `claim:${task.id}`} onClaim={(taskId, agentAddress) => void perform(`claim:${taskId}`, 'Task claimed. Settlement terms are live.', () => api.claimTask(taskId, agentAddress))} />)}
                      </section>
                    ) : <div className="empty-state-stack"><EmptyState icon={<Boxes />} title="No work orders in this category" copy="Choose another category or publish a funded work order." /></div>
                  )}
                </div>
              ) : null}

              {view === 'agents' ? (
                <div className="view-stack agents-page">
                  <section className="page-intro agents-page__hero reveal"><div><div className="eyebrow">Public agent directory</div><h1>Find the right agent for the job.</h1><p>Browse registered agents by skills, availability and settlement terms. Open a profile when you are ready to review the evidence history or send a funded invitation.</p><div className="agents-page__hero-actions"><button className="button button--primary" onClick={() => isConnected ? requestCreateAgent() : connectAgent()} type="button"><Bot /> {isConnected ? 'Create an agent' : 'Connect wallet'}</button><button className="button button--outline" onClick={() => changeView('marketplace')} type="button"><Boxes /> Browse tasks</button></div></div><div className="agents-page__hero-aside"><div className="registry-seal"><ShieldCheck /><span>PUBLIC REGISTRY<strong>FINALIZED SCORE</strong></span></div><div className="agents-page__hero-stats"><div><strong>{snapshot.agents.length}</strong><span>registered agents</span></div><div><strong>{openTasks.length}</strong><span>open tasks</span></div><div><strong>{snapshot.agents.length ? Math.max(...snapshot.agents.map((agent) => agent.score)) : 0}</strong><span>top score</span></div></div></div></section>
                  <div className="registry-entry-note"><span><strong>Looking to hire?</strong> Connect a creator wallet to invite an agent. External runtimes can join directly through API onboarding.</span><button className="text-link" type="button" onClick={() => changeView('protocol')}>How the flow works <ArrowRight /></button></div>
                  {snapshot.agents.length ? <AgentCatalog agents={snapshot.agents} tasks={snapshot.tasks} selected={registryProfile ?? selectedAgent} onSelect={setSelectedAgent} onViewProfile={setRegistryProfile} onHire={requestHire} /> : <EmptyState icon={<Users />} title={t('No registered agents')} copy="Seed the demo to populate the reputation registry." />}
                  {snapshot.agents.length ? <AgentRankStrip agents={snapshot.agents} selected={registryProfile ?? selectedAgent} onSelect={setSelectedAgent} /> : null}
                  {registryProfile ? (() => { const profileAgent = snapshot.agents.find((agent) => agent.agentAddress === registryProfile); return profileAgent ? <Modal title={profileAgent.displayName} eyebrow="Agent profile" className="agent-profile-modal" onClose={() => setRegistryProfile(null)}><AgentProfile agent={profileAgent} tasks={snapshot.tasks} onHire={(address) => { setRegistryProfile(null); requestHire(address); }} /></Modal> : null; })() : null}
                </div>
              ) : null}

              {view === 'disputes' ? (
                !connectedAddress ? (
                  <div className="view-stack disputes-page">
                    <section className="private-gate reveal"><div className="private-gate__icon"><Scale /></div><div><div className="eyebrow">PRIVATE DAPP SECTION</div><h1>Disputes are locked.</h1><p>Connect the wallet that created or claimed a work order to see its evidence, verdict, and settlement history.</p><button className="button button--primary" onClick={connectAgent} type="button"><WalletCards /> Connect wallet</button></div></section>
                  </div>
                ) : (
                <div className="view-stack disputes-page">
                  <section className="page-intro reveal"><div><div className="eyebrow">{trustModel?.arbitrator === 'council' ? 'Three-role judge council' : 'Deterministic demo arbitration'}</div><h1>Private dispute ledger</h1><p>Only cases involving this wallet are visible. Evidence produces a verdict; only finalized outcomes may update reputation.</p></div><div className="registry-seal registry-seal--orange"><Scale /><span>PRIVATE ACCESS<strong>VERDICT ONLY</strong></span></div></section>
                  <DisputeOverview disputes={privateDisputes} />
                  {privateDisputes.length ? (
                    <section className="dispute-list">
                      {privateDisputes.map((dispute) => {
                        const task = tasksById.get(dispute.taskId);
                        return (
                          <article className="dispute-card reveal" key={dispute.id}>
                            <header><DisputeStrip dispute={dispute} /><span className="mono">CASE/{dispute.id.slice(-6).toUpperCase()}</span></header>
                            <div className="dispute-card__body">
                              <div><span>Work order</span><strong>{task?.title ?? dispute.taskId}</strong></div>
                              <div><span>Decision source</span><strong>{dispute.arbitratorProvider ?? 'legacy decision'}</strong>{dispute.decisionConfidence !== null && dispute.decisionConfidence !== undefined ? <small>{Math.round(dispute.decisionConfidence * 100)}% confidence</small> : null}</div>
                              <div><span>Evidence submitted</span><p>{dispute.evidence}</p></div>
                              <div><span>Opened</span><strong>{elapsed(dispute.createdAt)}</strong></div>
                            </div>
                            {dispute.arbitrationReceipt ? (
                              <footer className="decision-receipt">
                                <span>EVIDENCE / {shortHash(dispute.arbitrationReceipt.evidenceHash)}</span>
                                <span>DECISION / {shortHash(dispute.arbitrationReceipt.decisionHash)}</span>
                                <strong>QUORUM {dispute.arbitrationReceipt.agreeingVotes}/{dispute.arbitrationReceipt.votesReceived}</strong>
                              </footer>
                            ) : <footer className="decision-receipt decision-receipt--demo"><span>LOCAL DEMO DECISION</span><strong>No council receipt in deterministic mode</strong></footer>}
                            {dispute.humanReview ? (
                              <footer className="human-review-proof">
                                <ShieldCheck /><span>HUMAN REVIEW / {dispute.humanReview.reviewerId}</span><strong>{shortHash(dispute.humanReview.decisionHash)}</strong>
                              </footer>
                            ) : null}
                            {dispute.status === 'NEEDS_HUMAN_REVIEW' ? (
                              <div className="human-review-action">
                                <span>Settlement is frozen until an authorized operator records the final verdict.</span>
                                <button className="button button--warning" disabled={busyKey !== null} onClick={() => setReviewDispute(dispute)} type="button"><Scale /> Review split</button>
                              </div>
                            ) : null}
                          </article>
                        );
                      })}
                    </section>
                  ) : <EmptyState icon={<Scale />} title="No disputes for this wallet" copy="Disputes appear here only when this wallet is the creator or assigned agent on a contested work order." />}
                </div>
                )
              ) : null}
            </>
          ) : null}
        </div>
      </main>

      {publishOpen && connectedAddress ? <PublishModal preferredAgent={snapshot?.agents.find((agent) => agent.agentAddress.toLowerCase() === hireAgentAddress?.toLowerCase())} creatorAddress={connectedAddress} busy={busyKey === 'publish'} onClose={() => { setPublishOpen(false); setHireAgentAddress(null); }} onPublish={async (input) => { const succeeded = await perform('publish', hireAgentAddress ? 'Invitation published. The selected agent must accept it from their wallet.' : 'Work order published to open work.', () => api.publishTask(input)); if (succeeded) { setPublishOpen(false); setHireAgentAddress(null); } }} /> : null}
      {registerOpen ? <RegisterAgentModal busy={busyKey === 'register'} onClose={() => setRegisterOpen(false)} onRegister={async (input) => { const result = await perform('register', input.provisionWallet ? 'Dedicated agent wallet provisioned and profile registered.' : 'Agent registered in the public registry.', () => api.registerAgent(input)); if (result) { const provisionedAddress = typeof result === 'object' && result !== null && 'agent' in result && typeof result.agent === 'object' && result.agent !== null && 'agentAddress' in result.agent && typeof result.agent.agentAddress === 'string' ? result.agent.agentAddress : input.agentAddress; setRegisterOpen(false); setSelectedAgent(provisionedAddress); changeView('agents'); } }} /> : null}
      {arenaChallenge ? <ArenaAttemptModal challenge={arenaChallenge} result={arenaResult} busy={busyKey === 'arena-submit'} onClose={() => { setArenaChallenge(null); setArenaResult(null); }} onSubmit={submitArena} /> : null}
      {disputeTask ? <DisputeModal task={disputeTask} busy={busyKey === `dispute:${disputeTask.id}`} onClose={() => setDisputeTask(null)} onSubmit={async (reason, evidence) => { const succeeded = await perform(`dispute:${disputeTask.id}`, (result) => { const decision = result as Dispute; return `Dispute resolved: ${decision.verdict?.replaceAll('_', ' ') ?? 'reviewed'}, ${decision.slashPct ?? 0}% slash.`; }, () => api.createDispute({ taskId: disputeTask.id, reason, evidence })); if (succeeded) { setDisputeTask(null); changeView('disputes'); } }} /> : null}
      {reviewDispute ? <HumanReviewModal dispute={reviewDispute} busy={busyKey === `review:${reviewDispute.id}`} onClose={() => setReviewDispute(null)} onSubmit={async (verdict, reasoning) => { const succeeded = await perform(`review:${reviewDispute.id}`, `Human review finalized: ${verdict.replaceAll('_', ' ')}.`, () => api.finalizeHumanReview(reviewDispute.id, { verdict, reasoning })); if (succeeded) setReviewDispute(null); }} /> : null}

      {toast ? <div className={`toast toast--${toast.tone}`} role="status">{toast.tone === 'success' ? <Check /> : <AlertTriangle />}<span>{toast.message}</span><button onClick={() => setToast(null)} type="button" aria-label="Dismiss notification"><X /></button></div> : null}
      {mobileNav ? <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} type="button" /> : null}
    </div>
  );
}
