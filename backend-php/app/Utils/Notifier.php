<?php

declare(strict_types=1);

namespace TheTeam\Utils;

use TheTeam\Log;

/**
 * Sends notifications.
 *
 * A partial port. The full notifier - the custom HTTP provider, the SSRF guard,
 * per-channel credential resolution - ports with the notifications group. What is
 * here is the part every other controller depends on: dispatching one message on
 * one channel and finding out what happened.
 *
 * The important behaviour is the one that is easy to skip. Sending is allowed to
 * fail, and a failure must never stop the action that triggered it: a member's
 * welfare request is not refused because an SMS gateway is unreachable, and the
 * money is still recorded anyway. That is why dispatch() reports rather than
 * throws, and why callers check the result for display but never for control
 * flow.
 *
 * The return shape matches the Node version's dispatch(), which resolves with
 * {success, skipped, reason}: callers such as the password reset tell the user
 * when a code did not arrive, which is otherwise indistinguishable from somebody
 * who simply never received it.
 */
final class Notifier
{
    /**
     * Sends one message.
     *
     * @return array{success:bool, skipped?:bool, reason?:string, error?:string}
     */
    public static function dispatch(string $channel, string $to, string $message): array
    {
        if (trim($to) === '' || trim($message) === '') {
            // Nothing worth sending to. Not an error: a member with no phone on
            // file is common, and warning about it would fill the log with noise
            // that hides real problems.
            return ['success' => false, 'skipped' => true, 'reason' => 'No contact address on file.'];
        }

        try {
            return self::send($channel, $to, $message);
        } catch (\Throwable $e) {
            // Swallowed deliberately. The caller already has their response, and
            // a notification failure is not the user's problem to solve at that
            // moment.
            Log::warn(sprintf(
                '[notifier] %s to %s failed: %s',
                $channel,
                self::maskPhone($to),
                $e->getMessage()
            ));

            return ['success' => false, 'error' => $e->getMessage()];
        }
    }

    /**
     * Sends one message, without the failure handling.
     *
     * @return array{success:bool, skipped?:bool, reason?:string}
     */
    public static function send(string $channel, string $to, string $message): array
    {
        // A channel that is switched off is reported as skipped rather than
        // failed. The difference matters to a caller deciding whether to warn
        // anybody: nothing went wrong, the group chose not to use this channel.
        if (!Settings::getBool('channel_' . $channel . '_enabled', false)) {
            return [
                'success' => false,
                'skipped' => true,
                'reason' => self::label($channel) . ' is switched off in Settings',
            ];
        }

        // Provider credentials are not ported yet. Reported honestly rather than
        // silently succeeding, so a code that was never sent cannot be mistaken
        // for one that was.
        return [
            'success' => false,
            'skipped' => true,
            'reason' => self::label($channel) . ' has no provider configured yet',
        ];
    }

    /** A phone number with its middle digits hidden, for logs. */
    private static function maskPhone(string $phone): string
    {
        $digits = preg_replace('/\D/', '', $phone) ?? '';

        if (strlen($digits) < 6) {
            return '***';
        }

        return substr($digits, 0, 4) . str_repeat('*', strlen($digits) - 7)
            . substr($digits, -3);
    }

    private static function label(string $channel): string
    {
        return match ($channel) {
            'sms' => 'SMS',
            'whatsapp' => 'WhatsApp',
            'email' => 'Email',
            default => ucfirst($channel),
        };
    }
}