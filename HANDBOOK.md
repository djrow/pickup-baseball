# ⚾ Pickup Baseball Foundation — User Guide & Manual Maintenance Handbook

Welcome! This handbook explains **how to use** the [Pickup Baseball Foundation web app](https://www.pickupbaseballfoundation.org) (for players, spectators, volunteers, organizers, and admins) and **how to make manual code changes yourself** using nothing more than a text editor and a terminal.

The entire app was built with **zero frontend build tools** (plain HTML, CSS, and standard JavaScript) specifically so a human volunteer can read, understand, and edit it 5 or 10 years from now without framework upgrades or broken build pipelines.

> ⚖️ **Copyright & License:** © 2026 Pickup Baseball Foundation. Content and code are licensed under the [Apache License, Version 2.0 (Apache-2.0)](https://www.apache.org/licenses/LICENSE-2.0).

---

## 📖 Table of Contents

- **Part I: How to Use the Web App**
  1. [For Players, Spectators & Volunteers](#1-for-players-spectators--volunteers)
     - [Browsing the Game Calendar (Homepage)](#-browsing-the-game-calendar-homepage)
     - [Subscribing Your Phone or Computer Calendar (`Subscribe (.ics)`)](#-subscribing-your-phone-or-computer-calendar-subscribe-ics)
     - [Signing In (Passwordless Email Login)](#-signing-in-passwordless-email-login)
     - [Saving Your Login Email in Your Browser & Device](#saving-login-credentials)
     - [How to Stay Logged In on Every Device (90-Day Session Persistence)](#how-to-stay-logged-in)
     - [Typical Rules of Play on the Field on Sundays](#rules-of-play)
     - [Submitting a Group RSVP (Players, Spectators & Volunteer Tasks)](#%EF%B8%8F-submitting-a-group-rsvp-players-spectators--volunteer-tasks)
     - [Waitlists & Automatic Promotion](#-waitlists--automatic-promotion)
     - [Discussion Board, Profile, Languages & Themes](#-discussion-board-profile-languages--themes)
     - [Top Bar Menu, Clubhouse, Gallery, Digital Waiver & Footer Version](#-top-bar-menu-clubhouse-gallery-digital-waiver--footer-version)
  2. [For Organizers & Administrators](#2-for-organizers--administrators)
     - [Limited Roster Size & Automatic Waitlist Behavior](#-limited-roster-size--automatic-waitlist-behavior)
     - [Restricting RSVPs to Invited Emails](#-restricting-rsvps-to-invited-emails-optional)
     - [Editing a Game & Turnout](#-editing-a-game--recording-actual-turnout)
     - [Smart Rainout Assistant & Drainage Tracker](#%EF%B8%8F-smart-rainout-assistant--24-hour-surface-accumulation-drainage-tracker)
     - [Calling a Rainout & Reopening](#-calling-a-rainout-or-reopening-a-game)
     - [Community Highlights & RSS Feed](#-publishing-community-highlights--submitting-multimedia-to-the-rss-feed)
     - [Paid Operations & Fair-Share Task Scheduling Policy (Section 2.5)](#-paid-operations--fair-share-task-scheduling-policy)
  3. [For Administrators](#3-for-administrators)
- **Part II: Manual Maintenance & Code Editing Handbook**
  4. [How the Codebase Is Organized](#4-how-the-codebase-is-organized)
  5. [The 4-Step Workflow for Any Manual Change](#5-the-4-step-workflow-for-any-manual-change)
  6. [Version Bumping Checklist (Clearing Browser & Phone Caches)](#6-version-bumping-checklist-clearing-browser--phone-caches)
  7. [Cookbook: Step-by-Step Recipes for Common Edits](#7-cookbook-step-by-step-recipes-for-common-edits)
  8. [House Rules & Safety Guardrails](#8-house-rules--safety-guardrails)
  9. [Troubleshooting & Emergency Recovery](#9-troubleshooting--emergency-recovery)

---

# Part I: How to Use the Web App

## 1. For Players, Spectators & Volunteers

### 📅 Browsing the Game Calendar (Homepage)
- The homepage (`index.html`) displays a **rolling 6-card schedule**:
  - **Card 1 (`📜 Past Game`):** The most recent past game with recorded turnout and a link to post-game comments.
  - **Card 2 (`⚾ Next Game` or `Today`):** The immediate upcoming game.
  - **Cards 3–6:** Upcoming confirmed games (`⚾ 12:00 PM`) or unscheduled future Sundays (`📅 Prospective` / `📍 TBA`).
- **Navigation:** Use `‹` and `›` to step backward or forward by 4 weeks, or click **`Today`** to jump back to the current week.
- **Preview Drawer:** Click any card to slide open a summary drawer with the field location, player/spectator headcount, volunteer task count, a **Google Cal ↗** shortcut, and an **RSVP & View Game Details →** button.
- **Cloud Sync Badge:** Next to the calendar subtitle, a live pill confirms whether your screen matches the cloud database:
  - `🟢 Cloud synced • Just now ↻` — Verified live against Cloudflare D1 (click anytime to re-check).
  - `⚠️ Offline — cached schedule (...) ↻` — Your phone/computer lost internet and is showing the last saved schedule.

### 🔄 Subscribing Your Phone or Computer Calendar (`Subscribe (.ics)`)
- Click **`🔄 Subscribe (.ics)`** in the calendar header to open the live sync drawer:
  - **🍎 Apple / Outlook (Live Sync):** Opens a `webcal://` subscription so iPhone, Mac, or Outlook calendars stay updated automatically.
  - **📅 Google Calendar (Live Sync):** Adds the live feed directly to Google Calendar.
  - **📋 Copy Feed URL:** Copies `https://www.pickupbaseballfoundation.org/api/events/calendar.ics`.
  - **📥 Download One-Time `.ics` File:** Downloads a static snapshot (does *not* auto-update if a rainout is called later).
- When subscribed to the live feed, newly scheduled games, field changes, and `🌧️ RAINED OUT:` alerts sync to your personal calendar automatically.

### 🔑 Signing In (Passwordless Email Login)
- Click **Log In** in the top bar (`/login.html`).
- Enter your email address (and name if it's your first time).
- Check your inbox for an email from `games@pickupbaseballfoundation.org`:
  - Either type the **6-digit code** into the login page, **or** click the **1-click magic sign-in link** in the email.
- Once signed in, your browser stays signed in for **90 days** (capped at 5 active device sessions per account).
  - Using a public or shared computer? Check **"Shared / public computer (4-hour temporary session)"** so the login cookie expires automatically in 4 hours.
  - You can log out anytime—or click **"Sign out all other devices"**—from `/profile.html` (or `/login.html`).

### 💾 Saving Your Email Address & Login Credentials in Your Browser
<a id="saving-login-credentials"></a>

Because Sunday Pickup Baseball uses a modern, secure **passwordless authentication system** (delivering a 6-digit verification code or a 1-click magic link to your email inbox), you never need to invent, memorize, or enter a complex password.

However, having to re-type your email address each time you sign in on a mobile phone, tablet, or desktop computer can become repetitive. This section provides a complete guide for saving and automatically filling your email address across **all major and legacy browsers on Android, iOS, macOS, and Windows**.

---

#### 1. The Instant Built-in Option: "Remember my email address on this device"
Right below the Email Address field on the sign-in page (`/login.html`), there is a built-in checkbox:
- ☑️ **"Remember my email address on this device"**
- **How It Works:** When checked, the web app securely stores your email address (and your display name) in your browser's client-side `localStorage`.
- **Zero Third-Party Sharing:** The saved email never leaves your local hardware and is never sent to advertising or analytics trackers.
- **Next Time You Visit:** When you navigate to `/login.html` on that device, both your name and email are pre-filled automatically. You just click **Send Sign-In Code**.
- **90-Day Active Session:** Once you verify your sign-in code or click the email link, your device receives a secure `baseball_session` cookie valid for **90 days**. You will stay signed in across browser restarts without having to re-authenticate unless you explicitly click **Log Out** or clear your cookies.

---

#### 2. Mobile Devices: Android (Phones & Tablets)

##### 🟢 Google Chrome on Android (Standard & Most Common)
Android and Chrome provide deep integration through **Autofill with Google**:
1. **Enable Autofill in Chrome:**
   - Open Chrome on your Android phone or tablet.
   - Tap the **three vertical dots (⋮)** in the top-right corner > select **Settings**.
   - Tap **Addresses and more** (or **Autofill and payments**).
   - Toggle **Save and fill addresses** to **ON**.
   - (Optional) Tap **Add address** to explicitly register your full name and email address.
2. **Enable System-Wide Google Autofill (Android OS Settings):**
   - Open your Android **Settings** app.
   - Go to **Passwords & accounts** (or **System** > **Languages & input** > **Autofill service** on older versions).
   - Verify that **Autofill service** is set to **Google** (or your preferred password manager).
3. **Using It in the Login Field:**
   - On the Sunday Pickup Baseball login page (`/login.html`), tap the **Email Address** input.
   - Look directly above the on-screen keyboard (Gboard or Samsung Keyboard): a pill containing your email address appears in the suggestion strip.
   - Tap your email pill to fill the field instantly.

##### 🔵 Samsung Internet (Samsung Galaxy Phones & Tablets)
1. **Enable Auto Fill Forms / Samsung Pass:**
   - Open Samsung Internet.
   - Tap the **Menu (☰)** in the bottom-right corner > tap **Settings** (gear icon).
   - Select **Personal browsing data** (or **Privacy & security**).
   - Tap **Autofill forms** (or **Samsung Pass**) and toggle it **ON**.
   - Make sure your personal profile contains your active email address.
2. **Using It:**
   - Tap the Email Address input on `/login.html`.
   - Samsung Pass or the Auto Fill bar will slide up with your saved email. Tap it (or confirm with your fingerprint/PIN) to populate.

##### 🦊 Mozilla Firefox for Android
1. Open Firefox > tap the **three dots (⋮)** > **Settings**.
2. Under the **Autofill** section:
   - Tap **Logins and passwords** > turn on **Save logins and passwords**.
   - Tap **Addresses** > turn on **Autofill addresses**.
3. On `/login.html`, tap the Email Address input and select your email from the Firefox suggestion bar.

##### 📱 Legacy Android Browsers (Android 4.4 KitKat to Android 8.0 Oreo Stock AOSP Browser)
1. Open the stock "Browser" or "Internet" app.
2. Tap **Menu** > **Settings** > **Privacy & security** (or **General**).
3. Check the boxes for **Remember form data** and **Enable Auto-fill**.
4. *Built-in Fallback:* Legacy Android WebKit browsers reliably support HTML5 `localStorage`. Simply check the site's built-in **"Remember my email address on this device"** checkbox, and your email will persist automatically!

---

#### 3. Mobile Devices: Apple iOS (iPhone & iPad)

##### 🧭 Apple Safari on iPhone & iPad
Safari on iOS uses your Contacts card and iCloud Keychain to fill credentials automatically:
1. **Enable Contact AutoFill (Fills Name & Email in One Tap):**
   - Open the iOS **Settings** app on your iPhone or iPad.
   - Scroll down and tap **Safari**.
   - Tap **AutoFill**.
   - Toggle **Contact Info** to **ON (Green)**.
   - Tap **My Info** and select **your own contact card** from your Contacts list (verify that your email address is included on that contact card).
2. **Enable Password & Passkey AutoFill (iCloud Keychain):**
   - In iOS **Settings**, tap **Passwords** (or **General** > **AutoFill & Passwords** on newer iOS versions).
   - Tap **Password Options** > ensure **AutoFill Passwords and Passkeys** is toggled **ON**.
3. **Using It on the Login Page:**
   - In Safari, navigate to `/login.html`.
   - Tap inside the **Email Address** field.
   - Look directly above the virtual keyboard: you will see **"AutoFill Contact"** or your email address in the predictive QuickType bar.
   - Tap your email or "AutoFill Contact". Safari will populate both your Name and Email address in one action.

##### 🟢 Google Chrome for iOS (iPhone & iPad)
1. Open Chrome on your iPhone or iPad.
2. Tap the **three horizontal dots (…)** in the bottom-right corner > select **Settings**.
3. Tap **Addresses and more** > toggle **Save and Fill Addresses** to **ON**.
4. When visiting `/login.html`, tap the Email Address field and select your saved email from the suggestion bar above the keyboard.

##### 🦊 Mozilla Firefox for iOS
1. Open Firefox > tap the **Menu (☰)** > **Settings**.
2. Tap **Logins & Passwords** > toggle **Save Logins** to **ON**.
3. Select your saved email when prompted in the keyboard suggestion row on `/login.html`.

##### 📱 Legacy iOS Devices (iOS 9 through iOS 13 — iPhone 5s, 6, 6 Plus, iPad Air 1, iPad mini 2/3)
1. Open **Settings** > **Safari** > **AutoFill**.
2. Enable **Use Contact Info** and make sure **My Info** is linked to your contact card.
3. If QuickType is disabled or unsupported, double-tap the email input field to trigger the AutoFill prompt, or check the website's built-in **"Remember my email address on this device"** checkbox.

---

#### 4. Desktop & Laptop: Apple Mac (macOS)

##### 🧭 Apple Safari on macOS
1. **Enable AutoFill:**
   - Open Safari.
   - In the top macOS menu bar, click **Safari** > select **Settings...** (or **Preferences...** on macOS Monterey and earlier), or press `Cmd + ,`.
   - Click the **AutoFill** tab.
   - Check the box for **"Using info from my contacts"** (click *Edit...* to ensure your Card in the macOS Contacts app contains your email).
   - Check the box for **"Usernames and passwords"**.
2. **Using It on the Login Page:**
   - Navigate to `/login.html`.
   - Click into the **Email Address** field.
   - Safari displays an AutoFill popover displaying your contact name and email address. Click the popover or press `Return` to fill.

##### 🟢 Google Chrome on macOS
1. Open Chrome > click the **three vertical dots (⋮)** in the upper right > **Settings** (or press `Cmd + ,`).
2. Click **Autofill and passwords** in the left sidebar > click **Addresses and more**.
3. Toggle **Save and fill addresses** to **ON**.
4. (Optional) Under Addresses, click **Add**, enter your name and email address, and click **Save**.
5. On `/login.html`, click into the email field and select your saved email from the dropdown menu.

##### 🦊 Mozilla Firefox on macOS
1. Open Firefox > click the **hamburger menu (☰)** in the upper right > **Settings** (or press `Cmd + ,`).
2. Click **Privacy & Security** in the left navigation.
3. Scroll down to **Forms and Autofill** > check the box for **Autofill addresses**.
4. Click **Saved Addresses...** to add or verify your email address.
5. On `/login.html`, double-click the email field or click inside it to select your email from the autofill dropdown.

##### 🌊 Microsoft Edge on macOS
1. Open Edge > click **…** (three dots) > **Settings**.
2. In the left menu, click **Profiles** > select **Personal info** (or **Wallet**).
3. Toggle **Save and fill personal info** to **ON**.

##### 💻 Legacy macOS Safari (OS X Mavericks, Yosemite, El Capitan, macOS Sierra, High Sierra, Mojave)
1. Open Safari > click **Safari** > **Preferences** > **AutoFill** tab.
2. Check **"Using info from my Address Book card"** (or Contacts card).
3. On `/login.html`, click the email field and select your contact profile.

---

#### 5. Desktop & Laptop: Microsoft Windows (Windows 11, Windows 10, Windows 7/8)

##### 🌊 Microsoft Edge on Windows (Default on Windows 10 & 11)
1. **Enable Personal Info Autofill:**
   - Open Microsoft Edge.
   - Click the **three horizontal dots (…)** in the top right > select **Settings**.
   - In the left sidebar, click **Profiles** > click **Personal info** (or **Wallet**).
   - Toggle **Save and fill info** to **ON**.
2. **Add Your Email Address Manually:**
   - Under Personal Info, click **Add address** or **Add personal info**.
   - Enter your name and email address, then click **Save**.
3. **Using It on the Login Page:**
   - On `/login.html`, click or press `Tab` into the **Email Address** box.
   - Edge displays a floating card showing your saved email. Click it or press the Down Arrow (`↓`) and `Enter` to populate the field.

##### 🟢 Google Chrome on Windows
1. Open Chrome > click the **three vertical dots (⋮)** in the upper right > **Settings**.
2. In the left navigation, click **Autofill and passwords** > **Addresses and more**.
3. Toggle **Save and fill addresses** to **ON**.
4. (Optional) Click **Add** under Addresses to manually store your email and name.
5. On `/login.html`, click into the email field and choose your email from the suggestion dropdown.

##### 🦊 Mozilla Firefox on Windows
1. Open Firefox > click the **hamburger menu (☰)** > **Settings**.
2. In the left navigation, click **Privacy & Security**.
3. Under **Forms and Autofill**, check the box for **Autofill addresses**.
4. Click **Saved Addresses...** to review or add your email address.
5. On `/login.html`, click or double-click the email input to select your address.

##### 🏛️ Legacy Browsers on Windows (Internet Explorer 11 & EdgeHTML)

###### Internet Explorer 11 (Windows 7, Windows 8.1, and Windows 10 Legacy)
Internet Explorer 11 utilizes the classic Windows **AutoComplete** system:
1. **Enable AutoComplete for Forms:**
   - Open Internet Explorer 11.
   - Click the **Tools** gear icon (`⚙️`) in the top right (or press `Alt + X`) > select **Internet Options**.
   - Switch to the **Content** tab.
   - In the **AutoComplete** section, click the **Settings** button.
   - Ensure the checkboxes for **"Forms"** and **"User names and passwords on forms"** are checked.
   - Click **OK**, then click **Apply** and **OK**.
2. **Using AutoComplete in IE11:**
   - Type your email into the Email Address field and submit the form once. IE11 records the entry into its AutoComplete cache.
   - On subsequent visits to `/login.html`, **double-click the Email Address field** or click inside it and press the **Down Arrow (`↓`)** on your keyboard to reveal your previous entries, then press **Enter**.
3. **HTML5 LocalStorage Compatibility:**
   - Internet Explorer 11 fully supports the HTML5 `localStorage` standard.
   - Checking the web app's built-in **"Remember my email address on this device"** checkbox works out of the box in IE11, preserving your email across reboots!

###### Legacy Microsoft Edge (EdgeHTML / "Spartan", Windows 10 Builds 1507–1909)
1. Open Edge > click the **three dots (…)** > **Settings**.
2. Click **View advanced settings** (or **Passswords & autofill**).
3. Toggle **Save form entries** to **ON**.
4. Click **Manage form entries** to review or add your email address.

---

#### 6. Third-Party Password Managers (Bitwarden, 1Password, Dashlane, KeePass, Proton Pass)
If you manage your credentials using a password manager extension or mobile vault:
1. **Create an Entry in Your Vault:**
   - **Title / Name:** Sunday Pickup Baseball
   - **Website URL:** `https://www.pickupbaseballfoundation.org` (or match `https://www.pickupbaseballfoundation.org/login.html`)
   - **Username / Login ID:** Your email address (e.g., `you@example.com`)
   - **Password:** Leave blank, or enter a label such as `passwordless-magic-link`
2. **Autofilling on the Login Page:**
   - When viewing `/login.html`, trigger your extension's autofill hotkey:
     - **Bitwarden:** `Ctrl + Shift + L` (Windows) or `Cmd + Shift + L` (Mac)
     - **1Password:** `Ctrl + \` (Windows) or `Cmd + \` (Mac)
     - **Proton Pass / Dashlane:** Click the inline icon directly inside the email field
   - Your email address will instantly populate the field.

---

#### 7. Troubleshooting & Privacy Best Practices

##### 🕵️ Incognito & Private Browsing Windows
- When using **Private Browsing** (Safari / Firefox) or **Incognito Mode** (Chrome) or **InPrivate** (Edge):
  - Browsers deliberately do not save form data or autofill suggestions.
  - The web app's "Remember my email address on this device" checkbox uses `localStorage`, which browsers erase immediately when the private tab or window is closed.
  - **Resolution:** If you want your email to stay saved and preserve your 90-day active session, use a standard (non-private) browser window.

##### 🧹 Clearing Browsing Data Without Losing Saved Emails
- When clearing browser history or cache in your browser's settings:
  - Keep **"Autofill form data"** (or **"Addresses and more"**) **UNCHECKED** so your browser does not erase your saved email.
  - Keep **"Cookies and other site data"** **UNCHECKED** if you want to remain logged in for the full 90-day duration without re-entering a verification code.

##### 🏫 Shared or Public Computers (Libraries, School/Work Terminals)
- When signing in on a shared public terminal:
  1. **Uncheck** "Remember my email address on this device".
  2. Use a **Private / Incognito** window.
  3. When finished, always click **Log Out** from `/profile.html` or the top navigation bar to invalidate the session cookie on the server.

---

### 🔒 How to Stay Logged In on Every Device (90-Day Session Persistence)
<a id="how-to-stay-logged-in"></a>

Sunday Pickup Baseball uses a secure, long-lived session cookie (`baseball_session`) that keeps you logged in for **90 continuous days**. You should **never** need to log in every week or every time you open your browser.

If you find that your phone, tablet, or laptop keeps logging you out prematurely, your browser or device is automatically deleting your session cookies. Follow this guide to configure your specific device so you stay signed in seamlessly.

---

#### 1. The #1 Reason for Unexpected Logouts: "In-App Browsers" (Email Apps)

> [!IMPORTANT]
> **This is the single most common reason players think they were logged out.**

When you tap the **"1-Click Magic Sign-In Link"** from your email inbox in apps like **Gmail**, **Yahoo Mail**, **Outlook**, **Apple Mail**, or **Facebook / Instagram**, the email app usually opens the link inside an **in-app browser preview window** (not your real standalone Safari or Chrome browser).

* **The Problem:** In-app browser windows operate in a temporary sandbox. When you close the email app, that sandbox—and your login cookie—is immediately deleted! Later, when you open Safari or Chrome to check the game, you aren't logged in.
* **How to Fix It on iPhone / iPad:**
  1. When viewing the website inside your email app's preview, tap the **Share icon** (box with arrow) or **Safari icon** in the bottom-right corner.
  2. Tap **"Open in Safari"**.
  3. Sign in here once. Now your login will persist in your real Safari browser for 90 days.
* **How to Fix It on Android (Gmail App):**
  1. Open the **Gmail app** > tap the **menu (☰)** in top-left > select **Settings**.
  2. Tap **General settings**.
  3. Scroll down and **UNCHECK** **"Open web links in Gmail"**.
  4. Now, whenever you tap any link or sign-in email, it opens directly in Google Chrome where your session remains permanently active.
* **How to Fix It on Microsoft Outlook Mobile:**
  1. Open the Outlook app > tap your profile icon > tap **Settings (gear icon)** in bottom-left.
  2. Under **Preferences**, tap **Open links in**.
  3. Select **Default browser** (or **System browser**).

---

#### 2. The Best Experience: Install as a Home Screen App (PWA)

> [!TIP]
> **Adding the web app to your Home Screen is the best way to stay logged in forever.**
> A Home Screen app runs in its own dedicated, standalone application container with dedicated storage. Even if you clear your general web browser tabs and history, your Home Screen app keeps its login session safe and intact!

##### 🍎 iPhone & iPad (Safari)
1. Open **Safari** and visit [pickupbaseballfoundation.org](https://www.pickupbaseballfoundation.org).
2. Sign in to your account.
3. Tap the **Share button** at the bottom of the screen (the square with an arrow pointing upward).
4. Scroll down the sharing sheet and tap **Add to Home Screen** (➕).
5. Tap **Add** in the top-right corner.
6. A **Pickup Baseball** icon will appear on your home screen. Tap it to launch the app full-screen without address bars, and you will stay logged in for 90 days.

##### 🤖 Android (Google Chrome & Samsung Internet)
1. Open **Chrome** and navigate to [pickupbaseballfoundation.org](https://www.pickupbaseballfoundation.org).
2. Sign in to your account.
3. Tap the **three dots (⋮)** in the top-right corner.
4. Tap **Install app** (or **Add to Home screen**).
5. Confirm by tapping **Install**. Launch the app directly from your home screen or app drawer.

##### 💻 Mac & Windows (Chrome, Edge & Brave)
1. Visit [pickupbaseballfoundation.org](https://www.pickupbaseballfoundation.org) in Chrome, Edge, or Brave.
2. Sign in to your account.
3. Look at the right side of the address bar at the top: click the **Install icon** (a desktop monitor with a small down arrow).
4. Click **Install**. The app opens in its own window and docks into your macOS Dock or Windows Taskbar.

---

#### 3. Browser-by-Browser Settings to Prevent Cookie Purging

If you prefer using your regular browser tabs, ensure your browser is not configured to destroy cookies on exit:

##### 🧭 Apple Safari (iPhone & iPad)
1. Open iOS **Settings** > scroll down and tap **Safari**.
2. Under **Privacy & Security**:
   - Ensure **"Block All Cookies"** is toggled **OFF (Grey)**.
3. On **iOS 17 and iOS 18**:
   - Scroll down to the bottom of the Safari settings page and tap **Advanced**.
   - Tap **Advanced Tracking and Fingerprinting Protection**.
   - Set it to **"Private Browsing"** (do **NOT** set it to "All Browsing", as "All Browsing" aggressively wipes first-party storage partitions).
4. **Avoid Private Browsing Mode:** Make sure Safari is not showing a black/dark search bar with "Private" selected, as Private mode erases all cookies the second the tab is closed.

##### 🧭 Apple Safari (macOS Mac)
1. Open Safari > click **Safari** in the top menu bar > **Settings...** (or press `Cmd + ,`).
2. Click the **Privacy** tab.
3. Verify that **"Block all cookies"** is **UNCHECKED**.
4. In the **Advanced** tab: ensure "Use advanced tracking and fingerprinting protection" is set to "in private browsing" only.

##### 🟢 Google Chrome (Windows, Mac & Android)
1. In Chrome, click the **three dots (⋮)** > select **Settings**.
2. Click **Privacy and security** in the left menu > click **Third-party cookies** (or **Site settings** > **Cookies**).
3. Ensure **"Clear cookies and site data when you close all windows"** is **OFF**.
4. **Whitelisting the Web App (Recommended if you keep auto-clear on):**
   - Scroll down to **"Sites allowed to use cookies"** (or **"Always allow"**).
   - Click **Add**.
   - Enter `[*.]pickupbaseballfoundation.org`.
   - Check the box for **"Including third-party cookies on this site"** and click **Add**.
   - Chrome will now preserve your Sunday Pickup Baseball login indefinitely, even if you clear other cookies on browser close!

##### 🦊 Mozilla Firefox (Windows, Mac & Android)
1. Open Firefox > click the **menu (☰)** > **Settings**.
2. Click **Privacy & Security** in the left navigation.
3. Under **Enhanced Tracking Protection**, choose **Standard** (Strict mode can aggressively purge cookies).
4. Under **Cookies and Site Data**:
   - If **"Delete cookies and site data when Firefox is closed"** is checked, click the **"Manage Exceptions..."** button.
   - Type `https://www.pickupbaseballfoundation.org`.
   - Click **Allow**, then click **Save Changes**.

##### 🦁 Brave Browser (Windows, Mac, Android, iOS)
Brave includes aggressive built-in privacy shields that can sometimes wipe site storage:
1. Visit [pickupbaseballfoundation.org](https://www.pickupbaseballfoundation.org).
2. Click the orange **Brave Lion icon** directly in the address bar.
3. Make sure **"Forget me when I close this site"** is turned **OFF**.
4. In Brave **Settings** > **Shields**:
   - Ensure Cookie control is set to **"Block cross-site cookies"** (Standard), **NOT** "Block all cookies".

##### 🌊 Microsoft Edge (Windows & Mac)
1. Open Edge > click **…** (three dots) > **Settings**.
2. Click **Cookies and site permissions** in the left navigation.
3. Click **Manage and delete cookies and site data**.
4. Ensure **"Clear cookies and site data when you close the browser"** is **OFF**.
5. Alternatively, under **Allow**, click **Add** and enter `[*.]pickupbaseballfoundation.org`.

##### 📱 Samsung Internet (Galaxy Phones & Tablets)
1. Open Samsung Internet > tap **Menu (☰)** in bottom-right > **Settings**.
2. Tap **Personal browsing data** > **Accept cookies**.
3. Ensure **"Allow all cookies"** or **"Block only third-party cookies"** is selected.
4. Make sure **Secret Mode** is not enabled when logging in.

---

#### 4. Phone Cleaners & Optimizer Apps to Check

If you find yourself logged out every few days without closing your browser, a third-party cleaner app may be purging your device's app storage in the background:
* **Android Maintenance Cleaners:** Apps like **CCleaner**, **CleanMaster**, **Avast Cleanup**, or built-in utilities like **Samsung Device Care** / **Auto-optimize** feature an automated "Trash & Cache Cleaner".
* **Solution:** Open your cleaner utility, find its **Settings / Protection / Whitelist**, and add **Google Chrome** (or your preferred browser, and the **Pickup Baseball** Home Screen app) to the **Exclusion List**.

---

#### 5. Quick 10-Second Diagnostic Checklist

If you were suddenly logged out, check these 4 quick items:
1. **Did you open the site from an email preview window?**
   * *Fix:* Tap the options menu in the top or bottom corner and select **"Open in Safari"** or **"Open in Chrome"**.
2. **Are you in a Private or Incognito tab?**
   * *Fix:* Switch to a standard browser tab before requesting a code or magic link.
3. **Did you recently clear your browser history?**
   * *Fix:* When clearing browser history, uncheck **"Cookies and other site data"** so your active logins are not wiped.
4. **Has it been 90 days since your last login?**
   * *Fix:* Sessions expire every 90 days for account security. Simply enter your email at `/login.html` to renew your 90-day login.

---

### ⚾ Typical Rules of Play on the Field on Sundays
<a id="rules-of-play"></a>

Every Sunday at Noon, the Pickup Baseball Foundation hosts free, accessible, and friendly pickup baseball for everyone in the community. Whether you played in college or have never picked up a baseball glove before, you are welcome on the field.

To keep the games fun, safe, fast-paced, and equitable for players of all experience levels, Sunday games follow these established field guidelines:

---

#### 1. Spirit of the Game: Friendly, Inclusive & Supportive
- **All Skill Levels Welcome:** Our primary goal is fun, exercise, community building, and reps. Veterans enthusiastically support newcomers, and beginners are encouraged to take their cuts and learn the game.
- **Zero-Tolerance for Unsportsmanlike Conduct:** Aggressive arguing, trash talking, throwing equipment, or dangerous play is strictly prohibited. We celebrate great plays made by either team!
- **Co-ed & Multi-Generational:** Adult players of all genders, backgrounds, and ages (including supervised youth) share the diamond together.

---

#### 2. Weekly Schedule & Sunday Afternoon Routine (12:00 PM – 4:00 PM)
- **12:00 PM – 12:30 PM (Warm-ups & Throwing):** Arrive promptly at Noon. Throw for 30 minutes, stretch arms and legs, play long-toss, and help set up bases.
- **12:30 PM – 1:30 PM (Batting Practice):** 1 full hour of machine-pitch batting practice off the pitching machine. Every attendee takes dedicated swings in the batter's box while teammates track fly balls and shag baseballs.
- **1:30 PM – ~3:15 PM (Pickup Baseball Game):** At 1:30 PM, players gather at home plate to split into balanced Home and Away squads. Game starts promptly with continuous batting orders and free defensive rotations.
- **3:15 PM – 4:00 PM (Fielding Drills & Field Care):** Drill grounders and fly balls for players seeking extra repetitions, then drag and rake the infield dirt, clear trash from dugouts, and pack foundation equipment.

---

#### 3. Continuous Batting Lineup (Everyone Bats!)
- **No Bench Sitters:** Every registered player and walk-up is included in their team's batting order.
- **Continuous Lineup:** If a team has 12, 14, or 16 players, the batting order cycles through all 12, 14, or 16 batters continuously throughout the entire game. You never sit out an inning while your team is hitting.
- **Late Arrivals:** Anyone arriving after first pitch is simply added to the bottom of their team's batting order without penalty.

---

#### 4. Free Defensive Substitutions & Outfield Sharing (Everyone Fields!)
- **Unlimited Rotations:** Players may swap defensive positions freely between innings (for example, playing two innings at second base, two innings in the outfield, or taking a rest in the dugout).
- **Extra Outfielders:** When team turnout is large (more than 9 fielders per side), teams routinely play with **4 outfielders** (Left, Left-Center, Right-Center, Right) to keep more players active on the field and reduce physical strain.
- **Fair Dugout Rotation:** If a team has more than 10 fielders, 1 or 2 players rotate into the dugout each half-inning so playing time is 100% equal.

---

#### 5. Pitching Machine Guidelines & Mound Safety
- **Electric Pitching Machine:** Most games utilize a portable electric pitching machine powered by a battery pack (one of our core volunteer duties).
- **Consistent, Hittable Strikes:** The machine is dialed in to a predictable, moderate speed (typically 45–55 mph) with minimal break. This allows batters of all skill levels to put balls in play and gives infielders and outfielders realistic fielding chances.
- **L-Screen Safety Rule (Dead Ball Single):** The machine operator is protected by a sturdy L-screen. Any batted ball that strikes the L-screen, the pitching machine, or the operator is immediately ruled a **dead-ball single** (or a re-pitch by mutual agreement) to ensure safety.
- **Coach / Volunteer Pitching:** If live volunteer pitching is used instead of the machine, pitchers focus on throwing strikes to induce contact rather than aiming for strikeouts.

---

#### 6. Count, Strikeouts & 5-Run Inning Cap
- **Standard 3 Strikes:** Batters receive standard 3-strike counts.
- **No Walks off the Machine:** Because the machine is set to throw strikes, wild pitches that are completely unhittable do not count against the batter. Hitters swing until they put the ball in play or record 3 swinging/called strikes, keeping the game brisk and engaging.
- **5-Run Maximum Per Half-Inning:** To prevent one team from being stranded under the hot sun during a prolonged inning, a half-inning automatically ends after **3 outs OR a maximum of 5 runs scored**, whichever occurs first. The 9th / final inning is typically uncapped.

---

#### 7. Baserunning Safety: Slide or Avoid Contact (No Collisions!)
- **Safety First (Zero Collisions):** Baserunners must slide or veer / give themselves up to avoid contact with fielders making a play. Barreling or colliding with a catcher or infielder is strictly prohibited.
- **No Base Stealing / Controlled Leads:** To protect voluntary catchers and pitchers, base stealing and leading off are prohibited. Runners advance only on batted balls or wild overthrows that leave the infield.
- **Courtesy Runners:** Any player nursing an injury, recovering from physical strain, or needing running assistance can request a courtesy runner (the player who made the last out) from home plate or from any base without burning a substitution.

---

#### 8. Protective Gear & Footwear
- **Batting Helmets:** Required for all batters, on-deck hitters, and baserunners while on the field.
- **Catcher's Gear:** Anyone catching behind the plate must wear a complete catcher's gear set (mask/helmet, chest protector, and shin guards).
- **Footwear:** Molded rubber/plastic cleats, turf shoes, or athletic sneakers only. **Metal spikes are strictly prohibited** for player safety and artificial/dirt turf preservation.
- **Bats:** Wood, wood-composite, BBCOR (-3), or USA Baseball certified bats. High-compression modified softball bats are not allowed.
- **Fielding Gloves:** Players are encouraged to bring their own glove. Volunteers regularly bring 2–3 spare gloves for newcomers.

---

#### 9. Self-Officiating & The Honor System
- **Self-Umpired:** Pickup baseball is played on the honor system. The batting team's catcher, machine feeder, or base coaches call balls, strikes, and fair/foul lines.
- **Tie Goes to the Runner:** If a close play occurs at any base, the call always favors the runner, or players agree to replay the pitch with a smile. There are no arguments in pickup baseball!

---

#### 10. Post-Game Field Care: Leave the Field Better Than We Found It
- **Infield Dragging & Raking:** Volunteers pull-drag the dirt infield, smooth out sliding paths, and rake the batter's boxes and pitcher's landing area.
- **Dugout & Bleacher Cleanup:** Pick up all water bottles, tape, athletic wrappers, and trash from both dugouts and spectator bleachers.
- **Packing Equipment:** Inventory and safely pack up the bases, pitching machine, battery, balls, and foundation equipment.

---

### ⚾👏🛡️ Submitting a Group RSVP (Players, Spectators & Volunteer Tasks)
On any game page (`/event.html?id=...`), one person or household account can RSVP for their whole group in a single step:
1. **⚾ Players (`−` / `+`):** How many people in your group are **playing on the field** (`0` to `25`). Only on-field players count toward a game's playing roster cap (`max_players`).
2. **👏 Spectators (`−` / `+`):** How many people in your group are **watching or helping off-field** (`0` to `25`). Spectators never take up playing spots and are confirmed immediately even if the playing roster is full.
3. **🛡️ Group Volunteer Tasks:** Check any game-day tasks your group will cover (such as *Bases*, *Pitching machine and power*, *Game Baseballs*, *Field Dragging*, *Game Facilitator*, or *Water / Food*). **Tasks belong to your group as a whole**, not to separate individuals inside your group.
   - *Off-field volunteers:* You can set `0 Players` and check a task (or add `1+ Spectators`) to volunteer without playing!
4. **Optional Group Names & Shared Gear:** Click *"Add group names or shared gear (optional)"* to list group members' names or equipment you're bringing (extra bats, gloves, catcher's gear).
5. **Confirm / Update / Cancel:**
   - Click **Confirm RSVP** (or **Update RSVP** if editing). You'll receive a confirmation email with a personal link to manage your RSVP later, plus an automatic reminder email ~24 hours before first pitch.
   - Plans changed? Click **Can't Make It** next to the update button. Your spot and any claimed tasks are immediately released so others can take them.

### ⏳ Waitlists & Automatic Promotion
- If an organizer sets a player cap (for example, `24` players) and all playing spots are full, groups requesting `1+ Players` are placed on the **Player Waitlist** in signup order.
- Whenever a confirmed group cancels or reduces their **⚾ Players** count, the system **automatically promotes** the next waitlisted group that fits and emails them immediately.

### 💬 Discussion Board, Profile, Languages & Themes
- **Game Discussion Board:** Bottom of every game page — post carpool notes, gear questions, weather updates, or post-game highlights.
- **Player Profile (`/profile.html`):** Update your display name, short baseball bio, Clubhouse opt-in preference, upload a profile photo (automatically resized to 256×256 and stripped of GPS/EXIF camera metadata for privacy), or revoke sessions on other devices.
- **Language Selector:** Bottom footer (`🌐` selector) — switch among **15 languages** (including right-to-left layout for Arabic and Persian).
- **Theme & Colors:** Bottom footer (`🎨 Theme & Colors`) — choose Light or Dark mode and pick from **12 MLB team color palettes**.

### 🧭 Top Bar Menu, Clubhouse, Gallery, Digital Waiver & Footer Version
- **Top Bar `☰ Menu` & `About Us` (`/about.html`):** Click **`☰ Menu`** in the top-right header to reach **Clubhouse**, **Gallery & Art**, **About Us** (foundation mission & contact), and **Donate** (plus **Organizer / Admin** tools when authorized).
- **💬 Clubhouse (`/clubhouse.html`):** Community dugout with `#announcements` (public read-only for visitors), `#general`, per-game synced `#game-*` channels, encrypted Direct Messages and private boards (Web Crypto ECDH P-256 + AES-GCM-256 with Safety Number verification), WebRTC voice channels, and baseball GIFs/attachments.
- **📸 Gallery & Art (`/gallery.html`):** View and submit community game photos and videos (uploaded to the foundation's Google Drive pool and reviewed by moderators), plus access the interactive Community Art Studio canvases (Pixel Diamond, Dugout Wall, Chalkboard).
- **📝 Player Liability Waiver (`/waiver.html`):** Sign the annual Pickup Baseball Foundation liability waiver online and view your timestamped, SHA-256 provenance-sealed certificate. *(Direct link also lives in the footer.)*
- **Loaded Version Badge:** Every page footer displays the currently loaded build number (for example, `v143`) next to the license notice, so you can verify immediately whether a device is running the latest release or tap **`✨ Update Available`** if a newer build is waiting.

---

## 2. For Organizers & Administrators

Accounts granted the **`Organizer`** or **`Admin`** role see **`🛡️ Org`** (or **`👑 Admin`**) inside the top-right **`☰ Menu`** (`/admin.html`) plus organizer tools directly on each game page, the past games archive (`/archive.html`), the gallery (`/gallery.html`), Clubhouse moderation, and the admin dashboard. Organizers handle all game-day planning, publishing games, managing lineups and rosters, broadcasting rainouts, and recording field attendance turnouts.

> [!NOTE]
> On-field game day coordination—such as setting batting orders and balancing squads at home plate—is supported by the **Game Facilitator** volunteer task (a volunteer slot open to all game attendees). Account-level administration and permissions are managed using the **`Organizer`** role.

### ⚡ Scheduling a Game
1. Go to **`/admin.html`**.
2. **Fastest way:** Click **⚡ Post Next Sunday @ Noon** to pre-fill next Sunday at 12:00 PM Pacific Time with the default field location and default 6 volunteer tasks, then click **Publish Game**.
3. **Custom game:** Fill out the title, date/time (always entered in Pacific Time), field location, Google Maps link (optional), max on-field players (leave blank for unlimited), and volunteer tasks.

### 👥 Limited Roster Size & Automatic Waitlist Behavior
To keep games organized, safe, and fun without overcrowded dugouts or excessive bench waiting, organizers can configure an active player cap on any game:

#### 1. Setting or Changing the Player Limit
- **When creating a game (`/admin.html`):** Under the "Schedule a New Game" form, check **"Cap Playing Roster Capacity"** and specify the maximum number of on-field players. The standard default is **`28` players** (two full 14-player lineups).
- **Unlimited games:** If left unchecked or blank, the game remains open to an unlimited number of players (`max_players = null`).
- **Adjusting on the fly (`/event.html`):** Click **✏️ Edit Game** in the top-right corner of the event card to raise or lower the player cap at any time.

#### 2. Who Counts Toward the Cap (Players vs. Spectators)
- **⚾ On-field Players:** Only registered **players** (`players_count`) count against `max_players`.
- **👏 Spectators & Off-field Volunteers:** Spectators (family members and friends cheering from the bleachers) and off-field volunteers (such as Bringing Water/Food or Game Facilitator) **never consume roster spots**. Spectator RSVPs are always confirmed immediately (`status: 'attending'`), even when the on-field playing roster is 100% full.

#### 3. Automatic Waitlist Activation & Queue Numbers
- As soon as confirmed on-field players reach the capacity limit, the game status dynamically switches to **"Playing Roster Full"**.
- Subsequent players who attempt to RSVP are automatically placed on the **⏳ Waitlist** and assigned an exact sequential queue position (e.g. *Waitlist #1*, *Waitlist #2*).
- An automated email is immediately sent to the registrant confirming their place on the waitlist with a direct link to check their status anytime.

#### 4. Automatic First-In, First-Out (FIFO) Promotion
- The waitlist runs entirely autonomously on a strict FIFO basis:
  - Whenever an active player or group cancels their reservation (via the **"Can't Make It? Cancel RSVP"** button on `/event.html`) or decreases their party's `players_count`, the system automatically checks if enough vacant spots opened to accommodate the next group in line.
  - The waitlisted group is automatically promoted to the active roster (`status: 'attending'`).
  - An instant email notification is dispatched via Resend:
    > *"⚾ A spot opened up! You're in for [Game Title] (Sunday, [Date] at 12:00 PM PST)"*
- **Organizer Moderation Trigger:** If an organizer manually deletes a mistaken or spam player from the roster using the `✕` / `🗑️` button on `/event.html`, the waitlist promotion engine evaluates immediately and promotes the next waiting player.
- **Raising Capacity:** If an organizer edits the game and increases the cap (e.g. from 24 to 28), the top waitlisted players are automatically promoted into the open slots with notification emails dispatched.

### 🔒 Restricting RSVPs to Invited Emails (Optional)
- When creating or editing a game on `/admin.html`, toggle **"Restrict RSVP to specific invited player accounts"**.
- Check registered players from the searchable directory (or type additional email addresses). Only those emails (plus organizers/admins) will be permitted to RSVP, and private restricted games are automatically hidden from the public `.ics` calendar feed.

### ✏️ Editing a Game & Recording Actual Turnout
- On any game page (`/event.html?id=...`), click **✏️ Edit Game** in the top-right corner of the header card to change title, date/time, location, player cap, or description inline.
- After a game finishes, use the **📊 Record Actual Turnout** box on the game page (or on `/archive.html`) to record how many people actually played on the field (including walk-ups who didn't RSVP online).

### 🌧️ Smart Rainout Assistant & 24-Hour Surface Accumulation Drainage Tracker
To help organizers and players know in advance whether the diamond is playable, the platform includes a zero-host, client-side **Smart Rainout Assistant**:

#### 1. Why Sunday 24-Hour Prior Rainfall Matters
- In the San Francisco Bay Area (Oakland, Berkeley, San Francisco), active rain during Sunday afternoons is exceedingly rare.
- Almost all pickup baseball rainouts are caused not by falling rain at Noon, but by **how much water accumulated on the field in the preceding 24 hours (Saturday 12:00 PM through Sunday 12:00 PM)** and **whether fallen rain had adequate time to percolate through the dirt and drain away**.

#### 2. The Soil Drainage & Surface Moisture Heuristic Model
The client-side engine queries hourly rainfall from Open-Meteo and applies an exponential percolation decay model:
$$\text{ESM} = \sum_{h=1}^{24} r_h \cdot e^{-h / \tau}$$
where $r_h$ is the rainfall in inches that fell $h$ hours before 12:00 PM warmups, and $\tau = 8.0\text{ hours}$ is the soil drainage half-decay rate:
- **Rain Saturday afternoon (18–24 hours ago):** Retains only 5%–10% surface effect ($e^{-20/8} \approx 0.08$). A steady 0.80" shower on Saturday that ends by evening will cleanly drain into the ground, leaving the field firm and ready for Sunday afternoon baseball!
- **Rain Sunday morning (1–3 hours before warmups):** Retains 70%–88% surface moisture ($e^{-2/8} \approx 0.78$). Even a light 0.20" shower will sit as standing puddles in batter's boxes and along baselines because it has had insufficient time to soak in.

#### 3. Four Field Playability Classifications
- 🟢 **Field Playable (Dry & Firm):** $\text{ESM} < 0.08"$. Infield dirt is dry, baselines firm, zero puddles. Full 12:00 PM – 4:00 PM program runs smoothly.
- 🟡 **Damp Infield (Playable with Care):** $0.08" \le \text{ESM} < 0.22"$. Rain had sufficient hours to drain; dirt is soft; molded cleats recommended.
- 🟠 **Puddle Alert (Drying / Maintenance Needed):** $0.22" \le \text{ESM} < 0.45"$ or rain ended $<3$ hours before noon. Standing puddles in depressions; organizers should inspect the field by 10:30 AM with rakes or brooms.
- 🔴 **High Rainout Likelihood (Waterlogged):** $\text{ESM} \ge 0.45"$ or heavy rain active within 2 hours of warmups. Deep standing water along baselines; field cannot drain in time for 12:00 PM warmups. Organizers should consider broadcasting a rainout.

#### 4. Zero-Cost, Zero-Host Client-Side Architecture
- The assistant runs 100% in the user's browser via `public/js/weather.js` using Open-Meteo's open-access API.
- Provides a **10-day weather forecast** (temperature & condition emoji on calendar cards), **5-day rainfall prediction & daily breakdown** (displayed across the event details card for the day of the event and the four previous days), and a **24-hour prior rainfall drainage simulation** for upcoming games.
- **Zero API keys**, **zero subscription fees**, and **zero Cloudflare Worker bandwidth or execution limits used**.
- Results are cached in browser `sessionStorage` (30-minute TTL) so page refreshes and navigation never make duplicate requests.

#### 5. Dynamic Field Location Awareness
- Weather widgets, pills, and the Smart Rainout Assistant automatically adjust coordinates according to the specific location that the organizer specifies when creating or editing a game.
- **Built-in Regional Diamond Dictionary:** Seamlessly maps common East Bay, San Francisco, South Bay, and North Bay baseball fields (e.g., Bushrod Park, Raimondi Park, San Pablo Park, James Kenney Park, Washington Park Alameda, Big Rec SF, Crocker Amazon, etc.).
- **Coordinate & Google Maps Link Parsing:** Automatically extracts latitude and longitude if an organizer enters coordinates directly or pastes a Google Maps link (e.g., `37.8560, -122.2836`).
- **Live Client-Side Geocoding Fallback:** If an arbitrary diamond or street address is entered, the engine queries Open-Meteo's open geocoding service and caches results in `sessionStorage` for instant repeat lookups.
- **Per-Card Weather Badges:** On the homepage calendar, each game's weather pill reflects its own designated field rather than a single global default.

### 🌧️ Calling a Rainout (or Reopening a Game)
- On the game page, click **🌧️ Call Rainout**, enter an optional field/weather note (e.g., *"Standing water on Bushrod Field 1"*), and confirm.
- What happens automatically:
  1. The game displays a prominent rainout banner and closes new RSVPs.
  2. Every confirmed attendee/group receives a **Rainout Alert email** releasing them from equipment and volunteer task commitments.
  3. Subscribed phone/computer calendars update the event title to `🌧️ RAINED OUT: ...`.
- If the sun comes out and fields dry up, click **☀️ Reopen Game** to restore active status and optionally notify attendees that the game is back on.

### 🛡️ Moderating Rosters & Comments
- Organizers and Admins see a small `✕` / `🗑️` button beside roster entries and discussion comments on `/event.html` to remove spam or mistaken entries (removing an attendee also triggers automatic waitlist promotion if a spot opens).

### 📢 Publishing Community Highlights & Submitting Multimedia to the RSS Feed
- Navigate to the **Community Highlights & RSS Feed** section on `/admin.html` (or click **+ New Highlight** on the homepage).
- **Zero-Storage Cloudflare Architecture:** To keep hosting costs zero and stay within Cloudflare D1 limits, you **do not upload heavy image or video files to Cloudflare**. Instead, you paste external links (YouTube, Imgur, direct image URLs, or video links) and the app renders them richly for users while generating standard Media RSS XML.
- **Filling out the publisher form:**
  1. **Headline / Title *:** Game recap title or announcement.
  2. **Associated Game (Optional):** Link the post to a specific Sunday game in the dropdown.
  3. **Story / Recap Content *:** The recap, box score, standout innings, or volunteer shoutouts.
  4. **Short Summary / Subtitle (Optional):** 1-sentence synopsis used in RSS feeds and reader apps.
  5. **External Multimedia URL (Optional):**
     - **YouTube videos or shorts:** (e.g. `https://www.youtube.com/watch?v=...` or `https://youtu.be/...`). The app automatically embeds a responsive 16:9 privacy-preserving player (`https://www.youtube-nocookie.com/embed/...`).
     - **Images & Photos:** (e.g. `https://i.imgur.com/...` or any direct `.jpg`/`.png` link). The app renders a photo card with lazy-loading and adds an RSS `<enclosure>` + `<media:content>` tag.
     - **Direct Video Streams:** (e.g. `.mp4` link). The app renders an HTML5 `<video controls playsinline>` player.
     - **Audio Podcasts / Voice Notes:** (e.g. `.mp3` link). The app renders a native `<audio controls>` player.
  6. **Media Format:** Leave as *Auto-detect from link* or pick explicitly.
  7. **Multimedia Live Preview:** As soon as you type or paste a URL, the real-time preview box below the form shows exactly how the media will look before you publish.
- Click **🚀 Publish Highlight to Community Feed & RSS**.
- The highlight is immediately published to:
  - The **📢 Highlights & Community Updates** grid on the homepage (`index.html#community-feed-section`).
  - The public **RSS 2.0 + Media RSS feed** at [`/feed.xml`](https://www.pickupbaseballfoundation.org/feed.xml).
- Organizers and admins can delete posts anytime using the red **🗑️ Delete** button on `/admin.html` or inline on the homepage.

---

### 💵 Paid Operations & Fair-Share Task Scheduling Policy
<a id="-paid-operations--fair-share-task-scheduling-policy"></a>

Sunday Pickup Baseball relies on dedicated operational roles to transport equipment and prepare high-quality playing diamonds every week. Because weekly events offer a limited number of compensated operational positions, this policy establishes a deterministic, transparent, and non-punitive system for distributing paid shifts equitably among interested community members.

#### 1. Core Principles: Decentralization, Transparency & Non-Punitive Design
- **No Private Organizer Hiring:** The **Game Organizer role does NOT include arranging or hiring paid workers** for their event. Organizers focus entirely on on-field game coordination, lineups, and community safety. Paid task scheduling is handled 100% autonomously and transparently by the web app.
- **Deterministic Transparency (Zero Lottery):** Sign-up windows and fair-share quotas are calculated using deterministic rules visible to everyone. There is no lottery, favoritism, or opaque manual selection.
- **Strictly Non-Punitive:** The system contains **zero strikes, cooldowns, or cancellation penalties**. If an emergency arises and a worker must drop a shift, their spot is immediately released back to the community without penalty, and any redeemed Backup Hero Credit is promptly refunded.

#### 2. The Two Paid Operational Roles & Badges
To ensure field safety and equipment reliability, only accounts holding the corresponding Foundation Certification Badge may claim paid operational tasks:
1. **⚡ Pitching Machine & Power (`machine_badge`):**
   - **Responsibilities:** Safely transporting the electric pitching machine and high-capacity battery station to the field, operating and feeding consistent strikes, packing the gear post-game, and recharging the battery pack between games.
   - **Certification:** Granted by Foundation Administrators on the user's account after hands-on training with machine calibration, battery charging safety, and L-screen placement.
2. **🚜 Field Dragging (`field_badge`):**
   - **Responsibilities:** Arriving 20 minutes prior to warm-ups with the pull rake and drag mat to smooth the infield dirt, level sliding paths, tamp the batter's boxes, and groom the diamond post-game.
   - **Certification:** Granted by Foundation Administrators upon completion of infield grooming and diamond care instruction.

> [!NOTE]
> General volunteer tasks (such as *Bases*, *Game Baseballs*, *Game Facilitator*, and *Water / Food*) are open to all attendees and do not require specialized operational badges.

#### 3. The 12-Week Sign-Up Timeline & Monday 5:00 AM Unlock Trigger
- **Release Moment:** An event's volunteer and operational tasks unlock exactly at **5:00 AM on Monday, 12 weeks prior to game day** (the day after the day 12 weeks before Sunday, or 83 days prior).
- **Task Release Cadence:** Every Monday morning at 5:00 AM Pacific, the next upcoming Sunday event three months away unlocks its tasks.
- **Locked State (`🔒`):** Prior to 5:00 AM on that Monday, tasks are locked. Players and spectators may RSVP for roster spots at any time, but operational tasks cannot be selected until the unlock moment.

#### 4. The Three Tiered Windows & Rolling 3-Month Fair-Share Cap
Across any rolling 3-month period (12 weekly events), there are 24 total paid operational shifts (12 pitching machine shifts and 12 field dragging shifts). Sign-ups progress across three distinct tiers over the 12-week window leading up to game day:

##### 🏆 Tier 1: Weeks 12 to 6 Prior (Fair-Share Quota Window)
- **Timeframe:** From the unlock trigger (83 days prior) down to 42 days (6 weeks) before game day.
- **Who Can Select:** Certified badged workers only.
- **Rolling 3-Month Fair-Share Cap:**
  To guarantee that every certified worker gets an equitable distribution of available shifts, each worker is subject to a per-type cap on a rolling 12-week basis:
  $$\text{Cap} = \left\lfloor \frac{24}{2n} \right\rfloor = \left\lfloor \frac{12}{n} \right\rfloor$$
  where $n$ is the number of active certified workers holding that specific badge ($n \ge 1$):
  - If $n = 4$ badged workers: $\text{Cap} = \lfloor 12/4 \rfloor = 3$ machine shifts and $3$ dragging shifts per worker per 3 months.
  - If $n = 3$ badged workers: $\text{Cap} = \lfloor 12/3 \rfloor = 4$ shifts per worker.
  - If $n = 2$ badged workers: $\text{Cap} = \lfloor 12/2 \rfloor = 6$ shifts per worker.
- **Cap Reached:** A worker who has already claimed their cap of that duty type within the rolling 12-week period cannot select additional shifts in Tier 1 **unless they redeem a Backup Hero Credit**.

##### 🔓 Tier 2: Weeks 6 to 2 Prior (Open Badged Access)
- **Timeframe:** From 42 days (6 weeks) down to 14 days (2 weeks) before game day.
- **Who Can Select:** **All certified badged workers**, even if they have already met their Tier 1 quota!
- **Purpose:** Ensures that shifts not claimed during the initial quota window are filled well in advance. No Backup Hero Credits are required.

##### 🚨 Tier 3: Weeks 2 to Game Day (Standby & Urgent Cover Incentive)
- **Timeframe:** Within 14 days of game day down to first pitch.
- **Who Can Select:** All qualified badged personnel.
- **🛡️ Short-Notice Backup Hero Credit:**
  Stepping up on short notice (**less than 48 hours before first pitch**) to claim an open or vacated shift automatically awards **+1 Backup Hero Credit** upon signup.

#### 5. Backup Hero Credit Mechanics
- **Earned Through Solidarity:** Backup Hero Credits recognize members who step up during short-notice emergencies (<48 hours) to ensure Sunday games run without interruption.
- **Redeemed for Early Tier 1 Access:** When high-demand future dates unlock (such as holiday weekends or season openers), a capped worker can redeem 1 Backup Hero Credit to claim a shift during Tier 1 above the standard cap.
- **Refund Policy:** Non-punitive by design: If a game is called for rain or if an attendee cancels their RSVP before game day, any redeemed hero credit is instantly restored to their balance.

---

## 3. For Administrators

Accounts with the **`Admin`** role have full access to `/admin.html` system controls:

- **👥 User Roles & Account Management:**
  - **Compact View & Scrolling:** The accounts table is rendered in a compact, vertically scrollable viewport (`max-height: 380px`) with sticky column headers, so even when hundreds of players register, the table only occupies a small, contained portion of the screen without pushing the rest of the dashboard down.
  - **Live Filter by Name or Email:** Use the search bar above the accounts table to instantly filter the list by any substring of a player's name or email address (case-insensitive). The live counter displays `Showing X of Y accounts` in real time, with clear feedback if no accounts match.
  - **Role Assignments & Actions:** Promote any registered player to `Organizer` or `Admin` (or demote back to `Player`), remove obsolete accounts, or block abusive email addresses (`banned_emails`).
- **🛡️ Access Control & Guest Policy:**
  - **Guest RSVP Policy Toggle:** Switch between allowing guests to RSVP with just a name + email vs. requiring all attendees to sign in with a verified email code first (disabling anonymous RSVPs across all games).
  - **Banned Email Addresses:** Review, add, or unban restricted email addresses directly on `/admin.html`. When removing a user account with the ban option checked, the address is automatically added to this list and blocked from requesting login codes, maintaining active sessions, or submitting RSVPs.
- **🛡️ Default Volunteer Tasks Template:** Edit the default list of tasks (titles, descriptions, and slot counts) that pre-populate whenever new Sunday games are created.
- **📥 Backup Database (`.sql`):** Click **📥 Backup Database (.sql)** on `/admin.html` at any time to download a complete SQL snapshot of all users, games, RSVPs, tasks, and comments.

---

# Part II: Manual Maintenance & Code Editing Handbook

## 4. How the Codebase Is Organized

There is **no build step** for the website. The files inside `public/` are served verbatim to browsers, and a **single unified Hono API (`src/app/`)** runs identically in production (Cloudflare Pages Functions + D1) and locally (Node.js + Express + `better-sqlite3`).

```text
pickup-baseball/
├── public/                        # FRONTEND (Served directly by Cloudflare Pages CDN)
│   ├── index.html                 # Homepage: hero banner, routine, privacy promise, calendar
│   ├── event.html                 # Single game page: Group RSVP, tasks, BP, weather, roster, comments
│   ├── clubhouse.html             # Clubhouse realtime chat, E2EE DMs/boards & WebRTC voice rooms
│   ├── gallery.html               # Community photo, video & art gallery
│   ├── art.html                   # Legacy Community Art Studio path (links to gallery.html)
│   ├── archive.html               # Past games archive & actual turnout history
│   ├── waiver.html                # Digital liability waiver & cryptographic certificates
│   ├── about.html                 # Foundation mission, contact & quick links
│   ├── donate.html                # Donation links & tax-receipt information
│   ├── admin.html                 # Organizer & Admin dashboard (users, security, tasks, DB backups)
│   ├── login.html                 # Passwordless 6-digit code / magic link sign-in
│   ├── profile.html               # Player profile, bio, avatar upload, & session controls
│   ├── 404.html                   # Custom 404 Not Found page
│   ├── sw.js                      # Offline PWA Service Worker & static cache list
│   ├── _headers                   # HTTP security headers (CSP, HSTS, Cache-Control)
│   ├── _redirects                 # Redirects *.pages.dev, /handbook, & /rules
│   ├── _routes.json               # Routes /api/*, /feed.xml, & /health to Pages Functions
│   ├── css/
│   │   ├── style.css              # Core layout, components, default Bay Area theme & dark mode
│   │   ├── themes.css             # 11 additional MLB team color palettes (light & dark)
│   │   └── clubhouse.css          # Clubhouse workspace styling
│   ├── i18n/*.json                # Translation dictionaries for 14 non-English languages
│   └── js/                        # Vanilla ES6 client modules (api.js, weather.js, clubhouse.js,
│                                  #   crypto.js, store.js, rtc.js, event.js, gallery.js, admin.js,
│                                  #   app.js, archive.js, art.js, login.js, profile.js, waiver.js,
│                                  #   nav-init.js)
│
├── src/
│   ├── app/                       # UNIFIED HONO API (Shared by Cloudflare Workers & Node.js)
│   │   ├── index.js               # Global security headers, CSRF, WAF, session lookup & mounts
│   │   ├── schema.js              # Dual-D1 schema, migrations, & DEFAULT_BASEBALL_DUTIES
│   │   ├── security.js            # Sessions, RBAC middleware, rate limits, SSRF & EXIF helpers
│   │   ├── gdrive.js              # Google Drive OAuth2 storage pool & range streaming
│   │   ├── mailer.js              # Resend transactional email templates
│   │   ├── feeds.js / policy.js / version.js
│   │   └── routes/                # auth, baseball, gifs, keys, media, posts, rtc, waiver,
│   │                              #   events/{core,rsvps,bp-duties,helpers},
│   │                              #   chat/{sync,channels,messages,moderation,helpers}
│   └── server.js / d1-sqlite.js / db.js / auth.js / seed.js  # Local Node runner (`npm run dev`)
│
├── functions/                     # THIN CLOUDFLARE PAGES ENTRYPOINTS (imports src/app/)
│   ├── api/[[route]].js           # Delegates /api/* to src/app/index.js
│   ├── feed.xml.js                # RSS 2.0 + Media RSS feed endpoint
│   └── health.js                  # Edge health check (/health)
│
├── tests/                         # Native node:test suites (core/*, clubhouse/tier1–6, workerd/*, helpers/*)
├── scripts/
│   ├── verify-all.js              # Automated E2E verification suite (`npm test`)
│   ├── security-scan.js           # Static/live security & parity scanner
│   ├── bump-version.js            # Atomic version/cache-bust bumper (`npm run bump`)
│   └── ship.ps1                   # Automated Windows release workflow script
└── wrangler.toml                  # Cloudflare Pages project config, env vars, & D1 bindings
```

> ### 💡 Single Unified Backend Architecture
> - **One API Codebase (`src/app/`):** You no longer have to duplicate changes across separate Cloudflare and Node backend files. Both `functions/api/[[route]].js` (production Cloudflare Pages + D1) and `src/server.js` (local `npm run dev` + `npm test` via `src/d1-sqlite.js`) execute the exact same Hono routers in `src/app/`.
> - **Schema & Migrations (`src/app/schema/`):** Database tables and versioned migrations for both `BASEBALL_DB` and `CHAT_DB` live in `src/app/schema/{baseball-ddl,chat-ddl,migrations,engine}.js` (with `src/app/schema.js` as the stable barrel and `npm run db:migrate` for pre-deploy runs).

---

## 5. The 4-Step Workflow for Any Manual Change

### Prerequisites (One-Time Setup on Your Computer)
1. Install **[Node.js](https://nodejs.org/)** (v20 or v22 LTS) and **Git**.
2. Open a terminal in the project folder and install dependencies:
   ```bash
   npm install
   ```
3. Log in to Cloudflare (only needed once per computer in order to deploy):
   ```bash
   npx wrangler login
   ```

### Making & Publishing a Change
1. **Preview Locally (Optional):**
   - Run `npm run dev` and open `http://localhost:3000` (uses local SQLite in `data/`, printing login codes and emails directly to your terminal!).
   - *Or* run `npm run pages:dev` to emulate Cloudflare Pages + Workers locally at `http://localhost:8788`.
2. **Edit the Files & Bump the Cache Version:**
   - Make your edits (see [Section 7 Cookbook](#7-cookbook-step-by-step-recipes-for-common-edits)), then run:
     ```bash
     npm run bump
     ```
     *(Atomically increments the version number across backend, Service Worker, client config, and all 13 HTML files.)*
3. **Run the Automated Test Suite & Security Scan:**
   ```bash
   npm test
   npm run security:scan
   ```
   Confirm `npm test` ends with `# fail 0` (223 tests) and `npm run security:scan` ends with `12 passed, 0 warnings, 0 failed.` (Note: if you intentionally renamed a heading or doc section asserted by `tests/core/*.test.js`, update the test expectation too.)
4. **Save to GitHub & Deploy to Cloudflare:**
   ```bash
   git add -A
   git commit -m "Describe your change here"
   git push origin trunk
   npm run deploy
   ```
   *(On Windows PowerShell, `.\scripts\ship.ps1 -Message "..."` automates Steps 2–4 plus `npm run security:scan:live`.)*
   Verify the live site updated by visiting `https://www.pickupbaseballfoundation.org/api/version` or checking the footer version pill (`v143`, etc.)!

---

## 6. Version Bumping Checklist (Clearing Browser & Phone Caches)

Because the site is an installable Progressive Web App (PWA) with an offline Service Worker, phones and browsers aggressively cache CSS and JavaScript files.

Whenever you deploy a frontend or API change, run:

```bash
npm run bump
```

`scripts/bump-version.js` atomically increments the version integer by `+1` across every required file:
1. **`src/app/version.js`** — `export const CURRENT_APP_VERSION = '...';` (transmitted via `/api/version` and the `X-App-Version` HTTP header)
2. **`public/sw.js`** — `const CACHE_NAME = 'pbf-cache-v...';`
3. **`public/js/api.js`** — `CLIENT_VERSION: '...'` (rendered in `#footer-app-version` in the footer)
4. **All 13 HTML files in `public/*.html`** — updates `?v=<N>` query strings on `/css/...` and `/js/...` links.

When `CURRENT_APP_VERSION` on the server increases, any player with an older tab or installed PWA open automatically sees the **`✨ Update Available`** button in the footer.

---

## 7. Cookbook: Step-by-Step Recipes for Common Edits

### Recipe A: Changing Page Text, Headings, or Footer Copy
> **⚡ Crucial Watch-Out (`data-i18n`):**
> Many HTML elements carry a `data-i18n="some.key"` attribute (for example, `<h1 data-i18n="hero.title">...</h1>`). On page load, `API.applyTranslations()` in `public/js/api.js` replaces that element's text with the matching entry from `EN_DICT` (for English) or `public/i18n/<lang>.json` (for other languages).
>
> **If you edit text in an HTML file and don't update `EN_DICT` in `public/js/api.js`, your new text will flash for a split second and revert to the old text!**

**How to change text cleanly:**
1. Find the element in `public/*.html` and update its text.
2. Check if it has a `data-i18n="..."` (or `data-i18n-html="..."` / `data-i18n-placeholder="..."`) attribute.
3. If it does, open **`public/js/api.js`**, find that key inside `EN_DICT`, and update its English string to match.
   - Because `npm run security:scan` checks that all 14 `public/i18n/*.json` bundles match every key in `EN_DICT`, update or add any new keys across `public/i18n/*.json` as well.
4. **Editing the Site Footer:** The footer on all pages is generated centrally inside `renderFooter()` in **`public/js/api.js`** (search for `renderFooter()`). Edit both `EN_DICT` and the fallback string inside `renderFooter()`.

---

### Recipe B: Updating Donation Links or the Privacy Promise
- **Donation Page:** Open **`public/donate.html`**. Edit button URLs (PayPal Giving Fund, Every.org, EIN details, etc.) directly in HTML, and update matching `donate.*` keys in `EN_DICT` inside **`public/js/api.js`**.
- **Homepage Mailing List Link:** Open **`public/index.html`** and look for `id="mailing-list-link"` to update the Google Form URL.
- **Privacy Promise Bullets:** Open **`public/index.html`** (`#privacy-policy`) and update matching `privacy.b1`–`privacy.b5` keys in `EN_DICT` inside **`public/js/api.js`**.

---

### Recipe C: Changing Default Field Location or Default Volunteer Tasks
- **Default Volunteer Tasks (No Code Needed!):** Sign in as an **Admin**, go to `/admin.html`, edit the **Default Volunteer Tasks Template**, and click Save.
  - *(To change the hardcoded fallback defaults in code, edit `DEFAULT_BASEBALL_DUTIES` in **`src/app/schema.js`**.)*
- **Default Field Location / Quick-Schedule Defaults:**
  - Calendar subtitle text: `calendar.subtitle` in `public/index.html` and `EN_DICT` in `public/js/api.js`.
  - "Post Next Sunday @ Noon" preset values: search for `Bushrod Park` in **`public/js/admin.js`**.

---

### Recipe D: Changing Colors, Fonts, or Adding a Team Color Theme
1. **Default Bay Area Heritage & Dark Mode tokens:** Open **`public/css/style.css`** (`:root` and `[data-theme="dark"]`).
2. **Other 11 MLB Team Themes:** Open **`public/css/themes.css`** (`[data-color-theme="team-id"]` and `[data-color-theme="team-id"][data-theme="dark"]`).
3. To add a new theme to the footer picker, add an entry to the `COLOR_THEMES` array in **`public/js/api.js`**, then add its `[data-color-theme="your-theme-id"]` CSS variable block in **`public/css/themes.css`**.

---

### Recipe E: Adding a New Column to the Database (Zero-Downtime)
If you ever need to store a new field in `BASEBALL_DB` or `CHAT_DB`:
1. Add the column to `CREATE_TABLES_SQL` in **`src/app/schema/baseball-ddl.js`** (or `CREATE_CHAT_TABLES_SQL` in **`src/app/schema/chat-ddl.js`**).
2. Add a new versioned migration step to `BASEBALL_MIGRATIONS` (or `CHAT_MIGRATIONS`) inside **`src/app/schema/migrations.js`**.
3. Run `npm run db:migrate` locally (and `node scripts/migrate-db.js --remote` for production D1 if migrating ahead of traffic).
   - *Why this works so well:* Both `npm test` and production Cloudflare Workers invoke `ensureDualD1Schema` (`src/app/schema/engine.js`) automatically, safely applying pending versioned migrations to existing D1 databases without losing a single row!

---

### Recipe F: Changing Admin Email, Sender Address, or API Secrets
- **Public settings (`ADMIN_EMAIL`, `ADMIN_NAME`, `FROM_EMAIL`, `REPLY_TO_EMAIL`, `APP_NAME`):**
  Edit **`wrangler.toml`** under `[vars]`, then run `npm run deploy`.
- **Encrypted Secrets (`RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, `GDRIVE_*`):**
  Never put secret API keys in `wrangler.toml`, `scripts/`, or Git. Rotate or update keys securely via terminal:
  ```bash
  npx wrangler pages secret put RESEND_API_KEY --project-name pickup-baseball
  # Or configure Google Drive OAuth secrets interactively:
  npm run setup:gdrive
  ```
  Paste the new key when prompted, then run `npm run deploy`.

---

### Recipe G: Managing the Community Highlights & RSS 2.0 Media Feed
- **How it works behind the scenes:**
  - Database table `posts` in Cloudflare D1 stores headlines, text content, author, created date, and external media URLs (`media_url`, `media_type`).
  - Edge endpoint `/feed.xml` (`functions/feed.xml.js`) and `/api/feed.xml` (`src/app/feeds.js`) render standard **RSS 2.0** XML with Yahoo **Media RSS** (`xmlns:media="http://search.yahoo.com/mrss/"`) tags and Atom self-links.
  - Homepage (`index.html`) fetches `GET /api/posts` and renders rich media cards with responsive 16:9 YouTube iframes (`youtube-nocookie.com`), photo zoom cards, and native HTML5 video/audio elements.
- **Adding or modifying supported external media embed rules:**
  - URL detection helpers live in **`public/js/api.js`** (`API.parseMediaType(url)`) and **`src/app/routes/posts.js`**.
  - Content Security Policy (CSP) headers in **`public/_headers`** and **`src/server.js`** control which external iframe origins can load (e.g., `frame-src` / `connect-src`).
  - Always keep `media-src 'self' https: data: blob:` in **`public/_headers`** so audio/video tags and Drive streams work reliably.

---

## 8. House Rules & Safety Guardrails

Follow these habits (automatically enforced by `npm run security:scan`) to keep the site fast, secure, and working across older phones:

1. **Keep Frontend JavaScript ES6-Compatible (`public/js/*.js`):**
   - Avoid newer JS operators like optional chaining (`obj?.prop`), nullish coalescing (`a ?? b`), or ES module `import`/`export` syntax in `public/js/*.js`. Write `obj && obj.prop` instead so older browsers and static checks pass cleanly.
2. **Strict CSP (No Inline Scripts or Handlers):**
   - Never add inline `<script>` blocks, `javascript:` URLs, `eval()`, `new Function()`, or inline HTML `onclick=`/`onchange=` attributes. Bind listeners in `.js` files.
3. **Always Escape User Input in HTML (`API.escapeHtml` / `esc`):**
   - Whenever inserting a player's name, bio, gear note, or comment into `.innerHTML`, wrap it in `${API.escapeHtml(value)}` to prevent Cross-Site Scripting (XSS).
4. **Always Use Parameterized SQL Queries (`?`):**
   - Always use `db.prepare('SELECT * FROM events WHERE id = ?').bind(eventId)` — never interpolate variables into SQL strings.
5. **Never Store Heavy Media Binaries in D1:**
   - Keep `clubhouse_gifs.local_data_base64` unused for GIFs and store heavy gallery/chat media in the Google Drive pool (`src/app/gdrive.js`).
6. **Verify Before Deploying:**
   - Always run `npm test` and `npm run security:scan`, and keep inputs at `16px` (`1rem`) minimum font size on mobile to avoid iOS Safari auto-zoom.

---

## 9. Troubleshooting & Emergency Recovery

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| **Edited HTML text reverts back immediately when page loads** | Element has a `data-i18n="..."` key overriding it from `public/js/api.js`. | Update the matching key in `EN_DICT` in `public/js/api.js` and all `public/i18n/*.json` bundles (see [Recipe A](#recipe-a-changing-page-text-headings-or-footer-copy)). |
| **Browser or phone still shows old CSS or JS after deploy** | Browser or Service Worker is serving cached version. | Run `npm run bump` ([Section 6](#6-version-bumping-checklist-clearing-browser--phone-caches)) and redeploy, or tap `✨ Update Available` in the footer / hard-refresh (`Ctrl+Shift+R`). |
| **`/api/...` route returns 404 or matches `/:id` by mistake** | Dynamic `:id` router/handler was registered above a named static sub-route. | Ensure static sub-routes mount **before** `/:id` handlers in `src/app/routes/events.js` (or `src/app/routes/events/core.js`) and `src/app/routes/chat.js`. |
| **Security scan fails on `i18n` or `PWA Asset & Version Parity`** | New key missing from `public/i18n/*.json` or new HTML/CSS/JS file omitted from `public/sw.js` `STATIC_ASSETS`. | Sync keys across all 14 `public/i18n/*.json` files or add the new file to `STATIC_ASSETS` in `public/sw.js` and run `npm run bump`. |
| **Login or RSVP emails aren't arriving** | Resend API key expired or domain DNS record changed. | Check **resend.com → Logs & Domains** to confirm `pickupbaseballfoundation.org` is verified, and re-set `RESEND_API_KEY` if needed ([Recipe F](#recipe-f-changing-admin-email-sender-address-or-api-secrets)). |
| **Need to roll back a bad deployment immediately** | Bug introduced in latest deploy. | Run `git revert HEAD && npm run deploy`, **or** open **Cloudflare Dashboard → Workers & Pages → `pickup-baseball` → Deployments** and click **Rollback** on the previous working deployment in 1 click. |
| **Need to restore data from a `.sql` backup file** | Accidental deletion of an event or table rows. | Sign in to `/admin.html` regularly to download `baseball_backup_YYYY-MM-DD.sql` snapshots (or use `npm run d1:backup` / `npm run d1:backup:chat`). Execute `INSERT` statements in **Cloudflare Dashboard → Storage & Databases → D1** or via `npx wrangler d1 execute pickup-baseball-db --remote --file=your_restore.sql`. |
