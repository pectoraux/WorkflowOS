import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * WORK-074 — the customer-facing login surface.
 *
 * The primary login paths are the human identity providers WORK-063 authorized:
 * Google, GitHub, and email/password. The demo-key API-key input is REMOVED
 * from the customer-facing production login path (finding F-1 resolved). A
 * demoted "Use an API key" affordance remains for automation/service-account
 * use — API keys are STILL first-class (WORK-063 invariant #10) — but they are
 * no longer the bootstrap the customer is funneled through.
 *
 * On a successful email login/signup, the canonical {@link useAuth} state
 * updates synchronously and the App shell re-renders to show the protected
 * routes — NO manual reload (WORK-074 proof #15).
 */
export default function LoginPage() {
  const { loginWithEmail, signupWithEmail, loginWithProvider, setApiKey } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError('Email and password are required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (mode === 'signup') {
        await signupWithEmail(email.trim(), password, displayName.trim() || undefined);
      } else {
        await loginWithEmail(email.trim(), password);
      }
      // The canonical auth state updated synchronously; navigate to the app.
      navigate('/');
    } catch (err) {
      setError((err as Error).message || 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleApiKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError('API key is required');
      return;
    }
    // The backend is the authority. If the key is wrong, the first API call
    // will return 401 and the UI will show an error.
    setApiKey(apiKey.trim());
    navigate('/');
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="flex items-center justify-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <span className="font-bold">W</span>
            </div>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">WorkflowOS</h1>
          <p className="text-sm text-muted-foreground">
            Build reliable software from architecture to verified implementation.
          </p>
        </div>

        {/* OAuth/OIDC providers (Google, GitHub). */}
        <div className="space-y-3">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => loginWithProvider('google')}
            disabled={loading}
          >
            Continue with Google
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => loginWithProvider('github')}
            disabled={loading}
          >
            Continue with GitHub
          </Button>
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">or</span>
          </div>
        </div>

        {/* Email/password login or signup. */}
        <form onSubmit={handleEmailSubmit} className="space-y-4">
          {mode === 'signup' && (
            <div className="space-y-2">
              <Label htmlFor="display-name">Display name (optional)</Label>
              <Input
                id="display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                disabled={loading}
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={loading}
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={loading}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Signing in…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </Button>

          <button
            type="button"
            className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
          </button>
        </form>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">automation</span>
          </div>
        </div>

        {/* Demoted API-key path (automation / service accounts — NOT the
            customer-facing bootstrap). API keys remain first-class. */}
        {showApiKey ? (
          <form onSubmit={handleApiKeySubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="api-key">API key</Label>
              <Input
                id="api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="Enter your API key"
                disabled={loading}
                autoFocus
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" variant="secondary" className="w-full" disabled={loading}>
              {loading ? 'Signing in…' : 'Use API key'}
            </Button>
          </form>
        ) : (
          <button
            type="button"
            className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowApiKey(true)}
          >
            Use an API key instead
          </button>
        )}

        <p className="text-center text-xs text-muted-foreground">
          The backend retains all authoritative state.
        </p>
      </div>
    </div>
  );
}
