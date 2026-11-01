// Tags on a lead or student (FLKRM-326 S3, D14): coloured chips, remove with
// ×, and an inline combobox that applies an existing tag or creates one by name.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { cn } from '../../../lib/utils';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { TAG_LABEL_MAX, cleanTagLabel } from '../../../../shared/crm/tags.js';

// Palette keys → soft chip colours; archived tags are always grey and struck through.
export const TAG_STYLES = {
  gray: 'bg-muted text-foreground border-border',
  red: 'bg-red-50 text-red-800 border-red-200',
  orange: 'bg-orange-50 text-orange-800 border-orange-200',
  amber: 'bg-amber-50 text-amber-800 border-amber-200',
  green: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  teal: 'bg-teal-50 text-teal-800 border-teal-200',
  blue: 'bg-sky-50 text-sky-800 border-sky-200',
  violet: 'bg-violet-50 text-violet-800 border-violet-200',
  pink: 'bg-pink-50 text-pink-800 border-pink-200',
};

// Solid dots for the colour picker, so the soft chip colours are easy to tell apart.
export const TAG_SWATCHES = {
  gray: 'bg-stone-400',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-400',
  green: 'bg-emerald-500',
  teal: 'bg-teal-500',
  blue: 'bg-sky-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
};

export function TagChip({ tag, onRemove, disabled, className }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        tag.archived ? 'border-border bg-muted text-muted-foreground line-through' : TAG_STYLES[tag.color] || TAG_STYLES.gray,
        className,
      )}
      title={tag.archived ? `${tag.label} (archived)` : tag.label}
    >
      <span className="truncate">{tag.label}</span>
      {onRemove && (
        <button type="button" className="rounded-full opacity-70 hover:opacity-100 disabled:opacity-40" aria-label={`Remove tag ${tag.label}`} disabled={disabled} onClick={() => onRemove(tag)}>
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/** Up to `max` chips and a "+N" counter, for cards and lists. */
export function TagChips({ tags = [], max = 2 }) {
  if (!tags.length) return null;
  const shown = tags.slice(0, max);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((tag) => <TagChip key={tag.id} tag={tag} />)}
      {tags.length > max && <span className="text-xs text-muted-foreground">+{tags.length - max}</span>}
    </span>
  );
}

/**
 * Tags for one record. `onChange(tags)` receives the record's tags after each
 * write; `onError(error)` reports failures.
 */
export default function TagPicker({ entityType, entityId, tags, canWrite, onChange, onError }) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const listId = useId();

  useEffect(() => {
    if (!adding) return;
    crmFetch('tags').then((result) => setOptions(result.items)).catch(() => setOptions([]));
    inputRef.current?.focus();
  }, [adding]);

  const label = cleanTagLabel(query);
  const applied = useMemo(() => new Set(tags.map((tag) => tag.id)), [tags]);
  const matches = useMemo(() => options
    .filter((tag) => !applied.has(tag.id) && tag.label.toLowerCase().includes(label.toLowerCase()))
    .slice(0, 8), [options, applied, label]);
  const exact = options.some((tag) => tag.label.toLowerCase() === label.toLowerCase());
  const choices = [...matches.map((tag) => ({ key: tag.id, tag })), ...(label && !exact ? [{ key: 'new', create: label }] : [])];

  const write = async (path, body) => {
    setBusy(true);
    try {
      const result = await crmFetch(path, { method: 'POST', body: { entityType, entityId, ...body }, idempotencyKey: newIdempotencyKey() });
      onChange(result.items);
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const choose = async (choice) => {
    if (!choice) return;
    const ok = await write('tags/apply', choice.create ? { label: choice.create } : { tagId: choice.tag.id });
    if (ok) { setQuery(''); setActive(0); setAdding(false); }
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, choices.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(choices[active]); }
    else if (event.key === 'Escape') { setAdding(false); setQuery(''); }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Tags">
      {tags.map((tag) => (
        <TagChip key={tag.id} tag={tag} disabled={busy} onRemove={canWrite ? () => write('tags/remove', { tagId: tag.id }) : undefined} />
      ))}
      {!tags.length && !canWrite && <span className="text-xs text-muted-foreground">No tags</span>}
      {canWrite && !adding && (
        <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" aria-label="Add tag" onClick={() => setAdding(true)}>
          <Plus className="mr-1 h-3 w-3" aria-hidden="true" />Tag
        </Button>
      )}
      {canWrite && adding && (
        <div className="relative w-56">
          <Input
            ref={inputRef}
            role="combobox"
            aria-expanded={choices.length > 0}
            aria-controls={listId}
            aria-activedescendant={choices[active] ? `${listId}-${choices[active].key}` : undefined}
            aria-label="Add a tag"
            placeholder="Find or create a tag"
            className="h-8 text-xs"
            maxLength={TAG_LABEL_MAX}
            value={query}
            disabled={busy}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => { if (!busy) setAdding(false); }, 150)}
          />
          {choices.length > 0 && (
            <ul id={listId} role="listbox" className="absolute left-0 right-0 z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg">
              {choices.map((choice, index) => (
                <li
                  key={choice.key}
                  id={`${listId}-${choice.key}`}
                  role="option"
                  aria-selected={index === active}
                  className={cn('cursor-pointer rounded-md px-2 py-1.5 text-xs', index === active && 'bg-muted')}
                  onMouseDown={(event) => { event.preventDefault(); choose(choice); }}
                  onMouseEnter={() => setActive(index)}
                >
                  {choice.create ? <>Create tag &ldquo;<strong>{choice.create}</strong>&rdquo;</> : <TagChip tag={choice.tag} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
