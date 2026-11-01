# Skyll Intake Android App

This Expo app is the class-admin intake client: create a test, select its
students, capture answer sheets, and attach the question paper and answer key.

The Android capture flow uses a native document scanner. It detects paper
edges, corrects perspective, supports multiple pages in one capture session,
and requires a page-by-page review before upload. The review surface highlights
low-resolution scans, lets the administrator remove a bad page, and allows
additional pages to be captured before the final upload.

Scans are copied to the app's durable private storage before upload. A test
draft, pending scans, and failed upload source files survive app restarts;
failed uploads have a retry action. The pre-upload legibility check combines
pixel dimensions, image data size, and on-device OCR confidence. It flags
potentially blurred, washed-out, or incomplete pages for a deliberate visual
check, while allowing diagram-only pages to proceed when an administrator has
verified them.

On launch the app checks for an Expo update in parallel with session restore
and, for returning users, paints the signed-in home screen immediately from a
cached identity before validating the session in the background — sign-out only
happens if the server explicitly rejects the session. The last successful
  `/api/intake/tests`, `/api/intake/batches`, and `/api/teacher-dashboard`
  responses are cached locally (60s TTL, namespaced per signed-in user) so a cold
  start renders stale data instantly and revalidates in the background; the cache
  is cleared on sign-out. While an equivalent GET or HEAD request is already in
  flight, callers share that request; writes, forced refreshes, and abortable
  reads always remain independent.

The test/job API and signed R2 uploads are implemented in the main app. Each
upload is registered as a `file_asset` only after the direct-to-R2 PUT succeeds.
The app queues processing only after the question paper, answer key, and at
least one student answer sheet have been uploaded.

Before processing is queued, the existing-paper actions let an administrator
preview every uploaded page of the paper (shown in scan order with
next/previous navigation), add pages, replace the paper, or use **Remove scan
and re-upload**. The final action deletes the uploaded source pages through the
authenticated API, resets the student to not uploaded, and offers an immediate
rescan. It is locked once processing has been queued or started.

Set `EXPO_PUBLIC_API_ORIGIN` to the deployed web/API origin before building an
APK. For local Android-emulator work, use the development machine's LAN address
instead of `localhost`.

## Internal Android APK

After the API is deployed, set the API origin in the EAS environment and build:

```bash
npm install
npx eas-cli@latest login
npx eas-cli build --platform android --profile preview
```

The `preview` EAS profile produces an internally distributable APK and a
shareable install link. It already points to `https://www.skyllai.com`. Use an
Expo login or an `EXPO_TOKEN` in CI before triggering the build. See
[`docs/OPERATIONS.md`](../../docs/OPERATIONS.md) for the backend contract and
live verification checklist.

## Scan storage and the upload queue

Scanned pages are kept under the app's document directory (see
`src/scanStorage.js`):

- `intake-review/{test}/{student}/` — pages open in the review screen. Never
  uploaded or recovered; deleted on Cancel/Back/Remove.
- `intake-outbox/{test}/{student}/` — confirmed pages. Boot recovery re-queues
  anything here the persisted queue lost; a successful upload deletes the file.
- `intake-quarantine/{test}/{student}/` — confirmed pages of a test that was
  locked before they were sent. Shown as "N pages not sent" with Retry and
  Discard; never uploaded or deleted automatically.
- `intake/{test}/{student}/` — legacy layout from older builds (review and
  confirmed pages mixed). Existing files keep the old behaviour and are
  re-queued as confirmed, except pages open in the review screen.

File names end in the durable per-student page number, which is also the
trailing number of the upload filename the worker sorts by.



Run `npm test` before building or publishing an app update. The automated suite
covers draft recovery, retryable uploads, queue eligibility, scan-quality
warnings, and the multi-page answer-sheet preview. Native scanner behaviour must
also pass the device smoke test in
[`docs/TESTING.md`](../../docs/TESTING.md).
