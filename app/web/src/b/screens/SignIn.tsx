// Sign-in, UI only: one "Continue with Google" button, no signup and no picker. The live Google flow stays in
// src/data/auth.ts and src/screens/SignIn.tsx; the B+ demo just moves on to the Stack.
import { Icon } from '../ui';

export function SignIn({ onContinue }: { onContinue: () => void }) {
  return (
    <main className="signin" id="main" data-testid="signin">
      <div className="signin-in">
        <span className="wm wm-l" aria-hidden="true" translate="no">ari</span>
        <h1>Your LinkedIn sends, ready every morning</h1>
        <p className="signin-sub">Ari drafts each message. You send it.</p>
        <button type="button" className="btn btn-google" onClick={onContinue}><Icon name="brand-google" />Continue with Google</button>
        <p className="signin-fine">Ari reads only LinkedIn notification emails in your Gmail.</p>
      </div>
    </main>
  );
}
