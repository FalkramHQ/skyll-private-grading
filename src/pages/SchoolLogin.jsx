import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signIn, signOut } from '../lib/session';
import { Button } from '../components/ui/Button';
import { AuthCardTitle, AuthError, AuthField, AuthInput, AuthShell, PasswordInput, authSubmitClass } from '../components/marketing/AuthShell';

export default function SchoolLogin({ school, subtitle = 'Assessment reports' }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function submit(event) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await signIn(username.trim().toLowerCase(), password);
      if (user.school !== school) {
        await signOut();
        throw new Error(`These credentials belong to a different school portal.`);
      }
      navigate('/dashboard');
    } catch (err) {
      setError(err.message || 'Unable to sign in');
      setLoading(false);
    }
  }

  return (
    <AuthShell backTo="/" title={school} subtitle={subtitle}>
      <form onSubmit={submit} className="space-y-5">
        <AuthCardTitle>Sign in to Skyll</AuthCardTitle>
        <AuthField id="school-username" label="Username">
          <AuthInput id="school-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
        </AuthField>
        <AuthField id="school-password" label="Password">
          <PasswordInput id="school-password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        </AuthField>
        <AuthError>{error}</AuthError>
        <Button type="submit" disabled={loading} className={authSubmitClass}>{loading ? 'Signing in...' : 'View reports'}</Button>
      </form>
    </AuthShell>
  );
}
