# AGENTS.md - Permanent Android App Factory Rules

These rules apply to every Android app built in this environment.
They are permanent instructions for OpenCode sessions working in this project
or any app scaffolded from it.

## THE CORE RULE

**The user provides ONE SIMPLE IDEA. OpenCode provides THE COMPLETE APP.**

"Build a calculator.", "Build a hymn app.", "Build a money management app." -
each of these is enough. OpenCode must independently design, decide, and
deliver a polished, production-quality app without asking the user to explain
screens, colors, fonts, navigation, buttons, layouts, storage, icons,
animations, features, package name, versioning, architecture, testing, GitHub
or build configuration.

A short idea is NEVER interpreted as a request for a prototype or demo unless
the user explicitly says "prototype", "demo", or "simple version".

Default standard: **PROFESSIONAL - POLISHED - COMPLETE - USEFUL - REAL-WORLD READY**

## AUTOMATIC PRODUCT DESIGN (before any code)

Act as a professional product designer + senior Android developer and decide:

1. Purpose and target users
2. Minimum complete feature set for a genuinely useful first release
3. Screen structure, navigation, interaction patterns
4. Data model / storage (offline-first where appropriate)
5. Colors, typography, spacing, visual hierarchy
6. Buttons/controls, touch targets, accessibility
7. Empty states, error states, loading states
8. Permissions only when genuinely necessary
9. App icon concept matching purpose and name
10. Professional app name when the user gave only a generic description
    (e.g. "build a calculator" -> "CalcPro"); ask only on naming with real
    business/legal implications
11. Onboarding/help only when useful

Do NOT ask the user questions like "what color?", "how many screens?",
"should I use a database?" - make sensible professional decisions. Ask only
when proceeding could produce a fundamentally wrong application.

### Quality bar

- Never ship a bare-minimum demonstration just because the request was short.
  A calculator request means history/memory/% /negatives/polish where useful -
  not just digits and operators.
- Equally: do not bloat. Focused beats feature-dumped. Include only what makes
  sense for THIS app.
- Every screen must handle empty/error/loading gracefully and look right in
  light and dark modes.

## THE MANDATORY WORKFLOW

```
APP IDEA -> AUTOMATIC PRODUCT ANALYSIS -> AUTOMATIC UX/UI DESIGN
-> AUTOMATIC FEATURE PLAN -> AUTOMATIC ICON DESIGN -> IMPLEMENTATION
-> LIGHTWEIGHT LOCAL VALIDATION (tests; local build only when useful)
-> GIT COMMIT -> GITHUB PUSH -> GITHUB ACTIONS FINAL BUILD (default builder)
-> CLOUD APK VERIFICATION + DOWNLOAD
-> GITHUB RELEASE PUBLISH (verified asset) -> PRESENT DOWNLOAD LINK
-> USER PRESSES LINK -> DEFAULT BROWSER DOWNLOADS -> USER INSTALLS
```

## Build system rules

- Use the existing lightweight Node.js + Android SDK CLI build system
  (`build.js` driving `aapt`, `javac`, `d8`, zipalign, `apksigner`).
- Never require Gradle, Kotlin, Android Studio, Replit, or a PC.
- Do not replace working build infrastructure without a technical reason.
- Avoid unnecessary npm dependencies; zero is the default.
- New apps target **Android 8.0 / API 26+** unless the app requires otherwise.
- Support ARM devices appropriately (the local device is aarch64); keep build
  tooling architecture-portable (see `tools/zipalign.js` fallback pattern).
- Keep apps permission-free unless genuinely required by features.
- Prefer offline-first operation and low memory/storage usage.

## Thermal-safe cloud-first build policy

GitHub Actions is the DEFAULT builder for every FINAL APK. Local Android
builds stress the phone (CPU/heat), so they are the exception, not the rule.

```
IDEA -> DESIGN -> CODE -> LOCAL LIGHTWEIGHT VALIDATION
-> GIT PUSH -> GITHUB ACTIONS FINAL BUILD -> VERIFY ARTIFACT
-> GITHUB RELEASE PUBLISH -> DOWNLOAD AVAILABLE (user downloads)
```

