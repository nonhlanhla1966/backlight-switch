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
-> APK DELIVERY (tools/deliver.js, verified destination) -> DOWNLOAD
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
-> DELIVER VERIFIED CLOUD APK -> DOWNLOAD
```

- The final delivered APK must be the verified GitHub Actions artifact
  whenever one is available: `npm run cloud` waits for the Actions run of
  the current commit, downloads the artifact, verifies badging, package,
  version and signature into `dist/`, then `tools/deliver.js` performs the
  full destination verification. Never substitute an unverified local APK
  when a verified cloud APK exists.
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

## Automatic error repair

On failure: read the actual error, identify the root cause, make the smallest
appropriate fix, rebuild, retest. Maximum 3 automatic retries, then report the
exact remaining error. No infinite loops, no unrelated edits, never hide or
suppress errors.

## Release and delivery

- Final deliverable is a signed release-style APK named
  `<AppName>-v<versionName>.apk`.
- Signing uses a locally generated keystore cached in `keys/` (stable across
  builds, never committed). This is self-signed - suitable for sideloading,
  not Play-Store production signing. Report this limitation honestly.

### APK DELIVERY SUCCESS != BUILD SUCCESS

A printed path is NOT a delivery. For every app, run the full chain:

```
BUILD -> FIND ACTUAL APK -> VERIFY SOURCE -> COPY -> VERIFY DESTINATION -> REPORT
```

Always use `node tools/deliver.js` (`npm run deliver`). It locates the built
APK, verifies badging + signature at the source, detects a genuinely writable
public Download directory starting at `/storage/emulated/0/Download/`
(fallbacks: `OPENCODE_DOWNLOAD_DIR`, `/sdcard/Download/`, `$HOME/Download/`),
copies the file with mode **0644** (mode 600 root-owned files are invisible
to Android apps - never ship them), then
verifies the DESTINATION copy: exists, readable, size > 0, sha256 identical
to source, package/versionName/versionCode readable from the destination
file, signature valid. It also best-effort requests a MediaStore rescan.

Never claim "APK DELIVERY SUCCESS" unless `tools/deliver.js` printed its
success line after verifying the destination file. If any step fails, the
workflow fails and shows the actual reason.

The generated test suite includes a Delivery section that runs this
verification; on hosts without public storage (e.g. GitHub runners) it skips
cleanly instead of failing.

## Automatic routine access

Perform all routine development operations immediately and automatically,
using the permissions this environment already has: creating/editing project
files and directories, running builds/tests/cleans, reading build logs,
git init/add/commit/push, GitHub API calls (repo creation, Actions/artifact
queries, releases), and copying the APK into Download.

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
