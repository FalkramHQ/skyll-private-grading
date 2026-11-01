import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signIn } from '../lib/session';
import { Button } from '../components/ui/Button';
import { AuthCardTitle, AuthError, AuthField, AuthInput, AuthShell, PasswordInput, authSubmitClass } from '../components/marketing/AuthShell';

export default function PartnerBLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn(username.trim().toLowerCase(), password);
      navigate('/dashboard');
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <AuthShell backTo="/" title="Partner Academy B" subtitle="Chemistry assessment report">
      <form onSubmit={submit} className="space-y-5">
        <AuthCardTitle>Sign in to your report</AuthCardTitle>
        <AuthField id="partnerb-username" label="Username">
          <AuthInput id="partnerb-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
        </AuthField>
        <AuthField id="partnerb-password" label="Password">
          <PasswordInput id="partnerb-password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        </AuthField>
        <AuthError>{error}</AuthError>
        <Button type="submit" disabled={loading} className={authSubmitClass}>{loading ? 'Signing in...' : 'View report'}</Button>
      </form>
    </AuthShell>
  );
}
