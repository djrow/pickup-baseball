// @ts-check
/**
 * @fileoverview Canonical English i18n Dictionary and Translation Engine for Pickup Baseball Foundation.
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * @global API
 */

(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var API = root.API = root.API || {};

  /**
   * Canonical English i18n dictionary.
   */
  var EN_DICT = {
      "nav.community": "Community",
      "nav.calendar": "Calendar",
      "nav.archive": "Archive",
      "nav.gallery": "Gallery & Art",
      "nav.gallery_title": "Photo, Video & Art Gallery",
      "nav.clubhouse": "Clubhouse",
      "nav.clubhouse_title": "Clubhouse Chat & Voice Dugout",
      "nav.donate": "Donate",
      "nav.about": "About Us",
      "nav.about_title": "About Pickup Baseball Foundation",
      "nav.menu": "Menu",
      "nav.handbook": "Handbook",
      "nav.login": "Log In",
      "nav.logout": "Log Out",
      "nav.admin": "⚙️ Admin",
      "nav.org": "⚾ Org",
      "about.hero_pill": "⚾ 501(c)(3) Nonprofit • Oakland, CA • Est. 2021",
      "about.hero_title": "About Us",
      "about.hero_desc": "Free access to pickup baseball for teens and adults in the greater San Francisco Bay Area.",
      "about.mission_title": "Our Mission",
      "about.mission_p1": "Pickup Baseball Foundation (PBF) provides free access to pickup baseball for teens and adults of all ages, genders, and skill levels. We foster a welcoming and inclusive environment for building community with fellow baseball fans of all backgrounds in the greater San Francisco Bay Area.",
      "about.mission_p2": "PBF is a 501(c)(3) nonprofit organization founded in 2021 and based in Oakland, CA.",
      "about.contact_desc": "Get in touch with us at <a href=\"mailto:pickupbaseballfoundation@gmail.com\">pickupbaseballfoundation@gmail.com</a>.",
      "about.play_title": "⚾ Sunday Pickup Games",
      "about.play_desc": "Check the game calendar, RSVP in seconds, and coordinate bats, balls, bases, and catcher's gear.",
      "about.play_btn": "View Game Calendar →",
      "about.support_title": "❤️ Keep Games Free",
      "about.support_desc": "Every pickup game is free to join. Donations help buy equipment and keep baseball accessible to all.",
      "about.support_btn": "Donate →",
      "calendar.title": "Game Calendar",
      "calendar.subtitle": "Sunday Pickup Games • 12:00 PM • Bushrod Park",
      "calendar.today": "Today",
      "calendar.add_to_calendar": "Subscribe All (.ics)",
      "calendar.subscribe_game_btn": "🔄 Subscribe Game (.ics)",
      "calendar.export_btn": "📥 Export Schedule (.ics)",
      "calendar.sync_checking": "Syncing with cloud…",
      "calendar.sync_just_now": "Cloud synced • Just now",
      "calendar.sync_mins_ago": "Cloud synced • {mins}m ago",
      "calendar.sync_at_time": "Cloud synced • {time}",
      "calendar.sync_offline_cached": "Offline — cached schedule ({time})",
      "calendar.sync_offline": "Offline — showing cached schedule",
      "calendar.sync_offline_empty": "Offline — unable to reach cloud",
      "offline.banner": "You are currently offline. Some features may be unavailable.",
      "offline.retry": "Retry",
      "offline.submit_offline": "Unavailable Offline",
      "calendar.subscribe_title": "🔄 All-Games Live Calendar Sync (.ics)",
      "calendar.subscribe_desc": "Subscribe once so newly scheduled games, field changes, and rainout alerts update automatically on your phone or computer.",
      "calendar.subscribe_apple_btn": "🍎 Apple / Outlook (Live Sync)",
      "calendar.subscribe_google_btn": "📅 Google Calendar (Live Sync)",
      "calendar.subscribe_copy_btn": "📋 Copy Feed URL",
      "calendar.subscribe_copied": "✓ Copied!",
      "calendar.subscribe_snapshot_btn": "📥 Download One-Time .ics File",
      "event.calendar_label": "Game Calendar",
      "calendar.noon_game": "12:00 PM Game",
      "calendar.legend_game": "Confirmed Game (12:00 PM)",
      "calendar.legend_prospective": "Prospective (TBA)",
      "calendar.legend_rainout": "Rainout",
      "calendar.legend_today": "Today",
      "calendar.legend_attending": "You're Attending",
      "calendar.no_game": "No game scheduled on this date.",
      "calendar.prospective_pill": "Prospective",
      "calendar.prospective_badge": "📅 Prospective",
      "calendar.pickup_reminder": "Free community pickup baseball is every Sunday at Noon at Bushrod Park!",
      "calendar.view_details": "RSVP & View Game Details →",
      "footer.tagline": "Building community through America's pastime.",
      "footer.subtext": "Built for simplicity and durability. Free & open-source.",
      "footer.about_site": "Prototyped with Google Gemini in October 2026 for simplicity and durability. Free & open-source",
      "footer.handbook": "Handbook & Field Rules",
      "footer.copyright": "© 2026 Pickup Baseball Foundation. Licensed under Apache License 2.0.",
      "footer.erase_data": "Erase My Data",
      "hero.handbook_btn": "📖 Handbook & Field Rules ↗",
      "rules.summary": "⚾ Typical Rules of Play on Sundays: Casual, all skill levels, pitching machine, continuous batting, and safety first.",
      "rules.full_link": "📖 Read the Complete Sunday Rules of Play in the Webapp Handbook ↗",
      "footer.update_app": "Update App",
      "footer.update_available": "Update Available — Click to Refresh",
      "footer.update_checking": "Checking for updates and clearing cache...",
      "footer.update_reloading": "✓ App updated! Reloading with latest version...",
      "footer.update_available_desc": "A new version of Sunday Pickup Baseball is ready.",
      "hero.title": "Free Pickup Baseball Every Sunday at Noon",
      "hero.desc": "We provide accessible, friendly Sunday baseball games for everyone in the community. Check the head count, coordinate gear, volunteer for game-day tasks, and play ball!",
      "hero.login_btn": "⚾ Player Log In / Sign In",
      "hero.profile_btn": "👤 Player Profile ({name})",
      "hero.mailing_btn": "Join Mailing List ↗",
      "hero.view_games_btn": "View Games ↓",
      "privacy.summary": "🔒 Our Privacy Promise: We collect only your name & email and never share it.",
      "privacy.read_details": "Read details ▾",
      "privacy.hide": "Hide ▴",
      "privacy.b1": "We collect only your <strong>name</strong> and <strong>email address</strong>.",
      "privacy.b2": "We <strong>never share</strong> your email address with anyone.",
      "privacy.b3": "Only <strong>One Person</strong> sends messages to the mailing list. Right now, that's David.",
      "privacy.b4": "Your handwritten signature is only on a paper waiver we keep on file. We <strong>never share it</strong>.",
      "privacy.b5": "If you make a player account, the site will also email you sign-in codes and game confirmations or reminders. Anything extra you add to your profile (like a bio or photo) is optional.",
      "privacy.contact_prefix": "Questions or want your info removed? Email",
      "privacy.erase_link": "Erase your Visitor / RSVP data →",
      "home.welcome_signed_in": "Welcome, {name}! You are signed in.",
      "home.scheduled_games": "Scheduled Games",
      "home.future_games": "Future Scheduled Games",
      "home.view_past_archive": "Past Games Archive →",
      "home.archive_prompt": "Looking for past game recaps, turnout records, and discussion boards?",
      "home.filter_upcoming": "Upcoming",
      "home.filter_past": "Past Archive",
      "home.loading_games": "Loading scheduled games...",
      "home.no_upcoming_title": "No Upcoming Games Scheduled Yet",
      "home.no_upcoming_desc": "Check back soon! Our Sunday pickup games are posted throughout the season.",
      "home.no_past": "No past games in the archive yet.",
      "home.no_additional": "No additional games scheduled right now.",
      "archive.title": "Past Games Archive",
      "archive.subtitle": "Browse past Sunday games, volunteer records, attendance turnouts, and field discussions.",
      "archive.back_to_upcoming": "← Back to Upcoming Games",
      "archive.no_games": "No past games found in the archive yet.",
      "home.next_sunday_badge": "Next Sunday Pickup",
      "home.sunday_game_badge": "Sunday Game",
      "home.you_are_attending": "✓ You are Attending",
      "home.rsvp_view_details": "RSVP & View Details →",
      "home.view_rsvp": "View & RSVP →",
      "home.date_time": "Date & Time",
      "home.field_location": "Field Location",
      "home.map_link": "Map Link ↗",
      "home.confirmed_players": "Confirmed Players",
      "home.players_count": "{count} Players",
      "home.on_roster_count": "{count} on Roster",
      "home.players_played": "{count} Played",
      "home.online_rsvps_sub": "({count} online)",
      "home.view_game": "View Game →",
      "home.duty_coordination": "Task Coordination",
      "home.duties_configured": "{count} Tasks Configured",
      "home.skill_levels_note": "⚾ Open to all skill levels. Need gear or can bring some? Click below to let the team know.",
      "home.join_roster_btn": "Join Roster / Volunteer for Tasks",
      "feed.heading": "Highlights & Community Updates",
      "feed.subtitle": "Game recaps, video highlights, photo albums, and field announcements.",
      "feed.rss_btn": "📡 RSS Feed",
      "feed.new_post_btn": "+ New Highlight",
      "feed.no_posts_title": "No Highlights Posted Yet",
      "feed.no_posts_desc": "Check back soon for game recaps, photo albums, video clips, and announcements!",
      "feed.confirm_delete": "Delete this highlight from the community feed and RSS?",
      "feed.delete_btn": "Delete",
      "feed.game_badge": "⚾ Game Link",
      "how.title": "How Our Pickup Baseball Webapp Works",
      "how.s1_title": "1. RSVP Anytime",
      "how.s1_desc": "Sign up in seconds as a guest or with just your name & email. Knowing player numbers helps us balance teams and pick the right field.",
      "how.s2_title": "2. Coordinate Gear & Tasks",
      "how.s2_desc": "Sign up to bring bases, balls, catcher's gear, or first aid. Tell everyone in advance what equipment you can share.",
      "how.s3_title": "3. Email Reminders",
      "how.s3_desc": "You'll receive an instant confirmation upon RSVP, plus an automated reminder email the day before game day with field details and rosters.",
      "how.s4_title": "4. Game Discussion",
      "how.s4_desc": "Discuss pre-game weather, field conditions, carpools, or share post-game photos and recaps directly on the event board.",
      "event.back_to_games": "← Back to All Games",
      "event.loading": "Loading game details...",
      "event.upcoming_badge": "Upcoming Game",
      "event.roster_count": "Roster Count",
      "event.duties_status": "Tasks Status",
      "event.slots_filled": "{filled} of {total} Slots Filled",
      "event.open_map": "[Open Map ↗]",
      "event.rsvp_heading": "RSVP & Volunteer Tasks",
      "event.rsvp_subheading": "Sign up players, spectators, and group tasks in one step.",
      "event.already_account": "Already have an account?",
      "event.login_autofill": "Log in to save your group RSVP and manage tasks anytime.",
      "event.signin_required_title": "⚾ Sign-In Required to RSVP",
      "event.signin_required_desc": "To protect community games from spam, please sign in with a verified email to RSVP for players, spectators, or tasks.",
      "event.signin_required_btn": "⚾ Sign In / Register to RSVP →",
      "event.signin_submit_btn": "Sign In to Submit RSVP",
      "event.name_label": "Name *",
      "event.name_placeholder": "Your name or group name",
      "event.email_label": "Email Address (Optional)",
      "event.email_placeholder": "Optional — only for email confirmations & reminders",
      "event.players_counter_title": "⚾ Players",
      "event.players_counter_sub": "Playing on the field",
      "event.spectators_counter_title": "👏 Spectators",
      "event.spectators_counter_sub": "Watching or helping off-field",
      "event.optional_details_summary": "Add group names or shared gear (optional)",
      "event.group_names_label": "Group / Guest Names",
      "event.cancel_rsvp_btn": "Can't Make It",
      "event.will_attend": "Will you attend?",
      "event.attending_yes": "⚾ Yes, I'm playing!",
      "event.attending_no": "✕ Can't make it",
      "event.cant_make_it_badge": "You marked Can't Make It",
      "event.additional_guests_label": "Bringing Additional Guests?",
      "event.additional_guests_help": "Bringing friends or family who want to play? Let us know how many extra players are coming with you.",
      "event.guest_names_placeholder": "e.g. Alex, Jordan, Sam",
      "event.just_me": "0 (Just me)",
      "event.guests_badge": "guest",
      "event.guests_badge_plural": "guests",
      "event.guests_prefix": "Group:",
      "event.gear_label": "Shared Gear Your Group Can Bring",
      "event.gear_placeholder": "e.g. 2 wood bats, catcher's helmet, spare glove",
      "event.gear_help": "Coordination helps us make sure we have enough bats, balls, and gear for players without their own.",
      "event.duties_label": "🛡️ Group Volunteer Tasks",
      "event.duties_help": "Your group covers checked tasks together",
      "event.submit_rsvp_btn": "Confirm RSVP",
      "event.update_rsvp_btn": "Update RSVP",
      "event.saving_rsvp": "Saving RSVP...",
      "event.rsvp_email_note": "📬 Email confirmation & reminders sent if an email is provided",
      "event.edit_link_prompt": "Already RSVPed as a visitor?",
      "event.edit_link_btn": "🔗 Email me a fresh edit link",
      "event.edit_link_email_placeholder": "Enter the email used for your RSVP",
      "event.edit_link_send_btn": "Send Edit Link",
      "event.edit_link_sending": "Sending...",
      "event.duty_board_title": "🛡️ Game Day Task Board",
      "event.duty_board_desc": "Essential roles to keep our pickup games safe, fun, and organized.",
      "event.duty_filled": "Filled",
      "event.duty_needed": "Needed",
      "event.duty_volunteers": "✓ Volunteer(s):",
      "event.duty_needs_count": "⚠️ Needs {count} volunteer(s)",
      "event.duty_covered": "Covered",
      "event.duty_covered_by": "✓ Covered by {names}",
      "event.duty_current_open": "Current: {names} ({count} open)",
      "event.roster_title": "👥 Attendee Roster",
      "event.roster_desc": "Players, non-playing guests, shared gear, and group tasks.",
      "event.actual_turnout": "Actual Turnout",
      "event.turnout_badge": "{count} Played",
      "event.turnout_count_sub": "({count} online RSVPs)",
      "event.record_turnout": "Record Actual Attendance",
      "event.record_turnout_desc": "{count} players RSVP'd online. How many players actually played?",
      "event.save_turnout": "Save Turnout",
      "event.roster_private_title": "Attendee Roster is Private",
      "event.roster_private_desc": "To protect attendee privacy, individual names, non-playing guests, and task assignments are only visible to attendees. Please RSVP (attending or can't make it) below to view who's coming!",
      "event.roster_private_cta": "RSVP to View Attendee Roster",
      "event.confirmed_badge": "{count} Confirmed",
      "event.waitlist_heading": "Waitlist",
      "event.waitlist_badge": "Waitlist #{pos}",
      "event.on_waitlist_badge": "On Waitlist",
      "event.waitlist_pos_badge": "Waitlist #{pos}",
      "event.join_waitlist_btn": "Join Waitlist (Auto-Promote)",
      "event.update_waitlist_btn": "Update Waitlist Info",
      "event.no_players_yet": "No attendees on the roster yet. Be the first to mark yourself attending!",
      "event.playing_badge": "Playing",
      "event.rained_out_badge": "Rained Out",
      "event.guest_tag": "(Guest)",
      "event.discussion_title": "💬 Game Discussion Board",
      "event.discussion_desc": "Coordinate carpools, ask about gear, discuss weather, or post post-game highlights!",
      "event.no_comments_yet": "No discussion yet. Have a question about field location or gear? Start the conversation below!",
      "event.comments_members_only": "Event discussion is visible to signed-in members only.",
      "event.signin_to_comment": "Please sign in to join the game discussion and coordinate gear with teammates.",
      "event.signin_email_btn": "Sign In with Email →",
      "event.leave_message": "Leave a Message",
      "event.email_optional": "Email (Optional)",
      "event.message_label": "Message",
      "event.message_placeholder": "Field update, gear questions, or post-game shoutouts...",
      "event.post_comment_btn": "Post to Discussion",
      "event.bp_title": "Batting Practice (BP) Order",
      "event.bp_subtitle": "12:30 PM – 1:30 PM machine-pitch warmup • Shag outfield fly balls while other rounds hit!",
      "event.bp_quick_claim": "Claim Next Slot",
      "event.bp_your_slot": "Your Spot",
      "event.bp_open_slot": "Open Slot",
      "event.bp_claim_btn": "Claim Slot",
      "event.bp_leave_btn": "Withdraw",
      "event.bp_change_btn": "Change",
      "event.bp_rsvp_checkbox": "⚾ Sign me up for Batting Practice (BP) order (12:30 PM warmup)",
      "login.title": "Player Sign-In",
      "login.subtitle": "No password needed. We'll send a 6-digit code or magic link to your email.",
      "login.name_label": "Name",
      "login.name_placeholder": "Your name",
      "login.name_help": "Only needed if this is your first time playing with us.",
      "login.email_label": "Email Address *",
      "login.remember_email": "Remember my email address on this device",
      "login.shared_device": "This is a shared or friend's device (temporary 4-hour sign-in)",
      "login.shared_device_help": "Signs out when the browser closes or after 4 hours, and won't save your email here.",
      "login.send_code_btn": "Send Sign-In Code",
      "login.enter_code_label": "Enter 6-Digit Code",
      "login.code_help": "Or click the link sent to your email to log in instantly. (Code expires in 10 minutes.)",
      "login.verify_btn": "Verify & Sign In",
      "login.change_email_btn": "← Change Email",
      "login.footer_hint": "💡 New here? Just enter your name and email above — we'll email you a code, and your account is created automatically.",
      "login.signed_in_title": "You are Signed In!",
      "login.view_games_btn": "⚾ View Scheduled Games",
      "login.profile_btn": "👤 Player Profile",
      "profile.back_to_games": "← Back to Games",
      "profile.title": "Player Profile",
      "profile.subtitle": "Customize how other players see you on the Sunday game rosters and discussion board.",
      "profile.picture_title": "Profile Picture",
      "profile.picture_desc": "JPEG, PNG, WebP or GIF (up to 5MB).",
      "profile.choose_photo": "📷 Choose Photo",
      "profile.remove_photo": "Remove",
      "profile.name_label": "Name *",
      "profile.name_placeholder": "Your name",
      "profile.email_label": "Email Address",
      "profile.email_help": "Used for sign-in and game day reminder notifications.",
      "profile.bio_label": "Short Bio / Baseball Background",
      "profile.bio_placeholder": "e.g. Played 3rd base in college, always happy to pitch in. Love Sunday pickup ball!",
      "profile.bio_help": "Shown on the game roster alongside gear you bring.",
      "profile.save_btn": "Save Changes",
      "profile.cancel_btn": "Cancel",
      "profile.sessions_title": "🔐 Signed-In Devices",
      "profile.sessions_desc": "Accounts stay signed in on up to 5 devices at once. If you forgot to log out on a friend's phone, sign out everywhere else below.",
      "profile.logout_other_devices_btn": "Sign Out of All Other Devices",
      "profile.erasure_title": "🗑️ Delete Account & Erase Data",
      "profile.erasure_notice": "Deleting your account immediately removes your profile, sessions, login codes, consent records, future RSVPs, task assignments, and batting practice slots. Past attendance counts, discussions, and posts are anonymized. Legal Waiver Retention Notice: Signed liability waivers remain sealed in restricted Admin-only quarantine for 3 years from signing or your last attended event before permanent deletion.",
      "profile.erasure_keep_gallery": "Keep my approved Gallery photos/videos anonymously attributed to \"Community Member\" (unapproved items are always deleted)",
      "profile.erasure_send_code_btn": "📧 Email Verification Code to Delete Account",
      "profile.erasure_code_label": "Enter 6-Digit Verification Code",
      "profile.erasure_code_placeholder": "123456",
      "profile.erasure_confirm_btn": "Permanently Delete My Account",
      "profile.erasure_cancel_btn": "Cancel",
      "profile.erasure_confirm_dialog": "Permanently delete your account and personal data? This cannot be undone. Any signed liability waiver will stay in restricted 3-year legal-defense quarantine before automatic purge.",
      "profile.erasure_code_sent": "Verification code sent to your email. Enter the 6-digit code below to confirm deletion.",
      "donate.hero_pill": "❤️ Support Free Community Baseball",
      "donate.hero_title": "Help Keep the Games Free",
      "donate.hero_desc": "Pickup Baseball Foundation provides free, welcoming Sunday baseball for everyone in the community. Your donation helps us buy equipment, maintain gear, and keep the games open to all.",
      "donate.paypal_title": "Donate with PayPal",
      "donate.paypal_desc": "Give securely through our official PayPal Giving Fund charity fundraiser page.",
      "donate.paypal_btn": "Donate via PayPal →",
      "donate.every_title": "Donate with Every.org",
      "donate.every_desc": "Give through our Every.org nonprofit page, which supports card, bank, DAF, and stock gifts.",
      "donate.every_btn": "Donate via Every.org →",
      "donate.tax_title": "🧾 Tax Receipts",
      "donate.tax_desc": "Need a receipt for your taxes? After you donate, email David at <a href=\"mailto:pickupbaseballfoundation@gmail.com\">pickupbaseballfoundation@gmail.com</a> with your name and the amount and date of your gift. David will send you a donation receipt on our letterhead that you can submit to the IRS.",
      "donate.footer_note": "Thank you for supporting the game! ⚾ Questions? Reply to any of our emails or write to <a href=\"mailto:pickupbaseballfoundation@gmail.com\">pickupbaseballfoundation@gmail.com</a>.",
      "phrase.sunday_pickup": "Sunday Pickup Baseball",
      "phrase.sunday_pickup_noon": "Sunday Pickup Baseball - Noon Game",
      "phrase.default_desc_1": "Weekly community pickup baseball game. All skill levels welcome! Bring your glove and enthusiasm. Please check off any gear you can share or tasks you can take.",
      "phrase.default_desc_2": "Accessible, friendly community pickup baseball. Free for everyone!",
      "phrase.default_desc_3": "No special announcements for this pickup game. Bring your glove and enthusiasm!",
      "phrase.duty_bases": "Bases",
      "phrase.duty_bases_desc": "Bring 3 throw-down bases.",
      "phrase.duty_machine": "Pitching machine and power",
      "phrase.duty_machine_desc": "Bring a pitching machine and a way to run it on the field.",
      "phrase.duty_balls": "Game Baseballs",
      "phrase.duty_balls_desc": "Bring game balls bucket.",
      "phrase.duty_drag": "Field Dragging",
      "phrase.duty_drag_desc": "Arrive 20 mins early to drag the infield with the pull rake.",
      "phrase.duty_facilitator": "Game Facilitator",
      "phrase.duty_facilitator_desc": "Help coordinate teams, batting order, and fair play throughout the game.",
      "phrase.duty_water_food": "Water / Food",
      "phrase.duty_water_food_desc": "Bring drinking water, ice, and dugout snacks or fruit for players.",
      "dialog.close": "Close notification",
      "dialog.notice": "Notice",
      "dialog.ok": "OK",
      "dialog.confirm_title": "Please Confirm",
      "dialog.cancel": "Cancel",
      "dialog.confirm": "Confirm",
      "dialog.input_title": "Enter Details",
      "dialog.save": "Save",
      "calendar.no_upcoming_export": "No upcoming games scheduled to export.",
      "feed.delete_failed": "Failed to delete post.",
      "archive.turnout_title": "Game Attendance",
      "archive.invalid_attendance": "Please enter a valid attendance number.",
      "archive.turnout_saved": "Attendance saved.",
      "archive.save_failed": "Failed to save turnout.",
      "archive.record_prompt": "Enter the number of players who attended and played in this game:",
      "archive.edit_prompt": "Update actual headcount for this game:",
      "profile.signin_required": "Please sign in to view and edit your profile.",
      "profile.confirm_remove_avatar": "Remove your profile picture?",
      "profile.waiver_card_title": "📝 Player Consent & Liability Waiver",
      "waiver.back_to_games": "← Back to Game Schedule",
      "waiver.print_blank": "🖨️ Print Paper Copy",
      "waiver.title": "CONSENT, WAIVER AND INDEMNITY",
      "waiver.sign_online_title": "🔏 Sign Online with Verified Email Provenance",
      "waiver.sign_cta": "⚾ Sign In with Email to Sign Waiver →",
      "waiver.execute_sig": "✍️ Execute Digital Signature",
      "waiver.age_attestation_label": "I confirm that I am 18 years of age or older, or that I am the parent or legal guardian signing on behalf of a minor participant.",
      "waiver.age_attestation_error": "You must confirm that you are 18 years of age or older (or a parent/legal guardian signing on behalf of a minor).",
      "gallery.photos_reel": "Community Photos Reel",
      "gallery.videos_reel": "Video Releases & Highlights Reel",
      "gallery.drop_links_btn": "📥 Drop Photos / Links",
      "gallery.mod_queue_title": "Admin Moderation Queue",
      "gallery.all_albums": "🌟 All Albums",
      "profile.export_title": "📦 Download Your Data",
      "profile.export_desc": "Download a JSON archive of your profile, consent history, RSVPs, volunteer tasks, signed waivers, and Clubhouse messages.",
      "profile.export_btn": "📥 Download JSON Export",
      "profile.export_decrypt_label": "Decrypt my encrypted Clubhouse messages in-browser before saving",
      "profile.export_working": "⏳ Preparing export...",
      "profile.export_success": "Your personal data export has been downloaded.",
      "profile.export_success_decrypted": "Your personal data export (with {count} decrypted E2EE message(s)) has been downloaded.",
      "profile.export_failed": "Failed to export your data: {error}",
      "profile.export_passphrase_title": "🔐 Unlock E2EE Key Vault",
      "profile.export_passphrase_msg": "Enter your E2EE Key Vault passphrase to decrypt your encrypted Clubhouse messages in-browser before saving:",
      "profile.export_passphrase_placeholder": "Enter vault passphrase...",
      "profile.export_passphrase_confirm": "Unlock & Decrypt",
      "profile.export_wrong_passphrase": "Incorrect E2EE vault passphrase. Encrypted messages could not be decrypted.",
      "profile.privacy_consent_title": "🔒 Privacy Consent",
      "profile.privacy_consent_desc": "By default, signed-in members see only your First L. initial and RSVP status. Toggle below to share full details with peers.",
      "profile.roster_visibility_label": "Show my full name, shared gear, and companion names to signed-in members",
      "profile.roster_visibility_help": "When off, peer members see \"First L.\" only (organizers always see full details).",
      "profile.profile_sharing_label": "Share my bio and profile picture with signed-in members",
      "profile.profile_sharing_help": "Controls whether your short bio and avatar appear to peers on rosters, comments, and Clubhouse.",
      "profile.notify_title": "📬 Notification Preferences",
      "profile.notify_rsvp_label": "RSVP confirmation emails",
      "profile.notify_rainouts_label": "Rainout and field change alerts",
      "profile.notify_reminders_label": "Pre-event reminder emails",
      "profile.notify_community_label": "Community updates and announcements",
      "event.visitor_privacy_title": "🔒 Privacy & Notification Choices (Optional)",
      "event.visitor_roster_consent_label": "Show my full name, shared gear, and companion names to signed-in members on the roster (otherwise shown as \"First L.\")",
      "event.visitor_notify_emails_label": "Send me event reminder and rainout notification emails for this event (if email provided)",
      "visitor_erasure.title": "🗑️ Erase Visitor / RSVP Data",
      "visitor_erasure.summary_hint": "Remove RSVPs or data without signing in",
      "visitor_erasure.notice": "Verify your email with a 6-digit code to permanently delete future RSVPs, task assignments, batting practice slots, and consent records, and anonymize past attendance and comments. Legal Waiver Retention Notice: Signed liability waivers remain sealed in restricted Admin-only quarantine for 3 years from signing or your last attended event before permanent deletion.",
      "visitor_erasure.email_label": "Email Address *",
      "visitor_erasure.email_placeholder": "you@example.com",
      "visitor_erasure.keep_gallery": "If an account exists, keep my approved Gallery photos/videos anonymously attributed to \"Community Member\" (unapproved items are always deleted)",
      "visitor_erasure.send_code_btn": "📧 Email Erasure Verification Code",
      "visitor_erasure.code_label": "Enter 6-Digit Erasure Code",
      "visitor_erasure.code_placeholder": "123456",
      "visitor_erasure.confirm_btn": "Permanently Erase My Data",
      "visitor_erasure.cancel_btn": "Cancel",
      "visitor_erasure.confirm_dialog": "Permanently erase all personal data and RSVPs matching this email? This cannot be undone. Any signed liability waiver will stay in restricted 3-year legal-defense quarantine before automatic purge.",
      "visitor_erasure.invalid_email": "Please enter a valid email address.",
      "visitor_erasure.invalid_code": "Please enter the 6-digit verification code sent to your email.",
      "profile.saving_btn": "Saving...",
      "profile.updated_success": "Profile and privacy settings updated successfully!",
      "profile.update_failed": "Error updating profile.",
      "profile.erasure_sending_code": "Sending code...",
      "profile.erasure_send_failed": "Failed to send verification code.",
      "profile.erasure_enter_code": "Please enter the 6-digit verification code sent to your email.",
      "profile.erasure_deleting_btn": "Deleting...",
      "profile.erasure_deleted_fallback": "Your account has been deleted.",
      "profile.erasure_delete_failed": "Failed to delete account. Please try again.",
      "visitor_erasure.sending": "Sending...",
      "visitor_erasure.sent_fallback": "If records matching that email address exist, a 6-digit erasure verification code has been sent. It expires in 10 minutes.",
      "visitor_erasure.network_error": "Error contacting server. Please try again.",
      "visitor_erasure.erasing": "Erasing...",
      "visitor_erasure.erased_fallback": "Your personal data and RSVPs have been erased.",
      "visitor_erasure.erasure_failed": "Failed to complete erasure. Please try again.",
      "waiver.paragraph_1": "I wish to participate in the baseball and other outdoor activities (the \"Activities\") with Pickup Baseball Foundation volunteers and other participants (collectively, the \"Participants\"). I understand that the Released Parties will not permit me to participate in the Activities if I do not sign this Consent, Waiver and Indemnity, because the possibility of liability for them is too great to accept.",
      "waiver.paragraph_2": "I understand that the Activities carry some risk of harm to myself and others. I voluntarily assume full responsibility for all risks of personal injury, death and property damage while participating in the Activities, including the risk of passive or active negligence on the part of the Participants, or hidden, latent or obvious defects at the location of any of the Activities, whether such location is under the control of any of the Participants or any other party.",
      "waiver.paragraph_3": "Accordingly, I agree that I release, and will not bring any legal action of any nature whatsoever against the Participants, or any of their trustees, directors, agents, employees or representatives, including volunteer managers, chaperones and the other participants (the \"Released Parties\") in connection with the Activities, including, without limitation, any and all claims which may be based upon negligence of any of the Released Parties. Furthermore, I agree to indemnify, defend and hold the Released Parties and their respective agents and representatives harmless from any loss, claim, expense (including attorneys' fees), demand or cause of action of any kind or character arising from the assertion by me, my family members, or any other person, firm, or corporation that may have, or claim to have, a claim or claims connected with my participation in the Activities. This agreement is intended to be construed to be as comprehensive as is allowed by law, as severable, and the invalidity of any portion of which will not affect the validity of any other provision.",
      "waiver.paragraph_4": "I am signing this Waiver and Indemnity to induce the Participants to allow me to participate in the Activities described above for my convenience. I understand this Waiver and Indemnity and would not sign it if I did not.",
      "waiver.controlling_notice": "The official and legally controlling text of this Consent, Waiver and Indemnity is in English. Translations are provided solely for convenience and mutual understanding.",
      "waiver.original_summary": "View Original Controlling English Text",
      "waiver.form_id_label": "Form ID: {docVer} • SHA-256 Provenance Sealed",
      "waiver.printed_name_label": "Printed Name (Full Legal Name) *",
      "waiver.printed_name_placeholder": "Enter your full legal name",
      "waiver.dated_label": "Dated *",
      "waiver.sig_label": "Signature *",
      "waiver.btn_draw_sig": "✍️ Draw Signature",
      "waiver.btn_type_sig": "⌨️ Type Signature",
      "waiver.btn_clear_sig": "🗑️ Clear",
      "waiver.type_sig_placeholder": "Type your full name to generate signature on the line below...",
      "waiver.sig_canvas_hint": "Sign above the line using your mouse, finger, or stylus",
      "waiver.consent_label_strong": "Electronic Signature Consent (ESIGN / UETA):",
      "waiver.consent_label_body": "I have read and understand this Consent, Waiver and Indemnity, and I voluntarily agree to sign it electronically. I understand that my electronic signature, verified email identity, timestamp, and cryptographic SHA-256 digest carry the same legal validity and enforceability as a handwritten ink signature.",
      "waiver.btn_submit": "🔏 Sign & Seal Waiver",
      "waiver.submitting": "Sealing & Recording Waiver...",
      "waiver.success_msg": "✓ Consent, Waiver and Indemnity signed and sealed! Certificate ID: {certId}",
      "waiver.status_active_digital": "🔏 Digital Waiver Signed & Sealed on File",
      "waiver.status_active_paper": "📄 Paper Waiver Recorded on File",
      "waiver.status_active_generic": "✓ Waiver Recorded on File",
      "waiver.status_digital_desc": "Signed by {name} on {date}",
      "waiver.status_paper_desc": "Your waiver status is active on file. You may also execute a digital signature below anytime if you would like a downloadable cryptographic certificate receipt.",
      "waiver.status_unsigned_desc": "Please review the Consent, Waiver and Indemnity below and sign digitally (or let an organizer know if you already signed a paper copy at the field).",
      "waiver.view_cert_btn": "📄 View / Print Signed Certificate ↗",
      "waiver.sig_required_error": "Please draw or type your signature on the Signature line.",
      "waiver.printed_name_required_error": "Please enter your full Printed Name.",
      "waiver.consent_required_error": "Please check the Electronic Signature Consent box to continue.",
      "rtc_turn_unavailable_note": "Unavailable: No TURN privacy relay server is configured on this deployment.",
      "rtc_turn_available_note": "TURN privacy relay server is configured and ready.",
      "rtc_turn_blocked_warning": "Privacy Relay Mode blocked direct P2P voice because no TURN relay server is configured.",
      "clubhouse.peer_block_btn": "🚫 Block",
      "clubhouse.peer_unblock_btn": "🔓 Unblock",
      "clubhouse.peer_block_badge": "🚫 Blocked",
      "clubhouse.peer_block_title": "Block this member (hides their shared-channel messages and prevents 1:1 DMs and voice)",
      "clubhouse.peer_unblock_title": "Unblock this member",
      "clubhouse.peer_block_confirm_title": "🚫 Block Member",
      "clubhouse.peer_block_confirm_msg": "Block {name}? This prevents 1:1 Direct Messages and voice calls between you two, and hides their messages in shared channels and group DMs for you. Announcement boards and Moderator actions are not affected.",
      "clubhouse.peer_block_btn_confirm": "Block Member",
      "clubhouse.peer_unblock_confirm_title": "🔓 Unblock Member",
      "clubhouse.peer_unblock_confirm_msg": "Unblock {name}? You will be able to exchange 1:1 Direct Messages and voice calls again, and their shared-channel messages will be visible.",
      "clubhouse.peer_unblock_btn_confirm": "Unblock Member",
      "clubhouse.peer_block_success": "{name} has been blocked.",
      "clubhouse.peer_unblock_success": "{name} has been unblocked.",
      "clubhouse.peer_block_error": "Unable to update block status.",
      "clubhouse.peer_blocked_msg_stub": "🚫 Message from blocked member {name} hidden from your view.",
      "clubhouse.peer_blocked_reply_stub": "🚫 Reply from blocked member {name} hidden.",
      "clubhouse.peer_blocked_show_once": "Show once",
      "clubhouse.peer_blocked_unblock_short": "Unblock",
      "clubhouse.peer_blocked_dm_notice": "🚫 Direct messages are blocked between you and this member.",
      "clubhouse.peer_blocked_dm_self": "Unblock this member to start or send a 1:1 Direct Message.",
      "clubhouse.peer_blocked_voice_notice": "🚫 Voice calls are blocked between you and this member.",
      "clubhouse.verify_key_btn": "🛡️ Verify Key",
      "clubhouse.verify_key_changed_btn": "⚠️ Key Changed!",
      "clubhouse.verify_key_verified_btn": "✓ Key Verified",
      "clubhouse.verify_modal_title": "🛡️ Verify E2EE Security Keys",
      "clubhouse.verify_modal_desc": "Compare these numbers in person or on a trusted call to verify there is no active man-in-the-middle key swap.",
      "clubhouse.verify_warning_title": "⚠️ Security Key Changed!",
      "clubhouse.verify_warning_desc": "One or more participants' ECDH public keys differ from what you previously saw. Re-verify before sending sensitive messages.",
      "clubhouse.verify_safety_number_label": "Shared 60-Digit Safety Number",
      "clubhouse.verify_copy_btn": "📋 Copy",
      "clubhouse.verify_done_btn": "Done",
      "clubhouse.verify_computing": "Computing cryptographic fingerprints...",
      "clubhouse.verify_unsupported": "Key verification is available on E2EE DMs and Private Boards.",
      "clubhouse.verify_your_fp": "Your Key Fingerprint",
      "clubhouse.verify_not_enrolled": "Not enrolled on this browser yet",
      "clubhouse.verify_reverify_btn": "⚠️ Re-Verify New Key",
      "clubhouse.verify_verified_badge": "✓ Verified",
      "clubhouse.verify_mark_btn": "✓ Mark Verified",
      "clubhouse.verify_no_vault": "⏳ No E2EE Vault",
      "clubhouse.verify_waiting_member": "Waiting for member to enroll key vault",
      "clubhouse.verify_last_rotated": "Last rotated: {date}",
      "clubhouse.verify_pinned_success": "✓ Key fingerprint pinned & marked verified on this device.",
      "clubhouse.verify_error": "Error: {message}",
      "clubhouse.verify_load_failed": "Failed to load key info: {message}",
      "clubhouse.verify_own_fp": "Your ECDH Identity Key Fingerprint: {fp}",
      "clubhouse.audit_notice_title": "Server Security Audit Notice",
      "clubhouse.audit_sender_name": "Clubhouse Security Audit",
      "clubhouse.audit_verified_badge": "🔐 Server Verified",
      "backup_scrubbed_btn": "📥 Operational SQL (.zip)",
      "backup_dr_btn": "🔐 Encrypted DR Backup (.pbfenc)",
      "backup_scrubbed_working": "⏳ Exporting scrubbed SQL...",
      "backup_dr_working": "⏳ Encrypting DR backup...",
      "backup_dr_prompt_title": "🔐 Encrypted Full DR Backup",
      "backup_dr_prompt_msg": "Enter a passphrase (at least 8 characters) to encrypt this full disaster-recovery backup. Keep it safe — you will need it with scripts/restore-backup.js:",
      "backup_dr_prompt_placeholder": "Enter backup encryption passphrase...",
      "backup_dr_confirm_btn": "Encrypt & Download",
      "backup_dr_passphrase_short": "Backup passphrase must be at least 8 characters.",
      "backup_scrubbed_success": "Scrubbed operational SQL backup downloaded.",
      "backup_dr_success": "Encrypted disaster-recovery backup (.pbfenc) downloaded.",
      "backup_failed": "Database backup failed: {error}",
      "admin.quarantined_title": "🔒 Quarantined Waivers (Legal-Defense Hold)",
      "admin.quarantined_desc": "Sealed waivers retained for 3 years after account erasure (all lookups are audit-logged and auto-purged after retention expires).",
      "admin.quarantined_refresh": "🔄 Refresh",
      "admin.quarantined_purge": "🧹 Purge Expired",
      "admin.quarantined_col_cert": "Certificate ID",
      "admin.quarantined_col_signer": "Signer",
      "admin.quarantined_col_signed": "Signed",
      "admin.quarantined_col_retention": "Retention Until",
      "admin.quarantined_col_action": "Action",
      "admin.quarantined_loading": "Loading quarantined waivers...",
      "admin.quarantined_empty": "No quarantined waivers on legal hold.",
      "admin.quarantined_inspect": "📄 Inspect",
      "admin.quarantined_load_failed": "Failed to load quarantined waivers.",
      "admin.quarantined_purged": "✓ Purged {count} expired quarantined waiver(s).",
      "admin.quarantined_purge_failed": "Failed to purge expired quarantined waivers.",
      "admin.remove_user_title": "Remove Member Account",
      "admin.remove_user_confirm": "Permanently remove member account {email}? Profile, future RSVPs, and media will be erased, past records anonymized, and any signed liability waiver will be held in 3-year legal-defense quarantine.",
      "admin.remove_user_ban_checkbox": "Also permanently BAN {email} from re-registering or signing in again",
      "admin.remove_user_confirm_btn": "Remove Member",
      "admin.removing_user": "Removing {email}...",
      "admin.remove_user_failed": "Failed to remove member account."
  };

  /**
   * Recognized event and task phrase keys for automated multilingual fallback.
   */
  var KNOWN_PHRASE_KEYS = {
    "Sunday Pickup Baseball": "phrase.sunday_pickup",
    "Sunday Pickup Baseball - Noon Game": "phrase.sunday_pickup_noon",
    "Weekly community pickup baseball game. All skill levels welcome! Bring your glove and enthusiasm. Please check off any gear you can share or duties you can take.": "phrase.default_desc_1",
    "Weekly community pickup baseball game. All skill levels welcome! Bring your glove and enthusiasm. Please check off any gear you can share or tasks you can take.": "phrase.default_desc_1",
    "Accessible, friendly community pickup baseball. Free for everyone!": "phrase.default_desc_2",
    "No special announcements for this pickup game. Bring your glove and enthusiasm!": "phrase.default_desc_3",
    "Bases": "phrase.duty_bases",
    "Bring 3 throw-down bases.": "phrase.duty_bases_desc",
    "Pitching machine and power": "phrase.duty_machine",
    "Bring a pitching machine and a way to run it on the field.": "phrase.duty_machine_desc",
    "Game Baseballs": "phrase.duty_balls",
    "Bring game balls bucket.": "phrase.duty_balls_desc",
    "Field Dragging": "phrase.duty_drag",
    "Arrive 20 mins early to drag the infield with the pull rake.": "phrase.duty_drag_desc",
    "Game Facilitator": "phrase.duty_facilitator",
    "Help coordinate teams, batting order, and fair play throughout the game.": "phrase.duty_facilitator_desc",
    "Water / Food": "phrase.duty_water_food",
    "Bring drinking water, ice, and dugout snacks or fruit for players.": "phrase.duty_water_food_desc"
  };

  /**
   * Top 15 languages spoken in California.
   */
  var SUPPORTED_LANGUAGES = [
    { code: 'en', label: 'English', short: 'EN', locale: 'en-US', rtl: false },
    { code: 'es', label: 'Español', short: 'ES', locale: 'es-US', rtl: false },
    { code: 'zh', label: '中文', short: '中', locale: 'zh-CN', rtl: false },
    { code: 'tl', label: 'Tagalog', short: 'TL', locale: 'fil-PH', rtl: false },
    { code: 'vi', label: 'Tiếng Việt', short: 'VI', locale: 'vi-VN', rtl: false },
    { code: 'ko', label: '한국어', short: '한', locale: 'ko-KR', rtl: false },
    { code: 'fa', label: 'فارسی', short: 'فا', locale: 'fa-IR', rtl: true },
    { code: 'hy', label: 'Հայերեն', short: 'Հայ', locale: 'hy-AM', rtl: false },
    { code: 'ar', label: 'العربية', short: 'عرب', locale: 'ar', rtl: true },
    { code: 'ru', label: 'Русский', short: 'РУ', locale: 'ru-RU', rtl: false },
    { code: 'hi', label: 'हिन्दी', short: 'हि', locale: 'hi-IN', rtl: false },
    { code: 'pa', label: 'ਪੰਜਾਬੀ', short: 'ਪੰ', locale: 'pa-IN', rtl: false },
    { code: 'ja', label: '日本語', short: '日', locale: 'ja-JP', rtl: false },
    { code: 'fr', label: 'Français', short: 'FR', locale: 'fr-FR', rtl: false },
    { code: 'pt', label: 'Português', short: 'PT', locale: 'pt-BR', rtl: false }
  ];

  API.EN_DICT = EN_DICT;
  API.KNOWN_PHRASE_KEYS = KNOWN_PHRASE_KEYS;
  API.SUPPORTED_LANGUAGES = SUPPORTED_LANGUAGES;
  API.i18nCache = API.i18nCache || { en: EN_DICT };

  /**
   * Detect current active language code.
   * @returns {string}
   */
  API.getLang = function () {
    try {
      var saved = localStorage.getItem('pickup_lang');
      if (saved && this.SUPPORTED_LANGUAGES.some(function (l) { return l.code === saved; })) {
        return saved;
      }
    } catch (e) { /* localStorage unavailable */ }
    if (typeof navigator !== 'undefined' && navigator.language) {
      var base = navigator.language.split('-')[0].toLowerCase();
      var normalized = base === 'fil' ? 'tl' : base;
      if (this.SUPPORTED_LANGUAGES.some(function (l) { return l.code === normalized; })) {
        return normalized;
      }
    }
    return 'en';
  };

  /**
   * Return metadata for a given or active language code.
   * @param {string} [code]
   * @returns {{ code: string, label: string, short: string, locale: string, rtl: boolean }}
   */
  API.getLangMeta = function (code) {
    var langCode = code || this.getLang();
    var match = this.SUPPORTED_LANGUAGES.find(function (l) { return l.code === langCode; });
    return match || this.SUPPORTED_LANGUAGES[0];
  };

  /**
   * Translate a dictionary key with optional variable interpolation.
   * @param {string} key
   * @param {string|Record<string, any>} [fallbackOrVars]
   * @param {Record<string, any>} [maybeVars]
   * @returns {string}
   */
  API.t = function (key, fallbackOrVars, maybeVars) {
    var fallback = null;
    var vars = {};

    if (typeof fallbackOrVars === 'string') {
      fallback = fallbackOrVars;
      vars = (maybeVars && typeof maybeVars === 'object') ? maybeVars : {};
    } else if (fallbackOrVars && typeof fallbackOrVars === 'object') {
      vars = fallbackOrVars;
    }

    var lang = this.getLang();
    var dict = (this.i18nCache && this.i18nCache[lang]) ? this.i18nCache[lang] : EN_DICT;
    var str = (dict && dict[key] !== undefined)
      ? dict[key]
      : (EN_DICT[key] !== undefined
          ? EN_DICT[key]
          : (fallback !== null ? fallback : key));

    if (vars && typeof vars === 'object') {
      var entries = Object.entries(vars);
      for (var i = 0; i < entries.length; i++) {
        var k = entries[i][0];
        var v = entries[i][1];
        str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
      }
    }
    return str;
  };

  /**
   * Translate recognized phrase or return original text.
   * @param {string} text
   * @returns {string}
   */
  API.translatePhrase = function (text) {
    if (!text) return '';
    var trimmed = String(text).trim();
    var key = KNOWN_PHRASE_KEYS[trimmed];
    if (key) return this.t(key);
    return String(text);
  };

  /**
   * Translate event title with date formatting for non-English locales.
   * @param {{ title?: string, event_date?: string }} ev
   * @returns {string}
   */
  API.translateEventTitle = function (ev) {
    if (!ev || !ev.title) return '';
    var raw = String(ev.title).trim();
    if (KNOWN_PHRASE_KEYS[raw]) {
      return this.t(KNOWN_PHRASE_KEYS[raw]);
    }
    if (/^Sunday Pickup Baseball\s*\(.+\)$/i.test(raw)) {
      if (this.getLang() === 'en') return raw;
      var formattedDate = (typeof this.formatDate === 'function') ? this.formatDate(ev.event_date) : '';
      return this.t('phrase.sunday_pickup') + ' (' + formattedDate + ')';
    }
    return raw;
  };

  /**
   * Helper to resolve public interpolation variables from config / settings.
   * @returns {Record<string, string>}
   */
  API.getInterpolationContext = function () {
    var ctx = {
      communityName: 'Sunday Pickup Baseball',
      location: 'Bushrod Park'
    };
    var cfg = this.bootConfig || this.publicConfig;
    if (!cfg) {
      try {
        var cached = localStorage.getItem('pbf_public_config');
        if (cached) cfg = JSON.parse(cached);
      } catch (e) { /* ignore */ }
    }
    if (cfg) {
      if (cfg.communityName) ctx.communityName = String(cfg.communityName);
      if (cfg.COMMUNITY_NAME) ctx.communityName = String(cfg.COMMUNITY_NAME);
      if (cfg.location) ctx.location = String(cfg.location);
      if (cfg.LOCATION) ctx.location = String(cfg.LOCATION);
      if (cfg.fieldLocation) ctx.location = String(cfg.fieldLocation);
    }
    return ctx;
  };

  /**
   * Fetch and cache surface-specific language dictionary (e.g. 'clubhouse' or 'admin').
   * @param {string} surface
   * @param {string} [lang]
   * @returns {Promise<Record<string, string>>}
   */
  API.loadSurfaceDict = function (surface, lang) {
    var l = lang || this.getLang();
    var self = this;
    if (!this.surfaceCaches) this.surfaceCaches = {};
    if (!this.surfaceCaches[surface]) this.surfaceCaches[surface] = {};
    if (this.surfaceCaches[surface][l]) {
      return Promise.resolve(this.surfaceCaches[surface][l]);
    }

    var cacheKey = 'pickup_i18n_' + surface + '_v' + this.CLIENT_VERSION + '_' + l;
    try {
      var cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        var parsed = JSON.parse(cachedRaw);
        this.surfaceCaches[surface][l] = parsed;
        if (!this.i18nCache) this.i18nCache = {};
        if (!this.i18nCache[l]) this.i18nCache[l] = {};
        Object.assign(this.i18nCache[l], parsed);
        return Promise.resolve(parsed);
      }
    } catch (e) { /* storage unavailable */ }

    var url = '/i18n/' + encodeURIComponent(surface) + '/' + encodeURIComponent(l) + '.json?v=' + this.CLIENT_VERSION;
    return fetch(url)
      .then(function (res) {
        if (!res.ok) {
          // If non-English bundle fails, try fallback to en bundle of the surface
          if (l !== 'en') {
            return self.loadSurfaceDict(surface, 'en');
          }
          return {};
        }
        return res.json().then(function (data) {
          self.surfaceCaches[surface][l] = data;
          if (!self.i18nCache) self.i18nCache = {};
          if (!self.i18nCache[l]) self.i18nCache[l] = {};
          Object.assign(self.i18nCache[l], data);
          try {
            localStorage.setItem(cacheKey, JSON.stringify(data));
          } catch (e) { /* storage quota */ }
          return data;
        });
      })
      .catch(function (err) {
        console.warn('Could not load surface dictionary for', surface, l, err);
        return {};
      });
  };

  /**
   * Fetch and cache language dictionary for non-English locales.
   * @param {string} lang
   * @returns {Promise<Record<string, string>>}
   */
  API.loadLangDict = function (lang) {
    if (lang === 'en') return Promise.resolve(EN_DICT);
    if (this.i18nCache && this.i18nCache[lang]) return Promise.resolve(this.i18nCache[lang]);
    var cacheKey = 'pickup_i18n_v' + this.CLIENT_VERSION + '_' + lang;
    try {
      var cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        this.i18nCache[lang] = JSON.parse(cachedRaw);
        return Promise.resolve(this.i18nCache[lang]);
      }
    } catch (e) { /* ignore invalid/unavailable i18n cache */ }

    var self = this;
    return fetch('/i18n/' + encodeURIComponent(lang) + '.json?v=' + this.CLIENT_VERSION)
      .then(function (res) {
        if (!res.ok) return EN_DICT;
        return res.json().then(function (data) {
          self.i18nCache[lang] = data;
          try {
            localStorage.setItem(cacheKey, JSON.stringify(data));
          } catch (e) { /* storage quota / private mode */ }
          return data;
        });
      })
      .catch(function (err) {
        console.warn('Could not load language dictionary:', lang, err);
        return EN_DICT;
      });
  };

  /**
   * Set active language, load bundle, and trigger translation re-render.
   * @param {string} lang
   * @returns {Promise<void>}
   */
  API.setLang = function (lang) {
    if (!this.SUPPORTED_LANGUAGES.some(function (l) { return l.code === lang; })) {
      return Promise.resolve();
    }
    try {
      localStorage.setItem('pickup_lang', lang);
    } catch (e) { /* localStorage unavailable */ }

    var self = this;
    var promises = [this.loadLangDict(lang)];
    if (this.activeSurfaces && Array.isArray(this.activeSurfaces)) {
      for (var s = 0; s < this.activeSurfaces.length; s++) {
        promises.push(this.loadSurfaceDict(this.activeSurfaces[s], lang));
      }
    }

    return Promise.all(promises).then(function () {
      self.applyTranslations();
      if (typeof self.renderNav === 'function') {
        self.renderNav(self.currentUser);
      }
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('pickup:langchange', { detail: { lang: lang } }));
      }
    });
  };

  /**
   * Apply translations to DOM elements matching data-i18n* attributes.
   * Supports: data-i18n (text), data-i18n-html (HTML), data-i18n-placeholder,
   * data-i18n-title, and data-i18n-aria-label.
   * Dynamic variables {communityName} and {location} are interpolated from public boot config.
   * @param {Document|Element} [root]
   */
  API.applyTranslations = function (root) {
    var target = root || document;
    if (!target || !target.querySelectorAll) return;

    var lang = this.getLang();
    var meta = this.getLangMeta(lang);
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = lang;
      document.documentElement.dir = meta.rtl ? 'rtl' : 'ltr';
      document.documentElement.style.setProperty('--privacy-more', JSON.stringify(String(this.t('privacy.read_details') || '')));
      document.documentElement.style.setProperty('--privacy-hide', JSON.stringify(String(this.t('privacy.hide') || '')));
    }

    var self = this;
    var defaultVars = this.getInterpolationContext();

    target.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (key) el.textContent = self.t(key, defaultVars);
    });

    target.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-html');
      if (key) el.innerHTML = self.t(key, defaultVars);
    });

    target.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-placeholder');
      if (key) el.setAttribute('placeholder', self.t(key, defaultVars));
    });

    target.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-title');
      if (key) el.setAttribute('title', self.t(key, defaultVars));
    });

    target.querySelectorAll('[data-i18n-aria-label]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-aria-label');
      if (key) el.setAttribute('aria-label', self.t(key, defaultVars));
    });

    if (typeof document !== 'undefined') {
      var langSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('lang-select'));
      if (langSelect && langSelect.value !== lang) {
        langSelect.value = lang;
      }
    }
  };

  /**
   * Initialize i18n subsystem on page boot.
   * @returns {Promise<void>}
   */
  API.initI18n = function () {
    var lang = this.getLang();
    var self = this;
    var loadPromise = (lang !== 'en') ? this.loadLangDict(lang) : Promise.resolve(EN_DICT);
    return loadPromise.then(function () {
      self.applyTranslations();
      if (lang !== 'en' && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('pickup:langchange', { detail: { lang: lang } }));
      }
    });
  };
})();
