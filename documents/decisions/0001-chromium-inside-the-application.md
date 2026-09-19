# 1. Chromium inside the application

- Date: 2026-09-19
- Status: accepted

## Context

This application is not a browser that shows pages to a person. It is a browser that an agent drives while a person
watches, and four of its promises decide which engine it can be built on. They are in `README.md`: input the page cannot
tell from a person's (`README.md:25`), a network log with response bodies, a whole scenario per call, and a tab that can
be handed over to the person when a sign-in or a payment appears.

Three of those four are not rendering features. They are made of commands of the Chrome DevTools Protocol, and the code
that makes them is one file:

- `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` (`src/main/tab.ts:585`, `src/main/tab.ts:882`) — the page
  receives clicks and keys with `isTrusted: true`, so a site that refuses synthetic events works normally.
- `Network.enable` and `Network.getResponseBody` (`src/main/tab.ts:1028`, `src/main/tab.ts:1047`) — the request log and
  the bodies behind it, not an approximation assembled from the page.
- `Page.captureScreenshot` (`src/main/tab.ts:968`) — the debugger paints its own copy, so a tab nobody is looking at can
  still be photographed.
- `DOM.setFileInputFiles` (`src/main/tab.ts:695`) — a file goes into a form without the system panel that no agent can
  answer.
- `Page.javascriptDialogOpening` and `Page.handleJavaScriptDialog` (`src/main/tab.ts:1088`) — a modal dialog does not
  freeze a tab that has no person in front of it.
- `Emulation.setAutomationOverride` and `Emulation.setFocusEmulationEnabled` (`src/main/tab.ts:211`,
  `src/main/tab.ts:1073`) — the disguise switch, and a background tab that still believes it has focus.

The fifth promise, the one the product is named for — projects that share nothing — is not an engine feature at all. It
is one session per project (`src/main/context.ts:73`, `src/main/project.ts:59`), and every engine considered here can do
the same thing under a different name.

The shell is a second, separate dependency. The window, the panel, the tray, the menus, the notifications, the file
dialogs, the screen metrics and the loopback endpoint are Electron API — `BaseWindow`, `WebContentsView`, `Tray`,
`Menu`, `Notification`, `dialog`, `ipcMain`, `session`, `net`, `screen`, `nativeTheme`, `clipboard`, `app` — across 9113
lines of TypeScript under `src/`. An engine change that keeps Chromium keeps most of that code; an engine change that
puts the engine in another process throws the panel away and writes it again.

## Decision

The engine stays Chromium, embedded in the application through Electron.

The engine was chosen by its automation protocol, not by its rendering. Anything with the same protocol is a variant of
this decision; anything without it is a different product.

## Consequences

What this buys:

- Real input, response bodies, screenshots of hidden tabs, file upload without a panel, and dialogs an agent can answer.
- Pages see the most ordinary browser there is. The user agent mentions neither Electron nor this application and
  `navigator.webdriver` is false, which is possible because the engine is embedded rather than driven from outside.
- One language for the whole application, and a shell that is already written.

What this costs, and the costs are accepted:

- About 280 MB installed (measured 2026-09-19), and a set of processes per project.
- The engine's security updates arrive as Electron releases, so staying current is a standing obligation of this
  repository, not of the operating system.
- No platform authenticator. Touch ID cannot sign anything here, `isUserVerifyingPlatformAuthenticatorAvailable()`
  answers false, and a site that offers a passkey leads the person into a dead end — see
  `documents/tasks/2026/09/a-passkey-this-browser-cannot-answer.md`. This is the sharpest edge of the decision and it
  has no fix inside a Chromium build.
- No App Sandbox, and therefore no Mac App Store: a browser that drives other people's pages does not fit one. The
  application ships outside the store with a Developer ID signature; signing, packaging and notarisation happen outside
  this repository.

## Alternatives considered

### WKWebView, the system web engine (also in the shape of Tauri or WRY)

- Pros. The application would weigh single-digit megabytes, use less memory, and take its engine updates from macOS.
  Passkeys and Touch ID work through the system, given Apple's browser entitlement. An App Sandbox becomes possible.
- Cons. There is no way to deliver a trusted event: `evaluateJavaScript` produces `isTrusted: false`, and synthetic
  clicks through `CGEvent` need the window frontmost and focused, which ends the idea of several agents working at once
  in tabs nobody is looking at. There is no network log with bodies — interception stops at custom schemes through
  `WKURLSchemeHandler`. There is no equivalent of `DOM.setFileInputFiles`, and a snapshot needs the view to be drawn.
- Risks. The browser entitlement is granted by Apple on application, and a refusal removes the one advantage the move
  was made for. WebKit's behaviour changes with macOS, on Apple's schedule.
- Best for. An application that shows a page to a person: a viewer, a help window, a sign-in sheet.

### CEF — Chromium inside a native application

- Pros. The same engine and the same protocol, so every promise survives, and the shell can be AppKit, which looks and
  behaves like the rest of the system.
