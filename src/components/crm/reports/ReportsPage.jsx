// Reports hub — /crm/reports. Filters scan cohort performance after an exam:
// batch (active batches only), exam (released exams only), and a name/search
// box. Published reports render as a score table; clicking a row opens the
// shared ReportViewPanel in place. Reads come from canonical tables only.

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Card, CardContent } from '../../ui/Card';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { Alert, AlertDescription } from '../../ui/Alert';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { ReportCard, ReportCardItem } from './ReportCard';
import { ReportViewPanel } from './ReportViewPanel';

const FILTER_DEBOUNCE = 300;

function sortKey(item) {
  // Newest first, then by score desc as a stable tiebreak.
  return [item.publishedAt ? -new Date(item.publishedAt).getTime() : 0, -(item.score ?? 0)];
}

export default function ReportsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [batches, setBatches] = useState([]);
  const [exams, setExams] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState('');
  const [selectedExam, setSelectedExam] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [expanded, setExpanded] = useState(null); // submissionId of the expanded report
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadOptions = useCallback(async () => {
    try {
      const batchRes = await crmFetch('classes/batches', { schoolId: getSupportSchoolId() });
      setBatches((batchRes?.items || []).map((b) => ({ id: b.id, name: b.name })));
      // Exams fallback to a no-op set when not available.
      setExams([]);
    } catch {
      setBatches([]);
      setExams([]);
    }
  }, []);

  const loadReports = useCallback(
    async (cursor) => {
      const params = new URLSearchParams({
        limit: '50',
        batchId: selectedBatch || '',
        examId: selectedExam || '',
        q: debouncedSearch || '',
      });
      if (cursor) params.set('cursor', cursor);

      try {
        const res = await crmFetch(`reports/list?${params.toString()}`, {
          schoolId: getSupportSchoolId(),
          idempotencyKey: newIdempotencyKey(),
        });
        setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
        setNextCursor(res.nextCursor || null);
        setError(null);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
        setIsRefreshing(false);
      }
    },
    [selectedBatch, selectedExam, debouncedSearch]
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    await loadReports();
  }, [loadReports]);

  const debouncedRef = useCallback(
    (v) => {
      clearTimeout(window.__reportsSearchTid);
      window.__reportsSearchTid = setTimeout(() => setDebouncedSearch(v), FILTER_DEBOUNCE);
    },
    []
  );

  useEffect(() => {
    loadOptions();
    loadAll();
  }, [loadOptions, loadAll]);

  useEffect(() => {
    if (!loading && !nextCursor && !error && search) {
      loadAll();
    }
  }, [debouncedSearch, loadAll, loading, nextCursor, error, search]);

  useEffect(() => {
    // Batch/exam filter resets and reloads.
    if (!loading) loadAll();
  }, [selectedBatch, selectedExam, loading, loadAll]);

  const onRefresh = async () => {
    setIsRefreshing(true);
    await loadAll();
  };

  const expandRow = useCallback((submissionId) => {
    setExpanded((prev) => (prev === submissionId ? null : submissionId));
  }, []);

  const hasProgress = items.length > 0;

  if (loading && items.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-9 w-64" />
        </div>
        <ReportCard.Skeleton rows={5} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filter bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-0">
              <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                Search
              </label>
              <input
                type="text"
                placeholder="Search students by name or roster key"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  debouncedRef(e.target.value);
                }}
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none ring-0 focus:border-action placeholder:text-muted-foreground"
              />
            </div>
            <div className="flex-1 min-w-0">
              <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                Batch
              </label>
              <Select
                value={selectedBatch}
                onChange={(e) => setSelectedBatch(e.target.value)}
              >
                <option value="">All batches</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex-1 min-w-0">
              <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                Exam
              </label>
              <Select
                value={selectedExam}
                onChange={(e) => setSelectedExam(e.target.value)}
              >
                <option value="">All exams</option>
                {exams.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={isRefreshing || loading}
                aria-label="Refresh reports"
              >
                {isRefreshing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message || 'Failed to load reports.'}</AlertDescription>
        </Alert>
      )}

      {!hasProgress && !loading && (
        <Card>
          <CardContent className="p-8 text-center">
            {search ? (
              <p className="text-sm text-muted-foreground">
                No published reports match your search.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No published reports match your filters — results will appear once an exam is
                published.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {hasProgress && (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-ink">
              Published reports ({items.length})
            </h2>
            {nextCursor && (
              <Button variant="outline" size="sm" onClick={() => loadReports(nextCursor)}>
                Load more
              </Button>
            )}
          </div>

          <div className="space-y-3">
            {items
              .slice()
              .sort((a, b) => sortKey(a) - sortKey(b))
              .map((item) => (
                <div
                  key={item.submissionId}
                  className={expanded === item.submissionId ? 'space-y-3' : ''}
                >
                  <ReportCardItem
                    item={{
                      ...item,
                      className: '',
                      reportPublished: item.reportPublished ?? true,
                    }}
                    compact={true}
                    onClick={() => expandRow(item.submissionId)}
                  />
                  {expanded === item.submissionId && (
                    <ReportCard
                      item={{
                        ...item,
                        examName: item.examName,
                        subject: item.subject,
                        batchName: item.batchName,
                        date: item.publishedAt,
                        score: item.score,
                        maxMarks: item.maxMarks,
                        reviewPending: item.reviewPending,
                        reportPublished: item.reportPublished ?? true,
                        caveat: null,
                        className: '',
                      }}
                      compact={false}
                      showHeader={true}
                    />
                  )}
                </div>
              ))}
          </div>
        </>
      )}

      </div>
  );
}

function getSupportSchoolId() {
  try {
    return sessionStorage.getItem('skyll.crm.supportSchoolId') || '';
  } catch {
    return '';
  }
}
