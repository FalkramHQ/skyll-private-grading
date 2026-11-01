// Settings → Tags (FLKRM-326 S3, D14): create, rename, recolour, archive and
// restore the school's tags. Archived tags stay on records, greyed out.
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Skeleton } from '../ui/Skeleton';
import { cn } from '../../lib/utils';
import { crmFetch, newIdempotencyKey } from '../../lib/crm/api';
import { useDraft } from '../../lib/crm/useDraft';
import { TAG_COLORS, TAG_LABEL_MAX, cleanTagLabel, tagLabelField } from '../../../shared/crm/tags.js';
import { TAG_SWATCHES, TagChip } from './records/TagPicker';

function ColorSwatches({ value, onChange, disabled, label }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={label}>
      {TAG_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          title={color}
          disabled={disabled}
          onClick={() => onChange(color)}
          className={cn('h-5 w-5 rounded-full border border-white/60', TAG_SWATCHES[color], value === color && 'ring-2 ring-ring ring-offset-2')}
        />
      ))}
    </div>
  );
}

function TagRow({ tag, busy, onSave, onArchive }) {
  const [label, setLabel] = useDraft(tag.label);
  const clean = cleanTagLabel(label);
  const renamed = clean && clean !== tag.label && tagLabelField.safeParse(clean).success;

  return (
    <li className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
      <div className="w-full lg:w-44"><TagChip tag={{ ...tag, label: clean || tag.label }} /></div>
      {tag.archived ? (
        <p className="flex-1 text-sm text-muted-foreground">Archived. Still shown on {tag.usage} record{tag.usage === 1 ? '' : 's'}; can&apos;t be added again.</p>
      ) : (
        <>
          <form className="flex flex-1 gap-2" onSubmit={(event) => { event.preventDefault(); if (renamed) onSave(tag, { label: clean }); }}>
            <Input aria-label={`Name of tag ${tag.label}`} value={label} maxLength={TAG_LABEL_MAX} disabled={busy} onChange={(event) => setLabel(event.target.value)} className="h-9" />
            {renamed && <Button type="submit" size="sm" disabled={busy}>Save</Button>}
          </form>
          <ColorSwatches label={`Colour of tag ${tag.label}`} value={tag.color} disabled={busy} onChange={(color) => color !== tag.color && onSave(tag, { color })} />
          <span className="text-xs text-muted-foreground lg:w-24">{tag.usage} record{tag.usage === 1 ? '' : 's'}</span>
        </>
      )}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => onArchive(tag, !tag.archived)}>
        {tag.archived ? 'Restore' : 'Archive'}
      </Button>
    </li>
  );
}

export default function TagSettings() {
  const [state, setState] = useState({ status: 'loading', tags: [], error: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState('gray');

  const load = useCallback(async () => {
    try {
      const result = await crmFetch('tags?includeArchived=true');
      setState({ status: 'ready', tags: result.items, error: null });
    } catch (err) {
      setState({ status: 'error', tags: [], error: err });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const write = async (path, body) => {
    setBusy(true);
    setError(null);
    try {
      await crmFetch(path, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
      await load();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'loading') return <Skeleton className="h-48 w-full" />;
  if (state.status === 'error') return <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>;

  const clean = cleanTagLabel(newLabel);
  const canCreate = tagLabelField.safeParse(clean).success;
  const active = state.tags.filter((tag) => !tag.archived);
  const archived = state.tags.filter((tag) => tag.archived);
  const rows = (tags) => tags.map((tag) => (
    <TagRow
      key={`${tag.id}:${tag.label}:${tag.color}:${tag.archived}`}
      tag={tag}
      busy={busy}
      onSave={(item, changes) => write('settings/tags/update', { tagId: item.id, ...changes })}
      onArchive={(item, value) => write('settings/tags/archive', { tagId: item.id, archived: value })}
    />
  ));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Tags help your team group leads and students. Anyone who can edit a record can add tags to it, and create new ones by typing a name.
      </p>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-center"
        onSubmit={async (event) => {
          event.preventDefault();
          if (canCreate && await write('settings/tags', { label: clean, color: newColor })) { setNewLabel(''); setNewColor('gray'); }
        }}
      >
        <Input aria-label="New tag name" placeholder="New tag, e.g. Sibling discount" value={newLabel} maxLength={TAG_LABEL_MAX} onChange={(event) => setNewLabel(event.target.value)} className="sm:max-w-xs" />
        <ColorSwatches label="Colour of new tag" value={newColor} onChange={setNewColor} disabled={busy} />
        <Button type="submit" disabled={busy || !canCreate}>Add tag</Button>
      </form>
      {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
      <Card>
        {active.length
          ? <ul className="divide-y divide-border" aria-label="Active tags">{rows(active)}</ul>
          : <p className="p-4 text-sm text-muted-foreground">No tags yet.</p>}
      </Card>
      {archived.length > 0 && (
        <section className="space-y-2" aria-label="Archived tags">
          <h3 className="text-sm font-semibold text-foreground">Archived</h3>
          <Card><ul className="divide-y divide-border">{rows(archived)}</ul></Card>
        </section>
      )}
    </div>
  );
}
