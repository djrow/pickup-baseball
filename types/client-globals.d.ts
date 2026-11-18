/**
 * Shared ambient facade declarations for zero-build browser scripts in `public/js/`.
 *
 * `tsconfig.client.json` uses `"moduleDetection": "force"` so each script is
 * isolated without top-level symbol collisions while sharing these global
 * facades and `window.*` contracts.
 */

declare const module: {
  exports: any;
};

declare const require: {
  (id: string): any;
  resolve(id: string): string;
  cache?: Record<string, any>;
};

interface PBFUser {
  id: number;
  name: string;
  email?: string;
  role?: string;
  isAdmin?: boolean;
  is_admin?: boolean | number;
  isOrganizer?: boolean;
  canManageEvents?: boolean;
  isModerator?: boolean;
  is_moderator?: boolean | number;
  isMuted?: boolean;
  is_muted?: boolean | number;
  clubhouseOptedIn?: boolean;
  clubhouse_opted_in?: boolean | number;
  rosterVisibility?: boolean;
  roster_visibility?: boolean | number;
  profileSharing?: boolean;
  profile_sharing?: boolean | number;
  notifyRsvpConfirm?: boolean;
  notify_rsvp_confirm?: boolean | number;
  notifyRainouts?: boolean;
  notify_rainouts?: boolean | number;
  notifyEventReminders?: boolean;
  notify_event_reminders?: boolean | number;
  notifyCommunityUpdates?: boolean;
  notify_community_updates?: boolean | number;
  avatarUrl?: string;
  bio?: string;
  badges?: string[];
  waiverSigned?: boolean;
  waiverStatus?: string;
  [key: string]: any;
}

interface PBFEvent {
  id: number;
  title: string;
  location?: string;
  description?: string;
  event_date: string;
  max_players?: number | null;
  status?: string;
  is_rainout?: boolean | number;
  invite_only?: boolean | number;
  [key: string]: any;
}

interface PBFApiRequestOptions {
  noStore?: boolean;
  throwOnError?: boolean;
  errorMsg?: string;
  headers?: Record<string, string>;
  invalidateKeys?: string[];
  invalidateOnSuccess?: boolean;
  [key: string]: any;
}

interface PBFDialogAlertOptions {
  title?: string;
  confirmLabel?: string;
  okLabel?: string;
  danger?: boolean;
  [key: string]: any;
}

interface PBFDialogFormField {
  name: string;
  label?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  [key: string]: any;
}

interface PBFDialogFormOptions extends PBFDialogAlertOptions {
  cancelLabel?: string;
  checkboxLabel?: string;
  defaultChecked?: boolean;
  defaultValue?: string;
  placeholder?: string;
  fields?: PBFDialogFormField[];
}

interface PBFDialogFacade {
  toast(message: string, typeOrOptions?: string | Record<string, any>): void;
  alert(message: string, options?: PBFDialogAlertOptions): Promise<void>;
  confirm(message: string, options?: PBFDialogFormOptions): Promise<boolean>;
  confirmWithCheckbox(
    message: string,
    options?: PBFDialogFormOptions
  ): Promise<{ confirmed: boolean; checked: boolean }>;
  prompt(message: string, options?: PBFDialogFormOptions): Promise<string | null>;
  form(
    titleOrMessage: string,
    fieldsOrOptions: PBFDialogFormField[] | PBFDialogFormOptions,
    options?: PBFDialogFormOptions
  ): Promise<Record<string, any> | null>;
}

interface PBFAPIError extends Error {
  status?: number;
  data?: any;
  code?: string;
  requestId?: string;
}