- The final published APK must be the verified GitHub Actions artifact
  whenever one is available: `npm run cloud` waits for the Actions run of
  the current commit, downloads the artifact and verifies badging, package,
  version, permission allow-list and signature into `dist/`. Never substitute
  an unverified local APK when a verified cloud APK exists.
- Local builds are allowed only for: fast development feedback, diagnosing a
  build problem, validating a small change, or checking the project before a
  push. Do not repeatedly rebuild the whole app locally when Actions can do
  the final build. No Replit. No paid services.
- Single-build rule: `build.js` holds a factory-wide lock
  (`appfactory-android-build.lock`) - it refuses to start while another
  factory Android build is alive and waits/reuses instead. Never launch
  competing Gradle/Android build processes.
- Wall-clock protection: a local build aborts cleanly after
  `OPENCODE_LOCAL_BUILD_TIMEOUT` seconds (default 900) with instructions to
  push and let Actions finish the job. Do not immediately start an identical
  rebuild; prefer pushing the current state.
- NEVER bypass, disable or work around Android thermal management. If builds
  get abnormally slow/hot/failing, stop local building entirely and rely on
  GitHub Actions until conditions change.
- Resource hygiene: no unnecessary background processes, dependency
  downloads or build caches; clean only when useful. Correctness always wins
  over CPU savings - do not skip verification steps to stay cool.
- Failure fallback: if Actions fails, inspect CI logs, fix the source within
  the max-3 automatic repair attempts, push again. Use a local full build
  only when genuinely needed to diagnose. No infinite local/cloud retry
  cycles.

## App identity rules

- Package name: `com.nonhlanhla1966.<appname>` - lowercase, valid Java package
  syntax, no spaces or invalid characters, unique per app, never reuse an
  existing app's package name. `tools/scaffold.js` enforces this.
- Versioning: `versionName` starts at `1.0.0`, `versionCode` starts at `1`
  (stored in `AndroidManifest.xml`; managed by `node tools/version.js`).
  Increment only for real releases, not for routine dev-build testing.

## Icons

Every app MUST have a custom launcher icon matching its purpose - never the
default Android icon:
1. Design a concept from the app idea/name during product design.
2. Generate it with a pure-Node generator (see `tools/genicons.js` pattern).
3. Produce all densities: mdpi 48, hdpi 72, xhdpi 96, xxhdpi 144, xxxhdpi 192,
   plus round variants.
4. Verify the icons exist inside the final APK.

## Testing rules

- Test every app (`npm test`) before declaring completion.
- Tests must cover real APPLICATION BEHAVIOR, not just file existence:
  - calculator -> arithmetic, decimals, %, negatives, division-by-zero, history
  - money app -> deposits, withdrawals, balances, totals, date filtering,
    persistence
  - church/hymn/content app -> navigation, content loading, search/favorites
- Adapt the suite to what the app actually does; fail the workflow when
  critical verification fails.
- WebView apps (UI in `www/`, native through `window` bridge) MUST include a
  runtime interaction wiring suite in `npm test`: the harness in
  `tests/ui-harness.js` loads the REAL index.html + bridge + app.js against a
  strict recording mock and drives real button/input events end to end
  (button -> handler -> bridge -> native -> result -> UI). It must prove
  actions both EXECUTE and PERSIST (never just "look alive"), failed/refused
  native ops surface as visible errors (never optimistic success), unsupported
  capabilities are visible, and one failing handler never breaks the rest of
  the UI. The same mechanism is the AppFactory permanent regression
  (`factory/core/webtest.js` + `factory/tests/fixtures/webview.js`, run by
  `node appfactory.js test`). CI runs `npm test` and FAILS the cloud build on
  any wiring regression.

## Automatic error repair

On failure: read the actual error, identify the root cause, make the smallest
appropriate fix, rebuild, retest. Maximum 3 automatic retries, then report the
exact remaining error. No infinite loops, no unrelated edits, never hide or
suppress errors.

