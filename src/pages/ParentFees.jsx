// The parent fees page (CRM M2 phase 2 S3, D10), opened from the "View fees"
// button in a WhatsApp fee message. No login: the link itself is the key. It
// shows every child this guardian pays for, with invoices and receipts to
// download and the class's payment instructions. Phone first; English or
// Hindi, following the class's message language.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, Phone } from 'lucide-react';
import { formatMoney } from '../../shared/crm/fees.js';

const TEXT = {
  en: {
    title: 'Fees', for: 'For', balance: 'Balance due', overdue: 'Overdue', credit: 'Credit', nextDue: 'Next due', invoices: 'Invoices', payments: 'Payments',
    due: 'Due', paid: 'Paid', invoice: 'Invoice', receipt: 'Receipt', howToPay: 'How to pay', contact: 'Contact', nothing: 'No fees yet.', reversed: 'Reversed',
    status: { unpaid: 'Unpaid', partly_paid: 'Part paid', paid: 'Paid' }, expires: 'This link works until', loading: 'Loading…',
    expired: 'This link has expired. Ask the class to send you a new one.', revoked: 'This link is no longer active. Ask the class to send you a new one.',
    notFound: 'This link isn’t valid. Please check you opened the whole link from the message.', busy: 'Too many requests. Please wait a minute and try again.',
    failed: 'Couldn’t load your fees. Please try again.', noChildren: 'There are no fees on this link.', defaultPay: 'Please pay at the class office.',
  },
  hi: {
    title: 'फ़ीस', for: 'के लिए', balance: 'देय राशि', overdue: 'बकाया', credit: 'जमा', nextDue: 'अगली तिथि', invoices: 'बिल', payments: 'भुगतान',
    due: 'अंतिम तिथि', paid: 'भुगतान', invoice: 'बिल', receipt: 'रसीद', howToPay: 'भुगतान कैसे करें', contact: 'संपर्क', nothing: 'अभी कोई फ़ीस नहीं।', reversed: 'रद्द',
    status: { unpaid: 'बाकी', partly_paid: 'आंशिक भुगतान', paid: 'भुगतान हो गया' }, expires: 'यह लिंक इस तारीख तक चलेगा:', loading: 'लोड हो रहा है…',
    expired: 'इस लिंक की अवधि समाप्त हो गई है। क्लास से नया लिंक माँगें।', revoked: 'यह लिंक अब सक्रिय नहीं है। क्लास से नया लिंक माँगें।',
    notFound: 'यह लिंक सही नहीं है। संदेश का पूरा लिंक खोलें।', busy: 'बहुत सारे अनुरोध। एक मिनट बाद फिर कोशिश करें।',
    failed: 'फ़ीस लोड नहीं हो सकी। फिर कोशिश करें।', noChildren: 'इस लिंक पर कोई फ़ीस नहीं है।', defaultPay: 'कृपया क्लास ऑफ़िस में भुगतान करें।',
  },
};

const ERRORS = { link_expired: 'expired', link_revoked: 'revoked', not_found: 'notFound', rate_limited: 'busy' };

