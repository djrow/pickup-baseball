/**
 * Standard API Helpers and Navigation for Pickup Baseball Charity
 * Vanilla JS, no external dependencies, durable for 10+ years.
 */

const EN_DICT = {
  "nav.community": "Community",
  "nav.calendar": "Calendar",
  "nav.archive": "Archive",
  "nav.gallery": "Gallery & Art",
  "nav.gallery_title": "Photo, Video & Art Gallery",
  "nav.donate": "Donate",
  "nav.handbook": "Handbook",
  "nav.login": "Log In",
  "nav.logout": "Log Out",
  "nav.admin": "⚙️ Admin",
  "nav.org": "⚾ Org",
  "calendar.title": "Game Calendar",
  "calendar.subtitle": "Sunday Pickup Games • 12:00 PM • Bushrod Park",
  "calendar.today": "Today",
  "calendar.add_to_calendar": "Subscribe (.ics)",
  "calendar.export_btn": "📥 Export Schedule (.ics)",
  "calendar.sync_checking": "Syncing with cloud…",
  "calendar.sync_just_now": "Cloud synced • Just now",
  "calendar.sync_mins_ago": "Cloud synced • {mins}m ago",
  "calendar.sync_at_time": "Cloud synced • {time}",
  "calendar.sync_offline_cached": "Offline — cached schedule ({time})",
  "calendar.sync_offline": "Offline — showing cached schedule",
  "calendar.sync_offline_empty": "Offline — unable to reach cloud",
  "calendar.subscribe_title": "🔄 Live Cloud Calendar Sync (.ics)",
  "calendar.subscribe_desc": "Subscribe once so newly scheduled games, field changes, and rainout alerts update automatically on your phone or computer.",
  "calendar.subscribe_apple_btn": "🍎 Apple / Outlook (Live Sync)",
  "calendar.subscribe_google_btn": "📅 Google Calendar (Live Sync)",
  "calendar.subscribe_copy_btn": "📋 Copy Feed URL",
  "calendar.subscribe_copied": "✓ Copied!",
  "calendar.subscribe_snapshot_btn": "📥 Download One-Time .ics File",
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
  "footer.about_site": "Built with Google Gemini in October 2026 for simplicity and durability. Free & open-source",
  "footer.handbook": "Handbook & Field Rules",
  "footer.copyright": "© 2026 Pickup Baseball Foundation. Licensed under Creative Commons BY-NC 4.0.",
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
  "how.title": "How Our Pickup Baseball Program Works",
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
  "event.email_label": "Email Address *",
  "event.email_placeholder": "For game reminder notifications",
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
  "event.rsvp_email_note": "📬 Confirmation email + 24h game reminder",
  "event.duty_board_title": "🛡️ Game Day Task Board",
  "event.duty_board_desc": "Essential roles to keep our pickup games safe, fun, and organized.",
  "event.duty_filled": "Filled",
  "event.duty_needed": "Needed",
  "event.duty_volunteers": "✓ Volunteer(s):",
  "event.duty_needs_count": "⚠️ Needs {count} volunteer(s)",
  "event.duty_covered": "Covered",
  "event.duty_covered_by": "✓ Covered by {names}",
  "event.duty_current_open": "Current: {names} ({count} open)",
  "event.roster_title": "👥 Who's Coming",
  "event.roster_desc": "Players, spectators, shared gear, and group tasks.",
  "event.actual_turnout": "Actual Turnout",
  "event.turnout_badge": "{count} Played",
  "event.turnout_count_sub": "({count} online RSVPs)",
  "event.record_turnout": "Record Actual Attendance",
  "event.record_turnout_desc": "{count} players RSVP'd online. How many players actually played?",
  "event.save_turnout": "Save Turnout",
  "event.roster_private_title": "Player Roster is Private",
  "event.roster_private_desc": "To protect player privacy, individual names and gear assignments are only visible to attendees. Please RSVP (attending or can't make it) below to view who's playing!",
  "event.roster_private_cta": "RSVP to View Roster",
  "event.confirmed_badge": "{count} Confirmed",
  "event.waitlist_heading": "Waitlist",
  "event.waitlist_badge": "Waitlist #{pos}",
  "event.on_waitlist_badge": "On Waitlist",
  "event.waitlist_pos_badge": "Waitlist #{pos}",
  "event.join_waitlist_btn": "Join Waitlist (Auto-Promote)",
  "event.update_waitlist_btn": "Update Waitlist Info",
  "event.no_players_yet": "No players on the roster yet. Be the first to mark yourself attending!",
  "event.playing_badge": "Playing",
  "event.guest_tag": "(Guest)",
  "event.discussion_title": "💬 Game Discussion Board",
  "event.discussion_desc": "Coordinate carpools, ask about gear, discuss weather, or post post-game highlights!",
  "event.no_comments_yet": "No discussion yet. Have a question about field location or gear? Start the conversation below!",
  "event.signin_to_comment": "Please sign in to join the game discussion and coordinate gear with teammates.",
  "event.signin_email_btn": "Sign In with Email →",
  "event.leave_message": "Leave a Message",
  "event.email_optional": "Email (Optional)",
  "event.message_label": "Message",
  "event.message_placeholder": "Field update, gear questions, or post-game shoutouts...",
  "event.post_comment_btn": "Post to Discussion",
  "login.title": "Player Sign-In",
  "login.subtitle": "No password needed. We'll send a 6-digit code or magic link to your email.",
  "login.name_label": "Name",
  "login.name_placeholder": "Your name",
  "login.name_help": "Only needed if this is your first time playing with us.",
  "login.email_label": "Email Address *",
  "login.remember_email": "Remember my email address on this device",
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
  "phrase.duty_water_food_desc": "Bring drinking water, ice, and dugout snacks or fruit for players."
};

