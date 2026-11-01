import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, ChevronDown, Menu, X } from 'lucide-react';
import { Button } from './ui/Button';
import { Wordmark } from './marketing/Notebook';
import { cn } from '../lib/utils';

const NAV_LINKS = [
  { to: '/#how-it-works', label: 'How it works' },
  { to: '/learner-dna', label: 'Learner DNA' },
  { to: '/labs', label: 'AI Labs' },
  { to: '/#pilot', label: 'Pricing' },
];

const SCHOOL_LOGINS = [
  { to: '/partnerb', label: "Partner Academy B" },
  { to: '/partnerc', label: 'Partner Academy C' },
  { to: '/partnera', label: "Partner Academy A" },
  { to: '/partnerd', label: 'Partner Academy D' },
  { to: '/partnere', label: 'Partner Academy E' },
];

function isActive(to, location) {
  const [path, hash] = to.split('#');
  if (hash) return location.pathname === '/' && location.hash === `#${hash}`;
  return location.pathname === path;
}

function SchoolLoginSelect({ className = '', onNavigate }) {
  const navigate = useNavigate();
  return (
    <div className={cn('relative', className)}>
      <select
        aria-label="School login"
        className="h-10 w-full cursor-pointer appearance-none whitespace-nowrap rounded-full bg-transparent pl-3 pr-8 text-sm font-semibold text-ink transition-colors hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(e) => {
          if (!e.target.value) return;
          navigate(e.target.value);
          onNavigate?.();
          e.target.value = '';
        }}
        defaultValue=""
      >
        <option value="" disabled>School login</option>
        {SCHOOL_LOGINS.map((s) => <option key={s.to} value={s.to}>{s.label}</option>)}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink" />
    </div>
  );
}

export default function Header() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const location = useLocation();
  const close = () => setIsMobileMenuOpen(false);

  return (
    <header className="sticky top-0 z-50 border-b-2 border-ink bg-paper">
      <nav className="layout-container flex h-[70px] items-center justify-between gap-3" aria-label="Main">
        <Link to="/" className="flex shrink-0 items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={close} aria-label="Skyll home">
          <Wordmark />
        </Link>

        <div className="hidden items-center gap-1 xl:flex">
          {NAV_LINKS.map((l) => {
            const active = isActive(l.to, location);
            return (
              <Link
                key={l.to}
                to={l.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'whitespace-nowrap rounded-full px-3.5 py-2 text-[15px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'bg-ink text-lime' : 'text-ink hover:bg-sunken',
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <SchoolLoginSelect className="hidden md:block" />
          <Button asChild variant="outline" className="hidden h-11 rounded-[10px] px-4 sm:inline-flex">
            <Link to="/demo">Try the demo</Link>
          </Button>
          <Button asChild className="h-11 rounded-[10px] px-3.5 sm:px-4">
            <Link to="/partner" aria-label="Start your free trial">
              <span className="sm:hidden">Free trial</span>
              <span className="hidden sm:inline">Start your free trial</span>
              <ArrowRight className="hidden h-4 w-4 sm:block" aria-hidden="true" />
            </Link>
          </Button>
          <button
            type="button"
            className="inline-flex h-11 w-11 items-center justify-center rounded-[10px] border-[1.5px] border-ink bg-card text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:hidden"
            aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isMobileMenuOpen}
            onClick={() => setIsMobileMenuOpen((v) => !v)}
          >
            {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {isMobileMenuOpen && (
        <div className="absolute left-0 top-full w-full border-b-2 border-ink bg-paper xl:hidden">
          <div className="layout-container flex flex-col py-3">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                onClick={close}
                className="flex min-h-12 items-center border-b border-hairline font-display text-xl font-bold tracking-[-0.02em] text-ink"
              >
                {l.label}
              </Link>
            ))}
            <Link to="/demo" onClick={close} className="flex min-h-12 items-center border-b border-hairline font-display text-xl font-bold tracking-[-0.02em] text-ink sm:hidden">
              Try the demo
            </Link>
            <SchoolLoginSelect className="mt-3 w-full rounded-full border-[1.5px] border-ink bg-card md:hidden" onNavigate={close} />
          </div>
        </div>
      )}
    </header>
  );
}