function day(value, language) {
  if (!value) return '—';
  const [y, m, d] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(language === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

async function download(path, filename) {
  const response = await fetch(`/api/auth/crm/${path}`, { credentials: 'omit' });
  if (!response.ok) throw new Error('Download failed');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-xl bg-[#F3F5F4] p-3">
      <p className="text-xs text-[#5F6B66]">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tone || ''}`}>{value}</p>
    </div>
  );
}

function Child({ child, t, language, token }) {
  const q = (extra) => new URLSearchParams({ token, ...extra }).toString();
  return (
    <section className="space-y-4 rounded-2xl border border-[#D8DDDA] bg-white p-4 shadow-sm" aria-label={child.name}>
      <h2 className="text-lg font-semibold">{child.name}</h2>
      <div className="grid grid-cols-2 gap-2">
        <Stat label={t.balance} value={formatMoney(child.summary.balancePaise)} />
        <Stat label={t.overdue} value={formatMoney(child.summary.overduePaise)} tone={child.summary.overduePaise ? 'text-[#C62828]' : ''} />
        {child.summary.creditPaise > 0 && <Stat label={t.credit} value={formatMoney(child.summary.creditPaise)} tone="text-[#1B6B47]" />}
        <Stat label={t.nextDue} value={child.summary.nextDue ? day(child.summary.nextDue.dueDate, language) : '—'} />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold text-[#5F6B66]">{t.invoices}</h3>
        {child.invoices.length ? (
          <ul className="divide-y divide-[#E6E9E7]">
            {child.invoices.map((invoice) => (
              <li key={invoice.id} className="flex items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{invoice.lines?.[0]?.label || invoice.number}</p>
                  <p className="text-xs text-[#5F6B66]">{t.due} {day(invoice.dueDate, language)} · {invoice.number}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold tabular-nums">{formatMoney(invoice.balancePaise || invoice.totalPaise)}</p>
                  <p className={`text-xs ${invoice.overdue ? 'text-[#C62828]' : 'text-[#5F6B66]'}`}>{invoice.overdue ? t.overdue : t.status[invoice.paymentStatus]}</p>
                </div>
                <button type="button" className="rounded-full p-2 text-[#14211C] hover:bg-[#F3F5F4]" aria-label={`${t.invoice} ${invoice.number}`} onClick={() => download(`public/fees/invoice?${q({ invoiceId: invoice.id })}`, `${invoice.number.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`)}>
                  <Download className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-[#5F6B66]">{t.nothing}</p>}
      </div>
      {child.payments.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-[#5F6B66]">{t.payments}</h3>
          <ul className="divide-y divide-[#E6E9E7]">
            {child.payments.map((payment) => (
              <li key={payment.id} className="flex items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className={`font-medium tabular-nums ${payment.reversed ? 'line-through' : ''}`}>{formatMoney(payment.amountPaise)}</p>
                  <p className="text-xs text-[#5F6B66]">{day(payment.receivedOn, language)} · {payment.method}{payment.reversed ? ` · ${t.reversed}` : ''}</p>
                </div>
                <button type="button" className="rounded-full p-2 text-[#14211C] hover:bg-[#F3F5F4]" aria-label={`${t.receipt} ${payment.receiptNumber}`} onClick={() => download(`public/fees/receipt?${q({ paymentId: payment.id })}`, `${payment.receiptNumber.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`)}>
                  <Download className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function ParentFees() {
  const { token } = useParams();
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  useEffect(() => {
    let live = true;
    // Keep this private page out of search engines and referrers.
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    fetch(`/api/auth/crm/public/fees?${new URLSearchParams({ token })}`, { credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!live) return;
        if (response.ok) setState({ status: 'ready', data: body, error: null });
        else setState({ status: 'error', data: null, error: ERRORS[body?.error?.code] || 'failed' });
      })
      .catch(() => live && setState({ status: 'error', data: null, error: 'failed' }));
    return () => { live = false; meta.remove(); };
  }, [token]);

  const language = state.data?.language === 'hi' ? 'hi' : 'en';
  const t = TEXT[language];
  return (
    <main className="min-h-screen bg-[#F7F5EF] px-4 py-6 text-[#14211C]">
      <div className="mx-auto max-w-lg space-y-4">
        {state.status === 'loading' && <p className="text-sm text-[#5F6B66]">{TEXT.en.loading}</p>}
        {state.status === 'error' && (
          <div className="rounded-2xl border border-[#D8DDDA] bg-white p-5 text-sm" role="alert">
            <p className="font-semibold">{TEXT.en[state.error]}</p>
            <p className="mt-1 text-[#5F6B66]">{TEXT.hi[state.error]}</p>
          </div>
        )}
        {state.status === 'ready' && (
          <>
            <header className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#5F6B66]">{t.title}</p>
              <h1 className="text-2xl font-bold">{state.data.school.name}</h1>
              {state.data.guardianName && <p className="text-sm text-[#5F6B66]">{state.data.guardianName}</p>}
            </header>
            {state.data.children.length ? state.data.children.map((child) => <Child key={child.name} child={child} t={t} language={language} token={token} />) : <p className="text-sm">{t.noChildren}</p>}
            <section className="space-y-2 rounded-2xl border border-[#D8DDDA] bg-white p-4 text-sm">
              <h2 className="font-semibold">{t.howToPay}</h2>
              <p className="whitespace-pre-line">{state.data.paymentInstructions || t.defaultPay}</p>
              {(state.data.contactLine || state.data.school.phone) && (
                <p className="flex items-center gap-2 text-[#5F6B66]"><Phone className="h-4 w-4" aria-hidden /> {t.contact}: {state.data.contactLine || state.data.school.phone}</p>
              )}
            </section>
            <p className="text-center text-xs text-[#5F6B66]">{t.expires} {day(state.data.expiresAt.slice(0, 10), language)}</p>
          </>
        )}
      </div>
    </main>
  );
}
