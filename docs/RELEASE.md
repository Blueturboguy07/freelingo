# Release preparation and prerequisites

Updated 2026-09-13. Product implementation proceeds in parallel with the Spanish audit under the [founder scheduling decision](PARALLEL-IMPLEMENTATION.md). No release candidate is approved yet. The previous P2-era checklist is preserved in [history](history/RELEASE-P2-20260913.md).

## Current evidence

P0 and P1 passed. The last integrated commit is `fca9a57`: [core CI passed](https://github.com/Blueturboguy07/freelingo/actions/runs/34734954579), [native database smoke passed](https://github.com/Blueturboguy07/freelingo/actions/runs/34734954572), and [Spanish pack CI failed validation](https://github.com/Blueturboguy07/freelingo/actions/runs/34734954606). That native run covered one database smoke flow on each platform; it is not lesson-player or later-surface evidence.

The frozen Spanish draw contains 300 items: 101 wrong (33.7%), 17 awkward and 182 OK. **PROVISIONAL (unreviewed by a paid native speaker)**. Audio was not heard in that review. The next complete generated population needs its own frozen draw, review and evidence. Candidate generation and passing unit tests do not clear the content gate. P3–P8 implementation and their device evidence are in progress.

## Build profiles

[EAS configuration](../apps/mobile/eas.json) is beside the mobile package, as required by Expo. `preview` produces an iOS simulator app or Android APK; `production` targets app-store distribution; `release-apk` produces a separately installable production APK. Native tool versions match the current local Node 24.18/pnpm 11.25 checkpoint. Release profiles compile the E2E diagnostics flag off and require a committed working tree. No EAS build has been run for these profiles yet.

The account tier is selected in the Expo account, not in `eas.json`. Use the approved Starter-or-higher account for release candidates; this task does not purchase a subscription. Ordinary simulator/emulator evidence continues in the existing GitHub native workflow. EAS profile behaviour follows Expo's [profile documentation](https://docs.expo.dev/build/eas-json/), [APK guide](https://docs.expo.dev/build-reference/apk/) and [simulator guide](https://docs.expo.dev/build-reference/simulators/).

Run from `apps/mobile` after verifying all release gates and configuring the owner's EAS project/signing identities:

```sh
npx eas-cli whoami
npx eas-cli project:info
npx eas-cli build --platform ios --profile preview
npx eas-cli build --platform android --profile release-apk
npx eas-cli build --platform ios --profile production
```

Record the exact git SHA, CLI/tool versions, build URLs, artifact hashes, Android signing-certificate fingerprint and iOS app/extension build numbers in the release report. The Android release key must be the durable release identity, never the generated development/debug key. Every WidgetKit target must match the app build number.

## Gates before publishing

- Every shipped language passes the actual validators, signed pack installation, audio budget/licence checks and its scored 300-item sample. The wrong-item limit remains 2%; the paid native review is a release prerequisite. Assigning a reviewer label never substitutes for a completed independent review bound to the exact population.
- Final core, pack, native and relevant mutation workflows pass on the release SHA, with downloadable artifacts. Pixel parity is supported by measured token/frame evidence; the README lists surfaces without references.
- The [manual device checklist](MANUAL-DEVICE-CHECKLIST.md) has a named reviewer, device/OS, date, outcome and evidence for every required row. Automated emulator checks supplement it.
- Public documentation reports actual provenance, language status and defect rates; Japanese remains beta. Code is AGPL-3.0 and original pack content CC BY-NC-SA 4.0, with source-specific attributions preserved. Review the final [listing draft](PUBLIK-LISTING.md) before the research owner posts it.

## Owner-supplied items and manual submission

Paid native reviewers, named device QA sign-off, an EAS account/project on the approved tier, and app-store signing credentials are still external prerequisites. Continue implementation while they are outstanding. Do not mark an unsigned checklist or absent identity as passed.

TestFlight submission is explicitly manual because App Store Connect credentials are absent. After a validated production iOS build, the owner can run:

```sh
npx eas-cli submit --platform ios --profile production --latest
```

Check that `--latest` identifies the exact approved build before submission; use a specific EAS build ID instead if it does not. Store submission, a public release and posting the listing are separate actions from preparing these files. No submission or posting has occurred.

The pack-signing public key is in `packages/schema/keys/pack-signing.pub`; CI holds the private key. Exercise the real signing and foreign-key rejection paths and record recovery ownership before release. Never copy signing secrets into source, documentation or logs.
