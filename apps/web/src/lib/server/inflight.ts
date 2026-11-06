let count = 0;
const waiters = new Set<() => void>();

/** Marks one request as running; call the returned function when it has finished. */
export function trackRequest(): () => void {
	count++;
	let done = false;
	return () => {
		if (done) return;
		done = true;
		if (--count === 0) for (const wake of [...waiters]) wake();
	};
}

/** Resolves true once no tracked request is running, false if `timeoutMs` passes first. */
export function drainRequests(timeoutMs: number): Promise<boolean> {
	if (count === 0) return Promise.resolve(true);
	return new Promise((resolve) => {
		const wake = () => {
			clearTimeout(timer);
			waiters.delete(wake);
			resolve(true);
		};
		const timer = setTimeout(() => {
			waiters.delete(wake);
			resolve(false);
		}, timeoutMs);
		waiters.add(wake);
	});
}

export const runningRequests = () => count;
