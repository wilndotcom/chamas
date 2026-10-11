<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Utils\Notifier;
use TheTeam\Utils\Phone;
use TheTeam\Utils\RiskMembers;
use TheTeam\Utils\Settings;
use TheTeam\Utils\Templates;

/**
 * Notifications: the outbox, sending, reminders and channel configuration.
 *
 * A port of backend/controllers/notificationController.js.
 *
 * Sending itself is not implemented - the provider calls port with the real SMS
 * integration. What is here is everything around it: the outbox, the templates,
 * the reminder fan-out, and the channel status that tells an operator whether
 * their credentials are actually in use.
 *
 * That last part is the valuable one. A credential can be saved, look correct,
 * and still be ignored; the status is computed the same way the dispatcher
 * computes it rather than inferred from whether fields are filled in.
 */
final class NotificationController
{
    /** Channels that can carry a message. */
    private const CHANNELS = ['sms', 'whatsapp', 'email', 'in_app'];

    /** The outbox, newest first. */
    public static function getAllNotifications(Request $r): void
    {
        try {
            $notifications = Database::all(
                <<<'SQL'
                    SELECT n.*, m.full_name AS member_name
                      FROM notifications n
                      LEFT JOIN members m ON n.member_id = m.id
                     ORDER BY n.created_at DESC LIMIT 200
                    SQL
            );

            Response::json(['notifications' => $notifications]);
        } catch (\Throwable $e) {
            Log::warn('getAllNotifications: ' . $e->getMessage());
            Response::error('Failed to fetch notifications.', 500);
        }
    }

    /** One member's own messages. */
    public static function getMemberNotifications(Request $r): void
    {
        try {
            $notifications = Database::all(
                'SELECT * FROM notifications WHERE member_id = ? ORDER BY created_at DESC LIMIT 100',
                [$r->user['id']]
            );

            Response::json(['notifications' => $notifications]);
        } catch (\Throwable $e) {
            Log::warn('getMemberNotifications: ' . $e->getMessage());
            Response::error('Failed to fetch your notifications.', 500);
        }
    }

    /** Sends one message to one member and records it. */
    public static function sendNotification(Request $r): void
    {
        try {
            $body = $r->body();

            $channels = self::resolveChannels($body['channels'] ?? ['sms']);
            $message = trim((string) ($body['message'] ?? ''));

            if ($message === '') {
                Response::error('Enter a message.', 400);
            }

            $memberId = $body['member_id'] ?? null;

            if (!$memberId) {
                // Group-wide: every active member with a contact address.
                $members = Database::all(
                    "SELECT id, full_name, phone, email FROM members WHERE status = 'active'"
                );
            } else {
                $members = Database::all(
                    'SELECT id, full_name, phone, email FROM members WHERE id = ?',
                    [$memberId]
                );

                if ($members === []) {
                    Response::error('Member not found.', 404);
                }
            }

            $sent = self::fanOut($members, $channels, $message, $body['subject'] ?? null);

            Response::json([
                'success' => true,
                'sent' => $sent['sent'],
                'failed' => $sent['failed'],
                'skipped' => $sent['skipped'],
                'recipients' => $sent['recipients'],
            ], 201);
        } catch (\Throwable $e) {
            Log::warn('sendNotification: ' . $e->getMessage());
            Response::error('Failed to send the notification.', 500);
        }
    }

    /** Sends one message to several named members. */
    public static function sendBulkNotification(Request $r): void
    {
        try {
            $body = $r->body();

            $channels = self::resolveChannels($body['channels'] ?? ['sms']);
            $message = trim((string) ($body['message'] ?? ''));
            $ids = $body['member_ids'] ?? [];

            if ($message === '') {
                Response::error('Enter a message.', 400);
            }

            if (!is_array($ids) || $ids === []) {
                Response::error('Choose at least one member.', 400);
            }

            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $members = Database::all(
                "SELECT id, full_name, phone, email FROM members WHERE id IN ({$placeholders})",
                $ids
            );

            $sent = self::fanOut($members, $channels, $message, $body['subject'] ?? null);

            Response::json([
                'success' => true,
                'sent' => $sent['sent'],
                'failed' => $sent['failed'],
                'skipped' => $sent['skipped'],
                'recipients' => $sent['recipients'],
            ], 201);
        } catch (\Throwable $e) {
            Log::warn('sendBulkNotification: ' . $e->getMessage());
            Response::error('Failed to send the notification.', 500);
        }
    }

