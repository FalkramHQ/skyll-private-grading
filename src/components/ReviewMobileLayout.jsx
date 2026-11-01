import React, { useState, useEffect } from 'react';
import { Users, X, ChevronLeft, ChevronRight, CheckCircle, Save } from 'lucide-react';
import { RosterSearch, StudentRosterCard, filterAndSortStudents } from './StudentRoster';
import Loader from '../components/Loader';
import { cn } from '../lib/utils';

export function useMobileLayout(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < breakpoint;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => {
      setIsMobile(window.innerWidth < breakpoint);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [breakpoint]);

  return isMobile;
}

export function MobileRosterDrawer({
  isOpen,
  onClose,
  students = [],
  selectedStudent,
  onSelectStudent,
  searchTerm,
  onSearchChange,
  sortMode,
  onSortChange,
  questionNavGrid,
}) {
  if (!isOpen) return null;

  const visibleStudents = filterAndSortStudents(students, searchTerm, sortMode);

  return (
    <div className="fixed inset-0 z-50 flex md:hidden" role="dialog" aria-modal="true" aria-label="Student roster drawer">
      <div className="fixed inset-0 bg-ink/40" onClick={onClose} aria-label="Close drawer overlay" />
      <div className="relative z-10 flex h-full w-80 max-w-[85vw] flex-col overflow-hidden border-r border-ink bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-foreground">
            <Users className="h-4 w-4" aria-hidden="true" />
            <span className="font-headline text-base font-bold tracking-tight">Student Roster</span>
            <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-bold tabular-nums text-foreground-secondary">{students.length}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close roster drawer"
            className="flex h-11 w-11 items-center justify-center rounded-[10px] text-foreground-secondary transition-colors hover:bg-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {questionNavGrid && (
          <div className="border-b border-border">
            {questionNavGrid}
          </div>
        )}

        <div className="p-3 flex-1 flex flex-col min-h-0 overflow-hidden">
          <RosterSearch
            searchTerm={searchTerm}
            onSearchChange={onSearchChange}
            sortMode={sortMode}
            onSortChange={onSortChange}
            studentCount={visibleStudents.length}
          />
          <div className="space-y-1 flex-1 overflow-y-auto pr-1 mt-1">
            {visibleStudents.map((s) => (
              <StudentRosterCard
                key={s.studentId}
                student={s}
                isSelected={selectedStudent === s.studentId}
                onSelect={() => {
                  onSelectStudent && onSelectStudent(s.studentId);
                  onClose && onClose();
                }}
              />
            ))}
            {visibleStudents.length === 0 && (
              <p className="py-8 text-center text-[13px] text-muted-foreground">No students found.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MobileActionBar({
  currentIndex = 0,
  totalItems = 0,
  onPrev,
  onNext,
  onApprove,
  onToggleRoster,
  isSaving = false,
  hasOverride = false,
  isApproved = false,
  rosterCount = 0,
}) {
  const navButton =
    'flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-hairline bg-card text-foreground transition-colors hover:bg-paper-soft disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-card px-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 md:hidden">
      <div className="mx-auto flex max-w-md items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggleRoster}
          aria-label="Toggle mobile student roster"
          className="relative flex h-11 min-w-11 shrink-0 flex-col items-center justify-center rounded-[10px] px-2 text-foreground transition-colors hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Users className="h-5 w-5" aria-hidden="true" />
          <span className="text-xs font-bold leading-tight">Roster</span>
          {rosterCount > 0 && (
            <span className="absolute -right-0.5 top-0 rounded-full bg-ink px-1.5 text-xs font-bold leading-4 tabular-nums text-white">
              {rosterCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={onPrev}
          disabled={currentIndex === 0 || isSaving}
          aria-label="Previous question"
          className={navButton}
        >
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={onApprove}
          disabled={isSaving}
          className={cn(
            'press flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[10px] border-[1.5px] border-ink px-4 text-sm font-bold shadow-hard transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            hasOverride
              ? 'bg-warning-soft text-warning-soft-foreground'
              : isApproved
              ? 'bg-action-pressed text-white'
              : 'bg-action text-white hover:bg-action-pressed'
          )}
        >
          {isSaving ? (
            <>
              <Loader size="inline" />
              <span>Saving...</span>
            </>
          ) : (
            <>
              {hasOverride ? <Save className="h-4 w-4" aria-hidden="true" /> : <CheckCircle className="h-4 w-4" aria-hidden="true" />}
              <span>{hasOverride ? 'Save Override' : 'Approve'}</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={onNext}
          disabled={currentIndex >= totalItems - 1 || isSaving}
          aria-label="Next question"
          className={navButton}
        >
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-1 text-center text-xs tabular-nums text-muted-foreground">
        Question {currentIndex + 1} of {totalItems || 1}
      </div>
    </div>
  );
}