## Network resilience and TLS policy

ALL network operations run under the shared retry policy in `tools/net.js`
(`withRetry`): GitHub API requests, Actions polling, artifact downloads,
release creation, APK uploads, HTTPS downloads, git push/pull, certificate
and connection failures.

Policy per failing operation:

1. Capture the exact error; stop the failed operation cleanly.
2. Never continue with a partial, corrupted or unverified result.
3. If the error is transient (DNS, connection reset/refused, timeout,
   TLS/certificate verification, HTTP 429 or 5xx), retry the SAME operation:
   max 3 attempts, short increasing delay, best-effort connectivity re-check.
4. If any attempt succeeds, continue the normal workflow automatically -
   never ask the user to manually retry routine transient failures.
5. If all 3 attempts fail, stop safely and report:
   `FAILED AFTER 3 ATTEMPTS — <exact error>`.

Permanent errors fail immediately on attempt 1 with a clear explanation and
are NEVER retried: invalid credentials (401/403), repository/not found (404),
malformed request (400/422), invalid configuration, permission denied that
cannot be resolved, invalid APK/signature.

TLS rules - absolute:

- NEVER disable TLS/HTTPS certificate verification.
- No insecure flags (`--insecure`, `curl -k`, `GIT_SSL_NO_VERIFY`,
  `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized: false`).
- Never bypass certificate validation; never accept an unverified APK.
- Certificate verification errors are retried over the normal secure HTTPS
  connection only; if they persist after 3 attempts, stop and report the
  exact certificate error.

Safe state after failures:

- After a failed operation the factory returns to a known safe state before
  retrying; partial artifacts are deleted (`*.part`), never used.
- Downloads buffer fully before touching disk; dist/ is updated atomically
  (write `.part` -> verify -> rename) so it can never hold a partial APK.
- After a successful retry, run the full verification chain again:
  APK exists -> integrity -> badging -> package -> version -> signature ->
  SHA-256 -> release/download URL. Then continue.

Report recovered operations as `RECOVERED AUTOMATICALLY — attempt X succeeded`.

## Autonomous orchestration (unattended pipeline)

`tools/factory.js` runs the whole flow from a one-line idea without stopping
for routine decisions:

```
IDEA -> DESIGN -> CODE -> TEST -> LOCAL_VALIDATION -> GITHUB_PUSH
     -> CI_BUILD -> (CI_REPAIR <= 3) -> APK_VERIFY -> RELEASE
     -> DOWNLOAD_READY ("APK READY — DOWNLOAD AVAILABLE <url>")
```

Rules:

- Never stop between normal stages to ask whether to continue, edit files,
  run tests, build, inspect logs, commit/push, or retry transient failures.
- Checkpoints: every completed stage is recorded in `.factory-state.json`
  (git-ignored). After any crash/stop, `--resume` detects the last completed
  checkpoint, inspects the repository and continues from the safest
  unfinished stage. Never repeat expensive completed stages; never restart
  the app unnecessarily.
- Recovery is finite: transient failures use the shared retry policy
  (`tools/net.js`, max 3); local test/build repair max 3; CI repair max 3;
  model failures fall through to the next model. No infinite loops.
- Permissions: automatically use access the environment already legitimately
  has (project storage, existing Git/GitHub credentials, existing network).
  Missing capabilities are reported as exact requirements - never bypassed,
  faked or weakened Android security.

## Multi-model AI layer ($0 guarantee)

`tools/models.js` discovers models from the existing host/OpenCode
configuration (never invented, never new API keys):

- Cost classes: free (local runtimes) / unknown (host-session models via the
  pre-existing opencode CLI) / paid. Routing prefers free, then unknown.
- Paid providers are NEVER used unless the user explicitly sets
  `FACTORY_ALLOW_PAID=1`. Otherwise stop and report:
  `Paid model/provider would be required.`
- Finite fallback: timeout / unavailable / rate-limit / invalid output /
  repeated build failure -> next model (status: `MODEL FALLBACK`).
