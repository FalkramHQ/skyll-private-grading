import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Info } from 'lucide-react';
import { signIn } from '../lib/session';
import { Button } from '../components/ui/Button';
import { AuthError, AuthField, AuthInput, AuthShell, PasswordInput, authSubmitClass } from '../components/marketing/AuthShell';

export default function ReviewLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const user = await signIn(username.trim().toLowerCase(), password, { allowedRoles: ['teacher', 'admin', 'skyll_admin', 'staff'] });
      // Office staff only have the CRM.
      const from = user?.role === 'staff' ? '/crm' : new URLSearchParams(location.search).get('from') || '/review';
      navigate(from);
      return;
    } catch (err) {
      setError(err.message);
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      eyebrow="For teachers and school admins"
      title="Review Portal"
      subtitle="Sign in with your teacher or school admin credentials to review graded answers"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <AuthField id="review-username" label="Username">
          <AuthInput
            id="review-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. partnerg_teacher, admin, skyll_admin"
            autoComplete="username"
            required
          />
        </AuthField>

        <AuthField id="review-password" label="Password">
          <PasswordInput
            id="review-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            autoComplete="current-password"
            required
          />
        </AuthField>

        <AuthError>{error}</AuthError>

        <Button type="submit" disabled={isLoading} className={authSubmitClass}>
          {isLoading ? 'Signing in...' : 'Sign In'}
        </Button>
      </form>

      <div className="mt-6 flex items-start gap-2.5 border-t border-hairline pt-5 text-[13px] leading-relaxed text-foreground-secondary">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink" aria-hidden="true" />
        <p>Teachers and school admins see only their school's cohorts. Skyll admins can review all schools.</p>
      </div>
    </AuthShell>
  );
}