    /** Chases everybody the risk report says is behind. */
    public static function sendReminders(Request $r): void
    {
        try {
            $body = $r->body();
            $channels = self::resolveChannels($body['channels'] ?? ['sms']);

            $risk = RiskMembers::find();
            $chamaName = Settings::get('chama_name', 'THE TEAM');

            $requested = $body['member_ids'] ?? null;

            $targets = $risk['members'];

            if (is_array($requested) && $requested !== []) {
                $targets = array_values(array_filter(
                    $targets,
                    static fn(array $m) => in_array((string) $m['member_id'], array_map('strval', $requested), true)
                ));
            } elseif (array_key_exists('include_loans', $body) && $body['include_loans'] === false) {
                // Contribution-only sweep, ignoring loan problems.
                $targets = array_values(array_filter(
                    $targets,
                    static fn(array $m) => $m['reason'] !== 'overdue_loan'
                        && $m['reason'] !== 'defaulted_loan'
                ));
            }

            if ($targets === []) {
                Response::json([
                    'success' => true,
                    'sent' => 0,
                    'message' => 'Nobody is currently behind, so there was nobody to remind.',
                ]);
            }

            $sent = 0;
            $failed = 0;
            $skipped = 0;

            foreach ($targets as $target) {
                $text = self::reminderText($target, $risk['monthlyAmount'], $chamaName);

                $outcome = self::deliver($channels, $target['phone'] ?? '', $target['email'] ?? '', $text);

                $sent += $outcome['sent'];
                $failed += $outcome['failed'];
                $skipped += $outcome['skipped'];
            }

            Response::json([
                'success' => true,
                'sent' => $sent,
                'failed' => $failed,
                'skipped' => $skipped,
                'recipients' => count($targets),
            ]);
        } catch (\Throwable $e) {
            Log::warn('sendReminders: ' . $e->getMessage());
            Response::error('Failed to send reminders.', 500);
        }
    }

    /**
     * Template metadata plus the placeholder list, for the Settings editor.
     *
     * Reads the stored bodies from settings where they exist, so the editor shows
     * what the group has actually customised rather than the built-in default.
     */
    public static function getTemplateInfo(Request $r): void
    {
        try {
            $stored = [];

            foreach (Database::all(
                "SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'tpl_%'"
            ) as $row) {
                $stored[$row['setting_key']] = $row['setting_value'];
            }

            Response::json([
                'placeholders' => Templates::PLACEHOLDERS,
                'sample' => Templates::SAMPLE_DATA,
                'templates' => array_map(
                    static fn(array $t) => [
                        'key' => $t['key'],
                        'label' => $t['label'],
                        'description' => $t['description'],

                        // The stored body where one exists, otherwise the default.
                        'body' => $stored[$t['key']] ?? $t['default'],

                        // Whether it has been customised, so the editor can say
                        // "reset to default" only where that would mean something.
                        'is_default' => !isset($stored[$t['key']]),
                    ],
                    Templates::TEMPLATES
                ),
            ]);
        } catch (\Throwable $e) {
            Log::warn('getTemplateInfo: ' . $e->getMessage());
            Response::error('Failed to load the templates.', 500);
        }
    }

