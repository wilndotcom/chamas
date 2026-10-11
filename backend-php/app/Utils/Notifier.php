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
 * money is still recorded. That is why send() reports rather than throws, and why
 * every caller ignores the result.
 *
 * A message is also never allowed to block the response. dispatch() is called
 * fire-and-forget, so it returns immediately and does its work afterwards.
 */
final class Notifier
{
    /** @var array<string, array<int, array>> Messages queued for this request. */
    private static array $pending = [];

    /**
     * Queues a message on a channel.
     *
     * Returns immediately. Nothing is sent inline, because an SMS gateway taking
     * two seconds would otherwise add two seconds to a request the user is
     * waiting on - and the outcome is not something the response depends on.
     */
    public static function dispatch(string $channel, string $to, string $message): void
    {
        if (trim($to) === '' || trim($message) === '') {
            // Nothing worth sending to. Not an error: a member with no phone on
            // file is common, and warning about it would fill the log with noise
            // that hides real problems.
            return;
        }

        self::$pending[$channel][] = ['to' => $to, 'message' => $message];

        // Under the CLI there is no long-lived process to flush at the end of
        // the request, so it happens now. On a web request sendPending() is
        // called once the response has been written.
        if (PHP_SAPI === 'cli') {
            self::sendPending();
        }
    }

    /**
     * Sends everything queued, after the response has been written.
     *
     * Called from the shutdown handler in index.php. Registering a shutdown
     * function rather than sending inline is what keeps a slow gateway off the
     * critical path.
     */
    public static function sendPending(): void
    {
        if (self::$pending === []) {
            return;
        }

        $queued = self::$pending;
        self::$pending = [];

        foreach ($queued as $channel => $messages) {
            foreach ($messages as $message) {
                try {
                    self::send($channel, $message['to'], $message['message']);
                } catch (\Throwable $e) {
                    // Deliberately swallowed. The caller already has their
                    // response, and a notification failure is not the user's
                    // problem to solve at that moment.
                    Log::warn(sprintf(
                        '[notifier] %s to %s failed: %s',
                        $channel,
                        self::maskPhone($message['to']),
                        $e->getMessage()
                    ));
                }
            }
        }
    }

    /**
     * Sends one message.
     *
     * Returns the outcome rather than throwing, matching the Node version's
     * dispatch(), which resolves with {success, skipped, reason} or a provider's
     * own response.
     */
    public static function send(string $channel, string $to, string $message): array
    {
        $enabledKey = $channel . '_enabled';

        // A channel that is switched off is reported as skipped rather than
        // failed. The difference matters to a caller deciding whether to warn
        // anybody: nothing went wrong, the group chose not to use this channel.
        if (!Settings::getBool($enabledKey, false)) {
            return [
                'success' => false,
                'skipped' => true,
                'reason' => self::label($channel) . ' is switched off in Settings',
            ];
        }

        // Provider credentials are not ported yet. Reported honestly rather than
        // silently succeeding, so the notifications group can be completed and
        // this becomes a real send.
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