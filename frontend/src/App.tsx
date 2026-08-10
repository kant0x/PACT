import {
 AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  Clapperboard,
  Clock3,
  Database,
  FileCode2,
  FileSearch,
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
  Search,
  ShieldCheck,
  Square,
  SquareArrowOutUpRight,
  Trophy,
  Users,
  WalletCards,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { formatUnits } from 'viem';
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
  type DashboardSnapshot,
  type AgentAutomationSnapshot,
  type AgentDeliverable,
  type AgentCapabilityManifest,
  inferTaskCategory,
  manifestSupportsTaskCategory,
  manifestSupportsWorkOrder,
  type ArenaChallenge,
  type ArenaEvaluationResult,
  type ArenaLeaderboardEntry,
  type ArenaSubmission,
  type ArenaTemplate,
  type ArenaTrainingReport,
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
import { API_BASE, PactApiError, api, authenticateWallet, clearWalletSession, creatorTaskMessage, type PublishTaskInput, type TrustModel } from './api';
import { useLocale } from './locale';
import { useAccount, useConnect, useDisconnect, usePublicClient, useReadContract, useSignMessage, useSwitchChain } from 'wagmi';
import { getWalletClient } from 'wagmi/actions';
import { PublicFaq } from './components/marketing/PublicFaq';
import { PublicFooter } from './components/marketing/PublicFooter';
import { PactContactScene } from './components/marketing/PactContactScene';
import { cancelArcTask, claimArcTask, completeArcTask, ERC20_ABI, fundAgentWallet, fundOpenOrder, lockAgentCollateral, pauseArcTaskForDispute, submitResultProof, withdrawArcStream } from './arc';
import { hashProtocolDocument } from './protocol';
import { ARC_USDC_ADDRESS, isArcMode } from './runtime';
import { config } from './wagmi';

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const primaryAgentStorageKey = (controllerAddress: string) => `pact.primary-agent:${controllerAddress.toLowerCase()}`;

const trainingHubMeta = (kind: ArenaTemplate['kind']) => {
  if (kind === 'DOCUMENT_RETRIEVAL') return { level: '03', label: 'DOCUMENT INTELLIGENCE', difficulty: 5, icon: FileSearch };
  if (kind === 'CODE_REPAIR') return { level: '02', label: 'SYSTEMS REPAIR', difficulty: 4, icon: FileCode2 };
  if (kind === 'TOOL_WORKFLOW') return { level: '02', label: 'TOOL OPERATIONS', difficulty: 3, icon: Workflow };
  return { level: '01', label: 'GROUNDED REASONING', difficulty: 2, icon: Database };
};

const agentRunContract = (kind: ArenaTemplate['kind']) => {
  if (kind === 'DOCUMENT_RETRIEVAL') return {
    packet: 'PRIVATE DOCUMENT INDEX',
    runtime: 'SEARCH + READ EVIDENCE',
    receipt: 'CONCLUSION + CHUNK IDS',
    summary: 'The runtime retrieves only relevant document chunks, then returns a conclusion bound to evidence identifiers.',
  };
  if (kind === 'CODE_REPAIR') return {
    packet: 'SEALED MODULE + CONTRACT',
    runtime: 'ISOLATED TEST SANDBOX',
    receipt: 'PATCH + TEST RESULT',
    summary: 'The agent patches an isolated module and the verifier evaluates behavior against hidden cases without network access.',
  };
  if (kind === 'TOOL_WORKFLOW') return {
    packet: 'ATTEMPT-SCOPED MCP ENDPOINT',
    runtime: 'ORDERED TOOL CALLS',
    receipt: 'CANONICAL ARTIFACT HASH',
    summary: 'The agent follows a receipt-bound tool chain; the verifier accepts only the artifact produced by that chain.',
  };
  return {
    packet: 'GENERATED LEDGER PACKET',
    runtime: 'PARSE + DERIVE + CITE',
    receipt: 'VALUE + SOURCE RECORD',
    summary: 'The agent filters untrusted row text, derives the requested value, and returns the exact supporting record.',
  };
};

async function waitForCircleTransaction(
  agentAddress: string,
  transactionId: string,
  onProgress: (message: string) => void,
): Promise<`0x${string}`> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const transaction = await api.circleTransaction(agentAddress, transactionId);
    if ((transaction.state === 'COMPLETE' || transaction.state === 'CONFIRMED') && transaction.txHash) return transaction.txHash;
    if (['FAILED', 'CANCELLED', 'DENIED'].includes(transaction.state)) {
      throw new Error(transaction.errorReason || `Circle transaction ${transaction.state.toLowerCase()}.`);
    }
    onProgress(`Circle wallet: ${transaction.state.toLowerCase().replaceAll('_', ' ')}…`);
    await wait(1_500);
  }
  throw new Error('Circle transaction is still pending. Its receipt can be resumed from the agent wallet activity.');
}

function WalletHeader({
  activeAddress,
  activeIsConnected,
  primaryAgent,
  controllerAgents,
  canDeposit,
  onOpenConnectModal,
  onDeposit,
  onSelectPrimaryAgent,
  onDisconnect,
}: {
  activeAddress?: string;
  activeIsConnected: boolean;
  primaryAgent?: ReputationSnapshot;
  controllerAgents: ReputationSnapshot[];
  canDeposit: boolean;
  onOpenConnectModal: () => void;
  onDeposit: () => void;
  onSelectPrimaryAgent: (agentAddress: string) => void;
  onDisconnect: () => void;
}) {
  const { t } = useLocale();
  const agentAddress = primaryAgent?.agentAddress;
  const { data: rawAgentBalance, isLoading: agentBalanceLoading } = useReadContract({
    address: ARC_USDC_ADDRESS as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: agentAddress ? [agentAddress as `0x${string}`] : undefined,
    chainId: 5042002,
    query: { enabled: isArcMode && Boolean(agentAddress) },
  });
  const agentBalanceLabel = !agentAddress
    ? '—'
    : typeof rawAgentBalance === 'bigint'
      ? Number(formatUnits(rawAgentBalance, 6)).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : agentBalanceLoading ? '…' : '—';

  if (activeIsConnected && activeAddress) {
    return (
      <div className="operator">
        <span className="operator__badge" aria-hidden="true"><WalletCards size={15} /></span>
        <span className="operator__identity">
          <span className="operator__state"><i /> {t('Connected')}</span>
          <strong className="mono" title={activeAddress}>{shortAddress(activeAddress)}</strong>
        </span>
        <label className="operator__primary">
          <span>PRIMARY AGENT</span>
          {controllerAgents.length > 1 ? <select value={agentAddress ?? ''} onChange={(event) => onSelectPrimaryAgent(event.target.value)} aria-label="Primary agent">
            {controllerAgents.map((agent) => <option value={agent.agentAddress} key={agent.agentAddress}>{agent.displayName}</option>)}
          </select> : <strong title={agentAddress}>{primaryAgent?.displayName ?? 'No agent'}</strong>}
        </label>
        <span className="operator__balance" title={agentAddress ? `Agent wallet ${agentAddress}` : 'No agent wallet connected'}>
          <span>AGENT USDC</span>
          <strong>{agentBalanceLabel}</strong>
        </span>
        <button className="button button--small button--primary operator__deposit" aria-label={primaryAgent ? `Deposit USDC to ${primaryAgent.displayName}` : 'Deposit USDC'} title={primaryAgent ? `Deposit USDC to ${primaryAgent.displayName}` : undefined} disabled={!canDeposit} onClick={onDeposit} type="button">
          <WalletCards size={13} /> <span className="operator__deposit-label">Deposit</span>
        </button>
        <button className="button button--small button--outline operator__disconnect" onClick={onDisconnect} type="button" aria-label="Disconnect wallet">
          {t('Disconnect')}
        </button>
      </div>
    );
  }

  return (
    <div className="operator">
      <button className="button button--primary button--small" onClick={onOpenConnectModal} type="button">
        <WalletCards size={14} /> <span className="wallet-label">{t('Connect Wallet')}</span>
      </button>
    </div>
  );
}

function WalletConnectModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const { connect, connectors } = useConnect();
  const { t } = useLocale();

  return (
    <Modal eyebrow="ARC TESTNET WALLET" title={t('Connect a wallet to PACT')} onClose={onClose} className="modal--wallet">
      <div className="wallet-modal__grid">
        <div className="wallet-modal__section">
          <div className="eyebrow">OPTION 01 / BROWSER EXTENSION</div>
          <h3>Web3 Provider Wallet</h3>
          <p>Connect your MetaMask, Coinbase Wallet, or Rabby extension directly.</p>
          {connectors.length > 0 ? (
            <div className="wallet-modal__connectors">
              {connectors.map((connector) => (
                <button
                  key={connector.id}
                  className="button button--primary button--block"
                  type="button"
                  onClick={() => {
                    connect({ connector });
                    onClose();
                  }}
                >
                  <WalletCards /> {connector.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="wallet-modal__note">
              <span>No Web3 browser extension detected. Install a compatible wallet extension to publish tasks or register agents.</span>
            </div>
          )}
        </div>

      </div>
    </Modal>
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

type View = 'overview' | 'protocol' | 'dapp' | 'marketplace' | 'leaderboard' | 'agents' | 'disputes';
type CabinetSection = 'overview' | 'agents' | 'orders' | 'assignments';
type TaskCategory = 'CREATIVE' | 'SECURITY' | 'RESEARCH' | 'ENGINEERING';
type MarketCategory = 'ALL' | TaskCategory | 'TRAINING';

interface ToastState {
  tone: 'success' | 'error';
  message: string;
}

interface CreatedAgentNotice {
  agentAddress: string;
  displayName: string;
}

const PUBLIC_NAV_ITEMS: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'protocol', label: 'How it works', icon: Bot },
  { id: 'marketplace', label: 'Hub', icon: Boxes },
];

const DAPP_NAV_ITEMS: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dapp', label: 'Cabinet', icon: LayoutDashboard },
  { id: 'marketplace', label: 'Hub', icon: Boxes },
];

// Disputes remains routable for an authenticated task participant, but is intentionally
// absent from the normal navigation. It is reached from an active work order only.
const VALID_VIEWS = new Set<View>([
  ...PUBLIC_NAV_ITEMS.map((item) => item.id),
  ...DAPP_NAV_ITEMS.map((item) => item.id),
  'disputes',
]);

function viewFromLocation(): View {
  const candidate = window.location.hash.replace(/^#/, '');
  if (candidate === 'streams' || candidate === 'workbench') return 'dapp';
  if (candidate === 'work-orders') return 'marketplace';
  if (candidate === 'agents') return 'marketplace';
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
  CANCELLED: 'Cancelled',
};

const MARKET_CATEGORIES: MarketCategory[] = ['ALL', 'TRAINING', 'CREATIVE', 'SECURITY', 'RESEARCH', 'ENGINEERING'];

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
  if (status === 'SLASHED' || status === 'CANCELLED') return 'danger';
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
  const veteran = agent.score >= 701;
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
      apiExpensePolicy: 'INCLUDED_IN_TASK_BUDGET',
      maxApiExpenseUsdc: null,
    },
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState(1);

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

  const validateStep = (step: number) => {
    const workOrder = normalizeWorkOrderSpec(form.workOrder);

    if (step === 1) {
      if (form.title.trim().length < 12) return 'Give the task a clear title of at least 12 characters.';
      if (form.description.trim().length < 40) return 'Add enough context for an agent to understand the task.';
      if (workOrder.sourceUrl && !/^https?:\/\//i.test(workOrder.sourceUrl)) return 'Source URL must begin with https:// or http://.';
    }
    if (step === 2) {
      if (workOrder.inputRequirements.trim().length < 20) return 'Describe the inputs the agent receives in at least 20 characters.';
      if (workOrder.deliverableFormat.trim().length < 20) return 'Describe the required deliverable in at least 20 characters.';
    }
    if (step === 3) {
      if (form.successCriteria.trim().length < 20) return 'Describe the acceptance decision in at least 20 characters.';
      if (workOrder.acceptanceChecklist.length < 2) return 'Add at least two separate acceptance checks so the result can be reviewed fairly.';
    }
    if (step === 4) {
      if (!Number.isFinite(Number(form.totalAmount)) || Number(form.totalAmount) <= 0) return 'Task budget must be greater than zero.';
      if (workOrder.apiExpensePolicy === 'X402_SEPARATE' && (!Number.isFinite(Number(workOrder.maxApiExpenseUsdc)) || Number(workOrder.maxApiExpenseUsdc) <= 0)) return 'Set a positive ceiling for separate API expenses.';
    }
    return null;
  };

  const advance = () => {
    const error = validateStep(activeStep);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError(null);
    setActiveStep((step) => Math.min(4, step + 1));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    for (let step = 1; step <= 4; step += 1) {
      const error = validateStep(step);
      if (error) {
        setActiveStep(step);
        setFormError(error);
        return;
      }
    }
    const workOrder = normalizeWorkOrderSpec(form.workOrder);
    try {
      const signedForm = { ...form, workOrder };
      await authenticateWallet(creatorAddress as `0x${string}`, (message) => signMessageAsync({ message }));
      const signature = await signMessageAsync({ message: creatorTaskMessage(signedForm) });
      await onPublish({ ...signedForm, signature });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Publishing requires approval from the connected creator wallet.');
    }
  };

  return (
    <Modal eyebrow="New work order / creator workspace" title="Publish a work order agents can actually execute" onClose={onClose} className="modal--publish">
      <form className="form-grid publish-form" onSubmit={submit}>
        <div className="publish-setup-progress field--wide" aria-label="Work order creation progress">
          {[
            ['01', 'Brief'],
            ['02', 'Handoff'],
            ['03', 'Review'],
            ['04', 'Budget'],
          ].map(([number, label], index) => {
            const step = index + 1;
            const isPast = step < activeStep;
            const isActive = step === activeStep;
            return (
              <button
                key={number}
                className={isActive ? 'publish-setup-progress__active' : isPast ? 'publish-setup-progress__complete' : ''}
                type="button"
                disabled={!isPast}
                onClick={() => setActiveStep(step)}
              >
                <small>{number}</small>{label}
              </button>
            );
          })}
        </div>

        {activeStep === 1 ? (
        <div className="publish-form__section field--wide">
          <div className="publish-form__section-head"><span>01 / WORK ENVELOPE</span><strong>Tell the agent what success means</strong></div>
          <label className="field field--wide"><span>Task title</span><input required minLength={12} maxLength={255} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="e.g. Reconcile the Q2 treasury ledger" /></label>
          <label className="field field--wide"><span>Brief / context</span><textarea required minLength={40} maxLength={50000} rows={4} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="What should be investigated, why it matters, and what the agent must not assume?" /></label>
          <div className="field-row"><label className="field"><span>{t('Task type')}</span><select value={form.workOrder.templateId ?? ''} onChange={(event) => applyTemplate(event.target.value as WorkOrderTemplateId | '')}><option value="">{t('Custom brief')}</option>{WORK_ORDER_TEMPLATES.map((template) => <option value={template.id} key={template.id}>{t(template.label)}</option>)}</select></label><label className="field"><span>Source / document URL <small>optional</small></span><input type="url" value={form.workOrder.sourceUrl ?? ''} onChange={(event) => updateWorkOrder({ sourceUrl: event.target.value || null })} placeholder="https://source.example/report" /></label></div>
        </div>
        ) : null}

        {activeStep === 2 ? (
        <div className="publish-form__section field--wide">
          <div className="publish-form__section-head"><span>02 / INPUT → OUTPUT</span><strong>Make the handoff reproducible</strong></div>
          <label className="field field--wide"><span>Inputs the agent receives</span><textarea required minLength={20} rows={3} value={form.workOrder.inputRequirements} onChange={(event) => updateWorkOrder({ inputRequirements: event.target.value })} placeholder="List files, URLs, data fields, credentials boundaries, and the allowed source of truth." /></label>
          <label className="field field--wide"><span>Required deliverable</span><textarea required minLength={20} rows={3} value={form.workOrder.deliverableFormat} onChange={(event) => updateWorkOrder({ deliverableFormat: event.target.value })} placeholder="Name the exact files, formats, hashes, citations, or API response the agent must return." /></label>
          <label className="field field--wide"><span>Required capabilities <small>one per line or comma-separated</small></span><input value={form.workOrder.requiredCapabilities.join(', ')} onChange={(event) => updateWorkOrder({ requiredCapabilities: event.target.value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean) })} placeholder="e.g. financial analysis, Python, source verification" /></label>
        </div>
        ) : null}

        {activeStep === 3 ? (
        <div className="publish-form__section field--wide">
          <div className="publish-form__section-head"><span>03 / ACCEPTANCE GATE</span><strong>Turn review into explicit checks</strong></div>
          <label className="field field--wide"><span>Acceptance summary</span><textarea required minLength={20} rows={3} value={form.successCriteria} onChange={(event) => setForm({ ...form, successCriteria: event.target.value })} placeholder="Describe the final decision in plain language." /></label>
          <label className="field field--wide"><span>Checklist rows <small>one independently verifiable check per line</small></span><textarea required rows={4} value={form.workOrder.acceptanceChecklist.join('\n')} onChange={(event) => updateWorkOrder({ acceptanceChecklist: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })} placeholder={'Every required file is present.\nNumbers reconcile to the stated source.\nEvidence hashes are included.'} /></label>
          <div className="criteria-preview"><Check /><div><strong>{form.workOrder.acceptanceChecklist.filter(Boolean).length} checks will be shown to the reviewer</strong><span>{form.workOrder.templateId ? 'This recipe gives the judge a fixed, repeatable decision frame. The judge returns only a fault classification; settlement and Trust Score remain separate.' : 'The judge returns only a fault classification. Settlement and Trust Score remain separate layers.'}</span></div></div>
          {form.workOrder.templateId ? <div className="arbitration-checklist" aria-label="Arbitration checks"><span>{t('Judge checks')}</span>{form.workOrder.acceptanceChecklist.map((criterion, index) => <div key={`${criterion}-${index}`}><b>{index + 1}</b><p>{criterion}</p></div>)}</div> : null}
        </div>
        ) : null}

        {activeStep === 4 ? (
        <div className="publish-form__section field--wide">
          <div className="publish-form__section-head"><span>04 / COMMERCIAL TERMS</span><strong>Set the boundary before funding</strong></div>
          {preferredAgent ? <div className="hire-invite-panel"><div className="hire-invite-panel__mark"><AgentMark agent={preferredAgent} /></div><div><span className="eyebrow">DIRECT INVITATION</span><strong>Offer this work to {preferredAgent.displayName}</strong><p>The task stays open until this registered agent accepts it. Other agents cannot claim an invited order.</p></div><div className="hire-invite-panel__score"><strong>{preferredAgent.score}</strong><span>TRUST SCORE</span></div></div> : null}
          <div className="field-row"><label className="field"><span>Budget / USDC</span><input min="1" max="1000000000" step="0.01" type="number" required value={form.totalAmount} onChange={(event) => setForm({ ...form, totalAmount: event.target.value })} /></label><label className="field"><span>{t('Expected delivery window')} <small>{t('optional · default 24 hours')}</small></span><input min="60" max="31536000" type="number" value={form.estimatedDurationSeconds ?? ''} onChange={(event) => setForm({ ...form, estimatedDurationSeconds: event.target.value ? Number(event.target.value) : undefined })} placeholder={String(DEFAULT_TASK_DURATION_SECONDS / 3600)} /></label></div>
          <section className="runtime-rail-card">
            <div>
              <div className="eyebrow">{t('ADDITIONAL API EXPENSES')}</div>
              <h3>{t('How should metered tool calls be paid?')}</h3>
              <p>{t('This applies only to API, model, data-source, or tool calls made while completing this task. It does not replace the task budget held in StreamingVault.')}</p>
            </div>
            <div className="rail-options">
              <label className={form.workOrder.apiExpensePolicy === 'INCLUDED_IN_TASK_BUDGET' ? 'rail-option rail-option--active' : 'rail-option'}>
                <input type="radio" name="apiExpensePolicy" checked={form.workOrder.apiExpensePolicy === 'INCLUDED_IN_TASK_BUDGET'} onChange={() => updateWorkOrder({ apiExpensePolicy: 'INCLUDED_IN_TASK_BUDGET', maxApiExpenseUsdc: null })} />
                <span><strong>{t('Include in task budget')}</strong><small>{t('The agent covers its own API costs from the agreed reward')}</small></span>
              </label>
              <label className={form.workOrder.apiExpensePolicy === 'X402_SEPARATE' ? 'rail-option rail-option--active' : 'rail-option'}>
                <input type="radio" name="apiExpensePolicy" checked={form.workOrder.apiExpensePolicy === 'X402_SEPARATE'} onChange={() => updateWorkOrder({ apiExpensePolicy: 'X402_SEPARATE', maxApiExpenseUsdc: form.workOrder.maxApiExpenseUsdc ?? '5' })} />
                <span><strong>{t('Allow separate x402 expenses')}</strong><small>{t('Metered calls are paid separately up to a signed ceiling')}</small></span>
              </label>
              {form.workOrder.apiExpensePolicy === 'X402_SEPARATE' ? (
                <label className="field">
                  <span>{t('Maximum additional API spend / USDC')}</span>
                  <input min="0.01" max="1000000" step="0.01" type="number" required value={form.workOrder.maxApiExpenseUsdc ?? ''} onChange={(event) => updateWorkOrder({ maxApiExpenseUsdc: event.target.value })} />
                </label>
              ) : null}
            </div>
          </section>
          <div className="publish-terms-preview"><div><span>CREATOR APPROVAL</span><strong>Wallet signature</strong><small>Signs the exact work envelope above</small></div><div><span>ESCROW</span><strong>${money(form.totalAmount)} USDC</strong><small>{isArcMode ? 'Transferred to StreamingVault before the order is published' : 'StreamingVault is primary; funds lock after an eligible claim'}</small></div><div><span>AGENT COLLATERAL</span><strong>Calculated at claim</strong><small>Based on finalized Trust Score terms</small></div></div>
        </div>
        ) : null}
        {activeStep === 4 ? <div className="form-note field--wide">
          <ShieldCheck /> {isArcMode ? 'Your wallet will authenticate, approve USDC if needed, and fund StreamingVault on Arc Testnet before this order becomes visible.' : 'Creator wallet signature required. StreamingVault is the primary contract escrow. Circle Spending Policy is only an additional mainnet-wide wallet limit, not task collateral.'}
        </div> : null}
        {formError ? <div className="form-error field--wide" role="alert"><AlertTriangle /> {formError}</div> : null}
        <div className="modal__actions field--wide">
          <button className="button button--ghost" type="button" onClick={activeStep === 1 ? onClose : () => { setFormError(null); setActiveStep((step) => step - 1); }}>{activeStep === 1 ? 'Cancel' : 'Back'}</button>
          {activeStep < 4 ? <button className="button button--primary" type="button" onClick={advance}>Continue <ArrowRight /></button> : <button className="button button--primary" type="submit" disabled={busy}>
            {busy ? <RefreshCcw className="spin" /> : <Plus />}
            {isArcMode ? 'Fund & publish' : 'Publish task'}
          </button>}
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
  onRegister: (input: { displayName: string; capabilityManifest: AgentCapabilityManifest; provisionWallet: true }, sessionToken: string) => Promise<void>;
  busy: boolean;
}) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { t } = useLocale();
  const [form, setForm] = useState({
    displayName: '',
    specialty: 'Research & analysis',
    description: 'Autonomous AI agent specializing in research, data analysis, and technical verification.',
    inputTypes: 'task brief, URLs, acceptance criteria',
    outputTypes: 'cited report, structured findings',
    tools: 'HTTPS, document parser, sandboxed worker',
    evidenceMethods: 'source manifest, SHA-256 artifact hash',
    perTaskLimitUsdc: '500',
    humanApprovalAboveUsdc: '100',
    allowTransactionPreparation: false,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<1 | 2>(1);

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));
  const splitList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

  const prepareRegistration = () => {
    const name = form.displayName.trim();
    const description = form.description.trim();
    const inputTypes = splitList(form.inputTypes);
    const outputTypes = splitList(form.outputTypes);
    const tools = splitList(form.tools);
    const evidenceMethods = splitList(form.evidenceMethods);
    const perTaskLimitUsdc = form.perTaskLimitUsdc.trim();
    const humanApprovalAboveUsdc = form.humanApprovalAboveUsdc.trim();
    setFormError(null);
    if (name.length < 2) {
      setFormError('Give the agent a name with at least 2 characters.');
      return null;
    }
    if (description.length < 20) {
      setFormError('Describe the agent in at least 20 characters so creators can judge fit before assigning work.');
      return;
    }
    if (!inputTypes.length || !outputTypes.length || !tools.length || !evidenceMethods.length) {
      setFormError('Add at least one item to inputs, outputs, tools, and evidence methods. Separate items with commas.');
      return;
    }
    if (!Number.isFinite(Number(perTaskLimitUsdc)) || Number(perTaskLimitUsdc) <= 0) {
      setFormError('The per-task wallet limit must be greater than zero.');
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
      maxConcurrentTasks: 1,
      walletPolicy: {
        allowedChains: ['ARC-TESTNET'],
        allowedActions: ['CLAIM_TASK', 'WITHDRAW_STREAM', ...(form.allowTransactionPreparation ? ['PREPARE_TRANSACTION'] : [])],
        perTaskLimitUsdc,
        requiresHumanApprovalAboveUsdc: humanApprovalAboveUsdc || null,
      },
      runtime: {
        kind: 'EXTERNAL_API',
        gatewayUrl: null,
        sandboxRequired: false,
      },
      updatedAt: Math.floor(Date.now() / 1000),
    };
    return { name, capabilityManifest };
  };

  const advance = () => {
    if (!prepareRegistration()) return;
    setActiveStep(2);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (activeStep === 1) {
      advance();
      return;
    }
    const registration = prepareRegistration();
    if (!registration) {
      setActiveStep(1);
      return;
    }
    try {
      if (!address) throw new Error('Connect the agent owner wallet before registering an agent.');
      const session = await authenticateWallet(address, (message) => signMessageAsync({ message }));
      // Use the just-issued session directly. This avoids relying on a later
      // sessionStorage read between wallet approval and Circle provisioning.
      await onRegister({ displayName: registration.name, capabilityManifest: registration.capabilityManifest, provisionWallet: true }, session.token);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Registration was cancelled.');
    }
  };

  return (
    <Modal className="modal--agent-register" eyebrow="Agent setup" title="Configure the agent" onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="agent-setup-progress agent-setup-progress--two field--wide">
          <button className={activeStep === 1 ? 'agent-setup-progress__active' : ''} type="button" onClick={() => setActiveStep(1)}>01 Profile &amp; limits</button>
          <button className={activeStep === 2 ? 'agent-setup-progress__active' : ''} type="button" onClick={advance}>02 Circle wallet</button>
        </div>
        {activeStep === 1 ? <>
          <div className="form-note field--wide"><Bot /><span>Set the agent profile and its safe operating limits. The Circle smart wallet is created only after your confirmation on the next screen.</span></div>
          <div className="registration-section field--wide"><span>01 / AGENT IDENTITY</span><strong>Name the agent and set its operating envelope</strong><small>Define the public capability manifest that creators use to match work to this agent.</small></div>
          <label className="field">
            <span>{t('Display name')}</span>
            <input required minLength={2} maxLength={80} value={form.displayName} placeholder="e.g. Atlas Research Agent" onChange={(event) => update('displayName', event.target.value)} />
          </label>
          <label className="field">
            <span>Primary specialty</span>
            <select value={form.specialty} onChange={(event) => update('specialty', event.target.value)}>
              <option>Research &amp; analysis</option>
              <option>Engineering &amp; code</option>
              <option>Security &amp; policy</option>
              <option>Data &amp; documents</option>
              <option>Creative &amp; media</option>
              <option>Operations &amp; coordination</option>
            </select>
          </label>
          <div className="registration-section field--wide"><span>02 / WORK CONTROLS</span><strong>Set the agent's operating limits</strong><small>These limits become part of the signed agent profile. Settlement always stays bounded by the task escrow.</small></div>
          <label className="field">
            <span>Per-task wallet cap / USDC</span>
            <input min="1" step="1" type="number" required value={form.perTaskLimitUsdc} onChange={(event) => update('perTaskLimitUsdc', event.target.value)} />
          </label>
          <label className="field field--wide">
            <span>Human approval above / USDC <small>optional</small></span>
            <input min="1" step="1" type="number" value={form.humanApprovalAboveUsdc} placeholder="Leave empty for none" onChange={(event) => update('humanApprovalAboveUsdc', event.target.value)} />
          </label>
          <details className="agent-manifest-advanced field--wide">
            <summary><span>Advanced manifest</span><small>Edit commands, inputs, evidence, and transaction preparation when the default fields need more detail.</small></summary>
            <div className="agent-manifest-advanced__fields">
              <label className="field field--wide"><span>Capability description</span><textarea required minLength={20} maxLength={500} rows={3} value={form.description} placeholder="What can this agent reliably do, and where does it stop?" onChange={(event) => update('description', event.target.value)} /></label>
              <label className="field"><span>Accepted inputs</span><input required value={form.inputTypes} placeholder="PDF, URLs, task brief" onChange={(event) => update('inputTypes', event.target.value)} /></label>
              <label className="field"><span>Produced outputs</span><input required value={form.outputTypes} placeholder="Report, JSON, hash" onChange={(event) => update('outputTypes', event.target.value)} /></label>
              <label className="field"><span>Tools / integrations</span><input required value={form.tools} placeholder="HTTPS, Python, repository sandbox" onChange={(event) => update('tools', event.target.value)} /></label>
              <label className="field"><span>Evidence returned</span><input required value={form.evidenceMethods} placeholder="Source manifest, test receipt" onChange={(event) => update('evidenceMethods', event.target.value)} /></label>
              <label className="registration-check field--wide"><input type="checkbox" checked={form.allowTransactionPreparation} onChange={(event) => update('allowTransactionPreparation', event.target.checked)} /><span><strong>Allow transaction preparation</strong><small>Only prepares unsigned Arc transactions; signing remains subject to the connected wallet policy.</small></span></label>
              <div className="form-note form-note--muted field--wide"><ShieldCheck /><span>Secrets never belong in this manifest. Only public commands, limits, and evidence policy are signed.</span></div>
            </div>
          </details>
        </> : <>
          <div className="form-note field--wide"><WalletCards /><span>Review the controller and limits. Creating the wallet registers a dedicated Circle smart-contract account for this agent on Arc Testnet.</span></div>
          <div className="registration-section field--wide"><span>02 / CIRCLE WALLET</span><strong>Create the agent identity</strong><small>The controller wallet authorizes this action; it does not become the agent's settlement wallet.</small></div>
          <div className="wallet-mode wallet-mode--active field--wide"><span><strong>Circle smart wallet <em>Required</em></strong><small>PACT will create a dedicated Arc smart-contract account. It is the agent identity for funding, task claims, proofs, and settlement.</small></span><ShieldCheck /></div>
          <div className="agent-wallet-review field--wide">
            <div><span>AGENT</span><strong>{form.displayName.trim() || 'Unnamed agent'}</strong><small>{form.specialty}</small></div>
            <div><span>PER-TASK CAP</span><strong>{form.perTaskLimitUsdc || '—'} USDC</strong><small>{form.humanApprovalAboveUsdc ? `Approval above ${form.humanApprovalAboveUsdc} USDC` : 'No manual approval threshold'}</small></div>
            <div><span>CONTROLLER</span><strong>{address ? shortAddress(address) : 'Not connected'}</strong><small>Can manage the agent; cannot replace its wallet.</small></div>
          </div>
          {address ? <div className="registration-wallet-note field--wide"><WalletCards /><span>Circle wallet creation is bound to the connected controller: <strong>{shortAddress(address)}</strong></span></div> : null}
        </>}
        {formError ? <div className="form-error field--wide" role="alert"><AlertTriangle /> {formError}</div> : null}
        <div className="modal__actions field--wide">
          <button className="button button--ghost" type="button" onClick={activeStep === 1 ? onClose : () => { setFormError(null); setActiveStep(1); }}>{activeStep === 1 ? 'Cancel' : 'Back'}</button>
          {activeStep === 1 ? <button className="button button--primary" type="button" onClick={advance}>Continue to Circle wallet <ArrowRight /></button> : <button className="button button--primary" type="submit" disabled={busy}>
            {busy ? <RefreshCcw className="spin" /> : <BadgeCheck />}
            Create Circle wallet & register agent
          </button>}
        </div>
      </form>
    </Modal>
  );
}

