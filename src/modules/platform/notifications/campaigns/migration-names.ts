// The file names of feature 23's migrations (notification center, L3): one constant, so a renumber at merge is a one-line change.

/**
 * The generated migration of the notification center (tables `notification_campaigns`, `notification_inbox`, `notifications.campaign_id`).
 *
 * Why: L3: every feature generates `0020_*` and the lead renumbers at merge; specs read the name from here.
 */
export const NOTIFICATION_CENTER_MIGRATION = '0026_notification_center';
