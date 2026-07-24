// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Small platform probes. Kept pure (user-agent string in, boolean out) so the
 * routing behaviour they describe can be tested without a device.
 */

/**
 * True on iPhone/iPod, where iOS routes live-mic monitoring to the *earpiece*
 * (the receiver at the top of the phone) rather than the loudspeaker.
 *
 * This is not a Voxwell choice and there is no fix for it in the page: once a
 * microphone stream is live, WebKit treats the tab like a phone call and there
 * is no web API to pick the output route — `navigator.audioSession.type` only
 * hints the category, and every value that allows recording (`play-and-record`)
 * routes to the earpiece. So we surface it to the user instead of pretending a
 * toggle could move it. iPads route live audio to the speaker and are excluded.
 */
export function routesMonitoringToEarpiece(userAgent: string): boolean {
  return /\b(iPhone|iPod)\b/.test(userAgent);
}