interface PBFApiFacade {
  CLIENT_VERSION: string;
  currentUser?: PBFUser | null;
  SUPPORTED_LANGUAGES: Array<{ code: string; label: string; dir?: string; [key: string]: any }>;
  COLOR_THEMES: Array<{ id: string; label: string; [key: string]: any }>;
  i18nCache: Record<string, Record<string, string>>;
  getLang(): string;
  getLangMeta(code?: string): Record<string, any>;
  t(key: string, fallbackOrVars?: string | Record<string, any>, maybeVars?: Record<string, any>): string;
  translatePhrase(text: string): string;
  translateEventTitle(ev: PBFEvent | Record<string, any>): string;
  loadLangDict(lang: string): Promise<Record<string, string>>;
  setLang(lang: string): Promise<void>;
  applyTranslations(root?: Document | Element): void;
  initI18n(): Promise<void>;
  getThemeMode(): string;
  getEffectiveTheme(): string;
  getTheme(): string;
  getColorTheme(): string;
  updateThemeColorMeta(): void;
  applyColorTheme(colorThemeId: string): void;
  setColorTheme(themeId: string): void;
  applyTheme(theme: string): void;
  setThemeMode(mode: string): void;
  _dispatchThemeChange(): void;
  toggleTheme(): void;
  initTheme(): void;
  updateThemePickersUi(rootEl?: Element | Document): void;
  populateThemePicker(containerEl: Element): void;
  updateFooterThemeUi(): void;
  renderFooter(): void;
  initFooterThemePicker(): void;
  checkResponseVersion(res: Response): void;
  checkForUpdates(): Promise<void>;
  initAppUpdater(): void;
  setUpdateAvailableUi(btn: HTMLElement | null, statusEl: HTMLElement | null, newVersion: string): void;
  triggerAppUpdate(btn: HTMLElement | null, statusEl: HTMLElement | null, waitingWorker?: ServiceWorker | null): Promise<void>;
  getCachedUser(): PBFUser | null;
  setCachedUser(user: PBFUser | null): void;
  clearClubhouseIndexedDb(): Promise<void>;
  clearDataCaches(skipIndexedDb?: boolean): Promise<void>;
  recordDiagnostic(entry: Record<string, any>): void;
  request(method: string, url: string, body?: any, opts?: PBFApiRequestOptions): Promise<any>;
  getPublicConfig(forceRefresh?: boolean): Promise<Record<string, any>>;
  isFeatureEnabled(flagKey: string, configOverride?: Record<string, any> | null): boolean;
  getMe(): Promise<PBFUser | null>;
  regenerateCalendarToken(): Promise<any>;
  logout(): Promise<void>;
  getPosts(): Promise<any>;
  createPost(payload: Record<string, any>): Promise<any>;
  deletePost(id: number | string): Promise<any>;
  getMedia(params?: Record<string, any>): Promise<any>;
  submitMedia(payload: Record<string, any>): Promise<any>;
  approveMedia(id: number | string): Promise<any>;
  updateMedia(id: number | string, payload: Record<string, any>): Promise<any>;
  deleteMedia(id: number | string, token?: string): Promise<any>;
  getEvents(filter?: string): Promise<any>;
  getEvent(id: number | string, token?: string): Promise<any>;
  postRsvp(id: number | string, payload: Record<string, any>): Promise<any>;
  postComment(id: number | string, payload: Record<string, any>): Promise<any>;
  deleteComment(eventId: number | string, commentId: number | string): Promise<any>;
  removeAttendee(eventId: number | string, attendeeId: number | string): Promise<any>;
  callRainout(id: number | string, payload?: Record<string, any>): Promise<any>;
  reopenEvent(id: number | string, payload?: Record<string, any>): Promise<any>;
  sendRainoutEmail(id: number | string, payload?: Record<string, any>): Promise<any>;
  sendReminders(id: number | string): Promise<any>;
  getBpOrder(eventId: number | string, token?: string): Promise<any>;
  postBpSignup(eventId: number | string, payload: Record<string, any>): Promise<any>;
  updateBpSignup(eventId: number | string, signupId: number | string, payload: Record<string, any>): Promise<any>;
  deleteBpSignup(eventId: number | string, signupId: number | string, payload?: Record<string, any>): Promise<any>;
  clearBpOrder(eventId: number | string): Promise<any>;
  sendLoginCode(email: string, name?: string, sharedDevice?: boolean): Promise<any>;
  verifyLoginCode(email: string, code: string, sharedDevice?: boolean): Promise<any>;
  getActiveSessions(): Promise<any>;
  logoutOtherDevices(): Promise<any>;
  updateProfile(name: string, bio?: string, extra?: Record<string, any>): Promise<any>;
  getConsent(): Promise<any>;
  updateConsent(payload: Record<string, any>): Promise<any>;
  setClubhouseOptIn(optedIn: boolean): Promise<any>;
  uploadAvatar(file: File | Blob): Promise<any>;
  deleteAvatar(): Promise<any>;
  getDefaultDuties(): Promise<any>;
  saveDefaultDuties(duties: any[]): Promise<any>;
  createEvent(payload: Record<string, any>): Promise<any>;
  updateEvent(id: number | string, payload: Record<string, any>): Promise<any>;
  deleteEvent(id: number | string): Promise<any>;
  addDuty(eventId: number | string, payload: Record<string, any>): Promise<any>;
  updateDuty(eventId: number | string, dutyId: number | string, payload: Record<string, any>): Promise<any>;
  deleteDuty(eventId: number | string, dutyId: number | string): Promise<any>;
  getAttendeeCandidates(): Promise<any>;
  getUsers(): Promise<any>;
  updateUserRole(userId: number | string, role: string): Promise<any>;
  updateUserBadges(userId: number | string, badges: any): Promise<any>;
  updateUserModerator(userId: number | string, isModerator: boolean): Promise<any>;
  muteUserModeration(userId: number | string, muted: boolean, reason?: string): Promise<any>;
  getWaiverStatus(): Promise<any>;
  signWaiver(payload: Record<string, any>): Promise<any>;
  updateUserWaiverStatus(userId: number | string, waiverStatus: string): Promise<any>;
  deleteUser(userId: number | string, ban?: boolean, reason?: string): Promise<any>;
  getBannedEmails(): Promise<any>;
  banEmail(email: string, reason?: string): Promise<any>;
  unbanEmail(id: number | string): Promise<any>;
  getSettings(): Promise<any>;
  updateSettings(settings: Record<string, any>): Promise<any>;
  testAppscript(url: string): Promise<any>;
  renderEditGameFieldsHtml(prefix: string, ev?: PBFEvent | Record<string, any>): string;
  bindEditGameCapToggle(prefix: string): void;
  readEditGameFields(prefix: string): Record<string, any>;
  formatDate(isoString: string): string;
  formatDateTime(isoString: string): string;
  isoToPacificLocalInput(isoString: string): { date: string; time: string } | string;
  localToPacificIso(dateString: string, timeString?: string): string;
  getNextSundayNoonPacificIso(): string;
  getGoogleCalendarUrl(ev: PBFEvent | Record<string, any>): string;
  downloadEventsIcs(events: Array<PBFEvent | Record<string, any>>, filename?: string): void;
  renderSubscribePanel(panelEl: Element | null, options?: Record<string, any>): void;
  renderNav(user?: PBFUser | null): void;
  initNavDropdown(): void;
  formatDisplayName(rawName: string, fallback?: string): string;
  formatDisplayNameList(rawList: string | string[]): string;
  abbreviateDisplayNames(records: Array<Record<string, any>>, nameProp?: string, idProp?: string, fallback?: string): any[];
  isMemberRole(role: any): boolean;
  escapeHtml(str: any): string;
  parseMediaType(url: string, explicitType?: string): string;
  getYouTubeId(url: string): string | null;
  getYouTubeEmbedUrl(url: string): string | null;
  getGoogleDriveId(url: string): string | null;
  getGoogleDriveEmbedUrl(url: string): string | null;
  safeUrl(rawUrl: string): string;
  safeAvatarUrl(rawUrl: string): string;
  icon(name: string, size?: number): string;
  renderCookieNotice(): void;
}