- Cons. The same 250-plus megabytes, plus the work: CEF is built and updated by hand, the Swift bindings are
  third-party, and the whole shell would be rewritten.
- Risks. A private build of an engine breaks on Xcode and macOS updates, and nobody else will fix it.
- Best for. A team that wants a native shell badly enough to carry an engine build.

### A Chromium next door, driven over CDP

- Pros. The engine detaches from the application: Chromium runs as its own process with a debugging port, and Playwright
  or a plain CDP client drives it. The engine updates without rebuilding the application, and the same code runs with no
  window at all.
- Cons. The windows belong to another process, so the panel with its per-agent tree, the hand-over to the person and the
  screenshots all become much harder. The weight is not saved: a bundled Chromium costs about the same.
- Risks. An open debugging port is access to every signed-in session for any local process, and closing it is now this
  application's problem.
- Best for. Work with no person in the loop: batch collection, checks in CI.

### A fork of Chromium

- Pros. Total control — a platform authenticator could be added, the fingerprint changed, anything built into the
  engine. Brave and Arc are made this way.
- Cons. Hours per build, tens of gigabytes of source, and every security update rebased onto local patches.
- Risks. This is work for a team. Falling behind Chromium means shipping a browser with known holes.
- Best for. A product whose whole business is the browser.

### Firefox, in its three possible shapes

Gecko cannot be embedded. GeckoView is the only maintained embedding of the engine and it is Android-only, so on macOS
"Firefox-based" always means a Firefox process next to the application, or a Firefox that has been forked.

- Stock Firefox over WebDriver BiDi. Pros: BiDi is a W3C standard rather than one vendor's protocol, Chrome is moving
  onto it too, and it now covers most of what is needed here — `network.addIntercept` and `network.getData` for request
  interception and response bodies, `input.setFiles` for a file field, `browsingContext.captureScreenshot`, and input
  actions synthesised by the browser rather than by page JavaScript. Firefox has supported passkeys through the iCloud
  Keychain since version 122, which is exactly the hole Chromium leaves. Cons: the engine is a separate process, so the
  shell is lost and the panel rewritten; and WebDriver requires the browser to announce itself — `navigator.webdriver`
  is true by specification, which cancels the disguise this application deliberately keeps. Risks: the automation
  surface is younger than CDP, and where it is short there is nothing below it to fall back on — Firefox removed CDP
  entirely in version 141. Best for: a second engine beside the first, for sites that refuse Chromium.
- Playwright's Firefox, over the Juggler protocol. Pros: a Firefox that is already patched for automation, with deeper
  control than BiDi offers. Cons: it is a build maintained for Playwright's needs, tracking it is somebody else's
  decision, and the engine is still in another process. Risks: a protocol with no standard behind it and one consumer.
  Best for: an automation library, which is what it is.
- A fork of Firefox. Pros: the honest way to get both the disguise and the passkeys — Camoufox demonstrates it, patching
  Gecko at the C++ level precisely because anything injected as JavaScript can be detected, and browsers like Zen show
  that the shell can then live inside the fork. Cons: the cost of the Chromium fork without the Chromium ecosystem.
  Risks: the passkey advantage is not automatic either — the system keychain path needs Apple's browser entitlement,
  which a fork must obtain for itself. Best for: a product whose value is being undetectable.

### Driving the person's own browser

- Pros. Nothing to install and nothing to weigh. Passkeys, saved passwords and Touch ID work, because it is the person's
  real Chrome or Safari.
- Cons. The agent inherits every session the person is signed into, and the separation between projects — the reason
  this application exists — disappears.
- Risks. One agent sees a login belonging to another project.
- Best for. A single errand on one's own machine, where isolation does not matter.

### Servo, Ladybird and the other young engines

- Pros. Embeddable, light, and outside the two-vendor arrangement.
- Cons. Real sites do not open, and there is no automation protocol.
- Risks. A bet on a date nobody will name.
- Best for. Watching, not shipping.

## What would reopen this

- Passkeys become compulsory on a site the person needs. No Chromium build answers that; only the system engine or the
  person's own browser does, and both cost something this application currently refuses to give up.
- Chromium itself becomes the tell — sites blocking the engine rather than the automation. Then a forked Firefox is the
  only shape that keeps both the disguise and the protocol.
- Gecko becomes embeddable on the desktop again, or WKWebView gains a trusted-input API. Either would turn a rewrite
  into an ordinary port.

## Sources

Read on 2026-09-19, not measured in this repository: WebDriver BiDi is a W3C Working Draft of 2026-09-16
(<https://www.w3.org/TR/webdriver-bidi/>); Firefox's CDP was deprecated from version 129 and removed in 141
(<https://fxdx.dev/cdp-retirement-in-firefox/>); GeckoView is Android-only
(<https://github.com/mozilla/geckoview>); Firefox has supported macOS passkeys through the iCloud Keychain since
version 122 (<https://passkeys.dev/docs/reference/macos/>); Camoufox patches Gecko at the C++ level because injected
JavaScript is detectable (<https://github.com/daijro/camoufox>).