    /**
     * Renders a template, and sends it only when explicitly asked.
     *
     * A dry run by default: previewing must never put a test message into a real
     * member's history. Sending needs dry_run false and a recipient.
     */
    public static function testTemplate(Request $r): void
    {
        try {
            $body = $r->body();
            $key = (string) ($body['template'] ?? '');

            $definition = null;
            foreach (Templates::TEMPLATES as $template) {
                if ($template['key'] === $key) {
                    $definition = $template;
                    break;
                }
            }

            if ($definition === null) {
                Response::error('Choose a template.', 400);
            }

            $channel = strtolower((string) ($body['channel'] ?? 'sms'));

            if (!in_array($channel, ['sms', 'whatsapp', 'email', 'in_app'], true)) {
                Response::error('Channel must be one of: sms, whatsapp, email, in_app', 400);
            }

            $stored = Database::scalar(
                'SELECT setting_value FROM settings WHERE setting_key = ?',
                [$key]
            );

            $raw = ($stored !== null && trim((string) $stored) !== '')
                ? (string) $stored
                : $definition['default'];

            $rendered = Templates::render($raw, Templates::SAMPLE_DATA);
            $unknown = Templates::unknownTokens($raw);

            $response = [
                'template_key' => $key,
                'label' => $definition['label'],
                'channel' => $channel,
                'raw' => $raw,
                'rendered' => $rendered,

                // Reported so an unsubstituted placeholder is caught here rather
                // than by a member reading "{{monthly_contribtion}}".
                'unknown_placeholders' => $unknown,
            ];

            if (($body['dry_run'] ?? true) !== false) {
                Response::json(array_merge($response, ['dry_run' => true]));
            }

            $to = trim((string) ($body['to'] ?? ''));

            if ($to === '' && $channel !== 'in_app') {
                Response::error('A phone number is required to send a test.', 400);
            }

            $outcome = $channel === 'in_app'
                ? ['success' => true]
                : Notifier::dispatch(
                    $channel,
                    $channel === 'email' ? (string) ($body['email'] ?? '') : (Phone::normalise($to) ?? $to),
                    $rendered
                );

            if ($outcome['success'] ?? false) {
                Database::run(
                    <<<'SQL'
                        INSERT INTO notifications (member_id, admin_id, type, category, subject, message, status, sent_at)
                        VALUES (NULL, ?, ?, 'general', ?, ?, 'sent', NOW())
                        SQL,
                    [$r->user['id'], $channel, $definition['label'] . ' (test)', $rendered]
                );
            }

            Response::json(array_merge($response, [
                'dry_run' => false,
                'delivery' => [
                    'success' => (bool) ($outcome['success'] ?? false),
                    'skipped' => (bool) ($outcome['skipped'] ?? false),
                    'provider' => $outcome['provider'] ?? null,
                    'detail' => $outcome['error'] ?? $outcome['reason'] ?? null,
                    'sent_to' => $to !== '' ? $to : ($body['email'] ?? null),
                ],
            ]));
        } catch (\Throwable $e) {
            Log::warn('testTemplate: ' . $e->getMessage());
            Response::error('Failed to test the template.', 500);
        }
    }

    /**
     * Which channels are usable right now, and where each credential comes from.
     *
     * Secret values are never echoed: only whether one is present and which store
     * it came from, because "saved here" versus "still falling back to .env" is
     * the distinction an operator actually needs.
     */
    public static function getChannelStatus(Request $r): void
    {
        try {
            $channels = [];

            foreach (['sms', 'whatsapp', 'email'] as $channel) {
                $enabledKey = "channel_{$channel}_enabled";
                $enabled = Settings::getBool($enabledKey, false);

                $requirements = self::requirementsFor($channel);
                $present = [];
                $missingKeys = [];

                foreach (array_keys($requirements) as $key) {
                    // Trimmed and compared as a string: a stored "0" or a
                    // whitespace-only value is not a credential, and treating it
                    // as one is how a channel reports itself configured while
                    // every send fails.
                    if (trim((string) Settings::get($key)) !== '') {
                        $present[] = $key;
                    } else {
                        $missingKeys[] = $key;
                    }
                }

                $channels[$channel] = [
                    'enabled' => $enabled,
                    'provider' => $channel === 'email'
                        ? 'smtp'
                        : (Settings::get($channel . '_provider') ?: 'none'),

                    // Whether a usable credential set is present, and whether a
                    // message would actually go out. Two different questions: a
                    // channel can be switched on with no key behind it, which is
                    // the exact state that made the old key field unusable.
                    'configured' => $missing === [],
                    'sends' => $enabled && $missing === [],

                    // Named as keys, not labels, so a client can point at the
                    // specific field that needs filling in.
                    'missing' => $missingKeys,
                    'present' => array_keys($present),
                ];
            }

            Response::json([
                'channels' => $channels,

                // Where each credential is coming from. Reported per key so a
                // half-configured channel shows which half is missing rather than
                // a flat "not configured". Secret values are never echoed - only
                // whether one is present and which store it came from.
                'source' => array_map(
                    static fn(string $key) => trim((string) Settings::get($key)) !== ''
                        ? 'settings'
                        : 'unset',
                    array_merge(
                        array_keys(self::requirementsFor('sms')),
                        array_keys(self::requirementsFor('whatsapp')),
                        array_keys(self::requirementsFor('email')),
                    )
                ),

                'provider' => [
                    'sms' => Settings::get('sms_provider'),
                    'whatsapp' => Settings::get('whatsapp_provider'),
                    'email' => 'smtp',
                ],

                // Non-secret values the screen can display to confirm what is in
                // use.
                'effective' => [
                    'sms_sender_id' => Settings::get('sms_sender_id') ?: null,
                    'twilio_sms_from' => Settings::get('twilio_sms_from') ?: null,
                    'twilio_whatsapp_number' => Settings::get('twilio_whatsapp_number') ?: null,
                    'email_from' => Settings::get('email_from') ?: null,
                    'email_host' => Settings::get('email_host') ?: null,
                    'email_port' => Settings::get('email_port') ?: null,
                ],
            ]);
        } catch (\Throwable $e) {
            Log::warn('getChannelStatus: ' . $e->getMessage());
            Response::error('Failed to read the notification channel settings.', 500);
        }
    }

