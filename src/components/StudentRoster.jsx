import React, { useState, useEffect } from 'react';
import { Search, X, CheckCircle, Clock, Flag, RotateCcw } from 'lucide-react';

export function filterAndSortStudents(students = [], searchTerm = '', sortMode = 'risk') {
  const query = searchTerm.trim().toLowerCase();
  const filtered = students.filter((s) => {
    if (!query) return true;
    const name = String(s.name || '').toLowerCase();
    const id = String(s.studentId || '').toLowerCase();
    const username = String(s.studentUsername || '').toLowerCase();
    return name.includes(query) || id.includes(query) || username.includes(query);
  });

  return [...filtered].sort((a, b) => {
    if (sortMode === 'risk') {
      // Unclear symbol-heavy answers (urgentCount) rank a student ahead of ordinary flags.
      const riskScore = (s) => (s.urgentCount || 0) * 1000 + (s.flaggedCount || 0) * 10 + (s.recheckCount || 0) * 5 + (s.pending || 0);
      const diff = riskScore(b) - riskScore(a);
      if (diff !== 0) return diff;
      const pctA = (a.marks || 0) / (a.total || 1);
      const pctB = (b.marks || 0) / (b.total || 1);
      return pctA - pctB;
    }
    if (sortMode === 'score_asc') {
      const pctA = (a.marks || 0) / (a.total || 1);
      const pctB = (b.marks || 0) / (b.total || 1);
      return pctA - pctB;
    }
    if (sortMode === 'score_desc') {
      const pctA = (a.marks || 0) / (a.total || 1);
      const pctB = (b.marks || 0) / (b.total || 1);
      return pctB - pctA;
    }
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

export function RosterSearch({ searchTerm, onSearchChange, sortMode, onSortChange, studentCount }) {
  const [localTerm, setLocalTerm] = useState(searchTerm || '');

  useEffect(() => {
    setLocalTerm(searchTerm || '');
  }, [searchTerm]);

  const handleInput = (e) => {
    const val = e.target.value;
    setLocalTerm(val);
    onSearchChange && onSearchChange(val);
  };

  const clearSearch = () => {
    setLocalTerm('');
    onSearchChange && onSearchChange('');
  };

  return (
    <div className="mb-2 space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          type="text"
          value={localTerm}
          onChange={handleInput}
          placeholder="Search students..."
          aria-label="Search student roster"
          className="h-9 w-full rounded-[10px] border border-input bg-card pl-8 pr-8 text-[13px] text-ink placeholder:text-muted-foreground hover:border-hairline-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {localTerm && (
          <button
            type="button"
            onClick={clearSearch}
            aria-label="Clear student search"
            className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 text-[12px] text-foreground-secondary">
        <span className="font-medium">Sort by</span>
        <select
          value={sortMode || 'risk'}
          onChange={(e) => onSortChange && onSortChange(e.target.value)}
          aria-label="Sort student roster"
          className="cursor-pointer rounded-md bg-transparent py-0.5 text-right font-semibold text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="risk">By Risk (Action needed)</option>
          <option value="score_asc">Score (Lowest first)</option>
          <option value="score_desc">Score (Highest first)</option>
          <option value="name_asc">Name (A-Z)</option>
        </select>
      </div>

      {typeof studentCount === 'number' && (
        <div className="text-right text-[12px] font-medium tabular-nums text-muted-foreground">
          Showing {studentCount} student{studentCount === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

export function StudentRosterCard({ student, isSelected, onSelect }) {
  const isAllReviewed = student.pending === 0 && !student.flaggedCount && !student.recheckCount;
  const displayName = String(student.name || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const scorePercent = student.total > 0 ? Math.round(((student.marks || 0) / student.total) * 100) : 0;
  const chip = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={Boolean(isSelected)}
      className={`mb-1 w-full rounded-xl bg-card text-left text-[13px] text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        isSelected
          ? 'border-2 border-ink p-[9px]'
          : 'border border-border p-2.5 hover:border-hairline-strong hover:bg-paper-soft'
      }`}
    >
      <div className="mb-1.5 flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="truncate font-bold tracking-tight">{displayName}</div>
          <div className="truncate text-[12px] text-muted-foreground">
            {student.studentUsername ? `Username: ${student.studentUsername}` : `ID: ${student.studentId}`}
          </div>
        </div>
        <div className={`rounded-lg px-2 py-0.5 text-right text-[12px] font-semibold tabular-nums ${
          scorePercent >= 75
            ? 'bg-success-soft text-success-soft-foreground'
            : scorePercent >= 40
            ? 'bg-warning-soft text-warning-soft-foreground'
            : 'bg-destructive-soft text-destructive-soft-foreground'
        }`}>
          {student.marks}/{student.total}
          <div className="text-[12px] opacity-80">{scorePercent}%</div>
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {student.pending > 0 && (
          <span className={`${chip} bg-warning-soft text-warning-soft-foreground`}>
            <Clock className="h-3 w-3" aria-hidden="true" />
            {student.pending} pending
          </span>
        )}
        {(student.flaggedCount || 0) > 0 && (
          <span className={`${chip} bg-destructive-soft text-destructive-soft-foreground`}>
            <Flag className="h-3 w-3" aria-hidden="true" />
            {student.flaggedCount} flagged
          </span>
        )}
        {(student.recheckCount || 0) > 0 && (
          <span className={`${chip} bg-info-soft text-info`}>
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            {student.recheckCount} recheck
          </span>
        )}
        {isAllReviewed && (
          <span className={`${chip} bg-success-soft text-success-soft-foreground`}>
            <CheckCircle className="h-3 w-3" aria-hidden="true" />
            Reviewed
          </span>
        )}
      </div>
    </button>
  );
}
