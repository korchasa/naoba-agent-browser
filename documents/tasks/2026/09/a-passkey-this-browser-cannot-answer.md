---
date: "2026-09-19"
status: to do
implements: []
tags: [agent-browser, naoba, authentication, webauthn, agent-experience]
related_tasks:
  [
    a-password-prompt-that-never-appears,
    nobody-is-asked-before-the-microphone-goes-on,
  ]
---
# A passkey this browser cannot answer

## Goal

A person signing in on a site that offers a passkey is not led into a dead end.
Either the sign-in works, or the site offers the password path from the start
because this browser told it the truth about itself.

## Overview

The WebAuthn API is present and there is no authenticator behind it. Measured on
2026-09-19:

```
typeof window.PublicKeyCredential                        → "function"
PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()  → false
PublicKeyCredential.isConditionalMediationAvailable()    → true
```

The second answer is the honest one: there is no built-in authenticator, so
Touch ID cannot sign anything here. The third is the trap. A site reads it as
"this browser can offer saved passkeys in the sign-in field", puts the passkey
path in front of the person, and the person clicks into something that cannot
finish. The two answers contradict each other, and a site is entitled to believe
either.

This is the nearest neighbour of the bug that started this line of work: a
sign-in that opens and never completes. The difference is that the popup bug had
a fix inside this application, and this one may not. Chromium inside Electron
has no platform authenticator, and that is not a setting.

So the useful question is not "how do we support passkeys" but "what do we tell
a site, and what do we tell the person". A browser that admits it cannot do this
is more use than one that pretends.

A hardware key over USB is a separate question and is not covered by the
measurement above — nobody plugged one in. It belongs in the first item below.

## Definition of Done

- [ ] What actually works is measured and written here: a hardware key over USB,
      a passkey from another device over the camera or Bluetooth, and the
      built-in authenticator. Each one tried, not reasoned about.
- [ ] A site is not told that conditional mediation is available while no
      authenticator exists, so the passkey path is not offered where it cannot
      finish.
- [ ] An agent meeting a passkey prompt gets a message naming what happened and
      what is left to try, rather than a page that stops.
- [ ] Whatever is decided is written into the manual, because an agent choosing
      between this browser and another one needs to know.
- [ ] A test covers the answers this browser gives about its authenticators.

## Solution

Not decided yet, and the first item of the Definition of Done has to be done
before it can be: the measurement above covers the built-in authenticator alone,
and a USB key may well work. If it does, the shape of the task changes from
"admit the gap" to "tell the person which key to reach for".

If nothing works, the direction is to stop claiming conditional mediation. The
honest surface is a `PublicKeyCredential` whose availability answers are all
false, or none at all — and which of those a site handles better has to be
measured on a real site rather than guessed. Apple, Google and GitHub each
behave differently when the API is missing versus present and empty.
