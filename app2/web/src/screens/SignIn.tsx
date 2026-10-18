import { signIn } from '../ui/session';

export function SignIn({ error, misconfigured }: { error: string | null; misconfigured: boolean }) {
  return (
    <section aria-labelledby="h-in" className="signin">
      <header className="hd"><h1 id="h-in">Ari</h1></header>
      {misconfigured ? <p className="muted" role="alert">This preview is not set up for sign-in yet.</p> : (
        <>
          <p className="muted">Sign in with the Google account Ari knows.</p>
          <button className="btn" onClick={signIn}>Sign in with Google</button>
          {error && <p className="status" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
