import { Link } from 'react-router-dom';
import AppStoreBadges from './AppStoreBadges';
import { Wordmark } from './marketing/Notebook';

const PRODUCT_LINKS = [
  { to: '/#how-it-works', label: 'How it works' },
  { to: '/learner-dna', label: 'Learner DNA' },
  { to: '/demo', label: 'Try the demo' },
  { to: '/labs', label: 'Skyll AI Labs' },
  { to: '/partner', label: 'Start your free trial' },
];

const LEGAL_LINKS = [
  { to: '/privacy', label: 'Privacy Notice' },
  { to: '/dpdp-compliance', label: 'DPDP Act Compliance' },
  { to: '/account-deletion', label: 'Account & Data Deletion' },
  { to: '/terms-of-service', label: 'Terms of Service' },
  { to: '/grievance-officer', label: 'Grievance Officer' },
];

const linkClass = 'w-fit rounded text-[15px] font-medium text-ink underline decoration-transparent decoration-2 underline-offset-4 transition-colors hover:decoration-lime focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function LinkColumn({ title, links }) {
  return (
    <div className="flex flex-col gap-3">
      <h4 className="mb-1 text-[13px] font-bold uppercase tracking-[0.12em] text-foreground-secondary">{title}</h4>
      {links.map((l) => (
        <Link key={l.to} to={l.to} className={linkClass}>{l.label}</Link>
      ))}
    </div>
  );
}

export default function Footer() {
  return (
    <footer className="border-t-2 border-ink bg-paper text-ink">
      <div className="layout-container pt-14 pb-8">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 md:grid-cols-4 md:gap-12">
          <div className="flex flex-col gap-4 sm:col-span-2">
            <Wordmark />
            <p className="max-w-md text-[15px] leading-relaxed text-foreground-secondary">
              Handwritten exams scanned on your campus, marked by AI, checked by Skyll’s reviewers, and turned into reports every student, parent and teacher can act on.
            </p>
            <a href="mailto:office@skyllai.com" className={`${linkClass} font-semibold`}>
              office@skyllai.com
            </a>
            <p className="text-[15px] text-foreground-secondary">
              A <a href="https://www.falkram.com" target="_blank" rel="noopener noreferrer" className="font-semibold text-ink underline decoration-ink/30 decoration-2 underline-offset-4 transition-colors hover:decoration-lime">Falkram</a> product.
            </p>
          </div>

          <LinkColumn title="Product" links={PRODUCT_LINKS} />
          <LinkColumn title="Legal & Trust" links={LEGAL_LINKS} />
        </div>

        <div id="app-download-section" className="mt-12 flex flex-col items-start justify-between gap-5 rounded-2xl border-2 border-ink bg-card p-5 sm:flex-row sm:items-center sm:p-6">
          <div>
            <p className="font-display text-lg font-bold tracking-[-0.02em] text-ink">Skyll Intake for scanning teams</p>
            <p className="text-sm text-foreground-secondary">The Android app your staff use to scan answer sheets.</p>
          </div>
          <AppStoreBadges />
        </div>

        <p aria-hidden="true" className="mt-12 select-none font-display text-[clamp(72px,19vw,220px)] font-extrabold leading-[0.8] tracking-[-0.06em] text-ink">
          Skyll<span className="text-coral">.</span>
        </p>

        <div className="mt-6 flex flex-col gap-2 border-t-2 border-ink pt-5 text-[13px] text-foreground-secondary md:flex-row md:items-center md:justify-between">
          <p>© {new Date().getFullYear()} Skyll AI. All rights reserved.</p>
          <p>Built in line with the DPDP Act 2023 and the IT Act 2000.</p>
        </div>
      </div>
    </footer>
  );
}
