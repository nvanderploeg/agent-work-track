export interface SessionUser {
	uid: string;
	email: string | null;
	name: string | null;
	picture: string | null;
}

interface WebConfig {
	apiKey: string;
	authDomain: string;
	projectId: string;
	appId?: string;
}

const EMAIL_KEY = 'chronicle.emailForSignIn';

class Session {
	user = $state<SessionUser | null>(null);
	config = $state<WebConfig | null>(null);
	ready = $state(false);
	private loading: Promise<void> | undefined;

	/** Asks the server who is signed in; later calls share the first answer. */
	load(): Promise<void> {
		this.loading ??= this.refresh();
		return this.loading;
	}

	async refresh(): Promise<void> {
		try {
			const [me, config] = await Promise.all([fetch('/api/me'), fetch('/api/auth/config')]);
			if (me.ok) this.user = (await me.json()).user;
			this.config = config.ok ? await config.json() : null;
		} finally {
			this.ready = true;
		}
	}

	private async auth() {
		if (!this.config) throw new Error('Sign-in is not available on this server.');
		const [{ getApp, getApps, initializeApp }, firebase] = await Promise.all([
			import('firebase/app'),
			import('firebase/auth')
		]);
		const app = getApps().length ? getApp() : initializeApp(this.config);
		return { auth: firebase.getAuth(app), firebase };
	}

	// The server's session cookie is the only login; the browser SDK's own state is dropped.
	private async exchange(
		auth: Awaited<ReturnType<Session['auth']>>['auth'],
		firebase: Awaited<ReturnType<Session['auth']>>['firebase'],
		credential: { user: { getIdToken(): Promise<string> } }
	): Promise<void> {
		const idToken = await credential.user.getIdToken();
		const res = await fetch('/api/auth/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ idToken })
		});
		await firebase.signOut(auth);
		if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Sign-in failed.');
		this.user = (await res.json()).user;
	}

	async signInWithGoogle(): Promise<void> {
		const { auth, firebase } = await this.auth();
		await this.exchange(
			auth,
			firebase,
			await firebase.signInWithPopup(auth, new firebase.GoogleAuthProvider())
		);
	}

	async sendEmailLink(email: string): Promise<void> {
		const { auth, firebase } = await this.auth();
		await firebase.sendSignInLinkToEmail(auth, email, {
			url: `${location.origin}/login`,
			handleCodeInApp: true
		});
		localStorage.setItem(EMAIL_KEY, email);
	}

	/** True when the current URL is a sign-in link from an email. */
	async isEmailLink(): Promise<boolean> {
		const { auth, firebase } = await this.auth();
		return firebase.isSignInWithEmailLink(auth, location.href);
	}

	rememberedEmail(): string {
		return localStorage.getItem(EMAIL_KEY) ?? '';
	}

	async completeEmailLink(email: string): Promise<void> {
		const { auth, firebase } = await this.auth();
		await this.exchange(
			auth,
			firebase,
			await firebase.signInWithEmailLink(auth, email, location.href)
		);
		localStorage.removeItem(EMAIL_KEY);
	}

	async signOut(): Promise<void> {
		await fetch('/api/auth/session', { method: 'DELETE' });
		this.user = null;
	}
}

export const session = new Session();