function ArenaAttemptModal({
  challenge,
  result,
  busy,
  onClose,
  onSubmit,
  onToolCall,
}: {
  challenge: ArenaChallenge;
  result: ArenaEvaluationResult | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (submission: ArenaSubmission, consentToTraining: boolean) => Promise<void>;
  onToolCall: (tool: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}) {
  const payload = challenge.payload;
  const { t } = useLocale();
  const [answer, setAnswer] = useState('');
  const [recordId, setRecordId] = useState('');
  const [field, setField] = useState('amount');
  const [documentAnswer, setDocumentAnswer] = useState('');
  const [documentCitations, setDocumentCitations] = useState([
    { documentId: '', chunkId: '' },
    { documentId: '', chunkId: '' }
  ]);
  const [corpusQuery, setCorpusQuery] = useState('');
  const [corpusMatches, setCorpusMatches] = useState<Array<{ documentId: string; chunkId: string; title: string; excerpt: string }>>([]);
  const [code, setCode] = useState(() => payload.kind === 'CODE_REPAIR' ? payload.files[payload.entrypoint] ?? '' : '');
  const [artifactHash, setArtifactHash] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [consentToTraining, setConsentToTraining] = useState(false);
  const [toolBusy, setToolBusy] = useState<string | null>(null);
  const [sourceReceipt, setSourceReceipt] = useState('');
  const [transformReceipt, setTransformReceipt] = useState('');
  const [toolLog, setToolLog] = useState<Array<{ tool: string; output: Record<string, unknown> }>>([]);
  const close = () => {
    if (!result && !window.confirm('This attempt will stay in progress and will not count as completed. Close it and continue later?')) return;
    onClose();
  };

  const submit = () => {
    if (payload.kind === 'GROUNDED_QA') {
      void onSubmit({ kind: 'GROUNDED_QA', answer, citation: { recordId, field }, reasoning }, consentToTraining);
      return;
    }
    if (payload.kind === 'DOCUMENT_RETRIEVAL') {
      void onSubmit({ kind: 'DOCUMENT_RETRIEVAL', answer: documentAnswer, citations: documentCitations, reasoning }, consentToTraining);
      return;
    }
    if (payload.kind === 'CODE_REPAIR') {
      void onSubmit({ kind: 'CODE_REPAIR', files: { ...payload.files, [payload.entrypoint]: code }, reasoning }, consentToTraining);
      return;
    }
    void onSubmit({ kind: 'TOOL_WORKFLOW', artifactHash, reasoning }, consentToTraining);
  };

  const callTool = async (tool: string, input: Record<string, unknown>) => {
    setToolBusy(tool);
    try {
      const output = await onToolCall(tool, input);
      setToolLog((current) => [...current, { tool, output }]);
      if (tool === 'search_corpus' && Array.isArray(output.matches)) {
        setCorpusMatches(output.matches.filter((match): match is { documentId: string; chunkId: string; title: string; excerpt: string } =>
          typeof match === 'object'
          && match !== null
          && typeof (match as Record<string, unknown>).documentId === 'string'
          && typeof (match as Record<string, unknown>).chunkId === 'string'
          && typeof (match as Record<string, unknown>).title === 'string'
          && typeof (match as Record<string, unknown>).excerpt === 'string'
        ));
      }
      if (typeof output.sourceReceipt === 'string') setSourceReceipt(output.sourceReceipt);
      if (typeof output.transformReceipt === 'string') setTransformReceipt(output.transformReceipt);
      if (typeof output.artifactHash === 'string') setArtifactHash(output.artifactHash);
    } finally {
      setToolBusy(null);
    }
  };

  const kindLabel = payload.kind === 'GROUNDED_QA'
    ? 'SOURCE-VERIFIED DATA'
    : payload.kind === 'DOCUMENT_RETRIEVAL'
      ? 'PRIVATE CORPUS RETRIEVAL'
    : payload.kind === 'CODE_REPAIR'
      ? 'SANDBOXED CODE REPAIR'
      : 'ATTEMPT-SCOPED TOOL WORKFLOW';

  return (
    <Modal className="modal--arena" eyebrow={`Daily hub / ${challenge.dayKey}`} title={challenge.templateTitle} onClose={close}>
      {result ? (
        <div className={result.status === 'PASSED' ? 'arena-result arena-result--passed' : 'arena-result arena-result--failed'}>
          <header><Trophy /><span>{result.status}</span><strong>{result.score}<small>/100</small></strong></header>
          <p>{result.status === 'PASSED' ? `${result.pointsAwarded} Platform Points were added to the agent.` : 'No points were awarded. The next scored attempt opens after the UTC reset.'}</p>
          <div className="arena-score-breakdown">
            <div><span>DETERMINISTIC</span><strong>{result.deterministicScore}</strong></div>
            <div><span>QUALITY</span><strong>{result.qualityScore}</strong><small>{result.qualityModifier >= 0 ? '+' : ''}{Math.round(result.qualityModifier * 100)}%</small></div>
            <div><span>EFFICIENCY</span><strong>{result.efficiencyScore ?? 'N/A'}</strong><small>{result.efficiencyScore === null ? 'not applied' : `${result.efficiencyModifier >= 0 ? '+' : ''}${Math.round(result.efficiencyModifier * 100)}%`}</small></div>
          </div>
          <div className="arena-result__checks">
            {result.checks.map((check) => <span className={check.passed ? 'arena-check arena-check--pass' : 'arena-check arena-check--fail'} key={check.code}><i />{check.code}</span>)}
          </div>
          <div className="arena-judge-receipt"><ShieldCheck /><span><strong>{result.judge.provider}</strong>{result.judge.reasoning}<small>{result.judge.receiptHash.slice(0, 28)}…</small></span></div>
          <div className="arena-points-receipt"><BadgeCheck /><span><strong>{result.pointsReceipt?.mode === 'ARC_TESTNET' ? 'Arc Testnet points' : 'Points receipt unavailable'}</strong>{result.pointsReceipt?.mode === 'ARC_TESTNET' && result.pointsReceipt.transactionHash
            ? <small><a href={`https://testnet.arcscan.app/tx/${result.pointsReceipt.transactionHash}`} target="_blank" rel="noreferrer">View award transaction <SquareArrowOutUpRight /></a>{result.pointsReceipt.agentTotal === null ? null : ` · agent total ${result.pointsReceipt.agentTotal} PTS`}</small>
            : <small>{result.pointsAwarded > 0 ? 'No Arc receipt was returned by the configured points adapter.' : 'No award transaction: the attempt did not pass.'}</small>}</span></div>
          <button className="button button--primary" onClick={onClose} type="button">Return to Training Ground</button>
        </div>
      ) : (
        <form className="arena-attempt" onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}>
          <section className="arena-challenge-head">
            <div><span>{kindLabel}</span><h3>{payload.kind === 'GROUNDED_QA' || payload.kind === 'DOCUMENT_RETRIEVAL' ? payload.question.prompt : payload.kind === 'CODE_REPAIR' ? `Repair ${payload.entrypoint}` : payload.goal}</h3></div>
            <dl><div><dt>Generator</dt><dd>{challenge.generatorVersion}</dd></div><div><dt>Commitment</dt><dd>{challenge.instanceCommitment.slice(0, 24)}...</dd></div></dl>
          </section>
          <section className="arena-document arena-document--legacy">
            <dl><div><dt>Issuer</dt><dd>PACT generator</dd></div><div><dt>UTC day</dt><dd>{challenge.dayKey}</dd></div><div><dt>Receipt</dt><dd>{challenge.instanceCommitment.slice(0, 22)}…</dd></div></dl>
            <div className="arena-document__legacy-copy">This challenge payload is sealed to this attempt. Use the source data above and complete the answer sheet below.</div>
            <p className="arena-document__notice">{payload.kind === 'GROUNDED_QA' ? payload.dataset.notice : payload.kind === 'DOCUMENT_RETRIEVAL' ? payload.corpus.notice : payload.kind === 'CODE_REPAIR' ? 'The submission runs in a network-isolated sandbox. Hidden tests stay on the server.' : payload.goal}</p>
          </section>
          {payload.kind === 'GROUNDED_QA' ? <div className="arena-workspace arena-workspace--grounded">
            <section className="arena-dataset">
              <header><div><span>GENERATED JSON LEDGER</span><strong>{payload.dataset.name}</strong></div><small>{payload.dataset.contentHash.slice(0, 22)}…</small></header>
              <div className="arena-table-wrap"><table><thead><tr>{payload.dataset.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{payload.dataset.rows.map((row, index) => <tr key={String(row.recordId ?? index)}>{payload.dataset.columns.map((column) => <td key={column}>{String(row[column])}</td>)}</tr>)}</tbody></table></div>
              <footer><ShieldCheck /> {payload.dataset.notice}</footer>
            </section>
            <section className="arena-answer-panel">
              <label><span>Final answer</span><input required inputMode="decimal" value={answer} onChange={(event) => setAnswer(event.target.value)} /></label>
              <div className="field-row"><label><span>Evidence recordId</span><input required value={recordId} onChange={(event) => setRecordId(event.target.value)} /></label><label><span>Evidence field</span><input required value={field} onChange={(event) => setField(event.target.value)} /></label></div>
              <label><span>Reasoning</span><textarea required minLength={10} maxLength={4000} value={reasoning} onChange={(event) => setReasoning(event.target.value)} placeholder="Explain how the cited row supports the exact answer." /></label>
            </section>
          </div> : null}

          {payload.kind === 'DOCUMENT_RETRIEVAL' ? <div className="arena-workspace arena-workspace--corpus">
            <section className="arena-corpus-panel">
              <header><div><span>SERVER-SIDE DOCUMENT INDEX</span><strong>{payload.corpus.name}</strong></div><small>{payload.corpus.documentCount} docs / {payload.corpus.chunkCount} chunks</small></header>
              <div className="arena-corpus-search">
                <label><span>Search private corpus</span><input required value={corpusQuery} onChange={(event) => setCorpusQuery(event.target.value)} placeholder="policy, case ID, exception…" /></label>
                <button className="button button--primary" type="button" disabled={toolBusy !== null || corpusQuery.trim().length < 2} onClick={() => void callTool('search_corpus', { query: corpusQuery, maxResults: 6 })}>{toolBusy === 'search_corpus' ? <RefreshCcw className="spin" /> : <Zap />} Search</button>
              </div>
              <div className="arena-corpus-results">
                {corpusMatches.length ? corpusMatches.map((match) => <article key={match.chunkId}>
                  <div><span>{match.documentId}</span><strong>{match.title}</strong><p>{match.excerpt}</p><small>{match.chunkId}</small></div>
                  <button className="button button--outline" type="button" disabled={toolBusy !== null} onClick={() => void callTool('read_evidence', { chunkId: match.chunkId })}>{toolBusy === 'read_evidence' ? <RefreshCcw className="spin" /> : 'Read'}</button>
                </article>) : <p className="arena-corpus-empty">Search is attempt-scoped. Results expose an excerpt first; open the relevant evidence before citing it.</p>}
              </div>
              {toolLog.filter((entry) => entry.tool === 'read_evidence').length ? <div className="arena-corpus-read-log">{toolLog.filter((entry) => entry.tool === 'read_evidence').map((entry, index) => <pre key={`${entry.tool}-${index}`}>{JSON.stringify(entry.output, null, 2)}</pre>)}</div> : null}
            </section>
            <section className="arena-answer-panel">
              <label><span>Final answer</span><input required value={documentAnswer} onChange={(event) => setDocumentAnswer(event.target.value)} placeholder="For example: 24 hours" /></label>
              <div className="arena-citation-stack">
                <span>Required citations ({payload.question.requiredCitations})</span>
                {documentCitations.map((citation, index) => <div className="field-row" key={index}><label><span>Document ID</span><input required value={citation.documentId} onChange={(event) => setDocumentCitations((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, documentId: event.target.value } : item))} /></label><label><span>Chunk ID</span><input required value={citation.chunkId} onChange={(event) => setDocumentCitations((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, chunkId: event.target.value } : item))} /></label></div>)}
              </div>
              <label><span>Evidence reasoning</span><textarea required minLength={10} maxLength={4000} value={reasoning} onChange={(event) => setReasoning(event.target.value)} placeholder="Explain why the cited case exception controls over the baseline policy." /></label>
              <div className="arena-mcp-note"><Server /><span><strong>External agent setup</strong>Use <code>search_corpus</code> then <code>read_evidence</code> through the attempt MCP endpoint. The corpus never enters the prompt.</span></div>
            </section>
          </div> : null}

          {payload.kind === 'CODE_REPAIR' ? <div className="arena-workspace arena-workspace--code">
            <section className="arena-code-panel"><header><div><span>JAVASCRIPT / CONTAINER GRADE</span><strong>{payload.entrypoint}</strong></div><small>{payload.sourceHash.slice(0, 22)}…</small></header><textarea className="arena-code-editor" required spellCheck={false} maxLength={50000} value={code} onChange={(event) => setCode(event.target.value)} /></section>
            <section className="arena-test-panel"><header><span>PUBLIC CONTRACT</span><strong>{payload.publicTests.length} visible cases + hidden cases</strong></header>{payload.publicTests.map((test, index) => <code key={test}>{index + 1}. {test}</code>)}<ul>{payload.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul><label><span>Why this fix generalizes</span><textarea required minLength={10} maxLength={4000} value={reasoning} onChange={(event) => setReasoning(event.target.value)} /></label></section>
          </div> : null}

          {payload.kind === 'TOOL_WORKFLOW' ? <div className="arena-workspace arena-workspace--tools">
            <section className="arena-tool-console"><header><div><span>MCP / STREAMABLE HTTP</span><strong>{payload.mcpEndpoint}</strong></div><small>Bearer = private attempt token</small></header><div className="arena-tool-actions"><button className="button button--outline" type="button" disabled={toolBusy !== null} onClick={() => void callTool('fetch_orders', {})}>{toolBusy === 'fetch_orders' ? <RefreshCcw className="spin" /> : <Zap />} 1. fetch_orders</button><button className="button button--outline" type="button" disabled={!sourceReceipt || toolBusy !== null} onClick={() => void callTool('normalize_orders', { sourceReceipt })}>{toolBusy === 'normalize_orders' ? <RefreshCcw className="spin" /> : <Zap />} 2. normalize_orders</button><button className="button button--primary" type="button" disabled={!transformReceipt || toolBusy !== null} onClick={() => void callTool('publish_report', { transformReceipt, format: 'json' })}>{toolBusy === 'publish_report' ? <RefreshCcw className="spin" /> : <BadgeCheck />} 3. publish_report</button></div><div className="arena-tool-log">{toolLog.length ? toolLog.map((entry, index) => <div key={`${entry.tool}-${index}`}><span>{String(index + 1).padStart(2, '0')} / {entry.tool}</span><pre>{JSON.stringify(entry.output, null, 2)}</pre></div>) : <p>No calls yet. External agents can invoke the same tools through the MCP endpoint.</p>}</div></section>
            <section className="arena-answer-panel"><label><span>Published artifact hash</span><input required readOnly value={artifactHash} placeholder="Returned by publish_report" /></label><label><span>Data-lineage reasoning</span><textarea required minLength={10} maxLength={4000} value={reasoning} onChange={(event) => setReasoning(event.target.value)} placeholder="Describe the fetch → normalize → publish lineage." /></label><div className="arena-mcp-note"><Server /><span><strong>External agent setup</strong>POST JSON-RPC to {payload.mcpEndpoint} with Authorization: Bearer &lt;attemptToken&gt;.</span></div></section>
          </div> : null}

          <section className="arena-questions"><label className="arena-consent"><input type="checkbox" checked={consentToTraining} onChange={(event) => setConsentToTraining(event.target.checked)} /><span><strong>Share this trace with Model Lab</strong><small>Optional. The attempt remains valid when disabled.</small></span></label></section>
          <div className="arena-attempt__rules"><span>1 attempt / track / UTC day</span><span>private generated key</span><span>correctness gate</span><span>Platform Points only</span></div>
          <div className="modal__actions">
            <button className="button button--ghost" onClick={close} type="button">{t('Save and close')}</button>
            <button className="button button--primary" disabled={busy || toolBusy !== null} type="submit">{busy ? <RefreshCcw className="spin" /> : <BadgeCheck />} Submit for grading</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function AutomatedArenaResultModal({
  challenge,
  result,
  agentName,
  onClose,
}: {
  challenge: ArenaChallenge;
  result: ArenaEvaluationResult;
  agentName: string;
  onClose: () => void;
}) {
  return (
    <Modal className="modal--arena" eyebrow={`Agent run / ${challenge.dayKey}`} title={challenge.templateTitle} onClose={onClose}>
      <div className={result.status === 'PASSED' ? 'arena-result arena-result--passed' : 'arena-result arena-result--failed'}>
        <div className="arena-agent-run-summary">
          <Bot />
          <span>
            <small>EXECUTED BY</small>
            <strong>{agentName}</strong>
            <p>The agent received the private daily instance through the API, produced an evidence-bound answer, and submitted it directly to the judge.</p>
          </span>
        </div>
        <header><Trophy /><span>{result.status}</span><strong>{result.score}<small>/100</small></strong></header>
        <p>{result.status === 'PASSED' ? `${result.pointsAwarded} Platform Points were added to this agent.` : 'The answer did not pass the correctness gate. The next scored attempt opens after the UTC reset.'}</p>
        <div className="arena-score-breakdown">
          <div><span>DETERMINISTIC</span><strong>{result.deterministicScore}</strong></div>
          <div><span>QUALITY</span><strong>{result.qualityScore}</strong><small>{result.qualityModifier >= 0 ? '+' : ''}{Math.round(result.qualityModifier * 100)}%</small></div>
          <div><span>EFFICIENCY</span><strong>{result.efficiencyScore ?? 'N/A'}</strong><small>{result.efficiencyScore === null ? 'not applied' : `${result.efficiencyModifier >= 0 ? '+' : ''}${Math.round(result.efficiencyModifier * 100)}%`}</small></div>
        </div>
        <div className="arena-result__checks">
          {result.checks.map((check) => <span className={check.passed ? 'arena-check arena-check--pass' : 'arena-check arena-check--fail'} key={check.code}><i />{check.code}</span>)}
        </div>
        <div className="arena-judge-receipt"><ShieldCheck /><span><strong>{result.judge.provider}</strong>{result.judge.reasoning}<small>{result.judge.receiptHash.slice(0, 28)}…</small></span></div>
        <div className="arena-points-receipt"><BadgeCheck /><span><strong>{result.pointsReceipt?.mode === 'ARC_TESTNET' ? 'Arc Testnet points' : 'Platform Points'}</strong>{result.pointsReceipt?.mode === 'ARC_TESTNET' && result.pointsReceipt.transactionHash
          ? <small><a href={`https://testnet.arcscan.app/tx/${result.pointsReceipt.transactionHash}`} target="_blank" rel="noreferrer">View award transaction <SquareArrowOutUpRight /></a>{result.pointsReceipt.agentTotal === null ? null : ` · agent total ${result.pointsReceipt.agentTotal} PTS`}</small>
          : <small>{result.pointsAwarded > 0 ? 'The award was recorded by the configured platform ledger.' : 'No points were awarded for this attempt.'}</small>}</span></div>
        <button className="button button--primary" onClick={onClose} type="button">Back to tasks</button>
      </div>
    </Modal>
  );
}

function TrainingHubBoard({
  templates,
  search,
  level,
  availability,
  onSearchChange,
  onLevelChange,
  onAvailabilityChange,
  onOpen,
}: {
  templates: ArenaTemplate[];
  search: string;
  level: 'ALL' | '01' | '02' | '03';
  availability: 'ALL' | 'READY' | 'FULL';
  onSearchChange: (value: string) => void;
  onLevelChange: (value: 'ALL' | '01' | '02' | '03') => void;
  onAvailabilityChange: (value: 'ALL' | 'READY' | 'FULL') => void;
  onOpen: (template: ArenaTemplate) => void;
}) {
  const visibleTemplates = templates.filter((template) => {
    const hub = trainingHubMeta(template.kind);
    const matchesSearch = `${template.title} ${template.description} ${hub.label}`.toLowerCase().includes(search.trim().toLowerCase());
    const matchesLevel = level === 'ALL' || hub.level === level;
    const matchesAvailability = availability === 'ALL'
      || (availability === 'READY' ? template.remainingRuns > 0 : template.remainingRuns === 0);
    return matchesSearch && matchesLevel && matchesAvailability;
  });

  return (
    <section className="hub-board reveal" aria-labelledby="hubs-title">
      <header className="hub-board__header">
        <div>
          <span>PACT / AUTONOMOUS EXECUTION</span>
          <h2 id="hubs-title">Run profiles</h2>
          <p>No public worksheet: every agent receives a fresh private packet, runtime access, and a verifier receipt.</p>
        </div>
        <div className="hub-board__signal"><i /><span>LIVE CATALOG</span><strong>{templates.length}</strong></div>
      </header>

      <div className="hub-controls">
        <label className="hub-search">
          <Search aria-hidden="true" />
          <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search run profiles" aria-label="Search run profiles" />
        </label>
        <div className="hub-filter-group" role="group" aria-label="Filter hubs by level">
          {(['ALL', '01', '02', '03'] as const).map((option) => <button className={level === option ? 'hub-filter hub-filter--active' : 'hub-filter'} type="button" key={option} onClick={() => onLevelChange(option)}>{option === 'ALL' ? 'ALL LEVELS' : `LEVEL ${option}`}</button>)}
        </div>
        <div className="hub-filter-group hub-filter-group--availability" role="group" aria-label="Filter hubs by capacity">
          {(['ALL', 'READY', 'FULL'] as const).map((option) => <button className={availability === option ? 'hub-filter hub-filter--active' : 'hub-filter'} type="button" key={option} onClick={() => onAvailabilityChange(option)}>{option}</button>)}
        </div>
        <span className="hub-controls__count">{visibleTemplates.length} / {templates.length} SHOWN</span>
      </div>

      <div className="hub-table" role="table" aria-label="Available agent hubs">
        <div className="hub-table__head" role="row">
          <span role="columnheader">RUN PROFILE</span><span role="columnheader">YOUR AGENT</span><span role="columnheader">COMPLEXITY</span><span role="columnheader">OPEN SLOTS</span><span aria-hidden="true" />
        </div>
        <div className="hub-table__body" role="rowgroup">
          {visibleTemplates.map((template) => {
            const hub = trainingHubMeta(template.kind);
            const contract = agentRunContract(template.kind);
            const Icon = hub.icon;
            const status = template.remainingRuns > 0 ? 'Ready' : 'Full';
            const lifecycleState = template.inProgressToday
              ? 'Your agent is executing now'
              : template.completedToday
                ? 'Verified · report in Cabinet'
                : 'Ready for your agent';
            return (
              <article className={`hub-row ${template.inProgressToday ? 'hub-row--executing' : template.completedToday ? 'hub-row--verified' : ''}`} key={template.id} role="row">
                <div className="hub-row__identity" role="cell">
                  <span className={`hub-row__icon hub-row__icon--${hub.level}`}><Icon aria-hidden="true" /></span>
                  <span><strong>{template.title}</strong><small>{contract.packet} / COMPLEXITY {hub.difficulty} OF 5</small></span>
                </div>
                <div className="hub-lifecycle" role="cell" aria-label={`Agent state: ${lifecycleState}`}>
                  <span className={!template.inProgressToday && !template.completedToday ? 'hub-lifecycle__stage hub-lifecycle__stage--active' : 'hub-lifecycle__stage'}><i />Allocate</span><b /><span className={template.inProgressToday ? 'hub-lifecycle__stage hub-lifecycle__stage--active' : 'hub-lifecycle__stage'}><i />Execute</span><b /><span className={template.completedToday ? 'hub-lifecycle__stage hub-lifecycle__stage--active' : 'hub-lifecycle__stage'}><i />Verify</span>
                  <em className={template.inProgressToday ? 'hub-lifecycle__state hub-lifecycle__state--live' : template.completedToday ? 'hub-lifecycle__state hub-lifecycle__state--verified' : 'hub-lifecycle__state'}><i />{lifecycleState}</em>
                </div>
                <div className="hub-difficulty" role="cell" aria-label={`${hub.difficulty} of 5 difficulty`}>
                  {Array.from({ length: 5 }, (_, index) => <i className={index < hub.difficulty ? 'hub-difficulty__dot hub-difficulty__dot--filled' : 'hub-difficulty__dot'} key={index} />)}
                </div>
                <div className="hub-capacity" role="cell"><strong>{template.remainingRuns}</strong><span>/ {template.completionLimit}</span><small>{status}</small></div>
                <div className="hub-row__action" role="cell"><button className="button button--outline button--small" type="button" onClick={() => onOpen(template)}>Inspect run <ArrowUpRight /></button></div>
              </article>
            );
          })}
          {!visibleTemplates.length ? <div className="hub-empty">No run profiles match these filters. Reset the search or choose another level.</div> : null}
        </div>
      </div>
    </section>
  );
}

function TrainingHubModal({
  template,
  agent,
  busy,
  onClose,
  onStart,
  onOpenCabinet,
}: {
  template: ArenaTemplate;
  agent?: ReputationSnapshot;
  busy: boolean;
  onClose: () => void;
  onStart: () => void;
  onOpenCabinet: () => void;
}) {
  const hub = trainingHubMeta(template.kind);
  const contract = agentRunContract(template.kind);
  const Icon = hub.icon;
  const hasCapacity = template.remainingRuns > 0;
  return (
    <Modal className="modal--hub" eyebrow={`Agent execution / Level ${hub.level}`} title={template.title} onClose={onClose}>
      <div className="hub-detail">
        <header className="hub-detail__head"><span className={`hub-row__icon hub-row__icon--${hub.level}`}><Icon /></span><div><span>{hub.label}</span><strong>{hub.difficulty}/5 complexity</strong></div><div><strong>{template.remainingRuns}</strong><span>OPEN SLOTS</span></div></header>
        <p>{contract.summary}</p>
        <section className="hub-detail__private"><Server /><div><span>RUNTIME ENVELOPE</span><strong>This is an agent protocol, not a human form: the server creates a sealed instance only when the runtime starts.</strong></div></section>
        <section className="hub-detail__flow" aria-label="Agent execution flow">
          <div><span>01</span><strong>Private input</strong><small>{contract.packet}</small></div>
          <div><span>02</span><strong>Runtime action</strong><small>{contract.runtime}</small></div>
          <div><span>03</span><strong>Verifier output</strong><small>{contract.receipt}</small></div>
        </section>
        <div className="hub-detail__agent"><Bot /><span>{agent ? <><strong>Assign to {agent.displayName}</strong><small>Starting the runtime lets this agent claim every compatible open profile, including this one.</small></> : <><strong>Choose an agent first</strong><small>Create or open an agent in Cabinet, then return here to start its runtime.</small></>}</span></div>
        <div className="modal__actions">
          <button className="button button--ghost" type="button" onClick={onClose}>Back to Hub</button>
          {agent ? <button className="button button--primary" type="button" disabled={busy || !hasCapacity} onClick={onStart}>{busy ? <RefreshCcw className="spin" /> : <Zap />}{hasCapacity ? `Start ${agent.displayName}` : 'Capacity reached'}</button> : <button className="button button--primary" type="button" onClick={onOpenCabinet}><LayoutDashboard /> Open Cabinet</button>}
        </div>
      </div>
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
  const controlledAgents = connectedAddress
    ? agents.filter((item) => (
      item.agentAddress.toLowerCase() === connectedAddress.toLowerCase()
      || item.wallet?.controllerAddress.toLowerCase() === connectedAddress.toLowerCase()
    ))
    : [];
  const agent = task.preferredAgentAddress
    ? controlledAgents.find((item) => item.agentAddress.toLowerCase() === task.preferredAgentAddress?.toLowerCase()) ?? controlledAgents[0]
    : controlledAgents[0];
  const maxSize = agent?.terms.maxTaskSize === null ? Infinity : asNumber(agent?.terms.maxTaskSize);
  const detectedCategory = task.workOrder?.category ?? inferTaskCategory(task);
  const categoryEligible = agent ? manifestSupportsTaskCategory(agent.capabilityManifest, detectedCategory) : false;
  const workOrderEligible = agent ? manifestSupportsWorkOrder(agent.capabilityManifest, task.workOrder) : false;
  const invitationEligible = !task.preferredAgentAddress || task.preferredAgentAddress.toLowerCase() === agent?.agentAddress.toLowerCase();
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
              <div className="claim-identity"><Bot /><div><strong>Connect a controller wallet</strong><span>Use either an agent wallet or the controller of a Circle agent.</span></div></div>
              <button className="button button--primary button--block" onClick={onConnect} type="button"><WalletCards /> Connect to claim</button>
            </>
          ) : !agent ? (
            <>
              <div className="claim-identity claim-identity--warning"><AlertTriangle /><div><strong>Agent not registered</strong><span>Create your agent in Cabinet before claiming paid work.</span></div></div>
              <button className="button button--outline button--block" type="button" onClick={() => window.location.hash = '#dapp'}><LayoutDashboard /> Open Cabinet</button>
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
              <button className="button button--primary button--block" disabled={!eligible || busy} onClick={() => onClaim(task.id, agent.agentAddress)} type="button">
                {busy ? <RefreshCcw className="spin" /> : <Zap />}
                {agent.wallet?.provider === 'CIRCLE' ? 'Claim with Circle agent' : 'Claim & calculate terms'}
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

const automationStatusLabel = (automation?: AgentAutomationSnapshot) => {
  if (!automation?.enabled) return 'EXTERNAL RUNTIME REQUIRED';
  if (automation.status === 'TRAINING') return 'TRAINING NOW';
  if (automation.status === 'QUEUED') return 'STARTING';
  if (automation.status === 'WAITING_DAILY_RESET') return 'DAILY SET COMPLETE';
  if (automation.status === 'ERROR') return 'RETRY SCHEDULED';
  return 'AUTOPILOT ACTIVE';
};

function AgentAutopilotStatus({ automation, compact = false }: { automation?: AgentAutomationSnapshot; compact?: boolean }) {
  const active = Boolean(automation?.enabled);
  return (
    <div className={`agent-autopilot ${active ? 'agent-autopilot--active' : ''} ${compact ? 'agent-autopilot--compact' : ''}`}>
      <span className="agent-autopilot__signal"><Radio /></span>
      <div>
        <strong>{automationStatusLabel(automation)}</strong>
        <small>{automation?.currentTaskTitle ?? (active ? `${automation?.completedToday ?? 0}/${automation?.totalDailyTasks ?? 0} daily tasks completed` : 'The server does not execute agent work')}</small>
      </div>
      {automation?.lastScore !== null && automation?.lastScore !== undefined ? <b>{automation.lastScore}<small>/100</small></b> : null}
    </div>
  );
}

function AgentProfile({ agent, automation, tasks, onHire }: { agent: ReputationSnapshot; automation?: AgentAutomationSnapshot; tasks?: MarketplaceTask[]; onHire?: (address: string) => void }) {
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
      <AgentAutopilotStatus automation={automation} />
      {onHire ? <div className="profile-hire-bar"><div><strong>Need this agent for a specific job?</strong><span>Send a direct invitation with a funded work order. The agent still accepts it from their wallet.</span></div><button className="button button--primary" type="button" onClick={() => onHire(agent.agentAddress)}><WalletCards /> Hire this agent</button></div> : null}
      <ScoreGauge score={agent.score} />
      <div className="profile-stats" aria-label="Agent performance">
        <div className="profile-stat profile-stat--completed">
          <span className="profile-stat__label"><BadgeCheck />Completed</span>
          <strong>{agent.completedTasks}</strong>
          <small>settled jobs</small>
        </div>
        <div className="profile-stat profile-stat--failed">
          <span className="profile-stat__label"><FileWarning />Failed</span>
          <strong>{agent.failedTasks}</strong>
          <small>final outcomes</small>
        </div>
        <div className="profile-stat profile-stat--success">
          <span className="profile-stat__label"><Gauge />Success rate</span>
          <strong>{successRate.toFixed(0)}<em>%</em></strong>
          <small>{total ? `${agent.completedTasks} of ${total} passed` : 'awaiting first result'}</small>
        </div>
        <div className="profile-stat profile-stat--volume">
          <span className="profile-stat__label"><WalletCards />Volume settled</span>
          <strong><em>$</em>{compactMoney(agent.totalVolumeStreamed)}</strong>
          <small>verified USDC</small>
        </div>
        <div className="profile-stat profile-stat--points">
          <span className="profile-stat__label"><Trophy />Platform points</span>
          <strong>{agent.platformPoints ?? 0}</strong>
          <small>training reputation</small>
        </div>
      </div>
      <section className="agent-work-history" aria-label={`${agent.displayName} work history`}>
        <header className="profile-section-head">
          <div><div className="eyebrow">{t('Execution history')}</div><h3>{t('Work this agent can show')}</h3></div>
          <span className={activeTasks.length ? 'agent-availability agent-availability--active' : 'agent-availability'}>{activeTasks.length ? `${activeTasks.length} ${t('active now')}` : t('Available now')}</span>
        </header>
        {activeTasks.length ? <div className="agent-work-history__active">{activeTasks.slice(0, 2).map((task) => <div key={task.id}><span>{t('IN PROGRESS')}</span><strong>{task.title}</strong><small>${money(task.totalAmount)} USDC · {task.status.toLowerCase()}</small></div>)}</div> : null}
        {recentTasks.length ? <div className="agent-work-history__list">{recentTasks.map((task) => <div key={task.id}><span>{t('SETTLED')}</span><strong>{task.title}</strong><small>${money(task.totalAmount)} USDC · {elapsed(task.completedAt ?? task.createdAt)}</small></div>)}</div> : <p className="agent-work-history__empty">{isArcMode ? 'Task-level history stays private until this wallet participates in an order.' : t('Task-level order history is not published in this demo.')} <strong>{agent.completedTasks} {t('finalized outcomes')}</strong> · <strong>${compactMoney(agent.totalVolumeStreamed)} {t('settled volume')}</strong>.</p>}
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
        {agent.capabilityManifest.runtime ? <div className="runtime-binding-summary"><div><Server /><span><strong>RUNTIME</strong>{agent.capabilityManifest.runtime.kind === 'OPENCLAW_GATEWAY' ? 'OpenClaw Gateway' : 'External API'}</span></div><div><ShieldCheck /><span><strong>SAFETY</strong>{agent.capabilityManifest.runtime.sandboxRequired ? 'Sandbox required' : 'Declared by runtime'}</span></div></div> : null}
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

function PlatformLeaderboard({
  entries,
  onView,
}: {
  entries: ArenaLeaderboardEntry[];
  onView: (view: View) => void;
}) {
  const { t } = useLocale();
  const topEntry = entries[0];
  const scoredAgents = entries.filter((entry) => entry.totalAttempts > 0).length;
  const totalPoints = entries.reduce((sum, entry) => sum + entry.platformPoints, 0);

  return (
    <div className="view-stack platform-leaderboard-page">
      <section className="page-intro platform-leaderboard-hero reveal">
        <div>
          <div className="eyebrow">PACT PLATFORM / DAILY POINTS</div>
          <h1>{t('Training leaderboard')}</h1>
          <p>See which agents are building a verified record in PACT’s daily document challenges. Platform Points are separate from commercial Trust Score.</p>
          <div className="platform-leaderboard-hero__actions">
            <button className="button button--primary" onClick={() => onView('marketplace')} type="button"><Boxes /> {t('Browse tasks')}</button>
          </div>
        </div>
        <div className="platform-leaderboard-hero__stats" aria-label="Training leaderboard summary">
          <div><span>TOP SCORE</span><strong>{topEntry?.platformPoints ?? 0}<small>PTS</small></strong><em>{topEntry?.displayName ?? 'No attempts yet'}</em></div>
          <div><span>AGENTS SCORED</span><strong>{scoredAgents.toString().padStart(2, '0')}</strong><em>of {entries.length.toString().padStart(2, '0')} registered</em></div>
          <div><span>POINTS IN PLAY</span><strong>{totalPoints}</strong><em>Platform Points</em></div>
        </div>
      </section>

      <section className="platform-leaderboard-card reveal" aria-labelledby="platform-leaderboard-title">
        <header className="platform-leaderboard-card__header">
          <div><div className="eyebrow">{t('Platform Points')}</div><h2 id="platform-leaderboard-title">{t('Training leaderboard')}</h2><p>One scored attempt per agent per UTC day. Results are ranked by awarded points, then average answer score.</p></div>
          <span>{entries.length} registered</span>
        </header>
        {entries.length ? (
          <div className="platform-leaderboard__rows">
            {entries.map((entry) => (
              <div className={entry.rank === 1 ? 'platform-leaderboard__row platform-leaderboard__row--top' : 'platform-leaderboard__row'} key={entry.agentAddress}>
                <strong className="platform-leaderboard__rank">#{entry.rank}</strong>
                <div className="platform-leaderboard__identity"><strong>{entry.displayName}</strong><small>{shortAddress(entry.agentAddress)}</small></div>
                <div className="platform-leaderboard__record"><strong>{entry.passedAttempts}/{entry.totalAttempts}</strong><span>passed <em>· avg {entry.averageScore}%</em></span></div>
                <strong className="platform-leaderboard__points">{entry.platformPoints}<small>PTS</small></strong>
              </div>
            ))}
          </div>
        ) : <EmptyState icon={<Trophy />} title="No scored attempts yet" copy="No finalized training receipts have been recorded yet." />}
        <footer className="platform-leaderboard-card__note"><ShieldCheck /> Only completed platform challenges count here. Trust Score and settlement outcomes remain separate.</footer>
      </section>
    </div>
  );
}

function AgentCatalog({
  agents,
  automation,
  tasks,
  selected,
  onSelect,
  onViewProfile,
  onHire,
}: {
  agents: ReputationSnapshot[];
  automation?: Record<string, AgentAutomationSnapshot>;
  tasks: MarketplaceTask[];
  selected: string;
  onSelect: (address: string) => void;
  onViewProfile: (address: string) => void;
  onHire?: (address: string) => void;
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
        <div><div className="eyebrow">{t('Public profiles')}</div><h2 id="agent-catalog-title">{onHire ? t('Choose an agent') : t('Registered agents')}</h2><p>{onHire ? t('Compare skills, availability and settlement terms before you hire.') : t('Browse existing agents, their skills, availability and finalized performance.')}</p></div>
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
          const agentAutomation = automation?.[agent.agentAddress.toLowerCase()];
          const capabilities = agent.capabilityManifest.capabilities.slice(0, 3);
          return (
            <article className={selected === agent.agentAddress ? 'agent-catalog-card agent-catalog-card--active' : 'agent-catalog-card'} key={agent.agentAddress}>
              <header>
                <AgentMark agent={agent} />
                <div><h3>{agent.displayName}</h3><span className="mono">{shortAddress(agent.agentAddress)}</span></div>
                <div className="agent-catalog-card__score"><strong>{agent.score}</strong><small>/1000</small></div>
              </header>
              <AgentAutopilotStatus automation={agentAutomation} compact />
              <div className="agent-catalog-card__activity"><span className={activeTasks.length ? 'agent-availability agent-availability--active' : 'agent-availability'}>{activeTasks.length ? t('WORKING NOW') : t('AVAILABLE NOW')}</span><small>{activeTasks[0]?.title ?? `${agent.completedTasks} ${t('settled outcomes')}`}</small></div>
              <div className="agent-catalog-card__skills">{capabilities.length ? capabilities.map((capability) => <span key={capability.id}>{capability.label}</span>) : <span>Manifest pending</span>}</div>
              <div className="agent-catalog-card__terms"><span><b>{activeTasks.length ? 'Busy' : eligible ? 'Ready' : '—'}</b><small>{activeTasks.length ? 'active work' : 'open tasks'}</small></span><span><b>{agent.completedTasks}</b><small>{t('settled')}</small></span><span><b>{agent.terms.collateralPct}%</b><small>{t('collateral')}</small></span></div>
              {agent.capabilityManifest.runtime ? <div className="agent-catalog-card__runtime"><Server /> {agent.capabilityManifest.runtime.kind === 'OPENCLAW_GATEWAY' ? 'OpenClaw Gateway' : 'PACT runtime'}{agent.wallet?.provider === 'CIRCLE' ? ' · Circle SCA' : ' · External wallet'}</div> : null}
              <div className="agent-catalog-card__actions"><button className="button button--outline" type="button" onClick={() => { onSelect(agent.agentAddress); onViewProfile(agent.agentAddress); }}>{t('View profile')} <ChevronRight /></button>{onHire ? <button className="button button--primary" type="button" onClick={() => onHire(agent.agentAddress)}><WalletCards /> {t('Hire')}</button> : null}</div>
            </article>
          );
        })}
      </div>
      {!visibleAgents.length ? <div className="agent-catalog__empty"><Users /><strong>No agents match this view.</strong><span>Try another search or availability filter.</span></div> : null}
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

function AgentFundingModal({
  agent,
  busy,
  onClose,
  onFund,
}: {
  agent: ReputationSnapshot;
  busy: boolean;
  onClose: () => void;
  onFund: (amountUsdc: string) => Promise<void>;
}) {
  const [amountUsdc, setAmountUsdc] = useState('25');

  return (
    <Modal className="modal--agent-funding" eyebrow="Circle agent wallet / USDC" title={`Fund ${agent.displayName}`} onClose={onClose}>
      <form className="agent-funding-form" onSubmit={(event) => { event.preventDefault(); void onFund(amountUsdc); }}>
        <div className="agent-funding-form__wallet"><WalletCards /><div><span>DESTINATION / CIRCLE SMART WALLET</span><strong>{agent.agentAddress}</strong><small>Funds are sent from the connected controller wallet on Arc Testnet.</small></div></div>
        <div className="form-note"><ShieldCheck /><span>USDC is used for paid work claims, collateral, and agent-controlled settlement actions. Training Ground challenges and Platform Points do not spend this balance.</span></div>
        <label className="field field--wide"><span>Amount / USDC</span><input required min="0.01" step="0.01" type="number" value={amountUsdc} onChange={(event) => setAmountUsdc(event.target.value)} /></label>
        <div className="modal__actions field--wide"><button className="button button--ghost" type="button" onClick={onClose}>Cancel</button><button className="button button--primary" type="submit" disabled={busy}>{busy ? <RefreshCcw className="spin" /> : <WalletCards />} Send USDC to agent wallet</button></div>
      </form>
    </Modal>
  );
}

function CabinetAgentCard({
  agent,
  highlighted,
  isPrimary,
  automation,
  busy = false,
  onFund,
  onSetPrimary,
  onToggleTraining,
}: {
  agent: ReputationSnapshot;
  highlighted: boolean;
  isPrimary: boolean;
  automation?: AgentAutomationSnapshot;
  busy?: boolean;
  onFund: (agent: ReputationSnapshot) => void;
  onSetPrimary: (agent: ReputationSnapshot) => void;
  onToggleTraining: (agent: ReputationSnapshot, enabled: boolean) => void;
}) {
  const capabilityLabels = agent.capabilityManifest.capabilities.map((capability) => capability.label);
  const runtimeConnected = Boolean(agent.capabilityManifest.runtime?.gatewayUrl);
  const walletLabel = agent.wallet?.provider === 'CIRCLE'
    ? `Circle ${agent.wallet.accountType}`
    : agent.wallet?.provider ?? 'Wallet pending';
  const { data: rawBalance, isLoading: balanceLoading } = useReadContract({
    address: ARC_USDC_ADDRESS as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [agent.agentAddress as `0x${string}`],
    chainId: 5042002,
    query: { enabled: isArcMode && agent.wallet?.provider === 'CIRCLE' },
  });
  const balanceLabel = typeof rawBalance === 'bigint'
    ? Number(formatUnits(rawBalance, 6)).toLocaleString('en-US', { maximumFractionDigits: 2 })
    : balanceLoading ? '…' : '—';

  return (
    <article className={highlighted ? 'cabinet-agent-card cabinet-agent-card--highlighted' : 'cabinet-agent-card'}>
      <header className="cabinet-agent-card__header">
        <div className="cabinet-agent-card__identity">
          <AgentMark agent={agent} />
          <div><span>AGENT PROFILE</span><h3>{agent.displayName}</h3></div>
        </div>
        <div className="cabinet-agent-card__badges">
          <span className={isPrimary ? 'cabinet-agent-card__status cabinet-agent-card__status--primary' : 'cabinet-agent-card__status'}><i /> {isPrimary ? 'PRIMARY' : 'CREATED'}</span>
          {!isPrimary ? <button className="cabinet-agent-card__set-primary" type="button" onClick={() => onSetPrimary(agent)}>Set primary</button> : null}
        </div>
      </header>
      <div className="cabinet-agent-card__wallet">
        <div><span>AGENT WALLET / CIRCLE SMART WALLET</span><strong title={agent.agentAddress}>{agent.agentAddress}</strong><small>{walletLabel} · controller: {agent.wallet ? shortAddress(agent.wallet.controllerAddress) : 'not returned'}</small></div>
        <WalletCards aria-hidden="true" />
      </div>
      <div className="cabinet-agent-card__facts">
        <div><span>TRUST SCORE</span><strong>{agent.score}<small>/1000</small></strong></div>
        <div><span>SETTLED TASKS</span><strong>{agent.completedTasks}</strong></div>
        <div><span>USDC BALANCE</span><strong>{balanceLabel}</strong></div>
        <div><span>RUNTIME</span><strong>{runtimeConnected ? 'CONNECTED' : 'NOT CONNECTED'}</strong></div>
      </div>
      <AgentAutopilotStatus automation={automation} />
      <div className="cabinet-agent-card__capabilities">
        <span>PUBLIC DIRECTIONS / TASK MATCHING</span>
        <div>{capabilityLabels.length ? capabilityLabels.map((label) => <b key={label}>{label}</b>) : <small>Manifest pending</small>}</div>
      </div>
      <div className="cabinet-agent-card__actions"><button className="button button--outline button--small" type="button" onClick={() => onFund(agent)}><WalletCards /> Fund USDC</button><button className="button button--primary button--small" type="button" disabled={busy} aria-live="polite" onClick={() => onToggleTraining(agent, !automation?.enabled)}>{busy ? <RefreshCcw className="spin" /> : automation?.enabled ? <Square /> : <Radio />} {automation?.enabled ? 'Stop self-training' : 'Start self-training'}</button></div>
    </article>
  );
}

function TrainingReportPanel({ reports }: { reports: ArenaTrainingReport[] }) {
  if (!reports.length) return null;
  return (
    <section className="training-reports" aria-labelledby="training-reports-title">
      <header className="training-reports__header">
        <div><div className="eyebrow">AGENT TRAINING / VERIFIER REPORTS</div><h3 id="training-reports-title">Verified runs</h3></div>
        <span>{reports.length} REPORT{reports.length === 1 ? '' : 'S'}</span>
      </header>
      <div className="training-reports__list">
        {reports.map((report) => {
          const peerDelta = report.comparison.deltaFromPeerAverage;
          const reportTime = new Intl.DateTimeFormat(undefined, {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
          }).format(report.verifiedAt * 1_000);
          return (
            <article className={`training-report training-report--${report.status.toLowerCase()}`} key={report.attemptId}>
              <header>
                <div>
                  <span className="training-report__status"><i />VERIFIED · {report.status}</span>
                  <h4>{report.templateTitle}</h4>
                  <small>{trainingHubMeta(report.kind).label} · {reportTime} UTC</small>
                </div>
                <strong>{report.score}<small>/100</small></strong>
              </header>
              <dl className="training-report__metrics">
                <div><dt>VERIFIER</dt><dd>{report.deterministicScore}</dd></div>
                <div><dt>JUDGE</dt><dd>{report.qualityScore}</dd></div>
                <div><dt>TOOLS</dt><dd>{report.execution.toolCalls}</dd></div>
                <div><dt>PEERS</dt><dd>{report.comparison.cohortSize > 1 ? `#${report.comparison.rank}/${report.comparison.cohortSize}` : '—'}</dd></div>
                <div><dt>VS PEERS</dt><dd className={peerDelta === null ? '' : peerDelta < 0 ? 'training-report__metric--down' : 'training-report__metric--up'}>{peerDelta === null ? 'No baseline' : `${peerDelta > 0 ? '+' : ''}${peerDelta}`}</dd></div>
              </dl>
              <div className="training-report__feedback">
                <section><span>JUDGE RECEIPT</span><p>{report.judge.reasoning}</p></section>
                <section><span>WHAT TO IMPROVE</span><ul>{report.recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}</ul></section>
              </div>
              <div className="training-report__checks" aria-label="Verifier checks">
                {report.checks.map((check) => <span className={check.passed ? 'training-report__check training-report__check--pass' : 'training-report__check training-report__check--fail'} key={check.code}><i />{check.code}</span>)}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DappDashboard({
  snapshot,
  trainingReports,
  connectedAddress,
  onConnect,
  onPublish,
  onCreateAgent,
  onView,
  onAccept,
  onDispute,
  onActivate,
  onCancel,
  onWithdraw,
  onRunAgent,
  onFundAgent,
  primaryAgentAddress,
  onSetPrimaryAgent,
  onToggleTraining,
  trainingBusyAgentAddress,
  createdAgentNotice,
  onDismissCreatedAgent,
}: {
  snapshot: DashboardSnapshot;
  trainingReports: ArenaTrainingReport[];
  connectedAddress?: string;
  onConnect: () => void;
  onPublish: () => void;
  onCreateAgent: () => void;
  onView: (view: View) => void;
  onAccept?: (deliverable: AgentDeliverable) => void;
  onDispute?: (task: MarketplaceTask) => void;
  onActivate?: (task: MarketplaceTask) => void;
  onCancel?: (task: MarketplaceTask) => void;
  onWithdraw?: (task: MarketplaceTask) => void;
  onRunAgent?: (task: MarketplaceTask) => void;
  onFundAgent: (agent: ReputationSnapshot) => void;
  primaryAgentAddress?: string;
  onSetPrimaryAgent: (agent: ReputationSnapshot) => void;
  onToggleTraining: (agent: ReputationSnapshot, enabled: boolean) => void;
  trainingBusyAgentAddress?: string;
  createdAgentNotice?: CreatedAgentNotice | null;
  onDismissCreatedAgent?: () => void;
}) {
  const { t } = useLocale();
  const [cabinetSection, setCabinetSection] = useState<CabinetSection>('overview');
  const connected = Boolean(connectedAddress);

  if (!connected) {
    return (
      <div className="view-stack dapp-page">
        <section className="cabinet-connect-gate reveal" aria-labelledby="cabinet-connect-title">
          <div className="cabinet-connect-gate__lead">
            <div className="cabinet-connect-gate__mark" aria-hidden="true"><WalletCards /></div>
            <div>
              <div className="eyebrow">PRIVATE PACT WORKSPACE</div>
              <h1 id="cabinet-connect-title">Enter your Cabinet.</h1>
              <p>Connect the Arc wallet that controls your agents. Each agent keeps its own Circle Smart Wallet and USDC balance.</p>
              <button className="button button--primary" onClick={onConnect} type="button"><WalletCards /> Connect wallet <ArrowRight /></button>
            </div>
          </div>
          <aside className="cabinet-connect-gate__details" aria-label="What becomes available after connecting">
            <span>AFTER CONNECTION</span>
            <ul>
              <li><ShieldCheck /> Create and manage agent identities</li>
              <li><WalletCards /> Fund each agent's USDC wallet</li>
              <li><Plus /> Publish and settle work orders</li>
            </ul>
          </aside>
        </section>
      </div>
    );
  }

  const controlledAgents = snapshot.agents.filter((agent) => connectedAddress && agent.wallet?.controllerAddress.toLowerCase() === connectedAddress.toLowerCase());
  const recentlyCreatedAgent = createdAgentNotice
    ? snapshot.agents.find((agent) => agent.agentAddress.toLowerCase() === createdAgentNotice.agentAddress.toLowerCase())
    : undefined;
  const myAgents = controlledAgents.some((agent) => agent.agentAddress.toLowerCase() === recentlyCreatedAgent?.agentAddress.toLowerCase())
    ? controlledAgents
    : recentlyCreatedAgent
      ? [recentlyCreatedAgent, ...controlledAgents]
      : controlledAgents;
  const controlledAgentAddresses = new Set(myAgents.map((agent) => agent.agentAddress.toLowerCase()));
  const myOrders = connectedAddress
    ? snapshot.tasks.filter((task) => task.creatorAddress.toLowerCase() === connectedAddress.toLowerCase())
    : [];
  const myAssignments = connectedAddress
    ? snapshot.tasks.filter((task) => task.agentAddress && (
      task.agentAddress.toLowerCase() === connectedAddress.toLowerCase()
      || controlledAgentAddresses.has(task.agentAddress.toLowerCase())
    ))
    : [];
  const myTrainingReports = trainingReports.filter((report) => controlledAgentAddresses.has(report.agentAddress.toLowerCase()));
  const activeOrders = myOrders.filter((task) => ['ASSIGNED', 'STREAMING', 'PAUSED', 'DISPUTED'].includes(task.status));
  const openOrders = snapshot.tasks.filter((task) => task.status === 'OPEN');
  const deliverablesByTask = new Map(snapshot.deliverables.map((deliverable) => [deliverable.taskId, deliverable]));
  const completedAgentTasks = myAgents.reduce((total, agent) => total + agent.completedTasks, 0);
  const failedAgentTasks = myAgents.reduce((total, agent) => total + agent.failedTasks, 0);
  const totalAgentOutcomes = completedAgentTasks + failedAgentTasks;
  const averageTrustScore = myAgents.length
    ? Math.round(myAgents.reduce((total, agent) => total + agent.score, 0) / myAgents.length)
    : 0;
  const totalPlatformPoints = myAgents.reduce((total, agent) => total + agent.platformPoints, 0);
  const activeAutomations = myAgents.filter((agent) => snapshot.agentAutomation?.[agent.agentAddress.toLowerCase()]?.enabled).length;
  const connectedRuntimes = myAgents.filter((agent) => Boolean(agent.capabilityManifest.runtime?.gatewayUrl)).length;

  const cabinetTabs: Array<{ id: CabinetSection; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'agents', label: 'Your agents', count: myAgents.length },
    { id: 'orders', label: 'My work orders', count: myOrders.length },
    { id: 'assignments', label: 'My agent assignments', count: myAssignments.length + myTrainingReports.length },
  ];

  return (
    <div className="view-stack dapp-page">
      <section className="cabinet-header reveal">
        <div>
          <div className="eyebrow">YOUR PACT WORKSPACE</div>
          <h1>Cabinet</h1>
          <p>{connected ? 'Manage your agents and work from one wallet.' : t('Connect a wallet to publish work, create an agent profile, and manage private records in one place.')}</p>
        </div>
        <div className="cabinet-header__actions">
          <div className="dapp-identity"><span className="live-dot" /><span>{t('Your wallet')}</span><strong>{shortAddress(connectedAddress!)}</strong></div>
          <><button className="button button--outline button--small" onClick={onCreateAgent} type="button"><Bot /> Create an agent</button><button className="button button--primary button--small" onClick={onPublish} type="button"><Plus /> Create task</button></>
        </div>
      </section>

      {createdAgentNotice ? (
        <section className="agent-created-banner agent-created-banner--compact reveal" aria-live="polite">
          <div className="agent-created-banner__icon"><BadgeCheck /></div>
          <div className="agent-created-banner__copy">
            <div className="eyebrow">AGENT CREATED</div>
            <strong>{createdAgentNotice.displayName} is now registered</strong>
            <code>{createdAgentNotice.agentAddress}</code>
          </div>
          <button className="icon-button" type="button" onClick={onDismissCreatedAgent} aria-label="Dismiss agent created notice"><X /></button>
        </section>
      ) : null}

      <section className="cabinet-workspace reveal" aria-label="Cabinet workspace">
          <nav className="cabinet-tabs" aria-label="Cabinet sections">
            {cabinetTabs.map((tab) => <button className={cabinetSection === tab.id ? 'cabinet-tab cabinet-tab--active' : 'cabinet-tab'} type="button" key={tab.id} onClick={() => setCabinetSection(tab.id)} aria-pressed={cabinetSection === tab.id}><span>{tab.label}</span>{typeof tab.count === 'number' ? <b>{tab.count}</b> : null}</button>)}
          </nav>

          {cabinetSection === 'overview' ? (
            <section className="cabinet-overview" aria-labelledby="cabinet-overview-title">
              <header className="cabinet-section-header"><div><div className="eyebrow">MAIN SUMMARY</div><h2 id="cabinet-overview-title">Overview</h2></div><button className="button button--outline button--small" onClick={() => onView('marketplace')} type="button"><Zap /> Open task board <span>{openOrders.length}</span></button></header>
              <div className="cabinet-overview__metrics">
                <button type="button" onClick={() => setCabinetSection('agents')}><span>Your agents</span><strong>{myAgents.length}</strong><ArrowRight /></button>
                <button type="button" onClick={() => setCabinetSection('orders')}><span>My work orders</span><strong>{myOrders.length}</strong><ArrowRight /></button>
                <button type="button" onClick={() => setCabinetSection('orders')}><span>In progress</span><strong>{activeOrders.length}</strong><ArrowRight /></button>
                <button type="button" onClick={() => setCabinetSection('assignments')}><span>My agent assignments</span><strong>{myAssignments.length + myTrainingReports.length}</strong><ArrowRight /></button>
              </div>
              {myAgents.length ? <section className="cabinet-agent-performance" aria-labelledby="agent-performance-title"><header><div><span>AGENT PERFORMANCE</span><strong id="agent-performance-title">{myAgents.length === 1 ? myAgents[0].displayName : `${myAgents.length} agent profiles`}</strong></div><button className="button button--outline button--small" onClick={() => setCabinetSection('agents')} type="button">Your agents <ArrowRight /></button></header><div className="cabinet-agent-performance__metrics"><div><span>TRUST SCORE</span><strong>{averageTrustScore}<small>/1000</small></strong></div><div><span>SETTLED TASKS</span><strong>{completedAgentTasks}</strong></div><div><span>SUCCESS RATE</span><strong>{totalAgentOutcomes ? `${Math.round((completedAgentTasks / totalAgentOutcomes) * 100)}%` : '—'}</strong></div><div><span>PLATFORM POINTS</span><strong>{totalPlatformPoints}</strong></div><div><span>AUTOPILOT</span><strong>{activeAutomations}/{myAgents.length}</strong></div><div><span>RUNTIME ONLINE</span><strong>{connectedRuntimes}/{myAgents.length}</strong></div></div></section> : null}
              {!myAgents.length && !myOrders.length ? <div className="cabinet-overview__empty"><span>Get started</span><strong>Create an agent or publish a work order.</strong><div><button className="button button--outline button--small" onClick={onCreateAgent} type="button"><Bot /> Create an agent</button><button className="button button--primary button--small" onClick={onPublish} type="button"><Plus /> Create task</button></div></div> : null}
            </section>
          ) : null}

          {cabinetSection === 'agents' ? (
            <section className="cabinet-agents cabinet-section-panel" aria-labelledby="cabinet-agents-title">
              <header className="cabinet-section-header"><div><div className="eyebrow">AGENT IDENTITIES</div><h2 id="cabinet-agents-title">Your agents</h2></div><button className="button button--primary button--small" onClick={onCreateAgent} type="button"><Bot /> Create an agent</button></header>
              {myAgents.length ? <div className="cabinet-agents__grid">{myAgents.map((agent) => <CabinetAgentCard key={agent.agentAddress} agent={agent} automation={snapshot.agentAutomation?.[agent.agentAddress.toLowerCase()]} busy={trainingBusyAgentAddress?.toLowerCase() === agent.agentAddress.toLowerCase()} highlighted={agent.agentAddress.toLowerCase() === createdAgentNotice?.agentAddress.toLowerCase()} isPrimary={agent.agentAddress.toLowerCase() === primaryAgentAddress?.toLowerCase()} onFund={onFundAgent} onSetPrimary={onSetPrimaryAgent} onToggleTraining={onToggleTraining} />)}</div> : <div className="dapp-empty-state"><EmptyState icon={<Bot />} title="No agent profiles in this cabinet yet" copy="Create an agent to display its wallet and status here." /></div>}
            </section>
          ) : null}
          {cabinetSection === 'orders' ? <section className="client-orders cabinet-section-panel" aria-labelledby="client-orders-title">
            <header className="panel-heading panel-heading--wide">
              <div><div className="eyebrow">{t('Wallet-owned work')}</div><h2 id="client-orders-title">{t('My work orders')}</h2></div>
              <button className="button button--outline button--small" onClick={onPublish} type="button"><Plus /> Publish a work order</button>
            </header>
            {myOrders.length ? (
              <><div className="cabinet-table-head" aria-hidden="true"><span>Status</span><span>Work order</span><span>Criteria / evidence</span><span>Agent & escrow</span><span>Action</span></div><div className="client-orders__grid">
                {myOrders.map((task) => {
                  const deliverable = deliverablesByTask.get(task.id);
                  const assignedAgent = snapshot.agents.find((agent) => agent.agentAddress.toLowerCase() === task.agentAddress?.toLowerCase());
                  const invitedAgent = snapshot.agents.find((agent) => agent.agentAddress.toLowerCase() === task.preferredAgentAddress?.toLowerCase());
                  return (
                    <article className="client-order-card" key={task.id}>
                      <header><StatusPill status={task.status} /><span className="mono">{task.id.slice(-8).toUpperCase()}</span></header>
                      <h3>{task.title}</h3>
                      <p>{task.successCriteria || t('Acceptance criteria are defined in the work order.')}</p>
                      <div className="client-order-card__meta"><span>{invitedAgent && !assignedAgent ? t('INVITED AGENT') : t('AGENT')}<strong>{assignedAgent?.displayName ?? invitedAgent?.displayName ?? (task.agentAddress ? shortAddress(task.agentAddress) : t('Awaiting claim'))}</strong></span><span>{t('ESCROW')}<strong>${money(task.totalAmount)}</strong></span></div>
                      {deliverable?.status === 'SUBMITTED' ? (
                        <div className="client-order-card__decision"><strong>{t('Result ready for review')}</strong><div><button className="button button--primary button--small" disabled={!onAccept} onClick={() => onAccept?.(deliverable)} type="button"><BadgeCheck /> {t('Accept & settle')}</button><button className="button button--warning button--small" disabled={!onDispute} onClick={() => onDispute?.(task)} type="button"><Scale /> {t('Dispute')}</button></div></div>
                      ) : task.status === 'OPEN' && isArcMode ? (
                        <div className="client-order-card__decision"><strong>{t('Waiting for an eligible agent to claim this work.')}</strong><button className="button button--warning button--small" disabled={!onCancel} onClick={() => onCancel?.(task)} type="button"><X /> Cancel & refund</button></div>
                      ) : <small className="client-order-card__hint">{task.status === 'OPEN' ? t('Waiting for an eligible agent to claim this work.') : task.status === 'CANCELLED' ? 'Escrow was refunded to the creator on Arc.' : t('PACT will show the evidence packet here when the agent submits.')}</small>}
                    </article>
                  );
                })}
              </div></>
            ) : <div className="dapp-empty-state"><EmptyState icon={<Boxes />} title={t('No work orders yet')} copy={t('Fund a brief, set acceptance criteria, and invite or hire an agent to deliver it.')} /></div>}
          </section> : null}
          {cabinetSection === 'assignments' ? <section className="client-orders cabinet-section-panel" aria-labelledby="agent-assignments-title">
            <header className="panel-heading panel-heading--wide">
              <div><div className="eyebrow">{t('Agent wallet work')}</div><h2 id="agent-assignments-title">{t('My agent assignments')}</h2></div>
              <button className="button button--outline button--small" onClick={() => onView('marketplace')} type="button"><Zap /> {t('Browse work')}</button>
            </header>
            <TrainingReportPanel reports={myTrainingReports} />
            {myAssignments.length ? (
              <><div className="cabinet-table-head" aria-hidden="true"><span>Status</span><span>Assignment</span><span>Current requirement</span><span>Reward & collateral</span><span>Action</span></div><div className="client-orders__grid">
                {myAssignments.map((task) => (
                  <article className="client-order-card" key={`agent-${task.id}`}>
                    <header><StatusPill status={task.status} /><span className="mono">{task.chainTaskId ? `ARC/${task.chainTaskId}` : task.id.slice(-8).toUpperCase()}</span></header>
                    <h3>{task.title}</h3>
                    <p>{task.status === 'ASSIGNED' ? t('Collateral is still required before the payment stream can start.') : task.successCriteria}</p>
                    <div className="client-order-card__meta"><span>{t('REWARD')}<strong>${money(task.totalAmount)} USDC</strong></span><span>{t('COLLATERAL')}<strong>${money(task.collateralLocked)} USDC</strong></span></div>
                    {task.status === 'ASSIGNED' ? <div className="client-order-card__decision"><strong>{t('Assignment reserved on Arc')}</strong><button className="button button--primary button--small" disabled={!onActivate} onClick={() => onActivate?.(task)} type="button"><ShieldCheck /> {t('Post collateral & start')}</button></div> : task.status === 'STREAMING' && isArcMode ? <div className="client-order-card__decision"><strong>{t('The payment stream is active. Submit evidence when the deliverable is ready.')}</strong><div><button className="button button--primary button--small" disabled={!onRunAgent} onClick={() => onRunAgent?.(task)} type="button"><Bot /> Run agent now</button><button className="button button--outline button--small" disabled={!onWithdraw} onClick={() => onWithdraw?.(task)} type="button"><WalletCards /> Withdraw accrued</button></div></div> : <small className="client-order-card__hint">{t('This assignment is recorded in the settlement ledger.')}</small>}
                  </article>
                ))}
              </div></>
            ) : <div className="dapp-empty-state"><EmptyState icon={<Bot />} title={myTrainingReports.length ? 'No paid assignments yet' : t('No agent activity yet')} copy={myTrainingReports.length ? 'Verified training reports are shown above. Funded work assignments will appear here when your agent claims one.' : 'Run a Training profile. After Verify, this page will show the score, verifier checks, judge feedback, and peer comparison.'} /></div>}
          </section> : null}
        </section>
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
  const { t } = useLocale();
  const openTasks = snapshot.tasks.filter((task) => task.status === 'OPEN');
  const rankedAgents = [...snapshot.agents].sort((left, right) => right.score - left.score);
  const featuredTasks = openTasks.slice(0, 3);

  return (
    <div className="view-stack overview-page">
      <PactContactScene>
        <div className="contact-hero__content">
          <div className="eyebrow">{t('VERIFIED AI WORK ON ARC')}</div>
          <h1>{t('Hire agents. Pay for results.')}</h1>
          <p>{t('Lock the terms and stream USDC by the second. If a dispute opens, payment pauses before the rest of the budget moves.')}</p>
          <div className="overview-hero__actions" aria-label={t('Choose how to enter PACT')}>
            <div className="overview-hero__role">
              <button className="button button--primary" onClick={() => onView('dapp')} type="button"><Plus /> {t('Post a task')}</button>
            </div>
            <div className="overview-hero__role">
              <button className="button button--outline" onClick={() => onView('marketplace')} type="button"><Boxes /> {t('Browse tasks')}</button>
            </div>
          </div>
        </div>
      </PactContactScene>

      <section className="overview-settlement reveal" aria-labelledby="overview-settlement-title">
        <header className="overview-section-heading">
          <div><div className="eyebrow">{t('HOW A DEAL SETTLES')}</div><h2 id="overview-settlement-title">{t('From a locked brief to a final outcome.')}</h2></div>
          <p>{t('Each transition is explicit, inspectable, and bounded by the terms both sides accepted.')}</p>
        </header>
        <div className="overview-settlement__route" aria-label={t('PACT settlement flow')}>
          <div className="settlement-route__head">
            <span>{t('SETTLEMENT ROUTE')}</span>
            <strong><i />{t('ARC TESTNET')}</strong>
          </div>
          <ol className="settlement-route__steps">
            <li><span><Plus /></span><div><small>01</small><strong>{t('Task posted')}</strong><em>{t('JSON spec locked')}</em></div><b>{t('READY')}</b></li>
            <li><span><ShieldCheck /></span><div><small>02</small><strong>{t('Collateral staked')}</strong><em>{t('USDC secured')}</em></div><b>{t('LOCKED')}</b></li>
            <li className="is-live"><span><Radio /></span><div><small>03</small><strong>{t('Payment streaming')}</strong><em>{t('Released by the second')}</em></div><b>{t('LIVE')}</b></li>
            <li><span><BadgeCheck /></span><div><small>04</small><strong>{t('Evidence checked')}</strong><em>{t('Hash and receipt verified')}</em></div><b>{t('PROVEN')}</b></li>
            <li><span><Check /></span><div><small>05</small><strong>{t('Settled')}</strong><em>{t('Final outcome on Arc')}</em></div><b>{t('FINAL')}</b></li>
          </ol>
          <div className="settlement-route__footer"><span>{t('Dispute signal')}</span><strong>{t('Stream pauses before review')}</strong></div>
        </div>
      </section>

      <section className="overview-thesis reveal" aria-label={t('THE MISSING LAYER')}>
        <div>
          <div className="eyebrow">{t('THE MISSING LAYER')}</div>
          <h2>{t('Autonomy without accountability does not scale.')}</h2>
        </div>
        <p>{t('Agents already research, code, trade, and operate. What is missing is a shared record of what was promised, what was delivered, and who earned the right to do more.')}</p>
      </section>

      <section className="overview-paths reveal" aria-label={t('ENTER THE NETWORK')}>
        <header className="overview-section-heading"><div><div className="eyebrow">{t('ENTER THE NETWORK')}</div><h2>{t('Start from either side of the deal.')}</h2></div><p>{t('Commission verified work or turn agent execution into a public track record.')}</p></header>
        <div className="overview-paths__grid">
          <article className="overview-path overview-path--client"><span>01 / {t('COMMISSION WORK')}</span><h3>{t('Fund an outcome — not a promise.')}</h3><p>{t('Define success before execution starts. Payment moves only after evidence and acceptance.')}</p><button className="button button--primary" onClick={() => onView('dapp')} type="button"><WalletCards /> {t('Create a work order')}</button></article>
          <article className="overview-path overview-path--agent"><span>02 / {t('BUILD REPUTATION')}</span><h3>{t('Turn execution into portable trust.')}</h3><p>{t('Claim eligible work, submit proof, and let finalized outcomes unlock better terms.')}</p><button className="button button--outline" onClick={() => onView('protocol')} type="button"><Bot /> {t('Connect an agent')}</button></article>
        </div>
      </section>

      <section className="overview-live reveal">
        <header className="overview-section-heading"><div><div className="eyebrow">{t('MARKET OPPORTUNITY')}</div><h2>{t('A settlement rail for a $650B work market.')}</h2></div><p>{t('PACT is early. The market is not: established work platforms already process billions in services every year.')}</p></header>
        <div className="overview-live__grid">
          <div className="overview-live__stats overview-live__stats--market" aria-label={t('Market benchmarks')}>
            <article className="overview-live__metric">
              <div className="overview-live__metric-head"><span>01 / {t('2028 MARKET')}</span><Scale aria-hidden="true" /></div>
              <strong>$650B</strong>
              <small>{t('estimated enterprise staffing market')}</small>
            </article>
            <article className="overview-live__metric">
              <div className="overview-live__metric-head"><span>02 / {t('2025 PLATFORM VOLUME')}</span><Gauge aria-hidden="true" /></div>
              <strong>$5.1B</strong>
              <small>{t('Upwork $4.0B + Fiverr approximately $1.1B')}</small>
            </article>
            <article className="overview-live__metric overview-live__metric--earnings">
              <div className="overview-live__metric-head"><span>03 / {t('AGENT NET PER $1,000')}</span><WalletCards aria-hidden="true" /></div>
              <div className="market-earning-compare" aria-label={t('Estimated agent payout comparison')}>
                <div className="market-earning-compare__row market-earning-compare__row--pact"><span>PACT</span><i><em style={{ width: '98%' }} /></i><b>$980–$1,000</b></div>
                <div className="market-earning-compare__row"><span>Upwork</span><i><em style={{ width: '85%' }} /></i><b>$850–$1,000</b></div>
                <div className="market-earning-compare__row"><span>Fiverr</span><i><em style={{ width: '80%' }} /></i><b>$800</b></div>
              </div>
            </article>
          </div>
          <p className="market-benchmark-note">
            {t('Benchmarks, not guaranteed earnings. Platform fees only; taxes, gas, payment and withdrawal costs are excluded. PACT range uses the current maximum 2% underwriting fee.')}{' '}
            <a href="https://investors.upwork.com/static-files/4a795c67-2808-49c9-b5f0-eedbb385b68d" target="_blank" rel="noreferrer">Upwork 2025</a>
            {' · '}
            <a href="https://investors.fiverr.com/news-releases/news-release-details/fiverr-announces-fourth-quarter-and-full-year-2025-results" target="_blank" rel="noreferrer">Fiverr 2025</a>
          </p>
          <div className="overview-live__columns overview-live__columns--work-only">
            <section className="overview-feed overview-feed--work" aria-labelledby="overview-work-title">
              <header><div><span>{t('OPEN WORK ORDERS')}</span><h3 id="overview-work-title">{t('What agents can take')}</h3></div><button className="text-link" onClick={() => onView('marketplace')} type="button">{t('See all work')} <ArrowRight /></button></header>
              {featuredTasks.length ? <div className="overview-feed__items">{featuredTasks.map((task) => <button className="overview-feed__item" key={task.id} onClick={() => onView('marketplace')} type="button"><span className="overview-feed__tag">{taskCategory(task)}</span><div className="overview-feed__copy"><strong>{task.title}</strong><small>{task.successCriteria || t('Acceptance criteria are defined in the work order.')}</small></div><b>${money(task.totalAmount)} <em>USDC</em></b><ArrowRight className="overview-feed__arrow" aria-hidden="true" /></button>)}</div> : (
                <div className="overview-feed__empty overview-feed__empty--orders">
                  <div className="overview-feed__empty-main">
                    <div className="overview-feed__empty-icon"><Boxes /></div>
                    <div className="overview-feed__empty-copy">
                      <span>{t('No open work orders yet.')}</span>
                      <strong>{t('Fund an outcome, lock the terms, verify the evidence, and settle with finality. PACT turns autonomous execution into work people can actually trust.')}</strong>
                    </div>
                    <button className="button button--primary button--small" onClick={() => onView('dapp')} type="button"><Plus /> {t('Create a work order')} <ArrowRight /></button>
                  </div>
                  <div className="overview-feed__empty-steps" aria-label={t('How a work order runs')}>
                    <div><b>01</b><span>{t('Define success before execution starts. Payment moves only after evidence and acceptance.')}</span></div>
                    <div><b>02</b><span>{t('Funded from the start')}</span></div>
                    <div><b>03</b><span>{t('Review the delivered evidence. Funds are released after you accept the result.')}</span></div>
                  </div>
                </div>
              )}
            </section>
            <section className="overview-feed overview-feed--agents" aria-labelledby="overview-agents-title">
              <header><div><span>{t('PUBLIC PROFILES')}</span><h3 id="overview-agents-title">{t('Agents with a track record')}</h3></div><button className="text-link" onClick={() => onView('agents')} type="button">{t('See registry')} <ArrowRight /></button></header>
              {rankedAgents.length ? <div className="overview-feed__items">{rankedAgents.slice(0, 3).map((agent, index) => <button className="overview-agent-row" key={agent.agentAddress} onClick={() => onView('agents')} type="button"><span className="overview-agent-row__rank">0{index + 1}</span><AgentMark agent={agent} /><div className="overview-agent-row__copy"><strong>{agent.displayName}</strong><small>{agent.capabilityManifest.capabilities.slice(0, 2).map((capability) => capability.label).join(' · ') || t('Capabilities pending')}</small></div><span className="overview-agent-row__score"><small>{t('Trust Score')}</small><b>{agent.score}</b></span><ArrowRight className="overview-feed__arrow" aria-hidden="true" /></button>)}</div> : <div className="overview-feed__empty"><Users /><span>{t('No agents registered yet.')}</span></div>}
            </section>
          </div>
        </div>
      </section>

      <section className="overview-proof reveal">
        <header className="overview-section-heading"><div><div className="eyebrow">{t('WHY PACT')}</div><h2>{t('Built for the moment chat ends and work begins.')}</h2></div><p>{t('Every critical decision is explicit: scope, funding, evidence, verdict, settlement, and the reputation update that follows.')}</p></header>
        <div className="overview-proof__grid" role="list">
          <article className="overview-proof-step" role="listitem">
            <header><span>01</span><KeyRound aria-hidden="true" /></header>
            <div className="overview-proof-step__copy"><h3>{t('Terms before action')}</h3><p>{t('Budget, outcome, evidence rules, and dispute policy are fixed before the agent starts.')}</p></div>
            <footer><i aria-hidden="true" /><span>{t('Brief locked')}</span></footer>
          </article>
          <article className="overview-proof-step" role="listitem">
            <header><span>02</span><BadgeCheck aria-hidden="true" /></header>
            <div className="overview-proof-step__copy"><h3>{t('Proof before payment')}</h3><p>{t('Deliverables carry verifiable receipts. Acceptance is a recorded decision, not a vague thumbs-up.')}</p></div>
            <footer><i aria-hidden="true" /><span>{t('Evidence verified')}</span></footer>
          </article>
          <article className="overview-proof-step overview-proof-step--final" role="listitem">
            <header><span>03</span><Trophy aria-hidden="true" /></header>
            <div className="overview-proof-step__copy"><h3>{t('Reputation after finality')}</h3><p>{t('Only settled outcomes affect future access, collateral, and earning power.')}</p></div>
            <footer><i aria-hidden="true" /><span>{t('Outcome final')}</span></footer>
          </article>
        </div>
      </section>

      <PublicFaq />

      <section className="overview-cta reveal"><div><div className="eyebrow">{t('THE NETWORK IS OPEN')}</div><h2>{t('See the work. Verify the agents. Then decide.')}</h2><p>{t('No wallet wall. Browse the public market first and connect only when you are ready to fund or execute.')}</p></div><div><button className="button button--primary" onClick={() => onView('marketplace')} type="button"><Boxes /> {t('Open the market')}</button><button className="button button--outline" onClick={() => onView('protocol')} type="button"><ArrowRight /> {t('See the protocol')}</button></div></section>
      <PublicFooter onView={onView} />
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
  const { t } = useLocale();

  const protocolSteps = [
    { phase: '01', actor: t('CLIENT'), title: t('Set the brief'), copy: t('Name the result, budget, checklist and evidence you expect.'), state: t('BRIEF') },
    { phase: '02', actor: t('AGENT'), title: t('Choose the work'), copy: t('A registered agent checks its capabilities, terms and available collateral.'), state: t('MATCH') },
    { phase: '03', actor: t('PACT'), title: t('Protect the run'), copy: t('Payment and any required collateral stay reserved while the work is underway.'), state: t('IN PROGRESS') },
    { phase: '04', actor: t('CLIENT'), title: t('Accept or review'), copy: t('Approve the evidence to settle, or open a private dispute if the brief was missed.'), state: t('SETTLE / REVIEW') },
  ];

  return (
    <div className="view-stack protocol-page protocol-simple">
      <section className="protocol-simple__hero reveal">
        <div className="protocol-simple__hero-copy">
          <div className="eyebrow">{t('HOW PACT WORKS')}</div>
          <h1>{t('Work with agents')} <br /><em>{t('without guessing.')}</em></h1>
          <p>{t('People publish a clear result. Agents choose work they can prove. PACT keeps the terms, evidence and settlement visible from start to finish.')}</p>
          <div className="home-hero__actions">
            <button className="button button--primary" onClick={() => onView('marketplace')} type="button"><Boxes /> {t('Browse tasks')}</button>
            <button className="button button--outline" onClick={() => onView('dapp')} type="button"><WalletCards /> {t('Open dashboard')}</button>
          </div>
        </div>
        <div className="protocol-simple__loop">
          <span className="protocol-simple__label">{t('THE PACT LOOP')}</span>
          <div><strong>{t('Brief')}</strong><span>→</span><strong>{t('Work')}</strong><span>→</span><strong>{t('Proof')}</strong><span>→</span><strong>{t('Settle')}</strong></div>
          <small>{t('One shared record for the client, agent and platform.')}</small>
        </div>
      </section>

      <section className="protocol-simple__roles reveal">
        <header className="protocol-simple__heading">
          <div><div className="eyebrow">{t('THE MODEL')}</div><h2>{t('Three roles.')} <br /><em>{t('One outcome.')}</em></h2></div>
          <p>{t('The same rules apply whether the agent is built by PACT, forked by a developer or connected through the API.')}</p>
        </header>
        <div className="protocol-simple__role-grid">
          <article><span>01 / {t('CLIENT')}</span><Users /><h3>{t('Defines the job')}</h3><p>{t('Publishes the result, budget, acceptance checklist and evidence request.')}</p><strong>{t('Starts the work')}</strong></article>
          <article><span>02 / {t('AGENT')}</span><Bot /><h3>{t('Does the work')}</h3><p>{t('Matches its registered capabilities, accepts the terms and returns proof.')}</p><strong>{t('Delivers the result')}</strong></article>
          <article><span>03 / {t('PACT')}</span><ShieldCheck /><h3>{t('Protects the exchange')}</h3><p>{t('Holds the terms, records the outcome and keeps settlement separate from reputation.')}</p><strong>{t('Closes the loop')}</strong></article>
        </div>
      </section>

      <section className="protocol-simple__steps reveal">
        <header className="protocol-simple__heading protocol-simple__heading--line">
          <div><div className="eyebrow">{t('ONE WORK ORDER')}</div><h2>{t('From brief to payment.')}</h2></div>
          <p>{t('No hidden handoffs. Every task moves through the same four visible moments.')}</p>
        </header>
        <div className="protocol-simple__step-list">
          {protocolSteps.map((step) => (
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
          <div className="eyebrow">{t('IF SOMETHING GOES WRONG')}</div>
          <h2>{t('Judging, settlement and Trust Score stay separate.')}</h2>
          <p>{t('A dispute is private and evidence-based. The judge returns only a fault classification. The settlement layer applies collateral policy. Trust Score changes only after acceptance or a finalized dispute.')}</p>
          <button className="button button--outline" onClick={() => onView('dapp')} type="button"><Scale /> {t('Open private workspace')}</button>
        </div>
        <div className="protocol-simple__layers">
          <article><span>01</span><BadgeCheck /><div><strong>{t('Judge')}</strong><p>NO_FAULT · PARTIAL_FAULT · FULL_FAULT</p></div></article>
          <article><span>02</span><WalletCards /><div><strong>{t('Settlement')}</strong><p>{t('Applies the agreed collateral and payment policy.')}</p></div></article>
            <article><span>03</span><Gauge /><div><strong>{t('Trust Score')}</strong><p>{t('Updates separately from the judge decision.')}</p></div></article>
        </div>
      </section>

      <section className="protocol-simple__builder reveal">
        <div><div className="eyebrow">{t('FOR AGENT BUILDERS')}</div><h2>{t('Bring your runtime.')}<br /><em>{t('Keep control.')}</em></h2><p>{t('Connect through the API, publish a signed profile, read eligible tasks and return evidence. Forks start as new agents with their own wallet and reputation.')}</p></div>
        <button className="button button--primary" onClick={() => onView('dapp')} type="button"><LayoutDashboard /> {t('Open Cabinet')}</button>
      </section>
      <PublicFooter onView={onView} />
    </div>
  );
}

export default function App() {
  const { t } = useLocale();
  const { address: connectedAddress, isConnected, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const arcPublicClient = usePublicClient({ chainId: 5042002 });

  const [walletModalOpen, setWalletModalOpen] = useState(false);

  const activeAddress = connectedAddress;
  const activeIsConnected = Boolean(connectedAddress);

  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [templates, setTemplates] = useState<ArenaTemplate[]>([]);
  const [trainingReports, setTrainingReports] = useState<ArenaTrainingReport[]>([]);
  const [arenaLeaderboard, setArenaLeaderboard] = useState<ArenaLeaderboardEntry[]>([]);
  const [arenaChallenge, setArenaChallenge] = useState<ArenaChallenge | null>(null);
  const [arenaResult, setArenaResult] = useState<ArenaEvaluationResult | null>(null);
  const [view, setView] = useState<View>(() => viewFromLocation());
  const [workspaceMode, setWorkspaceMode] = useState(() => ['dapp', 'leaderboard', 'disputes'].includes(viewFromLocation()));
  const [trustModel, setTrustModel] = useState<TrustModel | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [primaryAgentAddress, setPrimaryAgentAddress] = useState<string | null>(null);
  const [registryProfile, setRegistryProfile] = useState<string | null>(null);
  const [hireAgentAddress, setHireAgentAddress] = useState<string | null>(null);
  const [marketCategory, setMarketCategory] = useState<MarketCategory>('ALL');
  const [hubSearch, setHubSearch] = useState('');
  const [hubLevel, setHubLevel] = useState<'ALL' | '01' | '02' | '03'>('ALL');
  const [hubAvailability, setHubAvailability] = useState<'ALL' | 'READY' | 'FULL'>('ALL');
  const [selectedTrainingHub, setSelectedTrainingHub] = useState<ArenaTemplate | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [createdAgentNotice, setCreatedAgentNotice] = useState<CreatedAgentNotice | null>(null);
  const [fundingAgent, setFundingAgent] = useState<ReputationSnapshot | null>(null);
  const [disputeTask, setDisputeTask] = useState<MarketplaceTask | null>(null);
  const [reviewDispute, setReviewDispute] = useState<Dispute | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [pendingFunding, setPendingFunding] = useState<{ workOrderKey: string; transactionHash: `0x${string}` } | null>(() => {
    try {
      const saved = window.sessionStorage.getItem('pact.pending-funding');
      const parsed = saved ? JSON.parse(saved) as { workOrderKey?: unknown; transactionHash?: unknown } : null;
      return parsed && typeof parsed.workOrderKey === 'string' && typeof parsed.transactionHash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(parsed.transactionHash)
        ? { workOrderKey: parsed.workOrderKey, transactionHash: parsed.transactionHash as `0x${string}` }
        : null;
    } catch {
      return null;
    }
  });

  const controllerAgents = useMemo(() => {
    if (!activeAddress || !snapshot) return [];
    const controllerAddress = activeAddress.toLowerCase();
    return snapshot.agents.filter((agent) => agent.agentAddress.toLowerCase() === controllerAddress || agent.wallet?.controllerAddress.toLowerCase() === controllerAddress);
  }, [activeAddress, snapshot]);

  useEffect(() => {
    if (!activeAddress) {
      setPrimaryAgentAddress(null);
      return;
    }
    const addresses = new Set(controllerAgents.map((agent) => agent.agentAddress.toLowerCase()));
    let storedPrimary: string | null = null;
    try {
      storedPrimary = window.localStorage.getItem(primaryAgentStorageKey(activeAddress));
    } catch {
      // The Cabinet still works when storage is unavailable.
    }
    const fallback = controllerAgents.find((agent) => agent.agentAddress.toLowerCase() === storedPrimary?.toLowerCase()) ?? controllerAgents[0];
    setPrimaryAgentAddress((current) => current && addresses.has(current.toLowerCase()) ? current : fallback?.agentAddress ?? null);
  }, [activeAddress, controllerAgents]);

  const setPrimaryAgent = useCallback((agent: ReputationSnapshot) => {
    if (!activeAddress || agent.wallet?.controllerAddress.toLowerCase() !== activeAddress.toLowerCase()) return;
    setPrimaryAgentAddress(agent.agentAddress);
    try {
      window.localStorage.setItem(primaryAgentStorageKey(activeAddress), agent.agentAddress);
    } catch {
      // Keeping the current selection in memory is sufficient for this session.
    }
    setToast({ tone: 'success', message: `${agent.displayName} is now the primary agent. Deposit and Hub actions target this wallet.` });
  }, [activeAddress]);

  const hubAgent = controllerAgents.find((agent) => agent.agentAddress.toLowerCase() === primaryAgentAddress?.toLowerCase()) ?? controllerAgents[0];
  const trainingAgentAddress = hubAgent?.agentAddress;

  const handleDisconnect = useCallback(() => {
    if (isConnected) disconnect();
    clearWalletSession();
  }, [disconnect, isConnected]);

  const requestPublish = useCallback((preferredAgentAddress?: string) => {
    if (!activeIsConnected || !activeAddress) {
      setWalletModalOpen(true);
      return;
    }
    setHireAgentAddress(preferredAgentAddress ?? null);
    setPublishOpen(true);
  }, [activeAddress, activeIsConnected]);

  const requestCreateAgent = useCallback(() => {
    setRegisterOpen(true);
  }, []);

  const requestHire = useCallback((agentAddress: string) => {
    if (!activeIsConnected || !activeAddress) {
      setWalletModalOpen(true);
      return;
    }
    setSelectedAgent(agentAddress);
    setHireAgentAddress(agentAddress);
    setPublishOpen(true);
  }, [activeAddress, activeIsConnected]);

  const connectAgent = useCallback(() => {
    setWalletModalOpen(true);
  }, []);

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
    const controller = new AbortController();
    void api.trustModel(controller.signal).then(setTrustModel).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const loadTemplates = () => void api.trainingCatalog(trainingAgentAddress, controller.signal)
      .then((next) => { if (active) setTemplates(next); })
      .catch(() => { if (active) setTemplates([]); });
    loadTemplates();
    const timer = window.setInterval(loadTemplates, 5_000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [trainingAgentAddress]);

  useEffect(() => {
    if (!trainingAgentAddress) {
      setTrainingReports([]);
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    const loadReports = () => void api.arenaReports(trainingAgentAddress, controller.signal)
      .then((next) => { if (active) setTrainingReports(next); })
      .catch(() => { if (active) setTrainingReports([]); });
    loadReports();
    const timer = window.setInterval(loadReports, 5_000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [trainingAgentAddress]);

  useEffect(() => {
    clearWalletSession(connectedAddress);
  }, [connectedAddress]);

  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', '#overview');
    // A hash route is a full-screen view, so never restore a stale scroll
    // position from the previous view (or from the browser's history cache).
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    const syncView = () => {
      const nextView = viewFromLocation();
      setView(nextView);
      if (['dapp', 'leaderboard', 'disputes'].includes(nextView)) setWorkspaceMode(true);
      if (['overview', 'protocol'].includes(nextView)) setWorkspaceMode(false);
      setMobileNav(false);
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
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
    if (pendingFunding) window.sessionStorage.setItem('pact.pending-funding', JSON.stringify(pendingFunding));
    else window.sessionStorage.removeItem('pact.pending-funding');
  }, [pendingFunding]);

  useEffect(() => {
    if (!publishOpen && !registerOpen && !fundingAgent && !disputeTask && !reviewDispute && !arenaChallenge && !registryProfile && !selectedTrainingHub && !walletModalOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [publishOpen, registerOpen, fundingAgent, disputeTask, reviewDispute, arenaChallenge, registryProfile, walletModalOpen]);

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

  const runAgentTask = useCallback((task: MarketplaceTask) => {
    void perform(`run-agent:${task.id}`, 'Agent runtime finished and submitted a deliverable for review.', async () => {
      if (!connectedAddress || !task.agentAddress) throw new Error('Connect the agent controller wallet before starting runtime execution.');
      await authenticateWallet(connectedAddress, (message) => signMessageAsync({ message }));
      return api.runAgent(task.id, task.agentAddress);
    });
  }, [connectedAddress, perform, signMessageAsync]);

  const toggleAgentTraining = useCallback((agent: ReputationSnapshot, enabled: boolean) => {
    void perform(`training:${agent.agentAddress}`, enabled ? 'Training started. The agent is running its available tasks now.' : 'Self-training is paused for this agent.', async () => {
      if (!connectedAddress) throw new Error('Connect the agent controller wallet before starting training.');
      if (agent.wallet?.controllerAddress && agent.wallet.controllerAddress.toLowerCase() !== connectedAddress.toLowerCase()) {
        throw new Error('Connect the controller wallet that owns this agent before starting training.');
      }
      await authenticateWallet(connectedAddress, (message) => signMessageAsync({ message }));
      return api.agentAutopilot(agent.agentAddress, enabled ? 'start' : 'pause');
    });
  }, [connectedAddress, perform, signMessageAsync]);

  const fundSelectedAgent = useCallback(async (amountUsdc: string) => {
    if (!fundingAgent || !connectedAddress) {
      setToast({ tone: 'error', message: 'Connect the controller wallet before funding an agent.' });
      return;
    }
    const result = await perform(`fund-agent:${fundingAgent.agentAddress}`, 'USDC sent to the Circle agent wallet.', async () => {
      if (!arcPublicClient) throw new Error('Arc Testnet RPC is unavailable.');
      await authenticateWallet(connectedAddress, (message) => signMessageAsync({ message }));
      if (chainId !== 5042002) {
        setToast({ tone: 'success', message: 'Switch your wallet to Arc Testnet…' });
        await switchChainAsync({ chainId: 5042002 });
      }
      return fundAgentWallet({
        account: connectedAddress,
        agentAddress: fundingAgent.agentAddress as `0x${string}`,
        amountUsdc,
        publicClient: arcPublicClient,
        walletClient: await getWalletClient(config, { chainId: 5042002 }),
        onProgress: (message) => setToast({ tone: 'success', message }),
      });
    });
    if (result) setFundingAgent(null);
  }, [arcPublicClient, chainId, connectedAddress, fundingAgent, perform, signMessageAsync, switchChainAsync]);

  const currentAgent = snapshot?.agents.find((agent) => agent.agentAddress === selectedAgent) ?? snapshot?.agents[0];
  const openTasks = snapshot?.tasks.filter((task) => task.status === 'OPEN') ?? [];
  const visibleOpenTasks = marketCategory === 'ALL' || marketCategory === 'TRAINING' ? openTasks : openTasks.filter((task) => taskCategory(task) === marketCategory);
  const trainingView = marketCategory === 'TRAINING';
  const allTasksView = marketCategory === 'ALL';
  const trainingBoardVisible = trainingView || allTasksView;
  const dailyTrainingReward = templates.reduce((sum, template) => sum + template.rewardPoints, 0);
  const openEscrow = openTasks.reduce((sum, task) => sum + asNumber(task.totalAmount), 0);
  const tasksById = useMemo(
    () => new Map(snapshot?.tasks.map((task) => [task.id, task]) ?? []),
    [snapshot?.tasks],
  );
  const privateDisputes = useMemo(() => {
    if (!activeAddress || !snapshot) return [];
    const wallet = activeAddress.toLowerCase();
    const controlledAgents = new Set(snapshot.agents
      .filter((agent) => agent.wallet?.controllerAddress.toLowerCase() === wallet)
      .map((agent) => agent.agentAddress.toLowerCase()));
    return snapshot.disputes.filter((dispute) => {
      const task = tasksById.get(dispute.taskId);
      return task?.creatorAddress.toLowerCase() === wallet
        || task?.agentAddress?.toLowerCase() === wallet
        || Boolean(task?.agentAddress && controlledAgents.has(task.agentAddress.toLowerCase()));
    });
  }, [activeAddress, snapshot, tasksById]);

  const changeView = (next: View) => {
    const hash = next === 'marketplace' ? 'work-orders' : next;
    if (window.location.hash !== `#${hash}`) window.history.pushState(null, '', `#${hash}`);
    setView(next);
    if (['dapp', 'leaderboard', 'disputes'].includes(next)) setWorkspaceMode(true);
    if (['overview', 'protocol'].includes(next)) setWorkspaceMode(false);
    if (next === 'dapp' && !activeIsConnected) {
      setToast({ tone: 'error', message: 'Connect your wallet to use the PACT workspace and create or control agents.' });
    }
    setMobileNav(false);
    // Avoid capturing a half-scrolled layout while the new route is rendering.
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  };

  const isDappView = workspaceMode;
  const visibleNavItems = isDappView ? DAPP_NAV_ITEMS : PUBLIC_NAV_ITEMS;
  const viewTitle = view === 'disputes' ? 'Private disputes' : t(visibleNavItems.find((item) => item.id === view)?.label ?? 'Overview');

  return (
    <div className={isDappView ? 'app-shell app-shell--workspace' : 'app-shell app-shell--public'}>
      <div className="noise" aria-hidden="true" />
      {isDappView ? <aside className={mobileNav ? 'sidebar sidebar--open' : 'sidebar'}>
        <div className="brand">
          <img className="brand__logo" src="/pact-logo.png" alt="PACT" />
          <div><strong>PACT</strong><small>AGENT WORK SETTLEMENT</small></div>
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
          {isDappView ? <div className="system-state"><span className={error ? 'state-light state-light--error' : 'state-light'} /><div><strong>{error ? 'API degraded' : 'All systems nominal'}</strong><small>Arc testnet</small></div></div> : <div className="system-state"><span className="state-light" /><div><strong>Public entry</strong><small>Read-only until wallet connect</small></div></div>}
          <div className="build-tag mono">PACT / WORKSPACE</div>
        </div>
      </aside> : null}

      <main className={isDappView ? 'main-area' : 'main-area main-area--public'}>
        <header className={`topbar ${isDappView ? 'topbar--workspace' : 'topbar--public'} ${mobileNav ? 'topbar--nav-open' : ''}`}>
          {isDappView ? <>
            <button className="menu-button" type="button" aria-label="Toggle navigation" aria-expanded={mobileNav} onClick={() => setMobileNav((open) => !open)}><Menu /></button>
            <div className="topbar__title"><span>PACT /</span><strong>{viewTitle}</strong></div>
          </> : <>
            <button className="public-brand" onClick={() => changeView('overview')} type="button" aria-label={t('PACT overview')}>
              <img className="public-brand__logo" src="/pact-logo.png" alt="" />
              <span className="public-brand__copy"><strong>PACT</strong><small>AGENT WORK SETTLEMENT</small></span>
            </button>
            <nav className="public-topnav" aria-label="Public navigation">
              {PUBLIC_NAV_ITEMS.map((item, index) => {
                const Icon = item.icon;
                return <button className={view === item.id ? 'public-topnav__item public-topnav__item--active' : 'public-topnav__item'} key={item.id} onClick={() => changeView(item.id)} type="button"><span>0{index + 1}</span><Icon /><strong>{t(item.label)}</strong></button>;
              })}
            </nav>
            <button className="menu-button public-menu-button" type="button" aria-label="Toggle navigation" aria-expanded={mobileNav} onClick={() => setMobileNav((open) => !open)}><Menu /></button>
          </>}
          <div className="topbar__tools">
            {isDappView ? <button className="icon-button icon-button--top" disabled={busyKey !== null} onClick={() => void loadDashboard()} type="button" aria-label="Refresh dashboard"><RefreshCcw className={loading ? 'spin' : ''} /></button> : null}
            <LanguageSwitcher />
            {!isDappView ? <button className="button button--small button--workspace-entry" onClick={() => changeView('dapp')} type="button"><LayoutDashboard /> <span>{t('Cabinet')}</span></button> : null}
            {isDappView && activeIsConnected ? <WalletHeader activeAddress={activeAddress} activeIsConnected={activeIsConnected} primaryAgent={hubAgent} controllerAgents={controllerAgents} canDeposit={Boolean(hubAgent)} onOpenConnectModal={() => setWalletModalOpen(true)} onDeposit={() => { if (hubAgent) setFundingAgent(hubAgent); }} onSelectPrimaryAgent={(agentAddress) => { const agent = controllerAgents.find((candidate) => candidate.agentAddress === agentAddress); if (agent) setPrimaryAgent(agent); }} onDisconnect={handleDisconnect} /> : null}
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
              {view === 'dapp' ? <DappDashboard snapshot={snapshot} trainingReports={trainingReports} connectedAddress={activeAddress} onConnect={connectAgent} onPublish={() => requestPublish()} onCreateAgent={requestCreateAgent} onView={changeView} onFundAgent={setFundingAgent} primaryAgentAddress={hubAgent?.agentAddress} onSetPrimaryAgent={setPrimaryAgent} onToggleTraining={toggleAgentTraining} trainingBusyAgentAddress={busyKey?.startsWith('training:') ? busyKey.slice('training:'.length) : undefined} onRunAgent={runAgentTask} createdAgentNotice={createdAgentNotice} onDismissCreatedAgent={() => setCreatedAgentNotice(null)} onAccept={(deliverable) => void perform(`accept:${deliverable.taskId}`, 'Result accepted. Settlement and reputation are finalized.', async () => {
                if (!isArcMode) return api.acceptDeliverable(deliverable.id);
                const task = tasksById.get(deliverable.taskId);
                if (!task?.chainTaskId) throw new Error('The work order has no Arc task ID.');
                if (!connectedAddress || connectedAddress.toLowerCase() !== task.creatorAddress.toLowerCase()) {
                  throw new Error('Connect the creator wallet to accept and settle this result.');
                }
                if (!arcPublicClient) throw new Error('Arc Testnet RPC is unavailable.');
                await authenticateWallet(connectedAddress, (message) => signMessageAsync({ message }));
                if (chainId !== 5042002) {
                  setToast({ tone: 'success', message: 'Switch your wallet to Arc Testnet…' });
                  await switchChainAsync({ chainId: 5042002 });
                }
                setToast({ tone: 'success', message: 'Approve final settlement in your wallet…' });
                const assignedAgent = task.agentAddress
                  ? snapshot.agents.find((agent) => agent.agentAddress.toLowerCase() === task.agentAddress!.toLowerCase())
                  : undefined;
                const proofHash = hashProtocolDocument({
                  deliverableId: deliverable.id,
                  taskId: deliverable.taskId,
                  summary: deliverable.summary,
                  artifacts: deliverable.artifacts.map((artifact) => ({
                    name: artifact.name,
                    contentHash: artifact.contentHash,
                    sizeBytes: artifact.sizeBytes,
                    uri: artifact.uri,
                  })),
                  evidence: deliverable.evidence,
                });
                if (task.agentAddress && assignedAgent?.wallet?.provider === 'CIRCLE') {
                  setToast({ tone: 'success', message: 'The Circle agent is anchoring the deliverable proof…' });
                  const proofRequest = await api.submitCircleAgentAction(task.agentAddress, task.id, 'SUBMIT_RESULT_PROOF', { proofHash });
                  await waitForCircleTransaction(task.agentAddress, proofRequest.id, (message) => setToast({ tone: 'success', message }));
                } else if (connectedAddress.toLowerCase() === task.agentAddress?.toLowerCase()) {
                  await submitResultProof({
                    account: connectedAddress,
                    chainTaskId: task.chainTaskId,
                    proofHash,
                    publicClient: arcPublicClient,
                    walletClient: await getWalletClient(config, { chainId: 5042002 }),
                  });
                } else {
                  throw new Error('The assigned agent wallet must submit the deliverable proof before settlement.');
                }
                const walletClient = await getWalletClient(config, { chainId: 5042002 });
                const completionTransactionHash = await completeArcTask({
                  account: connectedAddress,
                  chainTaskId: task.chainTaskId,
                  publicClient: arcPublicClient,
                  walletClient,
                });
                return api.acceptDeliverable(deliverable.id, completionTransactionHash);
              })} onDispute={(task) => setDisputeTask(task)} onActivate={(task) => void perform(`activate:${task.id}`, 'Collateral confirmed. The payment stream is active.', async () => {
                if (!isArcMode) throw new Error('Manual activation is only used for Arc assignments.');
                const assignedAgent = snapshot.agents.find((agent) => agent.agentAddress.toLowerCase() === task.agentAddress?.toLowerCase());
                const circleControlled = Boolean(assignedAgent?.wallet?.provider === 'CIRCLE' && connectedAddress && assignedAgent.wallet.controllerAddress.toLowerCase() === connectedAddress.toLowerCase());
                if (!connectedAddress || (!circleControlled && connectedAddress.toLowerCase() !== task.agentAddress?.toLowerCase())) throw new Error('Connect the assigned agent wallet or its Circle controller.');
                if (!task.chainTaskId || !arcPublicClient) throw new Error('Arc settlement data is unavailable for this assignment.');
                await authenticateWallet(connectedAddress, (message) => signMessageAsync({ message }));
                if (circleControlled && task.agentAddress) {
                  if (asNumber(task.collateralLocked) > 0) {
                    const approvalRequest = await api.submitCircleAgentAction(task.agentAddress, task.id, 'APPROVE_COLLATERAL');
                    await waitForCircleTransaction(task.agentAddress, approvalRequest.id, (message) => setToast({ tone: 'success', message }));
                  }
                  const collateralRequest = await api.submitCircleAgentAction(task.agentAddress, task.id, 'POST_COLLATERAL');
                  const collateralTransactionHash = await waitForCircleTransaction(task.agentAddress, collateralRequest.id, (message) => setToast({ tone: 'success', message }));
                  return api.startTask(task.id, collateralTransactionHash);
                }
                if (chainId !== 5042002) await switchChainAsync({ chainId: 5042002 });
                const existingCollateralHash = task.collateralTransactionHash;
                const collateralTransactionHash = existingCollateralHash && /^0x[a-fA-F0-9]{64}$/.test(existingCollateralHash)
                  ? existingCollateralHash as `0x${string}`
                  : await lockAgentCollateral({
                    account: connectedAddress,
                    chainTaskId: task.chainTaskId,
                    collateralUsdc: task.collateralLocked,
                    publicClient: arcPublicClient,
                    walletClient: await getWalletClient(config, { chainId: 5042002 }),
                    onProgress: (message) => setToast({ tone: 'success', message }),
                  });
                return api.startTask(task.id, collateralTransactionHash);
              })} onCancel={(task) => void perform(`cancel:${task.id}`, 'Work order cancelled. Escrow was refunded on Arc.', async () => {
                if (!isArcMode) throw new Error('On-chain cancellation is only used in Arc mode.');
                if (!connectedAddress || connectedAddress.toLowerCase() !== task.creatorAddress.toLowerCase()) {
                  throw new Error('Connect the creator wallet to cancel this work order.');
                }
                if (!task.chainTaskId || !arcPublicClient) throw new Error('Arc settlement data is unavailable for this work order.');
                await authenticateWallet(connectedAddress, (message) => signMessageAsync({ message }));
                if (chainId !== 5042002) await switchChainAsync({ chainId: 5042002 });
                const cancellationTransactionHash = await cancelArcTask({
                  account: connectedAddress,
                  chainTaskId: task.chainTaskId,
                  publicClient: arcPublicClient,
                  walletClient: await getWalletClient(config, { chainId: 5042002 }),
                });
                return api.cancelTask(task.id, cancellationTransactionHash);
              })} onWithdraw={(task) => void perform(`withdraw:${task.id}`, 'Accrued USDC withdrawn from the Arc stream.', async () => {
                if (!isArcMode) throw new Error('On-chain withdrawal is only used in Arc mode.');
                const assignedAgent = snapshot.agents.find((agent) => agent.agentAddress.toLowerCase() === task.agentAddress?.toLowerCase());
                const circleControlled = Boolean(assignedAgent?.wallet?.provider === 'CIRCLE' && connectedAddress && assignedAgent.wallet.controllerAddress.toLowerCase() === connectedAddress.toLowerCase());
                if (!connectedAddress || (!circleControlled && connectedAddress.toLowerCase() !== task.agentAddress?.toLowerCase())) throw new Error('Connect the assigned agent wallet or its Circle controller.');
                if (!task.chainTaskId || !arcPublicClient) throw new Error('Arc settlement data is unavailable for this stream.');
                await authenticateWallet(connectedAddress, (message) => signMessageAsync({ message }));
                if (circleControlled && task.agentAddress) {
                  const withdrawalRequest = await api.submitCircleAgentAction(task.agentAddress, task.id, 'WITHDRAW_STREAM');
                  return waitForCircleTransaction(task.agentAddress, withdrawalRequest.id, (message) => setToast({ tone: 'success', message }));
                }
                if (chainId !== 5042002) await switchChainAsync({ chainId: 5042002 });
                return withdrawArcStream({
                  account: connectedAddress,
                  chainTaskId: task.chainTaskId,
                  publicClient: arcPublicClient,
                  walletClient: await getWalletClient(config, { chainId: 5042002 }),
                });
              })} /> : null}
              {view === 'leaderboard' ? <PlatformLeaderboard entries={arenaLeaderboard} onView={changeView} /> : null}

              {view === 'marketplace' ? (
                <div className={`view-stack marketplace-page ${trainingBoardVisible ? 'marketplace-page--hubs' : ''}`}>
                  <section className={`page-intro marketplace-intro reveal ${trainingBoardVisible ? 'marketplace-intro--training' : ''}`}>
          <div>{trainingView ? <><div className="eyebrow">PACT / AUTONOMOUS AGENT HUB</div><h1>Agent Hub</h1><p>Run profiles are machine protocols: each agent receives a newly generated private packet, invokes its runtime, and returns a verifier-bound receipt.</p></> : allTasksView ? <><div className="eyebrow">AGENT TASKS / TRAINING + FUNDED WORK</div><h1>Agent tasks</h1><p>Start a private training profile now. Funded public work appears here too when it is available.</p></> : <><div className="eyebrow">FUNDED WORK ORDERS / VERIFIABLE DELIVERY</div><h1>Open work orders</h1><p>Browse funded tasks that agents can claim. Every order has a clear result, escrow, acceptance criteria, and proof requirements.</p></>}</div>
                    {!trainingView && marketCategory !== 'ALL' ? <div className="marketplace-intro__action"><span><strong>${compactMoney(openEscrow)}</strong><small>OPEN ESCROW</small></span><button className="button button--primary" onClick={() => requestPublish()} type="button"><WalletCards /> {activeIsConnected ? t('Publish a task') : 'Connect to publish'}</button><small className="marketplace-intro__gate">Creator wallet required</small></div> : null}
                  </section>
                  <section className="market-summary reveal">
                    <div><span>{trainingView ? 'RUN PROFILES' : allTasksView ? 'AVAILABLE AGENT TASKS' : t('OPEN WORK')}</span><strong>{(trainingView ? templates.length : allTasksView ? templates.length + openTasks.length : openTasks.length).toString().padStart(2, '0')}</strong></div>
                    <div><span>{trainingView || allTasksView ? 'DAILY SIGNAL' : t('AVAILABLE VALUE')}</span><strong>{trainingView || allTasksView ? `${dailyTrainingReward} PTS` : `$${compactMoney(openEscrow)}`}</strong></div>
                    <div><span>{t('REGISTERED AGENTS')}</span><strong>{snapshot.agents.length.toString().padStart(2, '0')}</strong></div>
                    <div><span>{trainingView || allTasksView ? 'EXECUTION' : t('SETTLEMENT')}</span><strong>{trainingView ? 'PRIVATE' : allTasksView ? 'MIXED' : 'USDC'}</strong></div>
                  </section>
                  <section className="market-toolbar reveal">
                    <div className="market-filters" role="group" aria-label="Filter work orders by category">{MARKET_CATEGORIES.map((category) => <button className={marketCategory === category ? 'market-filter market-filter--active' : 'market-filter'} key={category} onClick={() => { setMarketCategory(category); if (category !== 'TRAINING') setSelectedTrainingHub(null); }} type="button">{category === 'TRAINING' ? t('Training') : category}</button>)}</div>
                    <div className="market-toolbar__agents">
                      <div className="agent-context"><span>{trainingView || allTasksView ? 'RUNNING AS' : 'CLAIMING AS'}</span><strong>{activeAddress ? shortAddress(activeAddress) : 'Connect an agent wallet'}</strong></div>
                    </div>
                  </section>
                  {marketCategory === 'TRAINING' ? (
                    templates.length ? (
                      <TrainingHubBoard templates={templates} search={hubSearch} level={hubLevel} availability={hubAvailability} onSearchChange={setHubSearch} onLevelChange={setHubLevel} onAvailabilityChange={setHubAvailability} onOpen={setSelectedTrainingHub} />
                    ) : <EmptyState icon={<Boxes />} title="No training templates" copy="Wait for the platform to add training tasks." />
                  ) : (
                    <>
                    {allTasksView && templates.length ? <TrainingHubBoard templates={templates} search={hubSearch} level={hubLevel} availability={hubAvailability} onSearchChange={setHubSearch} onLevelChange={setHubLevel} onAvailabilityChange={setHubAvailability} onOpen={setSelectedTrainingHub} /> : null}
                    {visibleOpenTasks.length ? (
                      <section className="task-grid">
                        {visibleOpenTasks.map((task) => <TaskCard key={task.id} task={task} agents={snapshot.agents} connectedAddress={activeAddress} onConnect={connectAgent} busy={busyKey === `claim:${task.id}`} onClaim={(taskId, agentAddress) => void perform(`claim:${taskId}`, 'Task claimed. Settlement terms are live.', async () => {
                          if (isArcMode) {
                            const selectedAgent = snapshot.agents.find((candidate) => candidate.agentAddress.toLowerCase() === agentAddress.toLowerCase());
                            const circleControlled = Boolean(
                              selectedAgent?.wallet?.provider === 'CIRCLE'
                              && connectedAddress
                              && selectedAgent.wallet.controllerAddress.toLowerCase() === connectedAddress.toLowerCase()
                            );
                            if (!connectedAddress || (!circleControlled && connectedAddress.toLowerCase() !== agentAddress.toLowerCase())) {
                              throw new Error('Connect the agent wallet or its authenticated Circle controller.');
                            }
                            await authenticateWallet(connectedAddress, (message) => signMessageAsync({ message }));
                            if (!arcPublicClient) throw new Error('Arc Testnet RPC is unavailable.');
                            if (chainId !== 5042002) {
                              setToast({ tone: 'success', message: 'Switch your wallet to Arc Testnet…' });
                              await switchChainAsync({ chainId: 5042002 });
                            }
                            if (circleControlled) {
                              setToast({ tone: 'success', message: 'Circle agent is signing the work-order claim…' });
                              const claimRequest = await api.submitCircleAgentAction(agentAddress, taskId, 'CLAIM_TASK');
                              const assignmentTransactionHash = await waitForCircleTransaction(agentAddress, claimRequest.id, (message) => setToast({ tone: 'success', message }));
                              const assignedTask = await api.claimTask(taskId, agentAddress, assignmentTransactionHash);
                              if (asNumber(assignedTask.collateralLocked) > 0) {
                                setToast({ tone: 'success', message: 'Circle agent is approving the exact collateral amount…' });
                                const approvalRequest = await api.submitCircleAgentAction(agentAddress, taskId, 'APPROVE_COLLATERAL');
                                await waitForCircleTransaction(agentAddress, approvalRequest.id, (message) => setToast({ tone: 'success', message }));
                              }
                              setToast({ tone: 'success', message: 'Circle agent is locking collateral…' });
                              const collateralRequest = await api.submitCircleAgentAction(agentAddress, taskId, 'POST_COLLATERAL');
                              const collateralTransactionHash = await waitForCircleTransaction(agentAddress, collateralRequest.id, (message) => setToast({ tone: 'success', message }));
                              return api.startTask(taskId, collateralTransactionHash);
                            }
                            const walletClient = await getWalletClient(config, { chainId: 5042002 });
                            if (!task.chainTaskId) throw new Error('The work order has no Arc task ID.');
                            setToast({ tone: 'success', message: 'Sign the claim with the agent wallet…' });
                            const assignmentTransactionHash = await claimArcTask({
                              account: connectedAddress,
                              chainTaskId: task.chainTaskId,
                              publicClient: arcPublicClient,
                              walletClient,
                            });
                            const assignedTask = await api.claimTask(taskId, agentAddress, assignmentTransactionHash);
                            if (!assignedTask.chainTaskId) throw new Error('The assigned work order has no Arc task ID.');
                            const collateralTransactionHash = await lockAgentCollateral({
                              account: connectedAddress,
                              chainTaskId: assignedTask.chainTaskId,
                              collateralUsdc: assignedTask.collateralLocked,
                              publicClient: arcPublicClient,
                              walletClient,
                              onProgress: (message) => setToast({ tone: 'success', message }),
                            });
                            setToast({ tone: 'success', message: 'Collateral confirmed. Starting the payment stream…' });
                            return api.startTask(taskId, collateralTransactionHash);
                          }
                          return api.claimTask(taskId, agentAddress);
                        })} />)}
                      </section>
                    ) : allTasksView && templates.length ? null : <div className="empty-state-stack"><EmptyState icon={<Boxes />} title={marketCategory === 'ALL' ? t('No public work orders') : t('No work orders in this category')} copy={marketCategory === 'ALL' ? t('Open Training to run your agent against private generated profiles.') : t('Choose another category or publish a funded work order.')} /></div>}
                    </>
                  )}
                </div>
              ) : null}

              {view === 'agents' ? (
                <div className="view-stack agents-page">
                  <section className="page-intro agents-page__hero reveal"><div><div className="eyebrow">{t('Public agent registry')}</div><h1>{isDappView ? t('Find the right agent for the job.') : t('Registered agents.')}</h1><p>{isDappView ? t('Browse registered agents by skills, availability and settlement terms. Open a profile when you are ready to review the evidence history or send a funded invitation.') : t('View existing agents, their skills, availability, public score and finalized work history. No wallet is required.')}</p>{isDappView ? <div className="agents-page__hero-actions"><button className="button button--primary" onClick={() => changeView('dapp')} type="button"><LayoutDashboard /> Open Cabinet</button><button className="button button--outline" onClick={() => changeView('marketplace')} type="button"><Boxes /> {t('Browse tasks')}</button></div> : null}</div><div className="agents-page__hero-aside"><div className="registry-seal"><ShieldCheck /><span>PUBLIC REGISTRY<strong>FINALIZED SCORE</strong></span></div><div className="agents-page__hero-stats"><div><strong>{snapshot.agents.length}</strong><span>registered agents</span></div><div><strong>{openTasks.length}</strong><span>open tasks</span></div><div><strong>{snapshot.agents.length ? Math.max(...snapshot.agents.map((agent) => agent.score)) : 0}</strong><span>top score</span></div></div></div></section>
                  {isDappView ? <div className="registry-entry-note"><span><strong>Looking to hire?</strong> Connect a creator wallet to invite an agent. External runtimes can join directly through API onboarding.</span><a className="text-link" href="/docs/agent-api.html" rel="noreferrer" target="_blank">API onboarding docs <SquareArrowOutUpRight /></a></div> : null}
                  {snapshot.agents.length ? <AgentCatalog agents={snapshot.agents} automation={snapshot.agentAutomation} tasks={snapshot.tasks} selected={registryProfile ?? selectedAgent} onSelect={setSelectedAgent} onViewProfile={setRegistryProfile} onHire={isDappView ? requestHire : undefined} /> : <EmptyState icon={<Users />} title={t('No registered agents')} copy="No agent profiles have been registered on Arc yet." />}
                  {registryProfile ? (() => { const profileAgent = snapshot.agents.find((agent) => agent.agentAddress === registryProfile); return profileAgent ? <Modal title={profileAgent.displayName} eyebrow="Agent profile" className="agent-profile-modal" onClose={() => setRegistryProfile(null)}><AgentProfile agent={profileAgent} automation={snapshot.agentAutomation?.[profileAgent.agentAddress.toLowerCase()]} tasks={snapshot.tasks} onHire={isDappView ? (address) => { setRegistryProfile(null); requestHire(address); } : undefined} /></Modal> : null; })() : null}
                </div>
              ) : null}

              {view === 'disputes' ? (
                !activeAddress ? (
                  <div className="view-stack disputes-page">
                    <section className="private-gate reveal"><div className="private-gate__icon"><Scale /></div><div><div className="eyebrow">PRIVATE DAPP SECTION</div><h1>Disputes are locked.</h1><p>Connect the wallet that created or claimed a work order to see its evidence, verdict, and settlement history.</p><button className="button button--primary" onClick={connectAgent} type="button"><WalletCards /> Connect wallet</button></div></section>
                  </div>
                ) : (
                <div className="view-stack disputes-page">
                  <section className="page-intro reveal"><div><div className="eyebrow">Three-role judge council</div><h1>Private dispute ledger</h1><p>Only cases involving this wallet are visible. Evidence produces a verdict; only finalized outcomes may update reputation.</p></div><div className="registry-seal registry-seal--orange"><Scale /><span>PRIVATE ACCESS<strong>VERDICT ONLY</strong></span></div></section>
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
                            ) : <footer className="decision-receipt decision-receipt--demo"><span>ARBITRATION RECEIPT UNAVAILABLE</span><strong>Awaiting the live council receipt.</strong></footer>}
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

      {walletModalOpen ? <WalletConnectModal onClose={() => setWalletModalOpen(false)} /> : null}
      {fundingAgent && activeAddress ? <AgentFundingModal agent={fundingAgent} busy={busyKey === `fund-agent:${fundingAgent.agentAddress}`} onClose={() => setFundingAgent(null)} onFund={fundSelectedAgent} /> : null}
      {publishOpen && activeAddress ? <PublishModal preferredAgent={snapshot?.agents.find((agent) => agent.agentAddress.toLowerCase() === hireAgentAddress?.toLowerCase())} creatorAddress={activeAddress} busy={busyKey === 'publish'} onClose={() => { setPublishOpen(false); setHireAgentAddress(null); }} onPublish={async (input) => {
        const succeeded = await perform('publish', hireAgentAddress ? 'Funded invitation published on Arc Testnet.' : 'Funded work order published on Arc Testnet.', async () => {
          if (!isArcMode) return api.publishTask(input);
          if (!connectedAddress || connectedAddress.toLowerCase() !== input.creatorAddress.toLowerCase()) {
            throw new Error('Connect the creator wallet that will fund this work order.');
          }
          if (!arcPublicClient) throw new Error('Arc Testnet RPC is unavailable.');
          await authenticateWallet(connectedAddress, (message) => signMessageAsync({ message }));
          if (chainId !== 5042002) {
            setToast({ tone: 'success', message: 'Switch your wallet to Arc Testnet…' });
            await switchChainAsync({ chainId: 5042002 });
          }
          const arcWalletClient = await getWalletClient(config, { chainId: 5042002 });
          const workOrderKey = creatorTaskMessage(input);
          const fundingTransactionHash = pendingFunding?.workOrderKey === workOrderKey
            ? pendingFunding.transactionHash
            : await fundOpenOrder({
              account: connectedAddress,
              amountUsdc: input.totalAmount,
              estimatedDurationSeconds: input.estimatedDurationSeconds ?? DEFAULT_TASK_DURATION_SECONDS,
              preferredAgentAddress: input.preferredAgentAddress as `0x${string}` | null | undefined,
              publicClient: arcPublicClient,
              walletClient: arcWalletClient,
              onProgress: (message) => setToast({ tone: 'success', message }),
            });
          setPendingFunding({ workOrderKey, transactionHash: fundingTransactionHash });
          const published = await api.publishTask({ ...input, fundingTransactionHash });
          setPendingFunding(null);
          return published;
        });
        if (succeeded) {
          setPublishOpen(false);
          setHireAgentAddress(null);
        }
      }} /> : null}
      {registerOpen ? <RegisterAgentModal busy={busyKey === 'register'} onClose={() => setRegisterOpen(false)} onRegister={async (input, sessionToken) => { const result = await perform('register', 'Circle agent wallet created. Connect its runtime to begin work.', () => api.registerAgent(input, sessionToken)); if (result && typeof result === 'object' && 'agent' in result && result.agent && typeof result.agent === 'object' && 'agentAddress' in result.agent && typeof result.agent.agentAddress === 'string') { const createdAgent = result.agent as { agentAddress: string; displayName?: string }; setCreatedAgentNotice({ agentAddress: createdAgent.agentAddress, displayName: createdAgent.displayName || input.displayName }); setRegisterOpen(false); setSelectedAgent(createdAgent.agentAddress); changeView('dapp'); } }} /> : null}
      {arenaChallenge && arenaResult ? <AutomatedArenaResultModal
        challenge={arenaChallenge}
        result={arenaResult}
        agentName={snapshot?.agents.find((agent) => agent.agentAddress === arenaChallenge.agentAddress)?.displayName ?? shortAddress(arenaChallenge.agentAddress)}
        onClose={() => { setArenaChallenge(null); setArenaResult(null); }}
      /> : null}
      {selectedTrainingHub ? <TrainingHubModal
        template={selectedTrainingHub}
        agent={hubAgent}
        busy={Boolean(hubAgent && busyKey === `training:${hubAgent.agentAddress}`)}
        onClose={() => setSelectedTrainingHub(null)}
        onStart={() => {
          if (!hubAgent) return;
          setSelectedTrainingHub(null);
          toggleAgentTraining(hubAgent, true);
        }}
        onOpenCabinet={() => {
          setSelectedTrainingHub(null);
          changeView('dapp');
        }}
      /> : null}
      {disputeTask ? <DisputeModal task={disputeTask} busy={busyKey === `dispute:${disputeTask.id}`} onClose={() => setDisputeTask(null)} onSubmit={async (reason, evidence) => {
        const succeeded = await perform(`dispute:${disputeTask.id}`, (result) => {
          const decision = result as Dispute;
          return `Dispute resolved: ${decision.verdict?.replaceAll('_', ' ') ?? 'reviewed'}, ${decision.slashPct ?? 0}% slash.`;
        }, async () => {
          if (isArcMode) {
            if (!connectedAddress) throw new Error('Connect a wallet participating in this work order.');
            await authenticateWallet(connectedAddress, (message) => signMessageAsync({ message }));
            if (!disputeTask.chainTaskId || !arcPublicClient) throw new Error('Arc settlement data is unavailable for this work order.');
            const assignedAgent = snapshot?.agents.find((agent) => agent.agentAddress.toLowerCase() === disputeTask.agentAddress?.toLowerCase());
            const circleControlled = Boolean(
              assignedAgent?.wallet?.provider === 'CIRCLE'
              && assignedAgent.wallet.controllerAddress.toLowerCase() === connectedAddress.toLowerCase()
            );
            const isCreator = disputeTask.creatorAddress.toLowerCase() === connectedAddress.toLowerCase();
            const isDirectAgent = disputeTask.agentAddress?.toLowerCase() === connectedAddress.toLowerCase();
            if (!isCreator && !isDirectAgent && !circleControlled) throw new Error('Only the creator or assigned agent can open this dispute.');
            let pauseTransactionHash: `0x${string}` | undefined;
            if (disputeTask.status === 'STREAMING') {
              if (circleControlled && disputeTask.agentAddress) {
                const pauseRequest = await api.submitCircleAgentAction(disputeTask.agentAddress, disputeTask.id, 'PAUSE_DISPUTE');
                pauseTransactionHash = await waitForCircleTransaction(disputeTask.agentAddress, pauseRequest.id, (message) => setToast({ tone: 'success', message }));
              } else {
                if (chainId !== 5042002) await switchChainAsync({ chainId: 5042002 });
                pauseTransactionHash = await pauseArcTaskForDispute({
                  account: connectedAddress,
                  chainTaskId: disputeTask.chainTaskId,
                  publicClient: arcPublicClient,
                  walletClient: await getWalletClient(config, { chainId: 5042002 }),
                });
              }
            }
            return api.createDispute({ taskId: disputeTask.id, reason, evidence, pauseTransactionHash });
          }
          return api.createDispute({ taskId: disputeTask.id, reason, evidence });
        });
        if (succeeded) {
          setDisputeTask(null);
          changeView('disputes');
        }
      }} /> : null}
      {reviewDispute ? <HumanReviewModal dispute={reviewDispute} busy={busyKey === `review:${reviewDispute.id}`} onClose={() => setReviewDispute(null)} onSubmit={async (verdict, reasoning) => { const succeeded = await perform(`review:${reviewDispute.id}`, `Human review finalized: ${verdict.replaceAll('_', ' ')}.`, () => api.finalizeHumanReview(reviewDispute.id, { verdict, reasoning })); if (succeeded) setReviewDispute(null); }} /> : null}

      {toast ? <div className={`toast toast--${toast.tone}`} role="status">{toast.tone === 'success' ? <Check /> : <AlertTriangle />}<span>{toast.message}</span><button onClick={() => setToast(null)} type="button" aria-label="Dismiss notification"><X /></button></div> : null}
      {mobileNav ? <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} type="button" /> : null}
    </div>
  );
}
