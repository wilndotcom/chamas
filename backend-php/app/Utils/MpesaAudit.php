<?php

declare(strict_types=1);

namespace TheTeam\Utils;

use TheTeam\Log;

/**
 * A durable record of what Safaricom actually said.
 *
 * The app's own Log writes to the PHP error log, which under Apache is a file
 * full of notices about timezones mixed in with everything else. That is fine
 * for diagnostics and useless for the question this exists to answer: where did
 * a member's money actually go?
 *
 * So every confirmation is written here, whole, as Safaricom sent it. The
 * BusinessShortCode in the reply is the only independent evidence of which till
 * the money was charged to - the app's own setting is a claim, and Safaricom's
 * answer is the fact. When those disagree the operator needs the answer on disk,
 * not inferred from a checkout id, which Safaricom hands out for any shortcode
 * at all.
 *
 * Kept out of the request path on purpose: a callback must always answer
 * Safaricom, even if the disk is full or the file cannot be opened.
 */
final class MpesaAudit
{
    /** Where the record is kept, relative to the backend root. */
    private const FILE = 'storage/mpesa-callbacks.log';

    /**
     * Values that must never be written down.
     *
     * A callback carries a member's phone number and a receipt, which are the
     * group's business and belong in its database. The credentials never arrive
     * here, but a passkey has no business in a log, and this file is exactly
     * the kind of thing that gets copied about while diagnosing.
     */
    private const SECRET_KEYS = ['passkey', 'Password', 'password'];

    public static function record(string $event, array $data): void
    {
        try {
            $dir = dirname(self::path());

            if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
                return;
            }

            $line = json_encode([
                'at' => gmdate('c'),
                'event' => $event,
                'data' => self::redact($data),
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

            // LOCK_EX so two confirmations arriving together cannot interleave
            // half a line into each other.
            @file_put_contents(self::path(), $line . "\n", FILE_APPEND | LOCK_EX);
        } catch (\Throwable $e) {
            // Swallowed on purpose: losing the audit line must never stop the
            // callback answering Safaricom, or a real payment gets retried.
            Log::warn('[mpesa] could not write the audit record: ' . $e->getMessage());
        }
    }

    /**
     * Strips anything that should not be written down.
     *
     * Applied to the whole structure rather than to a list of known keys,
     * because a field nobody has seen is exactly the one worth keeping -
     * provided it is not a credential.
     */
    private static function redact(array $data): array
    {
        foreach ($data as $key => $value) {
            if (is_array($value)) {
                $data[$key] = self::redact($value);
            } elseif (in_array((string) $key, self::SECRET_KEYS, true)) {
                $data[$key] = '[withheld]';
            }
        }

        return $data;
    }

    private static function path(): string
    {
        return dirname(__DIR__, 2) . '/' . self::FILE;
    }
}