interface WeatherServiceFacade {
  HEURISTIC_CONFIG: Record<string, any>;
  extractCoordinates(text: string): { lat: number; lon: number } | null;
  getCoordsForLocation(location: string): { lat: number; lon: number; name?: string };
  resolveCoordsForLocation(location: string): Promise<{ lat: number; lon: number; name?: string }>;
  getWeatherCodeInfo(code: number): { label: string; emoji: string; [key: string]: any };
  getPacificDateParts(dateInput?: Date | string | number): Record<string, any>;
  getPacificTodayDateKey(): string;
  fetchForecast(lat: number, lon: number): Promise<any>;
  calculateFieldDrainage(hourlyData: any, targetIso: string): Record<string, any>;
  buildDailyForecast(dailyData: any): any[];
  renderDailyRainTrackHtml(days: any[]): string;
  renderMiniDailyRainRowHtml(days: any[]): string;
  getForecastForGame(isoDate: string, location?: string): Promise<Record<string, any>>;
  renderAssistantWidget(containerEl: Element | null, isoDate: string, location?: string, options?: Record<string, any>): Promise<void>;
  populateCardWeatherBadges(): void;
}

interface ClubhouseCryptoFacade {
  clearMemoryKeys(): void;
  setPinOwner(userId: number): void;
  stripJpegMetadata(buffer: ArrayBuffer): any;
  arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string;
  base64ToUint8Array(base64: string): Uint8Array;
  generateIdentityKeyPair(): Promise<Record<string, any>>;
  deriveVaultKeyFromPassphrase(passphrase: string, saltBase64: string): Promise<CryptoKey>;
  encryptVault(vaultObj: any, passphrase: string): Promise<Record<string, any>>;
  decryptVault(vaultPayload: Record<string, any>, passphrase: string): Promise<any>;
  generateChannelKey(): Promise<CryptoKey>;
  deriveEcdhSharedKey(privateKey: CryptoKey, publicKeyJwk: JsonWebKey): Promise<CryptoKey>;
  wrapChannelKey(channelKey: CryptoKey, wrappingKey: CryptoKey): Promise<any>;
  unwrapChannelKey(wrappedBase64: string, wrappingKey: CryptoKey, wrapIv?: string, extractable?: boolean): Promise<CryptoKey>;
  encryptPayload(key: CryptoKey, plaintext: string): Promise<any>;
  decryptPayload(key: CryptoKey, ciphertext: string, iv?: string): Promise<string>;
  encryptBinaryBuffer(key: CryptoKey, buffer: ArrayBuffer): Promise<any>;
  decryptBinaryBuffer(key: CryptoKey, buffer: ArrayBuffer, iv?: string): Promise<ArrayBuffer>;
  enrollIdentityWithPassphrase(passphrase: string): Promise<Record<string, any>>;
  restoreIdentityFromServerVault(vaultRecord: Record<string, any>, passphrase: string): Promise<Record<string, any>>;
  hasLocalIdentityKeys(): Promise<boolean>;
  getStoredIdentityKeys(): Promise<Record<string, any> | null>;
  toNonExtractableAesKey(rawOrJwk: any): Promise<CryptoKey>;
  computeKeyFingerprint(publicKeyJwk: JsonWebKey): Promise<string>;
  computeSafetyNumber(userIdA: number | JsonWebKey, jwkA: JsonWebKey, userIdB?: number, jwkB?: JsonWebKey): Promise<string>;
  getPeerVerificationState(peerUserId: number, currentFingerprint: string): Promise<Record<string, any>>;
  markPeerFingerprintVerified(peerUserId: number, fingerprint: string): Promise<Record<string, any>>;
  clearPeerVerificationPin?(peerUserId: number): Promise<void>;
  idbGet(key: string): Promise<any>;
  idbPut(key: string, value: any): Promise<void>;
  idbDelete?(key: string): Promise<void>;
  idbDeleteByPrefix?(prefix: string): Promise<void>;
}