    /**
     * Sends one real message to one number, to check credentials before they are
     * relied on for a reminder to the whole group.
     *
     * Deliberately not routed through sendNotification: that writes a notification
     * row against a member and sends to a member's number, so testing credentials
     * would put a bogus message into a member's history. This records nothing.
     */
    public static function testChannel(Request $r): void
    {
        try {
            $body = $r->body();
            $channel = (string) ($body['channel'] ?? '');

            if (!in_array($channel, ['sms', 'whatsapp', 'email'], true)) {
                Response::error('Choose SMS, WhatsApp or email.', 400);
            }

            $target = $channel === 'email'
                ? trim((string) ($body['email'] ?? ''))
                : trim((string) ($body['phone'] ?? ''));

            if ($target === '') {
                Response::error(
                    $channel === 'email'
                        ? 'An email address is required.'
                        : 'A phone number is required.',
                    400
                );
            }

            // Says which number it will actually reach, before sending. A
            // mistyped digit is the most likely way to "test" the wrong person
            // and then wonder why they got a message from a chama they are not in.
            $preview = $channel === 'email' ? $target : Phone::normalise($target);

            if ($channel !== 'email' && $preview === null) {
                Response::error(
                    'That does not look like a Kenyan number. Use the international form, '
                    . 'for example 254712345678.',
                    400
                );
            }

            $outcome = Notifier::dispatch(
                $channel,
                $channel === 'email' ? (string) ($body['email'] ?? '') : $preview,
                'This is a test message from THE TEAM. If you received it, '
                . $channel . ' notifications are working.'
            );

            // Nothing recorded: a test is not a notification and must not appear
            // in the history that admins read.
            Response::json([
                'success' => (bool) ($outcome['success'] ?? false),
                'skipped' => (bool) ($outcome['skipped'] ?? false),
                'provider' => $outcome['provider'] ?? null,
                'sent_to' => $preview,
                'detail' => $outcome['error'] ?? $outcome['reason'] ?? null,
            ]);
        } catch (\Throwable $e) {
            Log::warn('testChannel: ' . $e->getMessage());
            Response::error('The test message could not be sent.', 500);
        }
    }

    // -------------------------------------------------------------- helpers

    /**
     * Which of the requested channels are actually usable.
     *
     * Says which were dropped and why, rather than leaving the operator to guess
     * why a reminder that should have sent did not.
     */
    private static function resolveChannels($requested): array
    {
        $selected = is_array($requested) ? $requested : [$requested];

        $usable = array_values(array_filter(
            $selected,
            static function ($c): bool {
                if (!in_array($c, self::CHANNELS, true)) {
                    return false;
                }

                // In-app needs no provider and has no switch.
                if ($c === 'in_app') {
                    return true;
                }

                return Settings::getBool("channel_{$c}_enabled", false);
            }
        ));

        if ($usable === []) {
            $dropped = array_values(array_filter(
                $selected,
                static fn($c) => in_array($c, self::CHANNELS, true)
            ));

            Response::error(
                'No valid channels selected.',
                400,
                $dropped === []
                    ? ['hint' => 'Choose at least one channel.']
                    : ['dropped' => $dropped, 'hint' => 'Switched off in Settings: ' . implode(', ', $dropped)]
            );
        }

        return $usable;
    }

