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
     * Every way a Kenyan mobile number reaches this app, reduced to one form.
     *
     * Accepting all of them is not fussiness. Members type their number from a
     * till receipt, a phone contact, or an M-Pesa confirmation message, and each
     * has a different idea of how to write it. A number that is correct but not
     * recognised gets a payment prompt that never arrives, or a payment that
     * cannot be credited to anybody:
     *
     *   0712345678        the local form members are stored in
     *   254712345678      already international
     *   +254712345678     as written on an M-Pesa confirmation
     *   00254712345678    the dialling prefix, used by some networks abroad
     *   712345678         local without the leading zero
     *   0712 345 678      spaced in threes, off a till receipt
     *   +254-712-345-678  hyphenated
     *   (0712) 345-678    bracketed
     *   0712345678.0      a trailing dot from a form field
     *
     * Returns null rather than a best guess for anything unrecognised: sending to
     * a malformed number costs money and delivers nothing, so an unrecognised
     * input is reported to the operator instead.
     *
     * Only Kenyan mobile numbers are accepted. Safaricom rejects anything whose
     * subscriber part does not begin with 7 or 1 with 400.002.02
     * "Invalid PhoneNumber", and 1 covers the 01 prefixes Safaricom has since
     * issued. Catching it here turns an opaque rejection into a sentence the
     * member can act on.
     */
    public static function normalise($phone): ?string
    {
        if ($phone === null || $phone === false) {
            return null;
        }

        // Everything that is not a digit goes: spaces, +, -, dots, brackets,
        // and the "tel:" or a name someone pasted in alongside the number.
        $digits = preg_replace('/\D+/', '', (string) $phone) ?? '';

        if ($digits === '') {
            return null;
        }

        // 00 is how many networks outside Kenya write the international prefix.
        if (str_starts_with($digits, '00')) {
            $digits = substr($digits, 2);
        }

        if (str_starts_with($digits, '254')) {
            // 254 plus a nine digit subscriber number.
            return strlen($digits) === 12 ? $digits : null;
        }

        if (str_starts_with($digits, '0') && strlen($digits) === 10) {
            return self::withCountry(substr($digits, 1));
        }

        if (strlen($digits) === 9) {
            return self::withCountry($digits);
        }

        return null;
    }

    /**
     * The subscriber part of a Kenyan mobile number, or null when it is not one.
     *
     * Kenyan mobiles begin 7 or 1 - the 01 prefixes Safaricom has issued since
     * the 07 range ran short. A landline beginning 0, or a subscriber part
     * beginning 0, is not an M-Pesa number and is refused rather than sent.
     */
    private static function withCountry(string $subscriber): ?string
    {
        return preg_match('/^([17])/', $subscriber) === 1 ? '254' . $subscriber : null;
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

    /**
     * Whether two numbers are the same subscriber, however each was written.
     *
     * Used to match an M-Pesa confirmation to a member. Comparing the stored
     * column as text only works while every member was saved in the same shape;
     * the first "+254712345678" stored next to a "0712345678" would stop matching
     * and that member's payments would silently stop being credited.
     */
    public static function sameNumber($a, $b): bool
    {
        $left = self::normalise($a);
        $right = self::normalise($b);

        return $left !== null && $left === $right;
    }
}