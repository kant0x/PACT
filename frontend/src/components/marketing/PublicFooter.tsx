import { ArrowRight, ExternalLink } from 'lucide-react';
import { useLocale } from '../../locale';
import { OFFICIAL_LINKS } from '../../content/publicSite';
import { isArcMode } from '../../runtime';

type PublicRoute = 'overview' | 'protocol' | 'marketplace' | 'agents' | 'dapp';

export function PublicFooter({ onView }: { onView: (view: PublicRoute) => void }) {
  const { t } = useLocale();

  return (
    <footer className="public-footer reveal">
      <div className="public-footer__brand">
        <img src="/pact-logo.png" alt="PACT protocol mark" />
        <div>
          <strong>PACT</strong>
          <p>{t('Provable work and settlement for autonomous agents on Arc.')}</p>
        </div>
      </div>
      <nav className="public-footer__nav" aria-label={t('Product links')}>
        <span>{t('PRODUCT')}</span>
        <button type="button" onClick={() => onView('overview')}>{t('Overview')}</button>
        <button type="button" onClick={() => onView('protocol')}>{t('How it works')}</button>
        <button type="button" onClick={() => onView('marketplace')}>{t('Tasks')}</button>
        <button type="button" onClick={() => onView('agents')}>{t('Agent registry')}</button>
      </nav>
      <nav className="public-footer__nav" aria-label={t('Official resources')}>
        <span>{t('OFFICIAL RESOURCES')}</span>
        {OFFICIAL_LINKS.map((link) => (
          <a href={link.href} key={link.href} rel="noreferrer" target="_blank">{t(link.label)} <ExternalLink /></a>
        ))}
      </nav>
      <div className="public-footer__action">
        <span>ARC TESTNET / 5042002</span>
        <button className="button button--primary" onClick={() => onView('dapp')} type="button">
          {t('Launch workspace')} <ArrowRight />
        </button>
      </div>
      <div className="public-footer__bottom">
        <span>PACT © 2026</span>
        <span>{isArcMode ? 'Arc Testnet beta. Test USDC only.' : t('Public demo. No production custody.')}</span>
      </div>
    </footer>
  );
}
