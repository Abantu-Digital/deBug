import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

const WHAT_YOU_WILL_SEE: { title: string; when: string; detail: string }[] = [
  { title: "A health wall", when: "after the first request", detail: "Every service the app calls, and the app's own code, as a box in red, orange, yellow, grey or green, worst first. Click one for what's failing, how often, and why." },
  { title: "A written summary", when: "after the first error", detail: "How many errors in the last 24 hours, the worst part of the app, the top issue and the release that's struggling, in plain sentences." },
  { title: "Incidents", when: "when several errors share a cause", detail: "Issues that failed together for the same reason, like every request failing right after the app reopens, shown as one problem with the issues inside it." },
  { title: "Issues by severity", when: "after the first error", detail: "Errors grouped by cause. Severity comes from how often each happened in the last 24 hours. Open one for the stack trace and the steps that led to it." },
  { title: "Release health", when: "as soon as the app starts", detail: "Every app launch is a session. You'll see the share of sessions per version that ran without a crash or an unhandled error." },
  { title: "Failing endpoints", when: "after the first failed request", detail: "Requests that timed out, failed or returned 5xx, captured from fetch and XHR without any code from you." },
  { title: "Where the app is failing", when: "once you tag flows", detail: "Errors by flow, like auth.login or checkout.payment. Wrap a step in deBug.track() and each flow also gets a failure rate." },
  { title: "Breakdowns", when: "after the first error", detail: "Errors split by OS, app version and device model, so you can see who is affected." },
];

/** What a new dashboard shows until the first event arrives. It reloads itself every 5 s. */
export function EmptyState() {
  // Re-run the loader every few seconds, so the first event shows up without a refresh.
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => void router.invalidate(), 5000);
    return () => clearInterval(t);
  }, [router]);
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Connected · waiting for the first event</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Your dashboard is ready, and empty for now.</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Nothing has arrived yet. Run your app with the SDK initialised, or send a test event with <code>npx debugkit test</code> (or <code>npx @debugkit/cli test</code>). This page fills in on its own.
        </p>
      </div>

      <section aria-labelledby="see-h" className="rounded-xl border border-line bg-panel p-4 sm:p-5">
        <h2 id="see-h" className="text-sm font-semibold">What you'll see here</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {WHAT_YOU_WILL_SEE.map((w) => (
            <li key={w.title} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{w.title}</span>
                <span className="text-[11px] uppercase tracking-wide text-muted">{w.when}</span>
              </div>
              <p className="mt-1 text-sm text-ink/80">{w.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="auto-h" className="rounded-xl border border-line bg-panel p-4 sm:p-5">
          <h2 id="auto-h" className="text-sm font-semibold">Recorded automatically</h2>
          <p className="mt-1 text-xs text-muted">Once <code>init()</code> runs, with no other code.</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            <li>Crashes and unhandled promise rejections</li>
            <li>Failed, timed-out and 5xx requests, with the code that made them</li>
            <li>Sessions, for crash-free rates per release</li>
            <li>Screens visited, buttons clicked, console warnings, app backgrounded or offline</li>
            <li>Device, OS, app version and network on every event</li>
          </ul>
        </section>
        <section aria-labelledby="manual-h" className="rounded-xl border border-line bg-panel p-4 sm:p-5">
          <h2 id="manual-h" className="text-sm font-semibold">What you add</h2>
          <p className="mt-1 text-xs text-muted">Only what the app can't know on its own.</p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-panel-2 p-3 text-xs leading-relaxed">{`// in a try/catch you already have
catch (err) {
  deBug.error(err, { flow: "checkout.payment", step: "charge" });
}

// success or failure of a step, plus the error
await deBug.track("auth.login", "submit_otp", () => verifyOtp(code));`}</pre>
        </section>
      </div>
    </main>
  );
}
