# Community Platform Glossary

Canonical domain language for the `pickup-baseball` codebase and its self-hosted community forks (`Community`). When code, specs, UI copy, or issues name these concepts, use these terms instead of the avoided synonyms.

## Community & Participants

**Community**:
A single self-hosted group operating one deployment of this platform with its own branding, configuration, and member roster.
_Avoid_: Tenant, workspace, org-account

**Member**:
A signed-in, registered account (`users` row) belonging to a Community. (Existing databases may still store `role = 'player'` as a legacy compatibility alias.)
_Avoid_: Generic "player" for non-playing organizers, moderators, or spectators

**Visitor**:
An unauthenticated person browsing public pages or submitting a no-login RSVP without signing in.
_Avoid_: Guest (when conflated with `+1` companions)

## Gatherings, Registrations & Safety

**Event**:
A scheduled Community gathering with a date, location, and optional capacity limit or volunteer tasks.
_Avoid_: Game (in shared scheduling, reminder, or config code)

**Invite Link**:
An Organizer-controlled, rotatable Event URL carrying a signed token that grants visibility and RSVP eligibility for a restricted Event without pre-listing email addresses.
_Avoid_: RSVP management link, public share link

**RSVP**:
A single Event registration record (`attendees` row) submitted by a Member or Visitor, carrying participant counts, spectator counts, and optional companions.
_Avoid_: Attendee-only record, ticket

**Participant**:
An active capacity-consuming spot inside an RSVP (such as an on-field player).
_Avoid_: Generic attendee

**Spectator**:
A non-participating attendee counted inside an RSVP who does not consume active Event capacity.
_Avoid_: Observer, companion

**Companion**:
An additional person (`additional_guests` / `guest_names`) registered inside another Member or Visitor's RSVP.
_Avoid_: Guest (when conflated with unauthenticated Visitors)

## Roles & Operations

**Admin**:
The highest Account Role with full authority over deployment configuration, role assignments, moderators, member deletion, and backups.
_Avoid_: Owner, superuser

**Organizer**:
An Account Role authorized to schedule and edit Events, manage rosters and rainouts, publish highlights, and moderate event media.
_Avoid_: Host, event admin

**Moderator**:
A Member (or Admin) granted chat-safety permissions (`is_moderator`) to review Clubhouse reports, mute members, and enforce community conduct rules.
_Avoid_: Facilitator, janitor

**Event Coordinator**:
A volunteer assigned to coordinate on-site logistics for a specific Event via an explicit `grants_coordinator` task attribute.
_Avoid_: Account-level Organizer permissions, hardcoded `"Game Facilitator"` title matching

**Volunteer Task**:
An open, unbadged task on an Event that any eligible Member or Visitor RSVP can claim.
_Avoid_: Paid shift, badged operation

**Certified Shift**:
An optional, feature-flagged operations task requiring an Organizer-granted qualification badge and governed by fair-share rolling rotation windows and caps.
_Avoid_: Title-substring classification (`"machine"`, `"drag"`)

**Backup Hero Credit**:
A non-punitive fairness credit earned by claiming an open or vacated Certified Shift on short notice (<48 hours before start), redeemable to claim an extra Tier-1 shift above the rolling cap.
_Avoid_: Karma, strike, penalty override

## Privacy, Consent & Communication

**Liability Waiver**:
A provenance-sealed legal release signed by an individual accepting participation risks for the configured Community.
_Avoid_: Generic consent, opt-in toggle

**Quarantined Waiver**:
A signed Liability Waiver held under restricted Admin legal-defense access until its statutory retention window expires after the signer requests erasure.
_Avoid_: Active roster record, indefinite archive, in-place PII redaction

**Privacy Consent**:
An explicit, versioned permission from a Member or Visitor authorizing optional visibility or sharing of personal data (such as roster visibility or profile sharing).
_Avoid_: Waiver, implicit public default

**Feature Opt-In**:
An explicit Member choice enabling or disabling an interactive product module such as Clubhouse chat.
_Avoid_: Legal consent, email subscription

**Notification Preference**:
A per-topic email delivery preference (reminders, rainouts, community updates) managed independently from submitting an RSVP.
_Avoid_: Default-on `"subscribed"` side effect of RSVPing

**Email Suppression**:
An automated delivery block applied to an email address after a permanent bounce or spam complaint from the mail provider so future dispatches skip that address and protect Community sender reputation.
_Avoid_: Admin conduct `Ban` (`banned_emails`), `Notification Preference` opt-out, or transient delivery deferral

**Peer Block**:
A bidirectional Member-to-Member safety boundary (`user_blocks`) that prevents 1:1 DMs and WebRTC connections and hides the blocked Member's messages for the blocker in shared channels, without suppressing `announcement` boards or Moderator actions.
_Avoid_: Moderator `Chat Mute` (global silencing), `Channel Hide` (`channel_members.hidden`), or Admin `Ban` (`banned_emails`)