    /** Sends to many members and records each outcome. */
    private static function fanOut(array $members, array $channels, string $message, ?string $subject): array
    {
        $sent = 0;
        $failed = 0;
        $skipped = 0;
        $recipients = [];

        foreach ($members as $member) {
            $outcome = self::deliver($channels, $member['phone'] ?? '', $member['email'] ?? '', $message, $subject);

            $sent += $outcome['sent'];
            $failed += $outcome['failed'];
            $skipped += $outcome['skipped'];

            if ($outcome['sent'] > 0 || $outcome['failed'] > 0) {
                $recipients[] = $member['full_name'];
            }

            // Recorded whatever happened, including a skip. A message that was
            // never attempted is exactly what an operator chasing a missing
            // reminder needs to see.
            Database::run(
                'INSERT INTO notifications (member_id, channel, subject, message, status)
                 VALUES (?, ?, ?, ?, ?)',
                [
                    $member['id'],
                    implode(',', $channels),
                    $subject,
                    $message,
                    $outcome['sent'] > 0 ? 'sent' : ($outcome['failed'] > 0 ? 'failed' : 'skipped'),
                ]
            );
        }

        return compact('sent', 'failed', 'skipped', 'recipients');
    }

    /**
     * Delivers one message and counts the outcome.
     *
     * Never throws. A member whose phone is broken must not stop the message
     * reaching everybody else.
     */
    private static function deliver(array $channels, string $phone, string $email, string $message, ?string $subject = null): array
    {
        $sent = 0;
        $failed = 0;
        $skipped = 0;

        foreach ($channels as $channel) {
            if ($channel === 'in_app') {
                // Delivered by being written to the notifications table, which the
                // caller does. Always succeeds.
                $sent++;
                continue;
            }

            $to = $channel === 'email' ? $email : Phone::normalise($phone);

            if ($to === null || $to === '') {
                $skipped++;
                continue;
            }

            $outcome = Notifier::dispatch($channel, $to, $message);

            if ($outcome['success'] ?? false) {
                $sent++;
            } elseif ($outcome['skipped'] ?? false) {
                $skipped++;
            } else {
                $failed++;
            }
        }

        return compact('sent', 'failed', 'skipped');
    }

    /** Which settings each channel needs before it can send. */
    private static function requirementsFor(string $channel): array
    {
        return match ($channel) {
            'sms' => match (Settings::get('sms_provider')) {
                'twilio' => [
                    'twilio_account_sid' => 'Twilio Account SID',
                    'twilio_auth_token' => 'Twilio Auth Token',
                    'twilio_sms_from' => 'Twilio SMS sender',
                ],
                'custom' => [
                    'custom_sms_endpoint' => 'Custom SMS endpoint',
                    'custom_sms_auth_value' => 'Custom SMS credentials',
                ],
                default => [
                    'sms_username' => "Africa's Talking username",
                    'sms_api_key' => "Africa's Talking API key",
                    'sms_sender_id' => "Africa's Talking sender id",
                ],
            },
            'whatsapp' => [
                'twilio_account_sid' => 'Twilio Account SID',
                'twilio_auth_token' => 'Twilio Auth Token',
                'twilio_whatsapp_number' => 'Twilio WhatsApp sender',
            ],
            'email' => [
                'email_host' => 'SMTP host',
                'email_user' => 'SMTP username',
                'email_pass' => 'SMTP password',
                'email_from' => 'From address',
            ],
            default => [],
        };
    }

    /** The reminder text for one member, matching the Node version's wording. */
    private static function reminderText(array $member, float $monthlyAmount, string $chamaName): string
    {
        $name = (string) $member['full_name'];
        $amount = (float) ($member['amount'] ?? 0);

        if ($member['reason'] === 'defaulted_loan') {
            return sprintf(
                '%s: Hello %s, our records show a defaulted loan balance of KES %s. '
                . 'Please contact the office to settle it.',
                $chamaName,
                $name,
                number_format($amount, 0, '.', ',')
            );
        }

        if ($member['reason'] === 'overdue_loan') {
            return sprintf(
                '%s: Hello %s, your loan balance of KES %s was due on %s (%d days ago). '
                . 'Please arrange repayment.',
                $chamaName,
                $name,
                number_format($amount, 0, '.', ','),
                $member['loan_due_date'],
                $member['days_overdue']
            );
        }

        $months = $member['months_missed'] > 1 ? "{$member['months_missed']} months" : 'this month';
        $owed = $monthlyAmount > 0
            ? ' (KES ' . number_format($monthlyAmount, 0, '.', ',') . ')'
            : '';

        return sprintf(
            '%s: Dear %s, this is a friendly reminder that your contribution for %s%s has not '
            . 'been received. Kindly pay via M-Pesa. Thank you.',
            $chamaName,
            $name,
            $months,
            $owed
        );
    }
}