interface ClubhouseStoreFacade {
  DB_NAME: string;
  DB_VERSION: number;
  VISIBLE_ACTIVE_SYNC_MS: number;
  VISIBLE_IDLE_SYNC_MS: number;
  HIDDEN_SYNC_MS: number;
  SYNC_ACTIVE_MS: number;
  SYNC_IDLE_MS: number;
  SYNC_DEEP_IDLE_MS: number;
  SYNC_VOICE_HIDDEN_MS: number;
  ACTIVE_CHAT_WINDOW_MS: number;
  DEEP_IDLE_WINDOW_MS: number;
  CHUNK_SIZE_BYTES: number;
  state: Record<string, any>;
  subscribe(listener: (eventName: string, payload?: any, state?: any) => void): () => void;
  emit(eventType: string, detail?: any): void;
  notify(eventType: string, detail?: any): void;
  apiRequest(method: string, url: string, body?: any, opts?: Record<string, any>): Promise<any>;
  createStoreHttpError(res: any, fallbackMsg?: string): PBFAPIError;
  normalizeIdList(list: any): number[];
  idListsEqual(a: any[], b: any[]): boolean;
  findChannelById(channelId: number | string): any;
  findMessageChannelId(messageId: number | string): number | null;
  upsertMessageInState(msg: any): void;
  closeStoreDbHandle(): void;
  broadcastClearSignal(): void;
  openStoreDb(): Promise<any>;
  saveChannelsToIdb(channels: any[]): Promise<void>;
  clearCryptoIdb(): Promise<void>;
  clearStoreIdb(storeNames?: string[]): Promise<void>;
  deleteChannelFromIdb(channelId: number | string): Promise<void>;
  getMetaFromIdb(key: string): Promise<any>;
  setMetaInIdb(key: string, value: any): Promise<void>;
  saveMessagesToIdb(messages: any[]): Promise<void>;
  loadCachedChannelsFromIdb(): Promise<any[]>;
  evictErasedUserMessagesFromIdb(erasedUserId: number | string): Promise<void>;
  clearLocalSessionData(): Promise<void>;
  loadPublicGuestChannels(): Promise<any[]>;
  bootstrap(): Promise<any>;
  fetchChannelMessages(channelId: number | string, opts?: Record<string, any>): Promise<any>;
  markChannelRead(channelId: number | string, lastMessageId?: number): Promise<any>;
  sendMessage(channelId: number | string, bodyOrOpts?: any, opts?: Record<string, any>): Promise<any>;
  createChannel(payload: Record<string, any>): Promise<any>;
  updateChannel(channelId: number | string, payload: Record<string, any>): Promise<any>;
  deleteChannel(channelId: number | string): Promise<any>;
  hideDmChannel(channelId: number | string): Promise<any>;
  unhideDmChannel(channelId: number | string): Promise<any>;
  setClubhouseOptIn(optedIn: boolean): Promise<any>;
  editMessage(messageId: number | string, body: string, channelId?: number | string): Promise<any>;
  deleteMessage(messageId: number | string): Promise<any>;
  hideMessage(messageId: number | string, reason?: string): Promise<any>;
  unhideMessage(messageId: number | string): Promise<any>;
  toggleReaction(messageId: number | string, emoji: string): Promise<any>;
  submitReport(payload: Record<string, any>): Promise<any>;
  fetchModerationReports(status?: string): Promise<any>;
  resolveReport(reportId: number | string, action?: string, resolutionNote?: string): Promise<any>;
  fetchModerationUsers(): Promise<any>;
  setUserGlobalMute(userId: number | string, muted: boolean, reason?: string): Promise<any>;
  setUserModerator(userId: number | string, isModerator: boolean): Promise<any>;
  muteUserPersonal(userId: number | string, reason?: string): Promise<any>;
  unmuteUserPersonal(userId: number | string): Promise<any>;
  isUserMutedByMe(userId: number | string): boolean;
  fetchBlockedPeers(): Promise<any>;
  blockPeer(userId: number | string): Promise<any>;
  unblockPeer(userId: number | string): Promise<any>;
  isPeerBlockedByMe(userId: number | string): boolean;
  maybeOptimizeChatImage(file: any, rawBuf: ArrayBuffer): Promise<{ buffer: ArrayBuffer; mimeType: string; fileName: string }>;
  uploadAttachment(channelId: number | string, file: File | Blob, opts?: any): Promise<any>;
  uploadChunksToGDrive(uploadUrl: string, arrayBuffer: ArrayBuffer, mimeType: string, progressCb: (pct: number, msg: string) => void): Promise<any>;
  getDmE2eeStatus(channelId: number | string): Promise<Record<string, any>> | Record<string, any>;
  ensureChannelE2eeKey(channelId: number | string, options?: Record<string, any>): Promise<any>;
  ensureDmChannelKey(channelId: number | string, options?: Record<string, any>): Promise<any>;
  getActiveChannelEpoch(channelId: number | string): number;
  createE2eeError(code: string, msg: string, extra?: Record<string, any>): any;
  parseJwkSafe(raw: any): any;
  getChannelParticipantIds(ch: any): number[];
  memberSetsEqual(aList: any[], bList: any[]): boolean;
  fetchAndUnwrapChannelShare(channelId: number | string, requestedEpoch: number, idKeys: any, exactEpoch?: boolean): Promise<any>;
  publishRotatedChannelKey(chNum: number, epoch: number, participantIds: number[], idKeys: any, forceRotate?: boolean): Promise<any>;
  verifyCachedDmPeersTofu(chObj: any): Promise<void>;
  getChannelVerificationInfo(channelId: number | string): Promise<any>;
  verifyPeerIdentityKey(peerUserId: number | string, fingerprint: string): Promise<any>;
  isServerSystemNotice(msg: any): boolean;
  maybeDecryptMessage(msg: any): Promise<any>;
  decryptMessageList(messages: any[]): Promise<any[]>;
  decryptAttachmentToBlobUrl(attachment: Record<string, any>, channelId?: number | string): Promise<string | null>;
  redecryptChannelMessages(channelId?: number | string): Promise<any>;
  clearCachedDmKeys(): void;
  invalidateChannelVerifiedEpoch(channelId: number | string): void;
  evictChannelDmKeyCache(channelId: number | string): void;
  revokeAttachmentBlobUrl(attachmentId: number | string): void;
  isDmChannel(channel: Record<string, any> | null | undefined): boolean;
  isPrivateBoardChannel(channel: Record<string, any> | null | undefined): boolean;
  requiresE2eeChannel(channel: Record<string, any> | null | undefined): boolean;
  pollDeltaSync(): Promise<any>;
  applySyncEventToState(ev: any): any;
  evictErasedUserState(erasedUid: number | string, payload?: any): Promise<void>;
  markChatActivity(): void;
  isChatRecentlyActive(): boolean;
  getSteppedSyncDelay(): number;
  scheduleNextSyncTick(): void;
  onUserActivity(): void;
  startAdaptiveSyncLoop(): void;
  stopAdaptiveSyncLoop(): void;
  [key: string]: any;
}

