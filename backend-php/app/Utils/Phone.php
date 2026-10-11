<?php

declare(strict_types=1);

namespace TheTeam\Utils;

/**
 * Kenyan phone numbers.
 *
 * Two directions, and they are not interchangeable:
 *
 *   normalise()      0712345678 -> 254712345678, the form an SMS or M-Pesa API
 *                    expects.
 *   toMemberPhone()  254712345678 -> 0712345678, the form members are stored in.
 *
 * A port of normalisePhone in backend/utils/notifier.js and toMemberPhone in
 * backend/controllers/mpesaController.js.
 *
 * The second one is what decides whether a payment is credited to a member.
 * M-Pesa sends 254712345678; members are stored as 0712345678. Get the
 * conversion wrong in either direction and the lookup matches nobody, so the
 * money is real and the books never see it - the one failure in the payment path
 * with no visible symptom.
 */
final class Phone
{
    /**
     * Kenyan numbers to the international form an API expects.
     *
     * Returns null rather than a best guess for anything unrecognised: sending to
     * a malformed number costs money and delivers nothing, so an unrecognised
     * input is reported to the operator instead.
     *
     * Three recognised shapes, and nothing else:
     *   254712345678  already international
     *   0712345678    local, ten digits
     *   712345678     local without the leading zero, nine digits
     */
    public static function normalise($phone): ?string
    {
        if ($phone === null || $phone === false || $phone === '') {
            return null;
        }

        $digits = preg_replace('/[^0-9]/', '', (string) $phone) ?? '';

        if ($digits === '') {
            return null;
        }

        if (str_starts_with($digits, '254')) {
            return $digits;
        }

        if (str_starts_with($digits, '0') && strlen($digits) === 10) {
            return '254' . substr($digits, 1);
        }

        if (strlen($digits) === 9) {
            return '254' . $digits;
        }

        return null;
    }

    /** The international form, or null when the number cannot be understood. */
    public static function toInternational($phone): ?string
    {
        return self::normalise($phone);
    }

    /**
     * The stored form, or null when the number cannot be understood.
     *
     * A member with an unusable phone number cannot be credited, and the caller
     * needs to know that rather than discovering it as a null in a silent query.
     */
    public static function toMemberPhone($phone): ?string
    {
        $digits = self::normalise($phone);

        if ($digits === null) {
            return null;
        }

        return str_starts_with($digits, '254') ? '0' . substr($digits, 3) : $digits;
    }
}