- Health tracking in `.factory-models.json`: repeated failures temporarily
  deprioritize a model (10 min cooldown); one success forgives. No permanent
  blacklisting.
- Task roles (design/coding/debug/test/review) may map to different models;
  with one usable model it does everything.
- Secrets are redacted everywhere (`Models.redact`); credentials are never
  placed in prompts, logs or commits.

## Release, verification and browser-based download

The factory NEVER copies APKs to `/storage/emulated/0/Download/` (or any
phone storage) automatically, NEVER installs APKs, and NEVER requests
phone-storage permissions. Downloading and installing are USER-CONTROLLED:
the user presses the provided link, the DEFAULT BROWSER downloads the file,
and the user decides whether to install it.

Final deliverable is a signed release-style APK named
`<AppName>-v<versionName>.apk`, published as a GitHub Release asset.
Signing uses a locally generated keystore cached in `keys/` (stable across
builds, never committed). Self-signed - suitable for sideloading, not
Play-Store production signing. Report this limitation honestly.

### BUILD SUCCESS -> APK VERIFIED -> APK PUBLISHED -> DOWNLOAD AVAILABLE

These are distinct states. The ONLY correct final status is:

```
APK READY — DOWNLOAD AVAILABLE <https-url-of-release-asset>
```

Never report "APK DELIVERY SUCCESS" - there is no automatic delivery.

Pipeline (`npm run ship` = cloud + publish):

1. `npm run cloud` (`tools/fetch-cloud-apk.js`) waits for the GitHub Actions
   run of the current commit, downloads the artifact and fully verifies it
   into `dist/`: badging readable, package + versionName match the manifest,
   permission set matches the manifest allow-list, signature valid.
2. `npm run publish` (`tools/release.js`) creates-or-updates the GitHub
   Release for the manifest version and attaches the VERIFIED APK as a
   release asset (idempotent: replaces an existing same-name asset).
3. Present the printed HTTPS URL as the final Download action, e.g.
   `https://github.com/<owner>/<repo>/releases/download/v1.0.0/App-v1.0.0.apk`.
   It is a stable public URL any browser can open.

The old auto-copy delivery tooling is retired: no `deliver` script, no
automatic writes to shared storage. Do not resurrect it.

## Automatic routine access

Perform all routine development operations immediately and automatically,
using the permissions this environment already has: creating/editing project
files and directories, running builds/tests/cleans, reading build logs,
git init/add/commit/push, GitHub API calls (repo creation, Actions/artifact
queries), and publishing GitHub Releases with verified APK assets.

Do NOT stop to ask "may I...?" for these. Never ask the same permission twice.

If an operation fails due to an access problem:
1. Inspect the exact error.
2. Look for a legitimate alternative already available in the environment
   (AndroidIDE's existing grants, app-specific/app-private storage, SAF
   access already granted, existing env vars, alternate writable paths).
3. Use the least-privileged legitimate alternative automatically and retry.
4. Only surface the issue if genuine interactive Android authorization is
   unavoidable - and then state exactly what is blocked and why, once.

NEVER bypass real Android security: no attempts to defeat sandboxes,
permission dialogs, authentication, or user-consent mechanisms.

## Git and GitHub

- Commit and push completed work to GitHub on `main`.
- Confirm the GitHub Actions run goes green and produces an APK artifact;
  download and re-verify the cloud-built APK when possible.
- Optionally create a GitHub Release (`node tools/release.js`) for versions.
- NEVER commit or expose API keys, tokens, passwords, auth files, keystores
  or any other secrets. Scan for secrets before pushing.

## User communication

When given an app idea, start building immediately after stating the design
decisions briefly. No questionnaires, no asking permission for routine steps
(files, git commits, pushes, builds, fixes). Stop only for genuinely blocking
information or irreversible actions outside project scope.

## Cost rules

- Target $0. No paid services unless explicitly requested by the user:
  no Replit, no paid AI APIs, no paid GitHub plans, no paid CI.