interface ClubhouseRTCFacade {
  state: Record<string, any>;
  onRtcEvent(listener: (eventName: string, payload?: any) => void): () => void;
  setTurnConfigured(configured: boolean): boolean;
  isTurnConfigured(): boolean;
  setIceServers(servers: any[]): any[];
  loadIceServers(): Promise<{ turnConfigured: boolean; iceServers: any[] }>;
  getIceConfiguration(privacyRelayMode?: boolean): RTCConfiguration;
  joinVoiceChannel(channelId: number | string, currentUserId?: number): Promise<any>;
  updateVoiceState(patch: Record<string, any>): Promise<any>;
  toggleScreenShare(): Promise<any>;
  leaveVoiceChannel(): Promise<void>;
  handleIncomingSignals(signals: any[]): Promise<void>;
  broadcastTypingIndicator(channelId: number, userName?: string): void;
}

interface ArtStudioFacade {
  setUser(user: PBFUser | null): void;
  getIsAdmin(): boolean;
  getIsChalkboardFrozen(): boolean;
  initPixelDiamond(): void;
  initEquipmentTrunk(): void;
  initDugoutChalkboard(): void;
}

declare const API: PBFApiFacade;
declare const PBFDialog: PBFDialogFacade;
declare const WeatherService: WeatherServiceFacade;
declare const ClubhouseCrypto: ClubhouseCryptoFacade;
declare const ClubhouseStore: ClubhouseStoreFacade;
declare const ClubhouseRTC: ClubhouseRTCFacade;
declare const ArtStudio: ArtStudioFacade;

interface Window {
  API: PBFApiFacade;
  PBFDialog: PBFDialogFacade;
  WeatherService: WeatherServiceFacade;
  ClubhouseCrypto: ClubhouseCryptoFacade;
  ClubhouseStore: ClubhouseStoreFacade;
  ClubhouseRTC: ClubhouseRTCFacade;
  ArtStudio: ArtStudioFacade;
  deferredPwaPrompt?: any;
}
