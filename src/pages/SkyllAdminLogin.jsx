import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { signIn, signOut } from '../lib/session';
import { Button } from '../components/ui/Button';
import { AuthError, AuthField, AuthInput, AuthShell, PasswordInput, authSubmitClass } from '../components/marketing/AuthShell';

export default function SkyllAdminLogin() {
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
      const user = await signIn(username.trim().toLowerCase(), password, { allowedRoles: ['skyll_admin'] });
      if (user?.role !== 'skyll_admin') {
        await signOut();
        throw new Error('This account does not have Skyll platform administrator access.');
      }
      const from = new URLSearchParams(location.search).get('from') || '/admin-dashboard';
      navigate(from);
    } catch (err) {
      setError(err.message || 'Unable to sign in');
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      eyebrow="Authorized staff only"
      title="Skyll Admin Portal"
      subtitle="Internal review dashboard."
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <AuthField id="skyll-admin-username" label="Admin Username">
          <AuthInput
            id="skyll-admin-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter admin username"
            autoComplete="username"
            required
          />
        </AuthField>

        <AuthField id="skyll-admin-password" label="Password">
          <PasswordInput
            id="skyll-admin-password"
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
    </AuthShell>
  );
}