const KNOWN_PHRASE_KEYS = {
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

const API = {
  // Installed Client Application Version
  CLIENT_VERSION: '77',

  // Current user cache
  currentUser: null,

  // Top 15 languages spoken in California
  SUPPORTED_LANGUAGES: [
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
  ],

  i18nCache: { en: EN_DICT },

  getLang() {
    try {
      const saved = localStorage.getItem('pickup_lang');
      if (saved && this.SUPPORTED_LANGUAGES.some(l => l.code === saved)) {
        return saved;
      }
    } catch (e) {}
    if (typeof navigator !== 'undefined' && navigator.language) {
      const base = navigator.language.split('-')[0].toLowerCase();
      const normalized = base === 'fil' ? 'tl' : base;
      if (this.SUPPORTED_LANGUAGES.some(l => l.code === normalized)) {
        return normalized;
      }
    }
    return 'en';
  },

  getLangMeta(code) {
    const langCode = code || this.getLang();
    return this.SUPPORTED_LANGUAGES.find(l => l.code === langCode) || this.SUPPORTED_LANGUAGES[0];
  },

  t(key, fallbackOrVars = {}, maybeVars = {}) {
    let fallback = null;
    let vars = {};

    if (typeof fallbackOrVars === 'string') {
      fallback = fallbackOrVars;
      vars = (maybeVars && typeof maybeVars === 'object') ? maybeVars : {};
    } else if (fallbackOrVars && typeof fallbackOrVars === 'object') {
      vars = fallbackOrVars;
    }

    const lang = this.getLang();
    const dict = this.i18nCache[lang] || EN_DICT;
    let str = (dict && dict[key] !== undefined)
      ? dict[key]
      : (EN_DICT[key] !== undefined
          ? EN_DICT[key]
          : (fallback !== null ? fallback : key));

    if (vars && typeof vars === 'object') {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return str;
  },

  translatePhrase(text) {
    if (!text) return '';
    const trimmed = String(text).trim();
    const key = KNOWN_PHRASE_KEYS[trimmed];
    if (key) return this.t(key);
    return String(text);
  },

  translateEventTitle(ev) {
    if (!ev || !ev.title) return '';
    const raw = String(ev.title).trim();
    if (KNOWN_PHRASE_KEYS[raw]) {
      return this.t(KNOWN_PHRASE_KEYS[raw]);
    }
    if (/^Sunday Pickup Baseball\s*\(.+\)$/i.test(raw)) {
      if (this.getLang() === 'en') return raw;
      return `${this.t('phrase.sunday_pickup')} (${this.formatDate(ev.event_date)})`;
    }
    return raw;
  },

  async loadLangDict(lang) {
    if (lang === 'en') return EN_DICT;
    if (this.i18nCache[lang]) return this.i18nCache[lang];
    const cacheKey = 'pickup_i18n_v' + this.CLIENT_VERSION + '_' + lang;
    try {
      const cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        this.i18nCache[lang] = JSON.parse(cachedRaw);
        return this.i18nCache[lang];
      }
    } catch (e) {}
    try {
      const res = await fetch('/i18n/' + encodeURIComponent(lang) + '.json?v=' + this.CLIENT_VERSION);
      if (res.ok) {
        const data = await res.json();
        this.i18nCache[lang] = data;
        try {
          localStorage.setItem(cacheKey, JSON.stringify(data));
        } catch (e) {}
        return data;
      }
    } catch (err) {
      console.warn('Could not load language dictionary:', lang, err);
    }
    return EN_DICT;
  },

  async setLang(lang) {
    if (!this.SUPPORTED_LANGUAGES.some(l => l.code === lang)) return;
    try {
      localStorage.setItem('pickup_lang', lang);
    } catch (e) {}
    await this.loadLangDict(lang);
    this.applyTranslations();
    this.renderNav(this.currentUser);
    window.dispatchEvent(new CustomEvent('pickup:langchange', { detail: { lang } }));
  },

  applyTranslations(root = document) {
    const lang = this.getLang();
    const meta = this.getLangMeta(lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = meta.rtl ? 'rtl' : 'ltr';
    document.documentElement.style.setProperty('--privacy-more', `"${this.t('privacy.read_details')}"`);
    document.documentElement.style.setProperty('--privacy-hide', `"${this.t('privacy.hide')}"`);

    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = this.t(key);
    });

    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      const key = el.getAttribute('data-i18n-html');
      if (key) el.innerHTML = this.t(key);
    });

    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) el.setAttribute('placeholder', this.t(key));
    });

    const langSelect = document.getElementById('lang-select');
    if (langSelect && langSelect.value !== lang) {
      langSelect.value = lang;
    }
  },

  async initI18n() {
    const lang = this.getLang();
    if (lang !== 'en') {
      await this.loadLangDict(lang);
    }
    this.applyTranslations();
    if (lang !== 'en') {
      window.dispatchEvent(new CustomEvent('pickup:langchange', { detail: { lang } }));
    }
  },

  COLOR_THEMES: [
    { id: 'bay-area', name: 'Bay Area Heritage', market: "SF Giants & Oakland A's", primaryColor: '#FD5A1E', secondaryColor: '#003831' },
    { id: 'seattle-mariners', name: 'Seattle Mariners', market: 'Northwest Green & Navy', primaryColor: '#005C5C', secondaryColor: '#0C2340' },
    { id: 'white-sox', name: 'Chicago White Sox', market: 'South Side Black & Silver', primaryColor: '#27251F', secondaryColor: '#94a3b8' },
    { id: 'milwaukee-brewers', name: 'Milwaukee Brewers', market: 'Glove Navy & Harvest Gold', primaryColor: '#B6891A', secondaryColor: '#12284C' },
    { id: 'dodger-blue', name: 'Dodger Blue & Silver', market: 'Los Angeles Dodgers', primaryColor: '#005A9C', secondaryColor: '#0B2341' },
    { id: 'pinstripe-navy', name: 'Pinstripe Navy & Silver', market: 'New York Yankees', primaryColor: '#1E3A5F', secondaryColor: '#0C2340' },
    { id: 'fenway-red', name: 'Fenway Crimson & Navy', market: 'Boston Red Sox', primaryColor: '#C8102E', secondaryColor: '#0C2340' },
    { id: 'wrigley-royal', name: 'Wrigley Royal & Red', market: 'Chicago Cubs', primaryColor: '#0E3386', secondaryColor: '#CC3433' },
    { id: 'camden-orange', name: 'Camden Orange & Black', market: 'Baltimore Orioles', primaryColor: '#DF4601', secondaryColor: '#212322' },
    { id: 'friar-gold', name: 'Friar Brown & Sungold', market: 'San Diego Padres', primaryColor: '#C48200', secondaryColor: '#2F241D' },
    { id: 'sedona-red', name: 'Sedona Red & Desert Teal', market: 'Arizona Diamondbacks', primaryColor: '#A71930', secondaryColor: '#26696D' },
    { id: 'powder-blue', name: 'Powder Blue & Royal', market: 'Classic 1980s Retro', primaryColor: '#0284c7', secondaryColor: '#004687' }
  ],

  getThemeMode() {
    try {
      const saved = localStorage.getItem('pickup_theme_mode');
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
      const legacy = localStorage.getItem('pickup_theme');
      if (legacy === 'light' || legacy === 'dark') return legacy;
    } catch (e) {}
    return 'system';
  },

  getEffectiveTheme() {
    const mode = this.getThemeMode();
    if (mode === 'dark') return 'dark';
    if (mode === 'light') return 'light';
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  },

  getTheme() {
    return this.getEffectiveTheme();
  },

  getColorTheme() {
    try {
      const saved = localStorage.getItem('pickup_color_theme');
      if (saved && this.COLOR_THEMES.some(t => t.id === saved)) {
        return saved;
      }
    } catch (e) {}
    return 'bay-area';
  },

  updateThemeColorMeta() {
    if (typeof document === 'undefined') return;
    const isDark = this.getEffectiveTheme() === 'dark';
    let bg = '#ffffff';
    if (isDark) {
      try {
        const computed = getComputedStyle(document.documentElement).getPropertyValue('--bg-card').trim();
        bg = computed || '#11221e';
      } catch (e) {
        bg = '#11221e';
      }
    } else {
      try {
        const computed = getComputedStyle(document.documentElement).getPropertyValue('--bg-card').trim();
        bg = computed || '#ffffff';
      } catch (e) {
        bg = '#ffffff';
      }
    }
    const metaTags = document.querySelectorAll('meta[name="theme-color"]');
    if (metaTags.length > 0) {
      metaTags.forEach(m => m.setAttribute('content', bg));
    } else {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.content = bg;
      document.head.appendChild(meta);
    }
  },

  applyColorTheme(colorThemeId) {
    const valid = this.COLOR_THEMES.some(t => t.id === colorThemeId) ? colorThemeId : 'bay-area';
    if (valid === 'bay-area') {
      document.documentElement.removeAttribute('data-color-theme');
    } else {
      document.documentElement.setAttribute('data-color-theme', valid);
    }
    this.updateThemeColorMeta();
  },

  setColorTheme(themeId) {
    if (!this.COLOR_THEMES.some(t => t.id === themeId)) return;
    try {
      localStorage.setItem('pickup_color_theme', themeId);
    } catch (e) {}
    this.applyColorTheme(themeId);
    this.updateFooterThemeUi();
  },

  applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    this.updateThemeColorMeta();
  },

  setThemeMode(mode) {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return;
    try {
      localStorage.setItem('pickup_theme_mode', mode);
      localStorage.setItem('pickup_theme', this.getEffectiveTheme());
    } catch (e) {}
    this.applyTheme(this.getEffectiveTheme());
    this.updateFooterThemeUi();
  },

  toggleTheme() {
    const current = this.getEffectiveTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    this.setThemeMode(next);
  },

  initTheme() {
    // 1. Immediately apply color theme and light/dark theme attributes
    this.applyColorTheme(this.getColorTheme());
    this.applyTheme(this.getEffectiveTheme());
    this.updateThemeColorMeta();

    // 2. Listen to system preference changes if in system mode
    if (typeof window !== 'undefined' && window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
          if (this.getThemeMode() === 'system') {
            this.applyTheme(this.getEffectiveTheme());
            this.updateFooterThemeUi();
          }
        });
      } catch (e) {}
    }

    // 3. Mount footer theme picker when DOM is interactive
    const mount = () => {
      this.renderFooter();
    };
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
      } else {
        mount();
      }
    }
  },

  updateFooterThemeUi() {
    const currentMode = this.getThemeMode();
    const currentColor = this.getColorTheme();
    const effectiveTheme = this.getEffectiveTheme();
    const activeThemeObj = this.COLOR_THEMES.find(t => t.id === currentColor) || this.COLOR_THEMES[0];

    const trigger = document.getElementById('footer-theme-trigger');
    if (trigger) {
      trigger.innerHTML = `
        <span style="display: inline-flex; align-items: center; gap: 4px; vertical-align: middle;">
          <span style="width: 11px; height: 11px; border-radius: 50%; background: ${activeThemeObj.primaryColor}; display: inline-block; border: 1.5px solid rgba(255,255,255,0.6);"></span>
          <span style="width: 11px; height: 11px; border-radius: 50%; background: ${activeThemeObj.secondaryColor}; display: inline-block; border: 1.5px solid rgba(255,255,255,0.6); margin-left: -5px; margin-inline-start: -5px;"></span>
        </span>
        <span>🎨 Theme &amp; Colors: <strong>${this.escapeHtml(activeThemeObj.name)}</strong> (${effectiveTheme === 'dark' ? 'Dark' : 'Light'})</span>
      `;
    }

    // Update mode tabs in panel
    document.querySelectorAll('#footer-theme-panel .theme-mode-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.mode === currentMode);
    });

    // Update palette cards in panel
    document.querySelectorAll('#footer-theme-panel .theme-palette-card').forEach(card => {
      const isSelected = card.dataset.colorTheme === currentColor;
      card.classList.toggle('selected', isSelected);
      const check = card.querySelector('.palette-check');
      if (check) check.textContent = isSelected ? '✓' : '';
    });
  },


  renderFooter() {
    if (typeof document === 'undefined') return;
    const footer = document.getElementById('site-footer') || document.querySelector('footer.site-footer');
    if (!footer) return;

    if (!footer.querySelector('.footer-controls')) {
      footer.innerHTML = `
        <div class="container">
          <p><img src="/logo.svg" alt="" class="footer-logo"> <strong>Pickup Baseball Foundation</strong> — <span data-i18n="footer.tagline">${this.escapeHtml(this.t('footer.tagline', "Building community through America's pastime."))}</span></p>
          <div class="footer-controls">
            <div class="footer-theme-wrapper">
              <button type="button" id="footer-theme-trigger" class="footer-theme-btn" aria-label="Change Appearance Theme">🎨 Theme &amp; Colors</button>
            </div>
            <div id="footer-theme-panel-slot"></div>
            <div id="footer-update-wrapper" class="footer-update-wrapper">
              <button type="button" id="footer-update-btn" class="footer-update-btn" aria-label="Update app to latest version">
                <span class="update-icon">🔄</span> <span class="update-label" data-i18n="footer.update_app">${this.escapeHtml(this.t('footer.update_app', 'Update App'))}</span>
              </button>
            </div>
            <div id="footer-update-status" class="footer-update-status" style="display: none;" role="status" aria-live="polite"></div>
          </div>
          <p style="margin-top: 12px; font-size: 0.8rem; color: #94a3b8; line-height: 1.5;">
            <span data-i18n="footer.about_site">${this.escapeHtml(this.t('footer.about_site', 'Built with Google Gemini in October 2026 for simplicity and durability. Free & open-source'))}</span> on <a href="https://github.com/djrow/pickup-baseball" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;">GitHub</a> • <a href="https://github.com/djrow/pickup-baseball/blob/trunk/HANDBOOK.md" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;" data-i18n="footer.handbook">${this.escapeHtml(this.t('footer.handbook', 'Handbook & Field Rules'))}</a>.
          </p>
          <p style="margin-top: 6px; font-size: 0.75rem; color: #64748b; line-height: 1.4;">
            <span data-i18n="footer.copyright">© 2026 Pickup Baseball Foundation. Licensed under <a href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;">Creative Commons BY-NC 4.0</a>.</span>
          </p>
        </div>
      `;
    }
    this.initFooterThemePicker();
    this.initAppUpdater();
  },

  initFooterThemePicker() {
    if (typeof document === 'undefined') return;
    const trigger = document.getElementById('footer-theme-trigger');
    if (!trigger) return;

    let panel = document.getElementById('footer-theme-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'footer-theme-panel';
      panel.className = 'footer-theme-panel';
      panel.setAttribute('aria-hidden', 'true');

      const currentMode = this.getThemeMode();
      const currentColor = this.getColorTheme();

      panel.innerHTML = `
        <div class="footer-theme-header">
          <div class="footer-theme-title">
            <span>⚾</span> <strong>Baseball Colors & Mode</strong>
          </div>
          <button type="button" id="footer-theme-close-btn" class="footer-theme-close" aria-label="Close theme options">✕</button>
        </div>

        <div class="theme-mode-tabs" role="tablist">
          <button type="button" class="theme-mode-tab ${currentMode === 'light' ? 'active' : ''}" data-mode="light">☀️ Light</button>
          <button type="button" class="theme-mode-tab ${currentMode === 'dark' ? 'active' : ''}" data-mode="dark">🌙 Dark</button>
          <button type="button" class="theme-mode-tab ${currentMode === 'system' ? 'active' : ''}" data-mode="system">💻 System</button>
        </div>

        <div class="theme-palette-heading" style="text-align: start; margin-top: 10px;">Select Market Palette</div>
        <div class="footer-theme-palette-grid">
          ${this.COLOR_THEMES.map(th => `
            <button type="button" class="theme-palette-card ${th.id === currentColor ? 'selected' : ''}" data-color-theme="${th.id}">
              <span class="palette-swatches">
                <span class="swatch-preview" style="background: ${th.primaryColor};"></span>
                <span class="swatch-preview" style="background: ${th.secondaryColor};"></span>
              </span>
              <span class="palette-info">
                <span class="palette-name">${this.escapeHtml(th.name)}</span>
                <span class="palette-sub">${this.escapeHtml(th.market)}</span>
              </span>
              <span class="palette-check">${th.id === currentColor ? '✓' : ''}</span>
            </button>
          `).join('')}
        </div>
      `;

      const slot = document.getElementById('footer-theme-panel-slot');
      if (slot) {
        slot.appendChild(panel);
      } else if (trigger.parentElement) {
        trigger.parentElement.insertAdjacentElement('afterend', panel);
      }
    }

    if (!trigger.dataset.bound) {
      trigger.dataset.bound = '1';
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = panel.classList.contains('open');
        panel.classList.toggle('open', !isOpen);
        panel.setAttribute('aria-hidden', String(isOpen));
        trigger.setAttribute('aria-expanded', String(!isOpen));
        if (!isOpen) {
          panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    }

    const closeBtn = document.getElementById('footer-theme-close-btn');
    if (closeBtn && !closeBtn.dataset.bound) {
      closeBtn.dataset.bound = '1';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
        trigger.setAttribute('aria-expanded', 'false');
      });
    }

    panel.querySelectorAll('.theme-mode-tab').forEach(tab => {
      if (!tab.dataset.bound) {
        tab.dataset.bound = '1';
        tab.addEventListener('click', (e) => {
          e.stopPropagation();
          const mode = tab.dataset.mode;
          this.setThemeMode(mode);
        });
      }
    });

    panel.querySelectorAll('.theme-palette-card').forEach(card => {
      if (!card.dataset.bound) {
        card.dataset.bound = '1';
        card.addEventListener('click', (e) => {
          e.stopPropagation();
          const colorTheme = card.dataset.colorTheme;
          this.setColorTheme(colorTheme);
        });
      }
    });

    document.addEventListener('click', (e) => {
      if (panel && panel.classList.contains('open')) {
        if (!panel.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) {
          panel.classList.remove('open');
          panel.setAttribute('aria-hidden', 'true');
          trigger.setAttribute('aria-expanded', 'false');
        }
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel && panel.classList.contains('open')) {
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
        trigger.setAttribute('aria-expanded', 'false');
      }
    });

    this.updateFooterThemeUi();
  },


  checkResponseVersion(res) {
    if (!res || !res.headers) return;
    try {
      const serverVersion = res.headers.get('x-app-version');
      if (serverVersion && serverVersion !== this.CLIENT_VERSION) {
        this.setUpdateAvailableUi(null, null, serverVersion);
      }
    } catch (e) {}
  },

  async checkForUpdates() {
    try {
      const res = await fetch('/api/version?t=' + Date.now());
      if (res.ok) {
        this.checkResponseVersion(res);
        const data = await res.json();
        if (data && data.version && data.version !== this.CLIENT_VERSION) {
          this.setUpdateAvailableUi(null, null, data.version);
          return true;
        }
      }
    } catch (e) {}
    return false;
  },

  initAppUpdater() {
    if (typeof document === 'undefined') return;
    const updateBtn = document.getElementById('footer-update-btn');
    const statusEl = document.getElementById('footer-update-status');
    if (!updateBtn || updateBtn.dataset.bound) return;
    updateBtn.dataset.bound = '1';

    let waitingWorker = null;

    // 1. Service Worker updatefound & waiting lifecycle detection
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (!reg) return;

        if (reg.waiting) {
          waitingWorker = reg.waiting;
          this.setUpdateAvailableUi(updateBtn, statusEl);
        }

        reg.addEventListener('updatefound', () => {
          const installingWorker = reg.installing;
          if (installingWorker) {
            installingWorker.addEventListener('statechange', () => {
              if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                waitingWorker = installingWorker;
                this.setUpdateAvailableUi(updateBtn, statusEl);
              }
            });
          }
        });
      }).catch((err) => {
        console.warn('[PWA] Service worker lookup error:', err);
      });

      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });
    }

    // 2. Non-blocking heartbeat version check (compares server X-App-Version against client version)
    setTimeout(() => {
      this.checkForUpdates();
    }, 1500);

    // 3. User update action
    updateBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await this.triggerAppUpdate(updateBtn, statusEl, waitingWorker);
    });
  },

  setUpdateAvailableUi(btn, statusEl, newVersion) {
    if (!btn) btn = document.getElementById('footer-update-btn');
    if (!statusEl) statusEl = document.getElementById('footer-update-status');
    const wrapper = document.getElementById('footer-update-wrapper') || (btn ? btn.closest('.footer-update-wrapper') : null);
    if (wrapper) {
      wrapper.classList.add('visible');
      wrapper.style.display = 'flex';
    }
    if (btn) {
      btn.classList.add('update-available');
      const label = btn.querySelector('.update-label');
      if (label) {
        label.textContent = this.t('footer.update_available', 'Update Available — Click to Refresh');
      }
    }
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.className = 'footer-update-status status-available';
      statusEl.textContent = this.t('footer.update_available_desc', 'A new version of Sunday Pickup Baseball is ready.');
    }
  },

  async triggerAppUpdate(btn, statusEl, waitingWorker) {
    if (btn) {
      btn.classList.add('updating');
      btn.disabled = true;
      const label = btn.querySelector('.update-label');
      if (label) {
        label.textContent = this.t('footer.update_checking', 'Checking for updates...');
      }
    }
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.className = 'footer-update-status status-checking';
      statusEl.textContent = this.t('footer.update_checking', 'Checking for updates and clearing cache...');
    }

    try {
      if (waitingWorker) {
        waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      }

      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          if (reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
          await reg.update().catch(() => {});
        }
      }

      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(k => caches.delete(k)));
      }

      this.clearDataCaches();
      try {
        localStorage.removeItem('pbf_events_cache');
        localStorage.removeItem('pbf_cached_user');
      } catch (err) {}

      if (statusEl) {
        statusEl.className = 'footer-update-status status-ready';
        statusEl.textContent = this.t('footer.update_reloading', '✓ App updated! Reloading with latest version...');
      }

      setTimeout(() => {
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('updated', String(Date.now()));
        window.location.href = currentUrl.toString();
      }, 450);

    } catch (err) {
      console.error('[Update Error]', err);
      window.location.reload();
    }
  },

  getCachedUser() {
    try {
      const raw = localStorage.getItem('pickup_cached_user');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  setCachedUser(user) {
    try {
      if (user) {
        localStorage.setItem('pickup_cached_user', JSON.stringify(user));
      } else {
        localStorage.removeItem('pickup_cached_user');
      }
    } catch (e) {}
  },

  clearDataCaches() {
    try {
      localStorage.removeItem('pickup_cached_user');
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('pickup_cached_event')) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  },

  async request(method, url, body, opts) {
    const options = opts || {};
    const init = { method: method };
    if (options.noStore) init.cache = 'no-store';
    if (body !== undefined && body !== null) {
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        init.body = body;
      } else {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, init);
    this.checkResponseVersion(res);
    const data = await res.json();
    if (options.throwOnError && !res.ok) {
      throw new Error((data && data.error) ? data.error : (options.errorMsg || 'Request failed.'));
    }
    if (options.invalidateKeys && (!options.invalidateOnSuccess || (data && data.success))) {
      try {
        options.invalidateKeys.forEach(function(k) { localStorage.removeItem(k); });
      } catch (e) {}
    }
    return data;
  },

  async getMe() {
    try {
      const data = await this.request('GET', '/api/auth/me');
      API.currentUser = data.user || null;
      API.setCachedUser(API.currentUser);
      return API.currentUser;
    } catch (e) {
      console.warn('Could not fetch session', e);
      return API.getCachedUser();
    }
  },

  async logout() {
    try {
      API.clearDataCaches();
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/index.html';
    }
  },

  async getPosts() {
    return this.request('GET', '/api/posts', null, {
      noStore: true, throwOnError: true, errorMsg: 'Failed to load community highlights.'
    });
  },

  async createPost(payload) {
    return this.request('POST', '/api/posts', payload || {}, {
      throwOnError: true, errorMsg: 'Failed to publish post.'
    });
  },

  async deletePost(id) {
    return this.request('DELETE', '/api/posts/' + encodeURIComponent(id), null, {
      throwOnError: true, errorMsg: 'Failed to delete post.'
    });
  },

  async getMedia(params) {
    const p = params || {};
    const q = new URLSearchParams();
    if (p.type) q.set('type', p.type);
    if (p.album) q.set('album', p.album);
    if (p.order) q.set('order', p.order);
    if (p.status) q.set('status', p.status);
    const qs = q.toString() ? '?' + q.toString() : '';
    return this.request('GET', '/api/media' + qs, null, {
      noStore: true, throwOnError: true, errorMsg: 'Failed to load community gallery.'
    });
  },

  async submitMedia(payload) {
    return this.request('POST', '/api/media', payload || {}, {
      throwOnError: true, errorMsg: 'Failed to submit media.'
    });
  },

  async approveMedia(id) {
    return this.request('PUT', '/api/media/' + encodeURIComponent(id) + '/approve', null, {
      throwOnError: true, errorMsg: 'Failed to approve media item.'
    });
  },

  async updateMedia(id, payload) {
    return this.request('PUT', '/api/media/' + encodeURIComponent(id), payload || {}, {
      throwOnError: true, errorMsg: 'Failed to update media item.'
    });
  },

  async deleteMedia(id, token) {
    const headers = {};
    if (token) headers['X-Delete-Token'] = token;
    const qs = token ? '?token=' + encodeURIComponent(token) : '';
    return this.request('DELETE', '/api/media/' + encodeURIComponent(id) + qs, null, {
      headers,
      throwOnError: true,
      errorMsg: 'Failed to delete media item.'
    });
  },

  async getEvents(filter = 'upcoming') {
    const data = await this.request('GET', '/api/events?filter=' + encodeURIComponent(filter), null, {
      noStore: true, throwOnError: true, errorMsg: 'Failed to sync schedule with cloud.'
    });
    if (data && data.user !== undefined) {
      API.currentUser = data.user || null;
      API.setCachedUser(API.currentUser);
    }
    return data;
  },

  async getEvent(id, token = '') {
    const url = '/api/events/' + id + (token ? '?token=' + encodeURIComponent(token) : '');
    const data = await this.request('GET', url);
    if (data && data.user !== undefined) {
      API.currentUser = data.user || null;
      API.setCachedUser(API.currentUser);
    }
    return data;
  },

  async postRsvp(id, payload) {
    return this.request('POST', '/api/events/' + id + '/rsvp', payload, {
      invalidateKeys: ['pickup_cached_event_' + id, 'pickup_cached_events_upcoming', 'pickup_cached_events_all']
    });
  },

  async postComment(id, payload) {
    return this.request('POST', '/api/events/' + id + '/comments', payload, {
      invalidateKeys: ['pickup_cached_event_' + id]
    });
  },

  async deleteComment(eventId, commentId) {
    return this.request('DELETE', '/api/events/' + eventId + '/comments/' + commentId, null, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  },

  async removeAttendee(eventId, attendeeId) {
    return this.request('DELETE', '/api/events/' + eventId + '/attendees/' + attendeeId, null, {
      invalidateKeys: ['pickup_cached_event_' + eventId, 'pickup_cached_events_upcoming', 'pickup_cached_events_all']
    });
  },

  async callRainout(id, payload) {
    return this.request('POST', '/api/events/' + id + '/rainout', payload || {}, {
      invalidateKeys: ['pickup_cached_event_' + id, 'pickup_cached_events_upcoming', 'pickup_cached_events_all']
    });
  },

  async reopenEvent(id, payload) {
    return this.request('POST', '/api/events/' + id + '/reopen', payload || {}, {
      invalidateKeys: ['pickup_cached_event_' + id, 'pickup_cached_events_upcoming', 'pickup_cached_events_all']
    });
  },

  async sendRainoutEmail(id, payload) {
    return this.request('POST', '/api/events/' + id + '/send-rainout-email', payload || {});
  },

  async sendReminders(id) {
    return this.request('POST', '/api/events/' + id + '/send-reminders');
  },

  async sendLoginCode(email, name = '') {
    return this.request('POST', '/api/auth/send-code', { email: email, name: name });
  },

  async verifyLoginCode(email, code) {
    return this.request('POST', '/api/auth/verify-code', { email: email, code: code });
  },

  async updateProfile(name, bio) {
    return this.request('PUT', '/api/auth/profile', { name: name, bio: bio });
  },

  async uploadAvatar(file) {
    const formData = new FormData();
    formData.append('avatar', file);
    return this.request('POST', '/api/auth/avatar', formData);
  },

  async deleteAvatar() {
    return this.request('DELETE', '/api/auth/avatar');
  },

  async getDefaultDuties() {
    return this.request('GET', '/api/events/default-duties');
  },

  async saveDefaultDuties(duties) {
    return this.request('PUT', '/api/events/default-duties', { duties: duties });
  },

  async createEvent(payload) {
    return this.request('POST', '/api/events', payload, {
      invalidateKeys: ['pickup_cached_events_upcoming', 'pickup_cached_events_all']
    });
  },

  async updateEvent(id, payload) {
    return this.request('PUT', '/api/events/' + id, payload, {
      invalidateOnSuccess: true,
      invalidateKeys: [
        'pickup_cached_event_' + id,
        'pickup_cached_events_upcoming',
        'pickup_cached_events_past',
        'pickup_cached_events_all'
      ]
    });
  },

  async deleteEvent(id) {
    return this.request('DELETE', '/api/events/' + id, null, {
      invalidateOnSuccess: true,
      invalidateKeys: [
        'pickup_cached_event_' + id,
        'pickup_cached_events_upcoming',
        'pickup_cached_events_past',
        'pickup_cached_events_all'
      ]
    });
  },

  async addDuty(eventId, payload) {
    return this.request('POST', '/api/events/' + eventId + '/duties', payload, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  },

  async updateDuty(eventId, dutyId, payload) {
    return this.request('PUT', '/api/events/' + eventId + '/duties/' + dutyId, payload, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  },

  async deleteDuty(eventId, dutyId) {
    return this.request('DELETE', '/api/events/' + eventId + '/duties/' + dutyId, null, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  },

  async getAttendeeCandidates() {
    return this.request('GET', '/api/events/attendee-candidates');
  },

  async getUsers() {
    return this.request('GET', '/api/auth/users');
  },

  async updateUserRole(userId, role) {
    return this.request('PUT', '/api/auth/users/' + userId + '/role', { role: role });
  },

  async updateUserBadges(userId, badges) {
    return this.request('PUT', '/api/auth/users/' + userId + '/badges', badges);
  },

  async deleteUser(userId, ban = false, reason = '') {
    return this.request('DELETE', '/api/auth/users/' + userId + '?ban=' + (ban ? 'true' : 'false') + '&reason=' + encodeURIComponent(reason));
  },

  async getBannedEmails() {
    return this.request('GET', '/api/auth/banned-emails');
  },

  async banEmail(email, reason = '') {
    return this.request('POST', '/api/auth/banned-emails', { email: email, reason: reason });
  },

  async unbanEmail(id) {
    return this.request('DELETE', '/api/auth/banned-emails/' + id);
  },

  async getSettings() {
    return this.request('GET', '/api/settings');
  },

  async updateSettings(settings) {
    return this.request('PUT', '/api/settings', settings);
  },

  async testAppscript(url) {
    return this.request('POST', '/api/settings/test-appscript', { url });
  },

  renderEditGameFieldsHtml(prefix, ev) {
    const pacificLocal = this.isoToPacificLocalInput(ev.event_date);
    const hasCap = Boolean(ev.max_players && ev.max_players > 0);
    const capVal = hasCap ? ev.max_players : 28;
    let allowedArr = [];
    if (Array.isArray(ev.allowed_emails_list)) {
      allowedArr = ev.allowed_emails_list;
    } else if (ev.allowed_emails) {
      try {
        allowedArr = typeof ev.allowed_emails === 'string' ? JSON.parse(ev.allowed_emails) : ev.allowed_emails;
      } catch (e) {}
    }

    return `
      <div class="grid-2">
        <div class="form-group" style="margin-bottom: 10px;">
          <label for="${prefix}-title" style="font-size: 0.82rem;">Game Title *</label>
          <input type="text" id="${prefix}-title" value="${this.escapeHtml(ev.title || '')}" required>
        </div>
        <div class="form-group" style="margin-bottom: 10px;">
          <label for="${prefix}-date" style="font-size: 0.82rem;">Date &amp; Time (Pacific) *</label>
          <input type="datetime-local" id="${prefix}-date" value="${this.escapeHtml(pacificLocal)}" required>
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group" style="margin-bottom: 10px;">
          <label for="${prefix}-location" style="font-size: 0.82rem;">Field Location *</label>
          <input type="text" id="${prefix}-location" value="${this.escapeHtml(ev.location || '')}" list="common-locations-list" required>
        </div>
        <div class="form-group" style="margin-bottom: 10px;">
          <label for="${prefix}-map" style="font-size: 0.82rem;">Map / Directions Link (Optional)</label>
          <input type="text" id="${prefix}-map" value="${this.escapeHtml(ev.location_url || '')}" placeholder="https://maps.google.com/?q=...">
        </div>
      </div>
      <div class="form-group" style="margin-bottom: 10px;">
        <label for="${prefix}-desc" style="font-size: 0.82rem;">Game Details &amp; Announcements</label>
        <textarea id="${prefix}-desc" rows="2">${this.escapeHtml(ev.description || '')}</textarea>
      </div>
      <div class="form-group" style="background: var(--bg-card); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); margin-bottom: 10px;">
        <label for="${prefix}-actual-attendance" style="font-weight: 600; font-size: 0.84rem; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
          <span>⚾</span> <span>Actual Attendance (Players who played)</span>
        </label>
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <input type="number" id="${prefix}-actual-attendance" value="${ev.actual_attendance != null ? ev.actual_attendance : ''}" min="0" max="200" placeholder="e.g. 18" style="width: 90px; padding: 5px 8px; font-weight: 700;">
          <span style="font-size: 0.8rem; color: var(--text-muted);">Record actual turnout from the field. Shown in Past Games archive!</span>
        </div>
      </div>
      <div class="form-group" style="background: var(--bg-card); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); margin-bottom: 10px;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 600; font-size: 0.84rem; margin: 0;">
          <input type="checkbox" id="${prefix}-cap-toggle" ${hasCap ? 'checked' : ''} style="width: 16px; height: 16px; accent-color: var(--primary);">
          <span>Limit Playing Roster Size (Auto-Waitlist when full)</span>
        </label>
        <div id="${prefix}-max-players-wrap" style="display: ${hasCap ? 'block' : 'none'}; margin-top: 8px; padding-left: 24px;">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <label for="${prefix}-max-players" style="font-size: 0.84rem; color: var(--text-muted); margin: 0;">Max Confirmed Players:</label>
            <input type="number" id="${prefix}-max-players" value="${capVal}" min="2" max="100" style="width: 80px; padding: 4px 8px;">
          </div>
        </div>
      </div>
      <div class="form-group" style="background: var(--bg-card); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); margin-bottom: 12px;">
        <label for="${prefix}-allowed-emails" style="font-weight: 600; font-size: 0.84rem; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
          <span>🔒</span> <span>Allowed Player Emails (Whitelist — Optional)</span>
        </label>
        <textarea id="${prefix}-allowed-emails" rows="2" placeholder="Leave blank to allow all players; or enter emails separated by commas or lines" style="font-size: 0.82rem;">${this.escapeHtml((allowedArr || []).join(', '))}</textarea>
      </div>
    `;
  },

  bindEditGameCapToggle(prefix) {
    const capToggle = document.getElementById(prefix + '-cap-toggle');
    const capWrap = document.getElementById(prefix + '-max-players-wrap');
    if (capToggle && capWrap) {
      capToggle.onchange = function() {
        capWrap.style.display = capToggle.checked ? 'block' : 'none';
      };
    }
  },

  readEditGameFields(prefix) {
    const titleEl = document.getElementById(prefix + '-title');
    const dateEl = document.getElementById(prefix + '-date');
    const locEl = document.getElementById(prefix + '-location');
    const mapEl = document.getElementById(prefix + '-map');
    const descEl = document.getElementById(prefix + '-desc');
    const attEl = document.getElementById(prefix + '-actual-attendance');
    const capToggle = document.getElementById(prefix + '-cap-toggle');
    const maxEl = document.getElementById(prefix + '-max-players');
    const allowedEl = document.getElementById(prefix + '-allowed-emails');

    const title = titleEl ? titleEl.value.trim() : '';
    const rawDate = dateEl ? dateEl.value : '';
    const location = locEl ? locEl.value.trim() : '';
    if (!title || !rawDate || !location) {
      return { error: 'Title, Date/Time, and Field Location are required.' };
    }

    const attRaw = attEl ? attEl.value.trim() : '';
    const parsedAtt = attRaw === '' ? null : parseInt(attRaw, 10);
    const maxPlayers = (capToggle && capToggle.checked)
      ? (parseInt(maxEl ? maxEl.value : '28', 10) || 28)
      : null;

    const allowedRaw = allowedEl ? allowedEl.value : '';
    const allowedList = allowedRaw.split(/[,\n;]/).map(function(s) { return s.trim().toLowerCase(); }).filter(function(s) { return s.indexOf('@') !== -1; });

    return {
      payload: {
        title: title,
        event_date: this.localToPacificIso(rawDate),
        location: location,
        location_url: mapEl ? mapEl.value.trim() : '',
        description: descEl ? descEl.value.trim() : '',
        max_players: maxPlayers,
        actual_attendance: (parsedAtt === null || isNaN(parsedAtt)) ? null : parsedAtt,
        allowed_emails: allowedList.length > 0 ? allowedList : null
      }
    };
  },

  formatDate(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const locale = this.getLangMeta().locale || 'en-US';
    return d.toLocaleDateString(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'America/Los_Angeles'
    });
  },

  formatDateTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const locale = this.getLangMeta().locale || 'en-US';
    return d.toLocaleString(locale, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Los_Angeles',
      timeZoneName: 'short'
    });
  },

  isoToPacificLocalInput(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(d);
    const get = (t) => (parts.find(p => p.type === t) || {}).value || '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  },

  localToPacificIso(dateString, timeString = '12:00') {
    if (!dateString) return '';
    const [datePart, timePart] = dateString.includes('T') ? dateString.split('T') : [dateString, timeString];
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, min] = (timePart || '12:00').split(':').map(Number);
    let d = new Date(Date.UTC(year, month - 1, day, hour + 7, min || 0));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric'
    }).formatToParts(d);
    const pHour = Number(parts.find(p => p.type === 'hour').value);
    const diffHours = hour - pHour;
    d = new Date(d.getTime() + diffHours * 3600000);
    return d.toISOString();
  },

  getNextSundayNoonPacificIso() {
    const now = new Date();
    const laFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
    });
    const dayName = laFormatter.formatToParts(now).find(p => p.type === 'weekday').value;
    const daysMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
    const currentDay = daysMap[dayName] !== undefined ? daysMap[dayName] : now.getDay();
    let daysUntilSunday = 7 - currentDay;
    if (daysUntilSunday === 7) {
      const currentHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric' }).format(now));
      if (currentHour < 12) daysUntilSunday = 0;
    }
    const targetDate = new Date(now.getTime() + daysUntilSunday * 86400000);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(targetDate);
    const yyyy = parts.find(p => p.type === 'year').value;
    const mm = parts.find(p => p.type === 'month').value;
    const dd = parts.find(p => p.type === 'day').value;
    return this.localToPacificIso(`${yyyy}-${mm}-${dd}`, '12:00');
  },

  getGoogleCalendarUrl(ev) {
    if (!ev || !ev.event_date) return '#';
    let startDate = new Date(ev.event_date);
    if (isNaN(startDate.getTime())) {
      startDate = new Date();
    }
    const endDate = new Date(startDate.getTime() + 3 * 60 * 60 * 1000);
    const pad = function(n) { return String(n).padStart(2, '0'); };
    const formatGCal = function(d) {
      return d.getUTCFullYear() +
        pad(d.getUTCMonth() + 1) +
        pad(d.getUTCDate()) + 'T' +
        pad(d.getUTCHours()) +
        pad(d.getUTCMinutes()) +
        pad(d.getUTCSeconds()) + 'Z';
    };
    const title = encodeURIComponent(this.translateEventTitle(ev) || ev.title || 'Sunday Pickup Baseball - Noon Game');
    const details = encodeURIComponent('Free community pickup baseball. Check headcount, coordinate gear & volunteer for tasks at https://www.pickupbaseballfoundation.org/event.html?id=' + ev.id);
    const location = encodeURIComponent(ev.location || 'Bushrod Park Field 1, Oakland, CA');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + title + '&dates=' + formatGCal(startDate) + '/' + formatGCal(endDate) + '&details=' + details + '&location=' + location;
  },

  renderNav(user) {
    const navContainer = document.getElementById('main-nav');
    if (!navContainer) return;

    const currentLang = this.getLang();
    let authHtml = '';
    if (user) {
      const safeAvatar = this.safeAvatarUrl(user.avatarUrl);
      const avatarImg = safeAvatar
        ? `<img src="${this.escapeHtml(safeAvatar)}" alt="${this.escapeHtml(user.name)}" class="nav-avatar" decoding="async">`
        : `<span class="nav-avatar-placeholder">${this.escapeHtml((user.name || 'P').charAt(0).toUpperCase())}</span>`;

      authHtml = `
        <a href="/profile.html" class="nav-user-badge" title="${this.escapeHtml(user.name)}">
          ${avatarImg}
          <span class="nav-user-name">
            ${this.escapeHtml(user.name)}
          </span>
        </a>
        ${user.canManageEvents ? `<a href="/admin.html" class="btn btn-outline btn-sm">${user.isAdmin ? this.t('nav.admin') : this.t('nav.org')}</a>` : ''}
      `;
    } else {
      authHtml = `
        <a href="/login.html" class="btn-login"><span class="btn-login-icon">⚾ </span><span>${this.t('nav.login')}</span></a>
      `;
    }

    const isDonatePage = typeof window !== 'undefined' && (window.location.pathname.endsWith('donate.html') || window.location.pathname === '/donate');
    const isArtPage = typeof window !== 'undefined' && (window.location.pathname.endsWith('art.html') || window.location.pathname === '/art');
    const isGalleryPage = typeof window !== 'undefined' && (window.location.pathname.endsWith('gallery.html') || window.location.pathname === '/gallery');
    // nav.art community art merged into nav.gallery (/art.html redirects to /gallery.html#community-art-section; nav-link-art alias)
    const galleryLinkHtml = `<a href="/gallery.html" class="nav-link-gallery${isGalleryPage || isArtPage ? ' active' : ''}" title="${this.t('nav.gallery_title', 'Photo, Video & Art Gallery')}"><span class="nav-gallery-icon">📸</span> <span>${this.t('nav.gallery', 'Gallery & Art')}</span></a>`;
    const donateLinkHtml = `<a href="/donate.html" class="nav-link-donate${isDonatePage ? ' active' : ''}">${this.t('nav.donate')}</a>`;

    const langOptionsHtml = this.SUPPORTED_LANGUAGES.map(l =>
      `<option value="${l.code}" ${l.code === currentLang ? 'selected' : ''} title="${this.escapeHtml(l.label)}">${l.short}</option>`
    ).join('');
    const langSelectHtml = `<select id="lang-select" class="lang-select" aria-label="Language" title="Language / Idioma / 语言">${langOptionsHtml}</select>`;

    navContainer.innerHTML = `
      <div class="nav-wrap">
        <a href="/index.html" class="brand">
          <img src="/logo.svg" alt="Pickup Baseball Foundation Logo" class="brand-logo">
          <span class="brand-text"><span class="brand-line">Pickup Baseball</span> <span class="brand-line">Foundation</span></span>
          <span class="brand-short">PBF</span>
        </a>
        <div class="nav-links">
          ${galleryLinkHtml}
          ${donateLinkHtml}
          ${langSelectHtml}
          ${authHtml}
        </div>
      </div>
    `;

    const langSelect = document.getElementById('lang-select');
    if (langSelect) {
      langSelect.addEventListener('change', (e) => API.setLang(e.target.value));
    }
  },

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  parseMediaType(url, explicitType) {
    if (explicitType && explicitType !== 'auto') return explicitType;
    if (!url) return 'none';
    const u = String(url).trim();
    if (/youtube\.com\/watch\?|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\//i.test(u)) {
      return 'youtube';
    }
    if (/\.(jpeg|jpg|png|webp|gif|svg)(\?.*)?$/i.test(u) || /imgur\.com\//i.test(u)) {
      return 'image';
    }
    if (/\.(mp4|webm|mov)(\?.*)?$/i.test(u)) {
      return 'video';
    }
    if (/\.(mp3|wav|ogg|m4a)(\?.*)?$/i.test(u)) {
      return 'audio';
    }
    return 'link';
  },

  getYouTubeId(url) {
    if (!url) return null;
    const match = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/i);
    return match ? match[1] : null;
  },

  getYouTubeEmbedUrl(url) {
    const id = this.getYouTubeId(url);
    if (!id) return '';
    return 'https://www.youtube-nocookie.com/embed/' + id;
  },

  getGoogleDriveId(url) {
    if (!url) return null;
    const match = String(url).match(/(?:drive\.google\.com\/(?:file\/d\/|open\?id=)|docs\.google\.com\/file\/d\/)([\w-]{25,})/i);
    return match ? match[1] : null;
  },

  getGoogleDriveEmbedUrl(url) {
    const id = this.getGoogleDriveId(url);
    if (!id) return '';
    return 'https://drive.google.com/file/d/' + id + '/preview';
  },

  safeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
      return trimmed;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch (e) {}
    return '';
  },

  safeAvatarUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (/^\/api\/users\/\d+\/avatar(\?v=\d+)?$/i.test(trimmed)) {
      return trimmed;
    }
    if (/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
      return trimmed;
    }
    return this.safeUrl(trimmed);
  },

  icon(name, size = 20) {
    const attrs = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -0.18em; flex-shrink: 0;"`;
    const icons = {
      calendar: `<svg ${attrs}><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
      pin: `<svg ${attrs}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
      users: `<svg ${attrs}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      shield: `<svg ${attrs}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
      bag: `<svg ${attrs}><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
      mail: `<svg ${attrs}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
      chat: `<svg ${attrs}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`
    };
    return icons[name] || '';
  }
};

window.API = API;
API.initTheme();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => API.initI18n());
} else {
  API.initI18n();
}

// Register PWA Service Worker
if (typeof window !== 'undefined' && 'serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[PWA] New version cached and ready.');
            }
          });
        }
      });
    }).catch((err) => {
      console.warn('[PWA] Service worker registration error:', err);
    });
  });

  // Track install prompt event for custom install triggers if needed
  window.addEventListener('beforeinstallprompt', (e) => {
    window.deferredPwaPrompt = e;
  });
}
