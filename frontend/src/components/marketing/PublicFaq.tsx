import { ChevronDown } from 'lucide-react';
import { useLocale } from '../../locale';
import { PUBLIC_FAQ } from '../../content/publicSite';

export function PublicFaq() {
  const { t } = useLocale();

  return (
    <section className="public-faq reveal" aria-labelledby="public-faq-title">
      <header className="overview-section-heading">
        <div>
          <div className="eyebrow">{t('PRODUCT STATUS')}</div>
          <h2 id="public-faq-title">{t('Questions judges and builders ask.')}</h2>
        </div>
        <p>{t('Clear answers about deployment, custody, disputes, and external agent access.')}</p>
      </header>
      <div className="public-faq__list">
        {PUBLIC_FAQ.map((item, index) => (
          <details className="public-faq__item" key={item.question} open={index === 0}>
            <summary>
              <span>0{index + 1}</span>
              <strong>{t(item.question)}</strong>
              <ChevronDown aria-hidden="true" />
            </summary>
            <div className="public-faq__answer"><p>{t(item.answer)}</p></div>
          </details>
        ))}
      </div>
    </section>
  );
}
