// Sign-in screens: a centred loud card on the dot-grid notebook page.
// Shared by the school, student, review and admin login pages.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { Input } from '../ui/Input';
import { cn } from '../../lib/utils';
import { Tape, Wordmark, display } from './Notebook';

export function AuthShell({ title, subtitle, eyebrow, backTo, children, footnote }) {
  return (
    <div className="notebook-grid relative flex min-h-screen flex-col items-center justify-center px-4 py-20 sm:py-16">
      {backTo && (
        <Link
          to={backTo}
          className="press absolute left-4 top-4 flex h-11 w-11 items-center justify-center rounded-full border-2 border-ink bg-card text-ink shadow-hard-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:left-8 sm:top-8"
          aria-label="Back to home"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
      )}

      <div className="w-full max-w-[440px]">
        <div className="mb-8 text-center">
          <Wordmark className="justify-center" />
          {eyebrow && <p className="mt-6 text-[13px] font-bold uppercase tracking-[0.12em] text-foreground-secondary">{eyebrow}</p>}
          <h1 className={cn(display, 'mt-3 px-2 text-[34px] text-ink sm:text-[44px]', !eyebrow && 'mt-6')}>{title}</h1>
          {subtitle && <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-foreground-secondary">{subtitle}</p>}
        </div>

        <div className="relative rounded-[20px] border-2 border-ink bg-card p-6 shadow-hard-lg sm:p-8">
          <Tape className="-top-3.5 left-1/2 -ml-12" tilt={-3} />
          {children}
        </div>

        {footnote && <div className="mt-8 text-center text-sm text-foreground-secondary">{footnote}</div>}
      </div>
    </div>
  );
}

export function AuthCardTitle({ children }) {
  return <h2 className="font-display text-[21px] font-bold tracking-[-0.02em] text-ink">{children}</h2>;
}

export function AuthField({ id, label, children }) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-[14px] font-semibold text-ink">{label}</label>
      {children}
    </div>
  );
}

export const authInputClass = 'h-12 rounded-[10px] border-[1.5px] border-ink px-3.5 text-[15px] hover:border-ink';

export function AuthInput({ className, ...props }) {
  return <Input className={cn(authInputClass, className)} {...props} />;
}

/** Password input with a show/hide toggle that is a real 44px target. */
export function PasswordInput({ className, ...props }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input type={visible ? 'text' : 'password'} className={cn(authInputClass, 'pr-12', className)} {...props} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-foreground-secondary hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </button>
    </div>
  );
}

export function AuthError({ children }) {
  if (!children) return null;
  return (
    <div role="alert" aria-live="assertive" className="flex items-start gap-2 rounded-xl border-[1.5px] border-destructive bg-destructive-soft px-3.5 py-3 text-sm font-semibold text-destructive-soft-foreground">
      <AlertCircle className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export const authSubmitClass = 'h-12 w-full rounded-xl border-2 text-base font-bold shadow-hard-md';
