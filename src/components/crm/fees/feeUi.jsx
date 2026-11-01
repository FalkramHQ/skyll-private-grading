// Small pieces shared by the Fees screens (CRM M2 phase 1).
import { useState } from 'react';
import { Download, Plus, Trash2 } from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { crmDownload } from '../../../lib/crm/api';
import { PAYMENT_STATUS_LABELS, paiseToRupees, rupeesToPaise } from '../../../../shared/crm/fees.js';

/** Overdue wins over the payment status; void is muted. */
export function InvoiceStatusBadge({ invoice }) {
  if (invoice.status === 'void') return <Badge variant="secondary">Void</Badge>;
  if (invoice.overdue) return <Badge variant="destructive">Overdue</Badge>;
  if (invoice.paymentStatus === 'paid') return <Badge variant="success">Paid</Badge>;
  if (invoice.paymentStatus === 'partly_paid') return <Badge variant="warning">Partly paid</Badge>;
  return <Badge variant="outline">{PAYMENT_STATUS_LABELS[invoice.paymentStatus]}</Badge>;
}

/** Editable lines as typed: `{ label, amount }` with the amount in rupees. */
export const toEditableLines = (lines) => lines.map((line) => ({ label: line.label, amount: paiseToRupees(line.amountPaise).replace(/,/g, '') }));
export const fromEditableLines = (lines) => lines.map((line) => ({ label: line.label.trim(), amountPaise: rupeesToPaise(line.amount) ?? Number.NaN }));

export function LinesEditor({ idPrefix, lines, onChange, errors = {}, compact = false }) {
  const update = (index, key) => (event) => onChange(lines.map((line, at) => (at === index ? { ...line, [key]: event.target.value } : line)));
  return (
    <div className="space-y-2">
      {lines.map((line, index) => (
        // Lines have no id until issued; rows are only appended or removed.
        <div key={index} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Input
              aria-label={`Charge ${index + 1}`}
              id={`${idPrefix}-label-${index}`}
              maxLength={80}
              className={compact ? 'h-8 text-sm' : undefined}
              value={line.label}
              onChange={update(index, 'label')}
              aria-invalid={errors[`${index}.label`] ? true : undefined}
            />
          </div>
          <div className="w-28 shrink-0">
            <Input
              aria-label={`Amount ${index + 1} (₹)`}
              inputMode="decimal"
              className={`${compact ? 'h-8 text-sm' : ''} text-right tabular-nums`}
              value={line.amount}
              onChange={update(index, 'amount')}
              aria-invalid={errors[`${index}.amountPaise`] ? true : undefined}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={compact ? 'h-8 w-8' : undefined}
            aria-label={`Remove ${line.label || `charge ${index + 1}`}`}
            disabled={lines.length === 1}
            onClick={() => onChange(lines.filter((_, at) => at !== index))}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
      {Object.keys(errors).length > 0 && <p className="text-xs text-destructive">Each charge needs a name and an amount above zero.</p>}
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...lines, { label: '', amount: '' }])} disabled={lines.length >= 24}>
        <Plus className="mr-1 h-4 w-4" aria-hidden="true" />Add a charge
      </Button>
    </div>
  );
}

/** Zod issues under `lines.N.*` (or `invoices.I.lines.N.*`) → `{ 'N.key': message }`. */
export function lineErrors(result, prefix) {
  if (result.success) return {};
  const errors = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join('.');
    if (path.startsWith(`${prefix}.`)) errors[path.slice(prefix.length + 1)] = issue.message;
  }
  return errors;
}

export const pdfName = (number) => `${String(number).replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;
export const invoicePdfPath = (invoice) => `fees/invoices/pdf?${new URLSearchParams({ invoiceId: invoice.id })}`;
export const receiptPdfPath = (payment) => `fees/payments/receipt?${new URLSearchParams({ paymentId: payment.id })}`;

/** Downloads a fee PDF; `children` is the label (defaults to "Download PDF"). */
export function DownloadButton({ path, filename, children = 'Download PDF', variant = 'ghost', className, iconOnly = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await crmDownload(path, filename);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col">
      <Button type="button" size="sm" variant={variant} className={className} disabled={busy} onClick={download} aria-label={iconOnly ? `${children} ${filename}` : undefined}>
        <Download className={iconOnly ? 'h-4 w-4' : 'mr-1 h-4 w-4'} aria-hidden="true" />{iconOnly ? null : children}
      </Button>
      {error && <span role="alert" className="text-xs text-destructive">{error.message}</span>}
    </span>
  );
}
