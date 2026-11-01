import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { useTaskSummary } from '../../lib/crm/tasks';
import CrmSchoolPicker from './CrmSchoolPicker';
import { visibleSections } from './crmSections';

function NavBadge({ badge, active }) {
  if (!badge?.count) return null;
  return (
    <span
      className={cn(
        'ml-auto min-w-5 rounded-full px-1.5 py-0.5 text-center text-xs font-bold leading-none tabular-nums',
        badge.urgent ? 'bg-destructive text-destructive-foreground' : active ? 'bg-lime text-ink' : 'bg-sunken text-foreground',
      )}
      aria-label={badge.label}
    >
      {badge.count}
    </span>
  );
}

function SectionLinks({ sections, badges = {}, onNavigate }) {
  return (
    <nav aria-label="CRM sections" className="flex flex-col gap-0.5">
      {sections.map(({ key, label, icon: Icon, path }) => (
        <NavLink
          key={key}
          to={path ? `/crm/${path}` : '/crm'}
          end={!path}
          onClick={onNavigate}
          className={({ isActive }) => cn(
            'flex h-10 items-center gap-3 rounded-[10px] px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            isActive ? 'bg-ink font-bold text-lime' : 'font-medium text-foreground hover:bg-sunken',
          )}
        >
          {({ isActive }) => (
            <>
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {label}
              <NavBadge badge={badges[key]} active={isActive} />
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

export default function CrmLayout({ me, supportSchoolId, onSupportSchoolChange }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const sections = visibleSections(me.sections);
  // "My tasks" badge: overdue plus due today (D12).
  const summary = useTaskSummary(me.capabilities.includes('crm.tasks.read'));
  const due = summary ? summary.mine.overdue + summary.mine.today : 0;
  const badges = {
    tasks: {
      count: due,
      urgent: Boolean(summary?.mine.overdue),
      label: summary ? `${summary.mine.overdue} overdue, ${summary.mine.today} due today` : undefined,
    },
  };
  const current = sections.find((section) => (section.path ? location.pathname.startsWith(`/crm/${section.path}`) : location.pathname.replace(/\/$/, '') === '/crm'));

  const header = (
    <div className="flex items-center gap-3 px-1">
      <div className="min-w-0 flex-1">
        <p className="font-headline text-[22px] font-extrabold leading-none tracking-[-0.03em] text-ink">
          <span aria-hidden="true">skyll<span className="text-coral">.</span></span>
          <span className="sr-only">Skyll CRM</span>
        </p>
        <p className="mt-1 truncate text-[13px] text-foreground-secondary">{me.school?.name || 'School'}</p>
      </div>
      {me.support && <Badge variant="warning">Support</Badge>}
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground md:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col gap-5 border-r border-border bg-card px-3.5 py-5 md:flex">
        {header}
        {me.support && (
          <CrmSchoolPicker value={supportSchoolId} onChange={onSupportSchoolChange} />
        )}
        <SectionLinks sections={sections} badges={badges} />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 border-b border-border bg-card px-4 py-3 md:hidden">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{header}</div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
        {menuOpen && (
          <div className="mt-3 flex flex-col gap-3 pb-1">
            {me.support && (
              <CrmSchoolPicker value={supportSchoolId} onChange={onSupportSchoolChange} />
            )}
            <SectionLinks sections={sections} badges={badges} onNavigate={() => setMenuOpen(false)} />
          </div>
        )}
      </header>

      <main className="min-w-0 flex-1 px-4 pb-12 pt-6 md:px-10 md:pt-8">
        {current && <h1 className="mb-6 font-headline text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink md:text-[40px]">{current.label}</h1>}
        <Outlet />
      </main>
    </div>
  );
}
