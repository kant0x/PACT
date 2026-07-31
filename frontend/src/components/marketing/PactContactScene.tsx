import type { ReactNode } from 'react';

export function PactContactScene({ children }: { children: ReactNode }) {
  return (
    <section className="pact-contact-scene pact-contact-scene--hero" aria-label="PACT human and agent settlement">
      <div className="pact-contact-scene__field" aria-hidden="true" />
      <img className="pact-contact-scene__hand pact-contact-scene__hand--machine" src="/pact-machine-hand.png" alt="" aria-hidden="true" />
      <img className="pact-contact-scene__hand pact-contact-scene__hand--human" src="/pact-human-hand.png" alt="" aria-hidden="true" />
      <div className="pact-contact-scene__content">{children}</div>
      <div className="pact-contact-scene__index" aria-hidden="true"><span>HUMAN</span><i /><span>AGENT</span></div>
    </section>
  );
}
